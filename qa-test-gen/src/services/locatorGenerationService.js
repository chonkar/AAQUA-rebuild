import { LocalLLM as GoogleGenerativeAI } from "../utils/llmClient";
import { generateBoilerplateLocators } from "../utils/locatorUtils";

const API_KEY = import.meta.env.VITE_LLM_API_KEY;
const LLM_ENDPOINT = import.meta.env.VITE_LLM_ENDPOINT;
const MODEL_NAME = import.meta.env.VITE_LLM_MODEL || "gpt-oss-20b";

export const generateLocators = async (htmlContent) => {
    if (!API_KEY) {
        throw new Error("API Key is missing. Please check your .env file.");
    }

    if (!htmlContent || !htmlContent.trim()) {
        throw new Error("Please provide valid HTML content.");
    }

    // 1. Generate Code-Based Locators
    const allLocators = generateBoilerplateLocators(htmlContent);

    // 2. Identify Weak/Unstable Locators (Confidence < 0.85)
    // Stable ones (ID, Unique Name) don't need expensive AI
    const stableLocators = allLocators.filter(l => l.confidence >= 0.85);
    const weakLocators = allLocators.filter(l => l.confidence < 0.85);

    if (weakLocators.length === 0) {
        return stableLocators;
    }

    // 3. Improve Weak Locators with AI
    try {
        const improvedLocators = await improveLocatorsWithAI(htmlContent, weakLocators);

        // Merge results
        const finalLocators = [...stableLocators, ...improvedLocators];
        return finalLocators;
    } catch (error) {
        console.error("AI Improvement Failed, falling back to code locators:", error);
        return allLocators.map(l => ({ ...l, reason: l.reason + ' (AI Failed)' }));
    }
};

const improveLocatorsWithAI = async (htmlContent, weakLocators) => {
    const genAI = new GoogleGenerativeAI(API_KEY, LLM_ENDPOINT);
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });

    const elementsData = weakLocators.map(l => ({
        element: l.element,
        type: l.type,
        snippet: l.snippet,
        current_css: l.css,
        current_xpath: l.xpath
    }));

    const prompt = `
        You are an expert Automation QA Engineer. 
        Your task is to improve unstable UI locators.

        Rules:
        - Do NOT use index-based selectors (nth-child, [2], etc).
        - Prefer id, name, aria-label, data-* attributes.
        - If no unique attribute exists, combine tag + text + attribute.
        - Generate locators suitable for Selenium and Playwright.
        - Keep selectors short and stable across UI changes.
        - **Exclude dynamic session IDs** (e.g. jsessionid) from attributes (href, action). Use 'contains' if necessary.
        - Analyze the 'snippet' provided for each element to find the best attributes.

        INPUT METADATA (Unstable Locators to Fix):
        \`\`\`json
        ${JSON.stringify(elementsData, null, 2)}
        \`\`\`

        GLOBAL HTML CONTEXT (Truncated):
        \`\`\`html
        ${htmlContent.slice(0, 15000)} 
        \`\`\`

        OUTPUT INSTRUCTIONS:
        Return a JSON ARRAY of objects in the following format for EACH element in the input:
        {
          "element": "<name from input>",
          "type": "<type from input>",
          "css": "<improved stable css selector>",
          "xpath": "<improved stable xpath>",
          "confidence": <number between 0.7 and 0.95>,
          "reason": "<explanation of improvement>",
          "source": "AI"
        }

        OUTPUT THE JSON ARRAY WRAPPED IN A MARKDOWN \`\`\`json CODE BLOCK. DO NOT INCLUDE ANY ADDITIONAL CONVERSATIONAL TEXT.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text();

    text = text.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
        const aiLocators = JSON.parse(text);
        if (!Array.isArray(aiLocators)) throw new Error("AI response not an array");
        return aiLocators.map(l => ({ ...l, source: 'AI' }));
    } catch (e) {
        console.error("Failed to parse AI response", text);
        throw e;
    }
};
