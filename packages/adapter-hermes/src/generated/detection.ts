/**
 * Checked runtime projection of
 * Surface `vendors/hermes/model/hermes@0.20.0/detection.json`.
 * Production code consumes this file; it never imports the ASM.
 */

export const HERMES_SURFACE_VERSION = '0.20.0';
export const HERMES_RELEASE_TAG = '2026.8.3';
export const HERMES_DEFAULT_EXECUTABLE = 'hermes';
export const HERMES_EXECUTABLE_ENV = 'CHOPSTICKS_HERMES_BIN';
export const HERMES_HOME_ENV = 'HERMES_HOME';
export const HERMES_PYTHON_ENV = 'HERMES_PYTHON';
export const HERMES_GATEWAY_URL_ENV = 'HERMES_TUI_GATEWAY_URL';
export const HERMES_VERSION_FLAG = '--version';
export const HERMES_VERSION_PATTERN = /^Hermes Agent v(\d+\.\d+\.\d+) \((\d{4}\.\d{1,2}\.\d{1,2})\)$/;

export const HERMES_LAUNCH_FLAGS = {
  tui: '--tui',
  cli: '--cli',
  resume: '--resume',
  continue: '--continue',
  worktree: '--worktree',
  yolo: '--yolo',
  ignoreUserConfig: '--ignore-user-config',
  ignoreRules: '--ignore-rules',
  safeMode: '--safe-mode',
  acp: 'acp',
} as const;
