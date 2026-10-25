import { createAcpSession, createStdioAcpConnector } from '@vibefield/puppeteer-adapter-acp';
import type { AgentAdapterBinding } from '@vibefield/puppeteer-core';
import { grokExtensionEvents } from '../normalization/adapter.js';
import { grokDeferredApprovalEvidence } from '../normalization/interaction.js';
import type { CreateGrokSessionOptions } from '../types.js';

/**
 * Whether the native viewer joins the controller's leader session.
 *
 * Grok 1.0.70's leader routes a permission request to every attached client and
 * takes the first answer, and its viewer renders the request for the person.
 * With a viewer attached and no host handler, the controller therefore stays
 * silent and lets the person answer in Grok's TUI; an immediate deny would
 * pre-empt them (and, since 1.0.70 also asks before spawn_subagent, refuse every
 * managed subagent). Without a viewer nobody else can answer, so the controller
 * keeps adapter-acp's immediate deny rather than hang the turn.
 */
export interface GrokControlComposition {
  viewer: 'attached' | 'none';
}

/** Open ACP control through the shared leader, optionally loading a session. */
export function openGrokControl(
  executable: string,
  cwd: string,
  socketPath: string,
  sessionId: string | undefined,
  options: Pick<CreateGrokSessionOptions, 'clientCapabilities' | 'onApproval' | 'onElicitation'>,
  env?: NodeJS.ProcessEnv,
  composition: GrokControlComposition = { viewer: 'none' },
): Promise<AgentAdapterBinding> {
  const args = ['agent', '--leader', '--leader-socket', socketPath, 'stdio'];
  return createAcpSession({
    cwd,
    connector: createStdioAcpConnector({ executable, args, cwd, env }),
    ...(sessionId ? { resume: sessionId } : {}),
    clientCapabilities: options.clientCapabilities,
    onApproval: options.onApproval,
    unhandledApproval: composition.viewer === 'attached' ? 'defer' : 'deny',
    deferredApprovalEvidence: grokDeferredApprovalEvidence,
    onElicitation: options.onElicitation,
    onExtensionNotification: grokExtensionEvents,
  });
}
