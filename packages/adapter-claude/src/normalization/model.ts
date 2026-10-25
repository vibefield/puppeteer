import type { AgentModelIdentity, ModelEvent } from '@vibefield/puppeteer-core';
import type { ClaudeHookPayload } from './types.js';
import { claudeString, nonEmptyClaudeString } from './wire.js';

/** Claude session model evidence -> Core model service. */
export function normalizeClaudeSessionModel(body: ClaudeHookPayload): ModelEvent | undefined {
  const model = claudeString(body.model);
  return model ? { type: 'model:updated', model: { id: model, provider: 'anthropic' } } : undefined;
}

/**
 * PostModelSwitch `to_model`: the model now serving the session after a requested switch, an
 * automatic fallback, an opusplan transition, or the model a resume restored. The switch has
 * landed; the cancellable request before it stays native.
 */
export function normalizeClaudeModelSwitched(body: ClaudeHookPayload): ModelEvent | undefined {
  const model = nonEmptyClaudeString(body.to_model);
  return model ? { type: 'model:updated', intent: 'observed', model: { id: model, provider: 'anthropic' } } : undefined;
}

/**
 * The root model has two native rails: the status line (`model.id` with its display name, at each
 * refresh, published whenever its own reading changes) and the hooks (SessionStart `model`, and
 * PostModelSwitch `to_model` as a switch lands, whether or not a status line runs). A hook that
 * repeats the id already reported is not news: republished, its bare id would replace the status
 * line's fuller card. So a root hook model is published only when it moves the id.
 */
export class ClaudeRootModelGate {
  private reportedId: string | undefined;

  /** Record the root model the status line just published. */
  observeStatusLine(model: AgentModelIdentity): void {
    this.reportedId = model.id;
  }

  /** Whether a root hook model is news; an admitted one is the id later reports are compared with. */
  admitHook(model: AgentModelIdentity): boolean {
    if (model.id === this.reportedId) return false;
    this.reportedId = model.id;
    return true;
  }
}
