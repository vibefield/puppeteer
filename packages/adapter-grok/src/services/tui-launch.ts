import type { CreateGrokSessionOptions } from '../types.js';

/** Build the native TUI invocation for a new or resumed leader-owned session. */
export function buildGrokTuiArgs(
  socketPath: string,
  sessionId: string,
  options: Pick<CreateGrokSessionOptions, 'resume' | 'model' | 'permissionMode' | 'sandbox'>,
): string[] {
  const args: string[] = [];
  if (options.model !== undefined) args.push('--model', options.model);
  if (options.permissionMode !== undefined) args.push('--permission-mode', options.permissionMode);
  if (options.sandbox !== undefined) args.push('--sandbox', options.sandbox);
  args.push('--leader', '--leader-socket', socketPath);
  args.push(options.resume ? '--resume' : '--session-id', sessionId);
  return args;
}
