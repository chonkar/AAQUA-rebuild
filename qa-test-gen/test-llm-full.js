const apiKey = "sk-mriZS3yJT6CqoFFKSFO2Yw";
const endpoint = "http://localhost:5174/llm-api/v1/chat/completions";

const prompt = `
      You are a Senior QA Test Architect.
      Generate comprehensive FUNCTIONAL test cases for the following requirement:
      "Login Page"

      Cover relevant scenarios from these Test Types (as applicable):
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

      Make the test data realistic and ensure high coverage.
    `;

console.log("Starting full fetch...");
const start = Date.now();
fetch(endpoint, {
    method: "POST",
    headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
    },
    body: JSON.stringify({
        model: "qwen2.5:14b",
        messages: [{ role: "user", content: prompt }]
    })
}).then(async res => {
    console.log(`Status: ${res.status} (Took ${Date.now() - start}ms)`);
    const data = await res.text();
    console.log("Data length:", data.length);
    console.log(data);
}).catch(err => {
    console.error("Error:", err);
});
