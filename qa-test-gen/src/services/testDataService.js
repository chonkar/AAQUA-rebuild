
import { LocalLLM as GoogleGenerativeAI } from "../utils/llmClient";
import { faker } from '@faker-js/faker';

const API_KEY = import.meta.env.VITE_LLM_API_KEY;
const LLM_ENDPOINT = import.meta.env.VITE_LLM_ENDPOINT;
const MODEL_NAME = import.meta.env.VITE_LLM_MODEL || "gpt-oss-20b";

// Strict validation helper
const isValidJSON = (str) => {
    try {
        JSON.parse(str);
        return true;
    } catch (e) {
        return false;
    }
};

// Process data to replace Faker placeholders and track stats
const processHybridData = (data) => {
    let fakerCount = 0;
    let totalFields = 0;

    const processValue = (val) => {
        totalFields++;
        if (typeof val !== 'string') return val;

        if (val.includes('{{FAKER_NAME}}')) { fakerCount++; return faker.person.fullName(); }
        if (val.includes('{{FAKER_EMAIL}}')) { fakerCount++; return faker.internet.email(); }
        if (val.includes('{{FAKER_PHONE}}')) { fakerCount++; return faker.phone.number(); }
        if (val.includes('{{FAKER_CITY}}')) { fakerCount++; return faker.location.city(); }
        if (val.includes('{{FAKER_COUNTRY}}')) { fakerCount++; return faker.location.country(); }
        if (val.includes('{{FAKER_COMPANY}}')) { fakerCount++; return faker.company.name(); }
        if (val.includes('{{FAKER_DATE}}')) { fakerCount++; return faker.date.past().toISOString().split('T')[0]; }
        if (val.includes('{{FAKER_UUID}}')) { fakerCount++; return faker.string.uuid(); }

        return val;
    };

    let processedData = data;
    if (Array.isArray(data)) {
        processedData = data.map(item => {
            const newItem = {};
            for (const key in item) {
                newItem[key] = processValue(item[key]);
            }
            return newItem;
        });
    }

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
        const model = genAI.getGenerativeModel({ model: MODEL_NAME });

        let promptContext = "";

        if (mode === 'schema') {
            promptContext = `
                I have a JSON Schema: 
                ${input}
                
                Generate ${count} records that verify this schema.
            `;
        } else {
            promptContext = `
                Generate ${count} records based on: "${input}"
            `;
        }

        const prompt = `
            ${promptContext}

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

            Output ONLY a valid JSON array of objects. No markdown.
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();

        // Cleanup markdown
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        if (!isValidJSON(text)) {
            throw new Error("AI failed to generate valid JSON.");
        }

        let rawData = JSON.parse(text);

        // Post-process with Faker and return { data, stats }
        return processHybridData(rawData);

    } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.error("Test Data Generation Error:", error);
        throw new Error(error.message || "Failed to generate test data");
    }
};
