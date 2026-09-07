/**
 * Frontend helper for the backend LLM streaming proxy (`POST /api/llm/generate`).
 *
 * The browser no longer talks to the LLM gateway directly — it POSTs a prompt
 * to our own backend, which relays the upstream OpenAI-compatible SSE stream
 * back verbatim. A POST body rules out the native `EventSource` API (it only
 * supports GET), so this reads the response body as a stream via `fetch`
 * and parses the `data: ...` frames itself.
 */
import { getAccessToken, API_BASE } from './apiClient.js'

/**
 * Stream an LLM completion for `prompt`, invoking `onToken` as each token
 * chunk arrives.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - The user prompt to send.
 * @param {number} [opts.maxTokens] - Upper bound on generated tokens.
 * @param {number} [opts.temperature] - Sampling temperature.
 * @param {(token: string, full: string) => void} [opts.onToken] - Called with
 *   each incremental token and the accumulated text so far.
 * @param {AbortSignal} [opts.signal] - Optional abort signal to cancel the request.
 * @returns {Promise<string>} The full accumulated completion text.
 */
export async function streamLLM({ prompt, maxTokens, temperature, onToken, signal }) {
  const token = getAccessToken()
  if (!token) {
    throw new Error('Not authenticated — please sign in again')
  }

  const res = await fetch(`${API_BASE}/llm/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt, maxTokens, temperature }),
    signal,
  })
  if (!res.ok) throw new Error(`LLM request failed: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let full = ''
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n\n')
    buffer = lines.pop() // keep incomplete frame for the next chunk
    for (const line of lines) {
      const data = line.replace(/^data: /, '').trim()
      if (!data || data === '[DONE]') continue
      try {
        const token = JSON.parse(data).choices?.[0]?.delta?.content ?? ''
        if (token) { full += token; onToken?.(token, full) }
      } catch {
        // Partial/malformed frame — ignored, next chunk may complete it.
      }
    }
  }
  return full
}
