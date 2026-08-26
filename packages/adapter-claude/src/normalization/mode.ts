import { claudePermissionMode } from '../provider-modes.js';
import type { ClaudeHookPayload, NormalizedHook } from './types.js';
import { claudeString } from './wire.js';

/** Deduplicates observed Claude permission modes for the Core mode service. */
export class ClaudeModeNormalizer {
  private permissionMode: string | undefined;

  append(result: NormalizedHook, body: ClaudeHookPayload): void {
    const permissionMode = claudeString(body.permission_mode);
    if (permissionMode === undefined || permissionMode === this.permissionMode) return;
    result.events.push({
      type: 'mode:updated',
      intent: 'observed',
      modeKind: 'provider-permission',
      mode: claudePermissionMode(permissionMode),
    });
    this.permissionMode = permissionMode;
  }

  reset(): void {
    this.permissionMode = undefined;
  }
}
