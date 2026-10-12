import { createAcpSession, createStdioAcpConnector } from '@vibefield/puppeteer-adapter-acp';
import type { AgentAdapterBinding } from '@vibefield/puppeteer-core';
import { grokExtensionEvents } from '../normalization/adapter.js';
import type { CreateGrokSessionOptions } from '../types.js';

/** Open ACP control through the shared leader, optionally loading a session. */
export function openGrokControl(
  executable: string,
  cwd: string,
  socketPath: string,
  sessionId: string | undefined,
  options: Pick<CreateGrokSessionOptions, 'clientCapabilities' | 'onApproval' | 'onElicitation'>,
  env?: NodeJS.ProcessEnv,
): Promise<AgentAdapterBinding> {
  const args = ['agent', '--leader', '--leader-socket', socketPath, 'stdio'];
  return createAcpSession({
    cwd,
    connector: createStdioAcpConnector({ executable, args, cwd, env }),
    ...(sessionId ? { resume: sessionId } : {}),
    clientCapabilities: options.clientCapabilities,
    onApproval: options.onApproval,
    onElicitation: options.onElicitation,
    onExtensionNotification: grokExtensionEvents,
  });
}
