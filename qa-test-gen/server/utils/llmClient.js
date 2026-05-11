export class LocalLLM {
    constructor(apiKey, endpoint) {
        this.apiKey = apiKey;
        this.endpoint = endpoint || 'https://llm.lab.aaseya.com/v1';
    }

    getGenerativeModel({ model }) {
        return {
            generateContent: async (prompt) => {
                const response = await fetch(`${this.endpoint}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [{ role: 'user', content: prompt }],
                        temperature: 0.8
                    })
                });

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`LLM API Error ${response.status}: ${errText}`);
                }

                const data = await response.json();

                return {
                    response: {
                        text: () => data.choices[0].message.content
                    }
                };
            }
        };
    }
}
