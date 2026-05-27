export class LocalLLM {
    constructor(apiKey, endpoint) {
        this.apiKey = apiKey;
        this.endpoint = endpoint || 'https://llm.lab.aaseya.com/v1';
    }

     getGenerativeModel({ model, generationConfig }) {
         return {
             generateContent: async (prompt) => {
                 // Abort a hung request so the socket doesn't dangle forever; the
                 // caller's own timeout still applies, this is the hard ceiling.
                 const timeoutMs = generationConfig?.timeoutMs || 120000;
                 const controller = new AbortController();
                 const timer = setTimeout(() => controller.abort(), timeoutMs);

                 let response;
                 try {
                     response = await fetch(`${this.endpoint}/chat/completions`, {
                         method: 'POST',
                         headers: {
                             'Authorization': `Bearer ${this.apiKey}`,
                             'Content-Type': 'application/json'
                         },
                         body: JSON.stringify({
                             model: model,
                             messages: [{ role: 'user', content: prompt }],
                             temperature: generationConfig?.temperature !== undefined ? generationConfig.temperature : 0.2,
                             // Only sent when a caller opts in — bounds output so slow
                             // local models finish predictably instead of running long.
                             ...(generationConfig?.maxOutputTokens ? { max_tokens: generationConfig.maxOutputTokens } : {}),
                             // gpt-oss is a reasoning model — without a cap it can spend the
                             // whole token budget thinking and return empty content
                             // (finish_reason=length). Callers pass reasoningEffort:'low'.
                             ...(generationConfig?.reasoningEffort ? { reasoning_effort: generationConfig.reasoningEffort } : {})
                         }),
                         signal: controller.signal
                     });
                 } catch (err) {
                     if (err.name === 'AbortError') {
                         throw new Error(`LLM request aborted after ${timeoutMs / 1000}s (endpoint slow or unreachable)`);
                     }
                     throw err;
                 } finally {
                     clearTimeout(timer);
                 }

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`LLM API Error ${response.status}: ${errText}`);
                }

                const data = await response.json();
                const choice = data && data.choices && data.choices[0];
                const content = choice && choice.message ? choice.message.content : undefined;
                if (content == null || String(content).trim() === '') {
                    // Reasoning models (e.g. gpt-oss) can exhaust max_tokens on internal
                    // reasoning and emit empty content; finish_reason='length' confirms it.
                    const reason = choice && choice.finish_reason;
                    if (reason === 'length') {
                        throw new Error('LLM hit the output token limit before producing an answer (raise maxOutputTokens).');
                    }
                    throw new Error(`LLM returned empty content (finish_reason=${reason || 'unknown'}).`);
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
