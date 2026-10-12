/** Grok-specific capture privacy rules layered on the shared conservative gate. */
import { extendRules } from '@vibefield/puppeteer-surface/sanitize';

export const grokRules = extendRules({
  sensitiveTextKey: /^(?:signature|prompt_text|summary_preview|description)$/i,
});
