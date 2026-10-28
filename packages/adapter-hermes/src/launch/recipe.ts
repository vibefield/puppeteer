import type { TerminalSpec } from '@vibefield/puppeteer-core';
import { buildHermesTuiArgs, resolveHermesExecutable } from '../detection.js';
import { HERMES_GATEWAY_URL_ENV, HERMES_HOME_ENV } from '../generated/detection.js';
import { authorizedGatewayUrl } from '../transport/gateway-auth.js';

export interface HermesLaunchRecipeOptions {
  executable?: string | undefined;
  cwd: string;
  hermesHome: string;
  gatewayUrl: string;
  /** The gateway's bearer. The TUI dials its URL verbatim, so the token rides a query it already sends. */
  gatewayToken?: string | undefined;
  resume?: string | undefined;
  yolo?: boolean | undefined;
  env?: Record<string, string> | undefined;
}

export function buildHermesAttachLaunch(options: HermesLaunchRecipeOptions): TerminalSpec {
  return {
    command: resolveHermesExecutable(options.executable),
    args: buildHermesTuiArgs({ resume: options.resume, yolo: options.yolo }),
    cwd: options.cwd,
    env: {
      ...(options.env ?? {}),
      [HERMES_HOME_ENV]: options.hermesHome,
      [HERMES_GATEWAY_URL_ENV]: authorizedGatewayUrl(options.gatewayUrl, options.gatewayToken),
    },
  };
}
