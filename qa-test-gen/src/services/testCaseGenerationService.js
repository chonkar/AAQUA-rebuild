
import { LocalLLM as GoogleGenerativeAI } from "../utils/llmClient";

const API_KEY = import.meta.env.VITE_LLM_API_KEY;
const LLM_ENDPOINT = import.meta.env.VITE_LLM_ENDPOINT;
const MODEL_NAME = import.meta.env.VITE_LLM_MODEL || "gpt-oss-20b";

export const generateTestCases = async (requirement, requirementHistory = [], signal) => {
    if (!API_KEY) {
        throw new Error("API Key is missing. Please check your .env file.");
    }

    if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }

    try {
        const genAI = new GoogleGenerativeAI(API_KEY, LLM_ENDPOINT);
        const model = genAI.getGenerativeModel({ model: MODEL_NAME });

        const historyText = requirementHistory.length > 0
            ? `\nPREVIOUS CONTEXT (Use this to understand the domain/project context if relevant):\n${requirementHistory.map((req, i) => `${i + 1}. ${req}`).join('\n')}\n`
            : '';

        const prompt = `
      You are a Senior QA Test Architect.
      ${historyText}
      Generate comprehensive FUNCTIONAL test cases for the following NEW requirement. You MUST generate AT LEAST 15 functional test cases. Ensure they are STRICTLY functional test cases without automation specifics:
      "${requirement}"

      Cover relevant scenarios from ALL of these Test Types to ensure 100% coverage:
      1. Positive Scenarios (Happy Path)
      2. Negative Scenarios (Invalid inputs, error handling)
      3. Boundary Value Analysis (Min/Max values)
      4. Edge Cases (Rare but possible scenarios)
      5. Security & Access Control (if applicable)

      CRITICAL: Output ONLY a JSON array of objects. Do NOT include any internal reasoning, chain-of-thought, or markdown formatting (like \`\`\`json). The response must start with [ and end with ].
      
      Each object must have exactly these fields:
      - id (string, e.g., "FT_001")
      - module (string)
      - feature (string)
      - scenario (string)
      - steps (array of strings, e.g., ["1. Open app", "2. Login"])
      - expectedResult (string)
      - priority (string: "P1-Critical", "P2-High", "P3-Medium", "P4-Low")
      - platform (string: "Web", "Mobile", "Both")
      - testType (string: "Positive", "Negative", "Boundary", "Edge", "Security")

      Make the test data realistic and ensure high coverage. Keep steps extremely concise.
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

        // Clean up if model returns markdown code blocks
        let cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();

        // Robust subset extraction: Find the first '[' and last ']' to ignore any conversational text the local LLM might have prepended/appended.
        const firstBracket = cleanedText.indexOf('[');
        const lastBracket = cleanedText.lastIndexOf(']');

        if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
            cleanedText = cleanedText.substring(firstBracket, lastBracket + 1);
        }

        try {
            return JSON.parse(cleanedText);
        } catch (parseError) {
            console.error("Failed to parse AI response:", text);
            throw new Error("AI response was not valid JSON. Please try again.");
        }

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
