
import { streamLLM } from '../utils/llmStream.js';

// Kept in sync with the values the (now removed) browser-side LocalLLM client
// used for this tool: src/utils/llmClient.js defaulted to max_tokens 12000 /
// temperature 0.2, so the streaming proxy is given the same budget rather than
// falling back to its own defaults. `reasoning_effort: 'low'` came from the
// same call site and matters just as much: gpt-oss is a reasoning model and
// without the cap it can burn all 12000 tokens on internal reasoning and
// return empty content (finish_reason='length') for every batch.
const MAX_TOKENS = 12000;
const TEMPERATURE = 0.2;
const REASONING_EFFORT = 'low';

// Parse the model's JSON array of test cases, tolerant of markdown fences,
// surrounding prose, and — importantly — a TRUNCATED response. Local models can
// hit the output-token cap mid-array, which makes a strict JSON.parse fail on
// the whole batch. We first try the well-formed array; if that fails we scan for
// balanced top-level {...} objects (string-aware) and parse each independently,
// so only a partial final object is dropped and the rest survive.
export function extractTestCases(text) {
    if (!text || typeof text !== 'string') return [];
    let s = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const firstArr = s.indexOf('[');
    if (firstArr !== -1) s = s.slice(firstArr);

    const lastArr = s.lastIndexOf(']');
    if (lastArr > 0) {
        try {
            const arr = JSON.parse(s.slice(0, lastArr + 1));
            if (Array.isArray(arr)) return arr;
        } catch { /* fall through to salvage */ }
    }

    const objects = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') { if (depth === 0) start = i; depth++; }
        else if (ch === '}') {
            depth--;
            if (depth === 0 && start !== -1) {
                try { objects.push(JSON.parse(s.slice(start, i + 1))); } catch { /* skip incomplete object */ }
                start = -1;
            }
        }
    }
    return objects;
}

/**
 * Generate functional test cases for `requirement`, streamed through the
 * backend LLM proxy (`POST /api/llm/generate` via streamLLM) — the browser no
 * longer holds an LLM API key nor talks to the gateway directly.
 *
 * The four-batch prompt strategy, the per-batch retry policy and the
 * JSON-salvage parsing are unchanged from the pre-streaming version. Batches
 * still run in parallel; because four interleaved token streams would be
 * unreadable in a single output pane, each batch accumulates into its own slot
 * and `onToken` receives a stable, section-headed composition of all four.
 *
 * @param {Object} opts
 * @param {string} opts.requirement - The feature/requirement to cover.
 * @param {string[]} [opts.requirementHistory] - Previously used requirements, passed as domain context.
 * @param {string} [opts.businessRules]
 * @param {string} [opts.regressionContext]
 * @param {string} [opts.techDetails]
 * @param {(token: string, full: string) => void} [opts.onToken] - Called with each
 *   incremental token and the composed live text of every batch so far.
 * @param {AbortSignal} [opts.signal] - Cancels every in-flight batch.
 * @returns {Promise<Object[]>} Test-case rows, re-indexed as FT_001…FT_NNN.
 */
export const generateTestCases = async ({
    requirement,
    requirementHistory = [],
    businessRules = '',
    regressionContext = '',
    techDetails = '',
    onToken,
    signal,
} = {}) => {
    if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }

    try {
        // Sanitize requirement to remove repeating dots, ellipses, and excess spacing from copied texts
        const sanitizedRequirement = (requirement || "")
            .replace(/[…⋯]/g, ' ') // Replace unicode ellipses
            .replace(/\.{2,}/g, ' ')         // Replace repeating periods with space
            .replace(/\s+/g, ' ')            // Normalize whitespace
            .trim();

        const historyText = requirementHistory.length > 0
            ? `\nPREVIOUS CONTEXT (Use this to understand the domain/project context if relevant):\n${requirementHistory.map((req, i) => `${i + 1}. ${req}`).join('\n')}\n`
            : '';

        const rulesText = businessRules?.trim()
            ? `\nBUSINESS RULES & CONSTRAINTS TO ENFORCE (You MUST create specific test cases to verify these rules):\n${businessRules.trim()}\n`
            : '';

        const regressionText = regressionContext?.trim()
            ? `\nEXISTING FEATURES & REGRESSION CONTEXT (You MUST generate regression test cases verifying that this existing functionality is not broken):\n${regressionContext.trim()}\n`
            : '';

        const techText = techDetails?.trim()
            ? `\nAPPLICATION BEHAVIOR & TECHNICAL DETAILS:\n${techDetails.trim()}\n`
            : '';

        const getPrompt = (batchDesc) => {
            return `
      You are a Senior QA Test Architect.
      ${historyText}
      ${rulesText}
      ${regressionText}
      ${techText}
      Generate 6 comprehensive, distinct FUNCTIONAL test cases focusing ONLY on: ${batchDesc}.
      Target the following requirement:
      "${sanitizedRequirement}"

      Ensure they are STRICTLY functional test cases without automation specifics.

      CRITICAL: Output the JSON array of objects wrapped in a markdown \`\`\`json code block. Do NOT include any conversational introduction, explanation, or internal reasoning. Start your response directly with the \`\`\`json code block.

      Each object must have exactly these fields:
      - id (string, e.g., "FT_001")
      - module (string)
      - feature (string)
      - scenario (string: a clear one-line summary of what is being verified)
      - preconditions (string: state/data/role required before execution, e.g. "User is logged in as Claimant and is on the New Claim screen"; use "None" if not applicable)
      - testData (string: concrete sample input values used, e.g. "Email: test@x.com, Amount: 5000"; use "N/A" if none)
      - steps (array of strings: DETAILED, numbered, self-explanatory actions a first-time reviewer can follow WITHOUT prior context. Each step must state the exact UI action AND where it happens, e.g. ["1. Navigate to Dashboard > Claims and click 'New Claim'", "2. In the Claimant Details form, enter 'John Doe' in the Name field", "3. Click the 'Cancel' button at the bottom of the form"]. Avoid vague steps like "Enter data" or "Verify".)
      - expectedResult (string: the precise, observable outcome — what the user should see or what the system should do)
      - priority (string: "P1-Critical", "P2-High", "P3-Medium", "P4-Low")
      - platform (string: "Web", "Mobile", "Both")
      - testType (string: one of "Positive", "Negative", "Boundary", "Edge", "Security", "Navigation", "Field Validation", "Cancel", "Regression")

      Make the test data realistic. Write steps in plain, detailed language so anyone reviewing them for the FIRST TIME understands exactly what to do and what to expect.
            `;
        };

        const batches = [
            {
                name: "Positive Scenarios / Happy Path",
                prompt: getPrompt("Positive Scenarios / Happy Path (Verify core functionality when all business rules are met)")
            },
            {
                name: "Negative Scenarios / Field Validation / Access Controls",
                prompt: getPrompt("Negative Scenarios, Field Validation (including read-only / non-editable fields), Access Control Violations, and Input Validation Error Handling (XSS, SQLi, privilege escalation)")
            },
            {
                name: "Boundary Values / Edge Cases",
                prompt: getPrompt("Boundary Values and Edge Cases (Empty inputs, special characters, max/min limits, null values, timeouts, and parallel edits)")
            },
            {
                name: "Regression Scenarios / System Integration",
                prompt: getPrompt("Regression Scenarios and System Integration (Verify that the existing system features and dependencies remain fully functional and are not broken by the new changes)")
            }
        ];

        // One accumulator slot per batch, so the caller always sees the batches
        // in declaration order regardless of which stream emits next.
        const partials = batches.map(() => '');
        const compose = () => batches
            .map((b, i) => `### ${b.name}\n${partials[i] || '…'}`)
            .join('\n\n');

        // Clearing a slot has to be pushed to the caller too, otherwise the
        // output pane keeps showing the abandoned attempt's text until the
        // next token of the new one happens to arrive.
        const resetPartial = (i, placeholder = '') => {
            partials[i] = placeholder;
            onToken?.('', compose());
        };

        const batchErrors = [];

        const queryBatchWithRetry = async (b, i, retriesLeft = 1) => {
            try {
                resetPartial(i); // a retry restarts this batch's visible output
                const text = await streamLLM({
                    prompt: b.prompt,
                    maxTokens: MAX_TOKENS,
                    temperature: TEMPERATURE,
                    reasoningEffort: REASONING_EFFORT,
                    signal,
                    onToken: (token, full) => {
                        partials[i] = full;
                        onToken?.(token, compose());
                    },
                });
                const cases = extractTestCases(text);

                // If it succeeded but returned very few cases (less than 5), retry once if retries are left
                if (cases.length < 5 && retriesLeft > 0) {
                    console.warn(`[AI Batch Warning] Generated only ${cases.length} cases for ${b.name}. Retrying once...`);
                    return await queryBatchWithRetry(b, i, retriesLeft - 1);
                }
                return cases;
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                console.error(`[AI Batch Error] Failed to generate ${b.name}:`, err);
                if (retriesLeft > 0) {
                    console.log(`[AI Batch Retry] Retrying ${b.name} after error...`);
                    return await queryBatchWithRetry(b, i, retriesLeft - 1);
                }
                batchErrors.push(err.message);
                // Out of retries: replace the partial text with the reason, so
                // the pane shows which batch gave up rather than a truncated
                // fragment that looks like it is still arriving.
                resetPartial(i, `[failed: ${err.message}]`);
                return [];
            }
        };

        // Run queries in parallel
        const results = await Promise.all(
            batches.map((b, i) => queryBatchWithRetry(b, i))
        );

        // Flatten all generated test cases
        let combinedCases = results.flat();

        if (combinedCases.length === 0) {
            const firstErr = batchErrors[0];
            const msg = firstErr ? `AI generation failed: ${firstErr}` : "AI failed to generate any valid test cases. Please try again.";
            throw new Error(msg);
        }

        // Re-index all test cases sequentially to ensure order and avoid ID duplicates
        combinedCases = combinedCases.map((tc, idx) => ({
            ...tc,
            id: `FT_${String(idx + 1).padStart(3, '0')}`
        }));

        return combinedCases;

    } catch (error) {
        if (error.name === 'AbortError') {
            throw error;
        }
        console.error("AI Service Error:", error);
        throw error;
    }
};
