import fs from 'fs';

async function testGenerate() {
    console.log("Sending request to backend...");
    const payload = {
        projectName: "node-test-framework",
        framework: "Selenium",
        language: "Java",
        features: {
            pageObjectModel: true,
            reporting: "Allure",
            logging: true,
            cicd: "None",
            docker: false,
            parallel: true
        }
    };

    try {
        const response = await fetch('http://localhost:3001/api/generate-framework', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.error(`Error: ${response.status} ${response.statusText}`);
            const text = await response.text();
            console.error(text);
            return;
        }

        console.log("Response OK. Saving zip...");
        const buffer = await response.arrayBuffer();
        fs.writeFileSync('node_test.zip', Buffer.from(buffer));
        console.log("Saved node_test.zip");

    } catch (e) {
        console.error("Test failed:", e);
    }
}

testGenerate();
