import type { AgentEvent, AgentProviderMode } from '@vibefield/puppeteer-core';
import { copilotString } from './types.js';

/**
 * Labels for the permission values Copilot is known to write. `on`/`off` are the allow-all pair's
 * `allowAllPermissionMode` (and the derived boolean). `manual | assisted | allow-all` is the `PermissionMode` enum of
 * the 1.0.105 npm package's `schemas/session-events.schema.json` for `session.permissions_changed.mode`; Rosetta's
 * derived writer document keeps that field as a plain string, and no committed capture writes it yet. `assisted`
 * (the LLM safety judge, the /permissions mode `--assisted-approval` selects) is neither manual nor auto, so it keeps
 * its own label. Any other value of this open string keeps only its raw form.
 */
const COPILOT_PERMISSION_LABELS: Readonly<Record<string, string>> = {
  on: 'auto',
  true: 'auto',
  'allow-all': 'auto',
  off: 'manual',
  false: 'manual',
  manual: 'manual',
  assisted: 'assisted',
};

function copilotPermissionMode(raw: string): AgentProviderMode {
  const normalized = COPILOT_PERMISSION_LABELS[raw];
  return { raw, ...(normalized ? { normalized } : {}) };
}

export function normalizeCopilotMode(type: string, data: Record<string, unknown>): AgentEvent[] | undefined {
  if (type === 'session.mode_changed') {
    const raw = copilotString(data.newMode);
    return raw
      ? [{ type: 'mode:updated', intent: 'observed', modeKind: 'provider-session', mode: { raw, normalized: raw } }]
      : [];
  }
  if (type === 'session.permissions_changed') {
    // The 1.0.105 writer schema replaces the allow-all pair with `mode`/`previousMode`, yet the 1.0.105 hermetic
    // captures still write only the allow-all pair; read the newer field first and keep both.
    const raw =
      copilotString(data.mode) ??
      copilotString(data.allowAllPermissionMode) ??
      (data.allowAllPermissions === true ? 'on' : data.allowAllPermissions === false ? 'off' : undefined);
    return raw
      ? [
          {
            type: 'mode:updated',
            intent: 'observed',
            modeKind: 'provider-permission',
            mode: copilotPermissionMode(raw),
          },
        ]
      : [];
  }
  return undefined;
}
