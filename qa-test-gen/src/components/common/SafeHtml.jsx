import { Box } from '@mui/material';
import DOMPurify from 'dompurify';

/**
 * SafeHtml — the ONLY sanctioned way to render HTML that this app did not
 * author itself.
 *
 * **ALL model-authored or third-party HTML must render through this component;
 * never call `dangerouslySetInnerHTML` directly.** LLM output is attacker-
 * reachable in this app (a JIRA story description, an uploaded spec or a
 * scraped page can all carry markup that reaches a prompt and comes back in
 * the completion), so an unsanitized fragment is a stored-XSS sink that runs
 * with the user's Keycloak session in scope.
 *
 * DOMPurify's `html` profile keeps ordinary document markup (headings,
 * paragraphs, lists, tables, inline `style` attributes) and drops the
 * executable surface: `<script>`, event handlers such as `onerror`/`onclick`,
 * `javascript:` URLs and unknown/namespaced elements.
 *
 * Sanitize at RENDER time only. Do not feed the sanitized string to an
 * exporter: converters such as html-docx-js need the full original markup
 * (including `<style>` blocks that DOMPurify's html profile strips) and a
 * generated .docx is not a browser execution context.
 *
 * @param {Object} props
 * @param {string} props.html - Untrusted HTML fragment to render.
 * @param {Object} [props.sx] - MUI `sx` applied to the wrapping Box, so a
 *   caller can style the rendered document (e.g. a light "paper sheet" look).
 */
export default function SafeHtml({ html, sx }) {
    const clean = DOMPurify.sanitize(String(html ?? ''), { USE_PROFILES: { html: true } });
    return <Box sx={sx} dangerouslySetInnerHTML={{ __html: clean }} />;
}
