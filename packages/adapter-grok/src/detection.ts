import { execFile } from 'node:child_process';

export const GROK_SURFACE_VERSION = '1.0.70';
export const GROK_SURFACE_REVISION = 'f50904eaee6c';
export const GROK_SURFACE_CHANNEL = 'stable';
export const GROK_EXECUTABLE_ENV = 'PUPPETEER_GROK_BIN';
export const GROK_DEFAULT_EXECUTABLE = 'grok';
export const GROK_VERSION_FLAG = '--version';
// A clean GROK_HOME omits the configured release-channel suffix even though
// the same executable still reports its immutable version and revision.
export const GROK_VERSION_PATTERN = /^grok (\d+\.\d+\.\d+) \(([0-9a-f]+)\)(?: \[(stable|alpha)\])?$/;

export const GROK_ADAPTER_CAPABILITIES = Object.freeze({
  executionMode: 'native-tui' as const,
  observationLevel: 'native-log' as const,
  controlProtocol: 'acp' as const,
  durableWire: 'updates.jsonl' as const,
  sharedLeader: true,
});

export interface GrokInstallationDetection {
  executable: string;
  version: string;
  revision: string;
  channel?: string;
  targetVersion: string;
  exactTarget: boolean;
  capabilities: typeof GROK_ADAPTER_CAPABILITIES;
}

/** Resolve Grok's native executable inside the adapter boundary. */
export function resolveGrokExecutable(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? environment[GROK_EXECUTABLE_ENV] ?? GROK_DEFAULT_EXECUTABLE;
}

export function parseGrokVersion(
  output: string,
): Pick<GrokInstallationDetection, 'version' | 'revision' | 'channel'> | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(GROK_VERSION_PATTERN);
    if (match?.[1] && match[2]) {
      return { version: match[1], revision: match[2], ...(match[3] ? { channel: match[3] } : {}) };
    }
  }
  return undefined;
}

export function detectGrokInstallation(
  explicitExecutable?: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<GrokInstallationDetection> {
  const executable = resolveGrokExecutable(explicitExecutable, options.env ?? process.env);
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [GROK_VERSION_FLAG],
      {
        timeout: options.timeoutMs ?? 10_000,
        ...(options.env ? { env: options.env } : {}),
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`failed to execute ${executable} ${GROK_VERSION_FLAG}: ${error.message}`, { cause: error }));
          return;
        }
        const parsed = parseGrokVersion(`${stdout}\n${stderr}`);
        if (!parsed) {
          reject(new Error(`${executable} ${GROK_VERSION_FLAG} returned an unrecognized version string`));
          return;
        }
        resolve({
          executable,
          ...parsed,
          targetVersion: GROK_SURFACE_VERSION,
          exactTarget:
            parsed.version === GROK_SURFACE_VERSION &&
            parsed.revision === GROK_SURFACE_REVISION &&
            (parsed.channel === undefined || parsed.channel === GROK_SURFACE_CHANNEL),
          capabilities: GROK_ADAPTER_CAPABILITIES,
        });
      },
    );
  });
}
