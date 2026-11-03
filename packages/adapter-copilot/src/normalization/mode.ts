import type { AgentEvent } from '@vibefield/puppeteer-core';
import { copilotString } from './types.js';

export function normalizeCopilotMode(type: string, data: Record<string, unknown>): AgentEvent[] | undefined {
  if (type === 'session.mode_changed') {
    const raw = copilotString(data.newMode);
    return raw
      ? [{ type: 'mode:updated', intent: 'observed', modeKind: 'provider-session', mode: { raw, normalized: raw } }]
      : [];
  }
  if (type === 'session.permissions_changed') {
    // The 1.0.105 writer schema replaces the allow-all pair with `mode` (manual | assisted | allow-all), yet the
    // 1.0.105 hermetic captures still write the allow-all pair; read the newer field first and keep both.
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
            mode: { raw, normalized: ['on', 'true', 'allow-all'].includes(raw) ? 'auto' : 'manual' },
          },
        ]
      : [];
  }
  return undefined;
}
