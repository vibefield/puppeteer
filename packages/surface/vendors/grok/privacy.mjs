/** Grok-specific capture privacy rules layered on the shared conservative gate. */
import { extendRules } from '@vibecook/chopsticks-surface/sanitize';

export const grokRules = extendRules({
  sensitiveTextKey: /^(?:signature|prompt_text|summary_preview|description)$/i,
});
