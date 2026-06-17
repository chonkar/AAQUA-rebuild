
import { LocalLLM as GoogleGenerativeAI } from "../utils/llmClient";

const API_KEY = import.meta.env.VITE_LLM_API_KEY;
const LLM_ENDPOINT = import.meta.env.VITE_LLM_ENDPOINT;
const MODEL_NAME = import.meta.env.VITE_LLM_MODEL || "gpt-oss-20b";

export const generateTestPlan = async (clientName, projectName, requirement, signal) => {
    if (!API_KEY) {
        throw new Error("API Key is missing. Please check your .env file.");
    }

    if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }

    try {
        const genAI = new GoogleGenerativeAI(API_KEY, LLM_ENDPOINT);
        const model = genAI.getGenerativeModel({ 
            model: MODEL_NAME, 
            generationConfig: { reasoningEffort: 'low' } 
        });

        const prompt = `
      You are a Senior QA Manager creating a formal Test Plan document following ISTQB standards.
      
      **Client**: ${clientName}
      **Project**: ${projectName}
      **Requirement**: "${requirement}"

      Generate a professional Test Plan in **HTML format** (using <h2>, <h3>, <p>, <ul>, <li>, <table> tags).
      Do NOT include <html>, <head>, or <body> tags, just the content div.
      
      The Test Plan MUST include these sections:
      1.  **1. Introduction** (Scope, Objectives, References)
      2.  **2. Test Strategy** (Test Levels, Test Types, Tools)
      3.  **3. Test Environment** (Hardware, Software, Data)
      4.  **4. Resourcing** (Roles & Responsibilities)
      5.  **5. Schedule** (Key Milestones)
      6.  **6. Risks and Mitigation**
      7.  **7. Entry/Exit Criteria**
      8.  **8. Deliverables**

      Style the HTML with inline CSS for a professional "Document" look (e.g., font-family: Calibri, sans-serif; headers in dark blue).
      Make the content realistic based on the requirement provided.
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
        let text = response.text();

        // Cleanup markdown if present
        text = text.replace(/```html/g, '').replace(/```/g, '');

        return text;
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.error("Test Plan Generation Error:", error);
        throw new Error(error.message || "Failed to generate test plan");
    }
};
