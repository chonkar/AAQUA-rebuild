export class LocalLLM {
    constructor(apiKey, endpoint) {
        this.apiKey = apiKey;
        this.endpoint = endpoint || 'https://llm.lab.aaseya.com/v1';

        // Bypass CORS in browser explicitly using Vite proxy
        if (typeof window !== 'undefined' && this.endpoint.includes('llm.lab.aaseya.com')) {
            const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
            this.endpoint = this.endpoint.replace('https://llm.lab.aaseya.com', `${BASE}/llm-api`);
        }
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
                        max_tokens: 4000
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
