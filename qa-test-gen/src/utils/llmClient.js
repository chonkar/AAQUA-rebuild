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

     getGenerativeModel({ model, generationConfig }) {
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
                         // Default 12000 leaves room for the larger detailed output
                         // (steps + preconditions + ≥15 cases); a caller can override.
                         max_tokens: generationConfig?.maxOutputTokens || 12000,
                         temperature: generationConfig?.temperature !== undefined ? generationConfig.temperature : 0.2,
                         // gpt-oss is a reasoning model — without a cap it can spend the
                         // entire token budget "thinking" and return empty content
                         // (finish_reason=length). Callers that want the budget spent on
                         // the answer pass reasoningEffort: 'low'.
                         ...(generationConfig?.reasoningEffort ? { reasoning_effort: generationConfig.reasoningEffort } : {})
                     })
                 });

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`LLM API Error ${response.status}: ${errText}`);
                }

                const data = await response.json();
                const choice = data && data.choices && data.choices[0];
                const content = choice && choice.message ? choice.message.content : undefined;
                if (content == null || String(content).trim() === '') {
                    // Reasoning models (gpt-oss) can spend the whole token budget on
                    // internal reasoning and return empty content; finish_reason='length'
                    // confirms truncation. Surface a clear message instead of letting an
                    // empty string fall through as a misleading "not valid JSON".
                    const reason = choice && choice.finish_reason;
                    if (reason === 'length') {
                        throw new Error('The AI hit its output length limit before returning any content. Try a shorter requirement or generate in smaller batches.');
                    }
                    throw new Error(`AI returned an empty response (finish_reason=${reason || 'unknown'}). Please try again.`);
                }

                return {
                    response: {
                        text: () => content
                    }
                };
            }
        };
    }
}
