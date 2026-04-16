
import { LocalLLM as GoogleGenerativeAI } from "../utils/llmClient";

const API_KEY = import.meta.env.VITE_LLM_API_KEY;
const LLM_ENDPOINT = import.meta.env.VITE_LLM_ENDPOINT;
const MODEL_NAME = import.meta.env.VITE_LLM_MODEL || "gpt-oss-20b";

export const generateTestCases = async (requirement, signal) => {
    if (!API_KEY) {
        throw new Error("API Key is missing. Please check your .env file.");
    }

    if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }

    try {
        const genAI = new GoogleGenerativeAI(API_KEY, LLM_ENDPOINT);
        const model = genAI.getGenerativeModel({ model: MODEL_NAME });

        const prompt = `
      You are a Senior QA Test Architect.
      Generate a comprehensive list of generic FUNCTIONAL test cases (at least 15-20) for the following requirement:
      "${requirement}"

      You MUST cover the following Test Types:
      1. Positive Scenarios (Happy Path)
      2. Negative Scenarios (Invalid inputs, error handling)
      3. Boundary Value Analysis (Min/Max values)
      4. Edge Cases (Rare but possible scenarios)
      5. Security & Access Control (if applicable)

      Output ONLY a JSON array of objects. Do not include markdown formatting (like \`\`\`json).
      Each object must have these fields:
      - id (string, e.g., "FT_001")
      - module (string)
      - feature (string)
      - scenario (string)
      - steps (string, clear numbered steps)
      - expectedResult (string)
      - priority (string: P1-Critical, P2-High, P3-Medium, P4-Low)
      - platform (string: Web, Mobile, Both)
      - testType (string: Positive, Negative, Boundary, Edge, Security)

      Make the test data realistic and ensure high coverage.
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
        const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();

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
