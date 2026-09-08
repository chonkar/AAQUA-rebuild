import { streamLLM } from '../utils/llmStream.js';

// Kept in sync with the values the (now removed) browser-side LocalLLM client
// used for this tool. The old call site passed only
// `generationConfig: { reasoningEffort: 'low' }`, so max_tokens/temperature
// fell through to src/utils/llmClient.js's own defaults of 12000 / 0.2 — the
// streaming proxy is handed the same budget rather than falling back to its
// defaults. `reasoning_effort: 'low'` matters just as much: gpt-oss is a
// reasoning model and without the cap it can spend the entire budget on
// internal reasoning and return empty content (finish_reason='length').
const MAX_TOKENS = 12000;
const TEMPERATURE = 0.2;
const REASONING_EFFORT = 'low';

/**
 * The ISTQB section list the prompt demands, verbatim. Exported so the page
 * can tell the reviewer what the document is supposed to contain without
 * duplicating the list.
 */
export const TEST_PLAN_SECTIONS = [
    '1. Introduction',
    '2. Test Strategy',
    '3. Test Environment',
    '4. Resourcing',
    '5. Schedule',
    '6. Risks and Mitigation',
    '7. Entry/Exit Criteria',
    '8. Deliverables',
];

/**
 * Build the Test Plan prompt. Unchanged from the pre-streaming version — the
 * same eight mandated sections, the same "HTML fragment, no <html>/<head>/
 * <body>" contract that the DOCX exporter relies on when it wraps the result
 * in its own document shell.
 */
export function buildTestPlanPrompt(clientName, projectName, requirement) {
    return `
      You are a Senior QA Manager creating a formal Test Plan document following ISTQB standards.
      
      **Client**: ${clientName}
      **Project**: ${projectName}
      **Requirement**: "${requirement}"

      Generate a professional Test Plan in **HTML format** (using <h2>, <h3>, <p>, <ul>, <li>, <table> tags).
      Do NOT include <html>, <head>, or <body> tags, just the content div.
      
      The Test Plan MUST include these sections:
      1.  **1. Introduction** (Scope, Objectives, References)
      2.  **2. Test Strategy** (Test Levels, Test Types, Tools)
      3.  **3. Test Environment** (Hardware, Software, Data)
      4.  **4. Resourcing** (Roles & Responsibilities)
      5.  **5. Schedule** (Key Milestones)
      6.  **6. Risks and Mitigation**
      7.  **7. Entry/Exit Criteria**
      8.  **8. Deliverables**

      Style the HTML with inline CSS for a professional "Document" look (e.g., font-family: Calibri, sans-serif; headers in dark blue).
      Make the content realistic based on the requirement provided.
    `;
}

/**
 * Strip the markdown fences a chat model likes to wrap HTML in, leaving the
 * bare fragment the preview and the DOCX exporter both consume.
 */
export function extractPlanHtml(text) {
    return String(text ?? '')
        .replace(/```html/gi, '')
        .replace(/```/g, '')
        .trim();
}

/**
 * Generate an ISTQB-shaped Test Plan as an HTML fragment, streamed through the
 * backend LLM proxy (`POST /api/llm/generate` via streamLLM) — the browser no
 * longer holds an LLM API key nor talks to the gateway directly.
 *
 * A test plan is one long-form document rather than a batch of records, so
 * there is a single stream and `onToken` receives the accumulated HTML as it
 * arrives; parsing (fence stripping) still runs once on the full text.
 *
 * @param {Object} opts
 * @param {string} opts.clientName
 * @param {string} opts.projectName
 * @param {string} opts.requirement - Project scope / requirements narrative.
 * @param {(token: string, full: string) => void} [opts.onToken] - Called with
 *   each incremental token and the accumulated text so far.
 * @param {AbortSignal} [opts.signal] - Cancels the in-flight request.
 * @returns {Promise<string>} The Test Plan as an HTML fragment.
 */
export const generateTestPlan = async ({
    clientName,
    projectName,
    requirement,
    onToken,
    signal,
} = {}) => {
    if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }

    try {
        const text = await streamLLM({
            prompt: buildTestPlanPrompt(clientName, projectName, requirement),
            maxTokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            reasoningEffort: REASONING_EFFORT,
            onToken,
            signal,
        });

        const html = extractPlanHtml(text);
        // The old LocalLLM client threw on empty/blank content (a reasoning
        // model that burns its budget thinking returns a completion with no
        // text); streamLLM legitimately resolves with '' in that case, so the
        // guard has to live here or the page would render a blank "document".
        if (!html) {
            throw new Error('The AI returned an empty test plan. Try a shorter requirement, then generate again.');
        }
        return html;
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.error('Test Plan Generation Error:', error);
        throw new Error(error.message || 'Failed to generate test plan');
    }
};
