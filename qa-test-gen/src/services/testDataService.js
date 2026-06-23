
import { LocalLLM as GoogleGenerativeAI } from "../utils/llmClient";
import { faker } from '@faker-js/faker';

const API_KEY = import.meta.env.VITE_LLM_API_KEY;
const LLM_ENDPOINT = import.meta.env.VITE_LLM_ENDPOINT;
const MODEL_NAME = import.meta.env.VITE_LLM_MODEL || "gemma-4";

// Strict validation helper
const isValidJSON = (str) => {
    try {
        JSON.parse(str);
        return true;
    } catch (e) {
        return false;
    }
};

// Robust helper to extract a JSON array or objects from the LLM text
export function extractTestData(text) {
    if (!text || typeof text !== 'string') return [];
    let s = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    
    // 1. Try to find and parse the outer array first
    const firstArr = s.indexOf('[');
    const lastArr = s.lastIndexOf(']');
    if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
        try {
            const arr = JSON.parse(s.slice(firstArr, lastArr + 1));
            if (Array.isArray(arr)) return arr;
        } catch { /* fallback to salvage */ }
    }

    // 2. If it is a single valid JSON object, parse it
    const firstObj = s.indexOf('{');
    const lastObj = s.lastIndexOf('}');
    if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) {
        try {
            const obj = JSON.parse(s.slice(firstObj, lastObj + 1));
            if (obj && typeof obj === 'object') {
                const keys = Object.keys(obj);
                // Wrapper detection: if single key and it contains an array, return that array
                if (keys.length === 1 && Array.isArray(obj[keys[0]])) {
                    return obj[keys[0]];
                }
                return [obj];
            }
        } catch { /* fallback to salvage */ }
    }

    // 3. Salvage parser: scan for balanced top-level {...} objects
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
                try { objects.push(JSON.parse(s.slice(start, i + 1))); } catch { /* skip */ }
                start = -1;
            }
        }
    }
    return objects;
}

// Process data to replace Faker placeholders and track stats
const processHybridData = (data) => {
    let fakerCount = 0;
    let totalFields = 0;

    const processValue = (val) => {
        if (Array.isArray(val)) {
            return val.map(processValue);
        }
        if (val !== null && typeof val === 'object') {
            const newObj = {};
            for (const k in val) {
                newObj[k] = processValue(val[k]);
            }
            return newObj;
        }

        totalFields++;
        if (typeof val !== 'string') return val;

        if (val.includes('{{FAKER_NAME}}')) { fakerCount++; return faker.person.fullName(); }
        if (val.includes('{{FAKER_EMAIL}}')) { fakerCount++; return faker.internet.email(); }
        if (val.includes('{{FAKER_PHONE}}')) { fakerCount++; return faker.string.numeric(10); }
        if (val.includes('{{FAKER_CITY}}')) { fakerCount++; return faker.location.city(); }
        if (val.includes('{{FAKER_COUNTRY}}')) { fakerCount++; return faker.location.country(); }
        if (val.includes('{{FAKER_COMPANY}}')) { fakerCount++; return faker.company.name(); }
        if (val.includes('{{FAKER_DATE}}')) { fakerCount++; return faker.date.past().toISOString().split('T')[0]; }
        if (val.includes('{{FAKER_UUID}}')) { fakerCount++; return faker.string.uuid(); }

        return val;
    };

    let processedData = Array.isArray(data) ? data.map(processValue) : processValue(data);

    return {
        data: processedData,
        stats: {
            totalFields,
            fakerCount,
            llmCount: totalFields - fakerCount
        }
    };
};

export const generateTestData = async (input, mode = 'prompt', count = 5) => {
    if (!API_KEY) {
        throw new Error("API Key is missing.");
    }

    // STRICT VALIDATION for Schema Mode
    if (mode === 'schema') {
        if (!isValidJSON(input)) {
            throw new Error("Invalid format: The input provided is not valid JSON.");
        }
    }

    try {
        const genAI = new GoogleGenerativeAI(API_KEY, LLM_ENDPOINT);
        const model = genAI.getGenerativeModel({ 
            model: MODEL_NAME, 
            generationConfig: { reasoningEffort: 'low' } 
        });

        let promptContext = "";

        if (mode === 'schema') {
            promptContext = `
                I have a JSON Schema: 
                ${input}
                
                Generate EXACTLY ${count} records that verify this schema.
            `;
        } else {
            const sanitizedInput = (input || "")
                .replace(/[\u2026\u22EF]/g, ' ') // Replace unicode ellipses
                .replace(/\.{2,}/g, ' ')         // Replace repeating periods with space
                .replace(/\s+/g, ' ')            // Normalize whitespace
                .trim();
            promptContext = `
                Generate EXACTLY ${count} records based on: "${sanitizedInput}"
            `;
        }

        const prompt = `
            ${promptContext}

            CRITICAL INSTRUCTIONS:
            - DO NOT output any reasoning, explanations, or thought process.
            - Wrap the JSON array output in a markdown \`\`\`json code block. Do not include any explanations or conversational text.
            
            IMPORTANT OPTIMIZATION INSTRUCTIONS:
            To save generation time, use the following PLACEHOLDERS for standard data types exactly as written below. Do NOT generate real names/emails yourself, just use the string placeholder:
            - Use "{{FAKER_NAME}}" for person names.
            - Use "{{FAKER_EMAIL}}" for emails.
            - Use "{{FAKER_PHONE}}" for phone numbers.
            - Use "{{FAKER_CITY}}" for cities.
            - Use "{{FAKER_COUNTRY}}" for countries.
            - Use "{{FAKER_COMPANY}}" for company names.
            - Use "{{FAKER_DATE}}" for past dates.
            - Use "{{FAKER_UUID}}" for unique IDs.

            For specific business logic or fields not covered above, generate realistic values yourself.
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();

        const rawData = extractTestData(text);

        if (rawData.length === 0) {
            console.error("AI failed to generate valid JSON data. Raw text was:", text);
            throw new Error("AI failed to generate any valid test data. Please try lowering the Count and trying again.");
        }

        // Post-process with Faker and return { data, stats }
        return processHybridData(rawData);

    } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.error("Test Data Generation Error:", error);
        throw new Error(error.message || "Failed to generate test data");
    }
};
