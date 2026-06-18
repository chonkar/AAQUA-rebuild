
import { LocalLLM as GoogleGenerativeAI } from "../utils/llmClient";

const API_KEY = import.meta.env.VITE_LLM_API_KEY;
const LLM_ENDPOINT = import.meta.env.VITE_LLM_ENDPOINT;
const MODEL_NAME = import.meta.env.VITE_LLM_MODEL || "gpt-oss-20b";

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

export const generateTestCases = async (requirement, requirementHistory = [], signal) => {
    if (!API_KEY) {
        throw new Error("API Key is missing. Please check your .env file.");
    }

    if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }

    try {
        const genAI = new GoogleGenerativeAI(API_KEY, LLM_ENDPOINT);
        const model = genAI.getGenerativeModel({ model: MODEL_NAME, generationConfig: { reasoningEffort: 'low' } });

        // Sanitize requirement to remove repeating dots, ellipses, and excess spacing from copied texts
        const sanitizedRequirement = (requirement || "")
            .replace(/[\u2026\u22EF]/g, ' ') // Replace unicode ellipses
            .replace(/\.{2,}/g, ' ')         // Replace repeating periods with space
            .replace(/\s+/g, ' ')            // Normalize whitespace
            .trim();

        const historyText = requirementHistory.length > 0
            ? `\nPREVIOUS CONTEXT (Use this to understand the domain/project context if relevant):\n${requirementHistory.map((req, i) => `${i + 1}. ${req}`).join('\n')}\n`
            : '';

        const getPrompt = (batchDesc) => {
            return `
      You are a Senior QA Test Architect.
      ${historyText}
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
      - testType (string: one of "Positive", "Negative", "Boundary", "Edge", "Security", "Navigation", "Field Validation", "Cancel")

      Make the test data realistic. Write steps in plain, detailed language so anyone reviewing them for the FIRST TIME understands exactly what to do and what to expect.
            `;
        };

        const batches = [
            {
                name: "Positive Scenarios / Happy Path",
                prompt: getPrompt("Positive Scenarios / Happy Path")
            },
            {
                name: "Negative Scenarios / Boundary Value Analysis / Edge Cases",
                prompt: getPrompt("Negative Scenarios / Boundary Value Analysis / Edge Cases")
            },
            {
                name: "Workflow Navigation / Field Validation / Cancel Actions / Security Controls",
                prompt: getPrompt("Workflow Navigation, Field Validation (including read-only / non-editable fields), Cancel/Discard/Back actions, and Security/Access Control Scenarios")
            }
        ];

        const cancellationPromise = new Promise((_, reject) => {
            if (signal) {
                signal.addEventListener('abort', () => reject(new DOMException("Aborted", "AbortError")));
            }
        });

        const queryBatchWithRetry = async (b, retriesLeft = 1) => {
            try {
                const result = await Promise.race([
                    model.generateContent(b.prompt),
                    cancellationPromise
                ]);
                const response = await result.response;
                const text = response.text();
                const cases = extractTestCases(text);
                
                // If it succeeded but returned very few cases (less than 5), retry once if retries are left
                if (cases.length < 5 && retriesLeft > 0) {
                    console.warn(`[AI Batch Warning] Generated only ${cases.length} cases for ${b.name}. Retrying once...`);
                    return await queryBatchWithRetry(b, retriesLeft - 1);
                }
                return cases;
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                console.error(`[AI Batch Error] Failed to generate ${b.name}:`, err);
                if (retriesLeft > 0) {
                    console.log(`[AI Batch Retry] Retrying ${b.name} after error...`);
                    return await queryBatchWithRetry(b, retriesLeft - 1);
                }
                return [];
            }
        };

        // Run queries in parallel
        const results = await Promise.all(
            batches.map(b => queryBatchWithRetry(b))
        );

        // Flatten all generated test cases
        let combinedCases = results.flat();

        if (combinedCases.length === 0) {
            throw new Error("AI failed to generate any valid test cases. Please try again.");
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
        if (error.message.includes("404")) {
            throw new Error(`Model '${MODEL_NAME}' not found or API Key invalid. Ensure your API key has access to Generative Language API.`);
        }
        throw error;
    }
};
