#!/usr/bin/env node
/**
 * Write the adapter detection projection from the Hermes candidate ASM.
 * First-vendor: read the model path directly until a ledger entry exists.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const adapterRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const detection = JSON.parse(
  readFileSync(
    join(adapterRoot, '../surface/vendors/hermes/model/hermes@0.20.0/detection.json'),
    'utf8',
  ),
);

const flags = detection.launchFlags ?? {};
const source = `/**
 * Checked runtime projection of
 * Surface \`vendors/hermes/model/hermes@0.20.0/detection.json\`.
 * Production code consumes this file; it never imports the ASM.
 */

export const HERMES_SURFACE_VERSION = '0.20.0';
export const HERMES_RELEASE_TAG = '2026.8.3';
export const HERMES_DEFAULT_EXECUTABLE = ${JSON.stringify(detection.executables?.[0] ?? 'hermes')};
export const HERMES_EXECUTABLE_ENV = ${JSON.stringify(detection.envVar ?? 'PUPPETEER_HERMES_BIN')};
export const HERMES_HOME_ENV = ${JSON.stringify(detection.isolatedHomeEnv ?? 'HERMES_HOME')};
export const HERMES_PYTHON_ENV = 'HERMES_PYTHON';
export const HERMES_GATEWAY_URL_ENV = 'HERMES_TUI_GATEWAY_URL';
export const HERMES_VERSION_FLAG = ${JSON.stringify(detection.versionFlag ?? '--version')};
export const HERMES_VERSION_PATTERN = /${String(detection.versionPattern ?? '').slice(1, -1)}/;

export const HERMES_LAUNCH_FLAGS = {
  tui: ${JSON.stringify(flags.tui ?? '--tui')},
  cli: ${JSON.stringify(flags.cli ?? '--cli')},
  resume: ${JSON.stringify(flags.resume ?? '--resume')},
  continue: ${JSON.stringify(flags.continue ?? '--continue')},
  worktree: ${JSON.stringify(flags.worktree ?? '--worktree')},
  yolo: ${JSON.stringify(flags.yolo ?? '--yolo')},
  ignoreUserConfig: ${JSON.stringify(flags.ignoreUserConfig ?? '--ignore-user-config')},
  ignoreRules: ${JSON.stringify(flags.ignoreRules ?? '--ignore-rules')},
  safeMode: ${JSON.stringify(flags.safeMode ?? '--safe-mode')},
  acp: ${JSON.stringify(flags.acp ?? 'acp')},
} as const;
`;

const target = join(adapterRoot, 'src/generated/detection.ts');
writeFileSync(target, source);
console.log(`generated ${target}`);
