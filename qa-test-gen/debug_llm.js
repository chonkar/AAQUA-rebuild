import fs from 'fs';

const API_KEY = "sk-mriZS3yJT6CqoFFKSFO2Yw";
const LLM_ENDPOINT = 'https://llm.lab.aaseya.com/v1';
const MODEL_NAME = "gpt-oss-20b";

const promptContext = `
    Generate EXACTLY 5 records based on: "table with epic and user_stories columns. Epics should be Loan Process, Loan Approval, etc."
`;

const prompt = `
    ${promptContext}

    CRITICAL INSTRUCTIONS:
    - DO NOT output any reasoning, explanations, or thought process.
    - Output ONLY the raw JSON array. NO MARKDOWN.
    
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

console.log("Fetching Test Data...");
fetch(`${LLM_ENDPOINT}/chat/completions`, {
    method: 'POST',
    headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        model: MODEL_NAME,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000
    })
}).then(async res => {
    const data = await res.json();
    const text = data.choices[0].message.content;
    console.log("---- RAW RESPONSE START ----");
    console.log(text);
    console.log("---- RAW RESPONSE END ----");

}).catch(err => {
    console.error("API Error:", err);
});
