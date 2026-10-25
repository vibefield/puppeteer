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
 * refresh) and the hooks (SessionStart `model`, and PostModelSwitch `to_model` as a switch lands,
 * whether or not a status line runs). The gate keeps the root model card last published by either
 * rail and admits only news:
 *
 * - A status-line card is news when it differs from that card, not merely from the status line's
 *   own previous reading: after a hook moved the id, the next refresh restores the display name
 *   and corrects a switch the hooks reported out of order.
 * - A root hook model is news only when it moves the id: republished, a bare id would replace the
 *   status line's fuller card.
 * - PostModelSwitch runs asynchronously (2.1.308 dispatches it from a detached task), so two quick
 *   switches can land out of order. A switch whose `from_model` is not the model currently
 *   reported describes a transition the session already left, and is dropped; the next status-line
 *   refresh reports whatever the hooks missed.
 */
export class ClaudeRootModelGate {
  private reported: AgentModelIdentity | undefined;

  /** Whether a status-line model card is news; an admitted one is the card later reports meet. */
  admitStatusLine(model: AgentModelIdentity): boolean {
    if (sameModelCard(model, this.reported)) return false;
    this.reported = model;
    return true;
  }

  /** Whether a root hook model, normalized from `body`, is news. */
  admitHook(model: AgentModelIdentity, body: ClaudeHookPayload): boolean {
    if (model.id === this.reported?.id) return false;
    const fromModel =
      claudeString(body.hook_event_name) === 'PostModelSwitch' ? nonEmptyClaudeString(body.from_model) : undefined;
    if (fromModel !== undefined && this.reported !== undefined && fromModel !== this.reported.id) return false;
    this.reported = model;
    return true;
  }
}

function sameModelCard(left: AgentModelIdentity, right: AgentModelIdentity | undefined): boolean {
  return (
    right !== undefined &&
    left.id === right.id &&
    left.displayName === right.displayName &&
    left.provider === right.provider
  );
}
