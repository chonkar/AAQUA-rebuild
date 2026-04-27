const apiKey = "sk-mriZS3yJT6CqoFFKSFO2Yw";
const endpoint = "http://localhost:5174/llm-api/v1/chat/completions";

console.log("Starting fetch...");
const start = Date.now();
fetch(endpoint, {
    method: "POST",
    headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
    },
    body: JSON.stringify({
        model: "gpt-oss-20b",
        messages: [{ role: "user", content: "Hi! This is a test." }]
    })
}).then(async res => {
    console.log(`Status: ${res.status} (Took ${Date.now() - start}ms)`);
    const data = await res.text();
    console.log("Data:", data);
}).catch(err => {
    console.error("Error:", err);
});
