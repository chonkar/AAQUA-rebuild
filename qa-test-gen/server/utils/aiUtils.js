/**
 * Helper: Robust Retry for 429 errors with exponential backoff and jitter
 */
export async function generateWithRetry(model, prompt, retries = 5, initialDelay = 4000) {
    for (let i = 0; i < retries; i++) {
        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        } catch (err) {
            const isRateLimit = err.message?.includes('429') ||
                (err.status && err.status === 429) ||
                err.message?.toLowerCase().includes('quota') ||
                err.message?.toLowerCase().includes('too many requests');

            if (isRateLimit && i < retries - 1) {
                // Exponential backoff: 4s, 8s, 16s, 32s...
                // Plus jitter: +/- 20% of the delay
                const baseDelay = initialDelay * Math.pow(2, i);
                const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
                const waitTime = Math.max(1000, baseDelay + jitter);

                console.warn(`[AI Rate Limit] Retrying in ${(waitTime / 1000).toFixed(1)}s... (Attempt ${i + 1}/${retries})`);
                await new Promise(r => setTimeout(r, waitTime));
            } else {
                throw err;
            }
        }
    }
    throw new Error(`Max retries exceeded for AI Generation. Quota likely exhausted.`);
}
