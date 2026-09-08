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
 * Resolves only once a genuine `[DONE]` frame is seen. If the stream closes
 * without one (upstream socket dropped, proxy killed mid-response) this
 * throws `'LLM stream ended unexpectedly'` instead of silently returning a
 * truncated answer as if it were complete. The backend proxy also injects an
 * explicit `data: {"error": "..."}` sentinel frame when *its* upstream fetch
 * breaks mid-stream (see server/routes/llmRoutes.js) — that frame is
 * rethrown here as an `Error` with the sentinel's message.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - The user prompt to send.
 * @param {number} [opts.maxTokens] - Upper bound on generated tokens.
 * @param {number} [opts.temperature] - Sampling temperature.
 * @param {'low'|'medium'|'high'} [opts.reasoningEffort] - Reasoning budget for
 *   reasoning models (gpt-oss). Without it such a model can spend the whole
 *   token budget thinking and return empty content, so callers that want an
 *   answer rather than a deliberation should pass 'low'. Forwarded by the
 *   proxy as the upstream `reasoning_effort` field; omitted when undefined.
 * @param {(token: string, full: string) => void} [opts.onToken] - Called with
 *   each incremental token and the accumulated text so far.
 * @param {AbortSignal} [opts.signal] - Optional abort signal to cancel the request.
 * @returns {Promise<string>} The full accumulated completion text.
 * @throws {Error} If not authenticated, the request fails, the upstream
 *   relays an error frame, or the stream ends without a `[DONE]` frame.
 */
export async function streamLLM({ prompt, maxTokens, temperature, reasoningEffort, onToken, signal }) {
  const accessToken = getAccessToken()
  if (!accessToken) {
    throw new Error('Not authenticated — please sign in again')
  }

  const res = await fetch(`${API_BASE}/llm/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ prompt, maxTokens, temperature, reasoningEffort }),
    signal,
  })
  if (!res.ok) throw new Error(`LLM request failed: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let full = ''
  let buffer = ''
  let done = false
  while (true) {
    const { done: readerDone, value } = await reader.read()
    if (readerDone) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n\n')
    buffer = lines.pop() // keep incomplete frame for the next chunk
    for (const line of lines) {
      const data = line.replace(/^data: /, '').trim()
      if (!data) continue
      if (data === '[DONE]') { done = true; continue }
      try {
        const parsed = JSON.parse(data)
        if (parsed.error) throw new Error(parsed.error)
        const delta = parsed.choices?.[0]?.delta?.content ?? ''
        if (delta) { full += delta; onToken?.(delta, full) }
      } catch (err) {
        if (err instanceof SyntaxError) {
          // Frame is complete (split on the `\n\n` delimiter) but not valid
          // JSON — a genuinely malformed frame, not a partial one (partial
          // frames are held back in `buffer` above and never reach here).
          continue
        }
        throw err // error frame from the proxy, or a non-JSON `parsed.error` throw above
      }
    }
  }
  if (!done) throw new Error('LLM stream ended unexpectedly')
  return full
}
