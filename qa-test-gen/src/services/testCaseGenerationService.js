
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
        // reasoningEffort:'medium' bounds gpt-oss's reasoning so it doesn't burn the
        // whole token budget thinking (the unset/high default returned empty content),
        // while keeping more deliberation than 'low'. Verified: ~4.4k tokens, completes.
        const model = genAI.getGenerativeModel({ model: MODEL_NAME, generationConfig: { reasoningEffort: 'medium' } });

        // Sanitize requirement to remove repeating dots, ellipses, and excess spacing from copied texts
        const sanitizedRequirement = (requirement || "")
            .replace(/[\u2026\u22EF]/g, ' ') // Replace unicode ellipses
            .replace(/\.{2,}/g, ' ')         // Replace repeating periods with space
            .replace(/\s+/g, ' ')            // Normalize whitespace
            .trim();

        const historyText = requirementHistory.length > 0
            ? `\nPREVIOUS CONTEXT (Use this to understand the domain/project context if relevant):\n${requirementHistory.map((req, i) => `${i + 1}. ${req}`).join('\n')}\n`
            : '';

        const prompt = `
      You are a Senior QA Test Architect.
      ${historyText}
      Generate comprehensive FUNCTIONAL test cases for the following NEW requirement. You MUST generate AT LEAST 15 functional test cases. Ensure they are STRICTLY functional test cases without automation specifics:
      "${sanitizedRequirement}"

      Cover relevant scenarios from ALL of these Test Types to ensure 100% coverage:
      1. Positive Scenarios (Happy Path)
      2. Negative Scenarios (Invalid inputs, error handling)
      3. Boundary Value Analysis (Min/Max values)
      4. Edge Cases (Rare but possible scenarios)
      5. Security & Access Control (if applicable)
      6. Navigation (moving between screens/tabs/links, Back/Breadcrumb behavior, redirects, deep links)
      7. Field Validation including READ-ONLY / non-editable fields (verify they are displayed, pre-populated where expected, and CANNOT be edited)
      8. Cancel / Discard / Back actions (verify no data is saved, any confirmation prompt appears, and the user is returned to the correct screen)

      MANDATORY COVERAGE: Whenever the requirement involves any form, screen, list, or multi-step workflow, you MUST include dedicated test case(s) for EACH of: (a) Cancel/Discard/Back, (b) Read-only / non-editable field validation, and (c) Navigation between screens. Do not omit these.

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

        const cancellationPromise = new Promise((_, reject) => {
            if (signal) {
                signal.addEventListener('abort', () => reject(new DOMException("Aborted", "AbortError")));
            }
        });

        const result = await Promise.race([
            model.generateContent(prompt),
            cancellationPromise
        ]);

        const response = await result.response;
        const text = response.text();

        const cases = extractTestCases(text);
        if (cases.length === 0) {
            console.error("Failed to parse AI response:", text);
            throw new Error("AI response was not valid JSON. Please try again.");
        }
        return cases;

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
