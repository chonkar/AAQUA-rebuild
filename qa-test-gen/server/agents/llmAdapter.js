import { LocalLLM } from '../utils/llmClient.js';

/**
 * Adapter that provides a clean, unified invocation interface for LangGraph nodes
 * using AAQUA's existing LocalLLM configuration.
 */
export class AaquaAgentLLM {
    constructor(options = {}) {
        const apiKey = options.apiKey || process.env.VITE_LLM_API_KEY;
        const endpoint = options.endpoint || process.env.VITE_LLM_ENDPOINT || 'https://llm.lab.aaseya.com/v1';
        this.modelName = options.model || process.env.VITE_LLM_MODEL || 'gpt-oss-20b';
        this.client = new LocalLLM(apiKey, endpoint);
    }

    async generate(promptText, config = {}) {
        const model = this.client.getGenerativeModel({
            model: this.modelName,
            generationConfig: {
                temperature: config.temperature ?? 0.2,
                maxOutputTokens: config.maxOutputTokens,
                reasoningEffort: config.reasoningEffort || 'low',
            }
        });

        const res = await model.generateContent(promptText);
        return res.response.text();
    }
}
