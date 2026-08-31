import type { AgentEvent } from '@vibecook/puppeteer-core';
import { copilotString } from './types.js';

export function normalizeCopilotMode(type: string, data: Record<string, unknown>): AgentEvent[] | undefined {
  if (type === 'session.mode_changed') {
    const raw = copilotString(data.newMode);
    return raw
      ? [{ type: 'mode:updated', intent: 'observed', modeKind: 'provider-session', mode: { raw, normalized: raw } }]
      : [];
  }
  if (type === 'session.permissions_changed') {
    const raw =
      copilotString(data.allowAllPermissionMode) ??
      (data.allowAllPermissions === true ? 'on' : data.allowAllPermissions === false ? 'off' : undefined);
    return raw
      ? [
          {
            type: 'mode:updated',
            intent: 'observed',
            modeKind: 'provider-permission',
            mode: { raw, normalized: ['on', 'true'].includes(raw) ? 'auto' : 'manual' },
          },
        ]
      : [];
  }
  return undefined;
}
