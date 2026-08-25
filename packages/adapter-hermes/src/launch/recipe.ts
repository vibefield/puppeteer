import type { TerminalSpec } from '@vibecook/puppeteer-core';
import { buildHermesTuiArgs, resolveHermesExecutable } from '../detection.js';
import { HERMES_GATEWAY_URL_ENV, HERMES_HOME_ENV } from '../generated/detection.js';

export interface HermesLaunchRecipeOptions {
  executable?: string;
  cwd: string;
  hermesHome: string;
  gatewayUrl: string;
  resume?: string;
  yolo?: boolean;
  env?: Record<string, string>;
}

export function buildHermesAttachLaunch(options: HermesLaunchRecipeOptions): TerminalSpec {
  return {
    command: resolveHermesExecutable(options.executable),
    args: buildHermesTuiArgs({ resume: options.resume, yolo: options.yolo }),
    cwd: options.cwd,
    env: {
      ...(options.env ?? {}),
      [HERMES_HOME_ENV]: options.hermesHome,
      [HERMES_GATEWAY_URL_ENV]: options.gatewayUrl,
    },
  };
}
