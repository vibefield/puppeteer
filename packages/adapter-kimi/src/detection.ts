import { execFile } from 'node:child_process';

export const KIMI_SURFACE_VERSION = '0.34.0';
export const KIMI_EXECUTABLE_ENV = 'PUPPETEER_KIMI_BIN';
export const KIMI_DEFAULT_EXECUTABLE = 'kimi';

export const KIMI_ADAPTER_CAPABILITIES = Object.freeze({
  executionMode: 'native-tui' as const,
  observationLevel: 'native-log' as const,
  durableWireProtocol: '1.5',
  promptConfirmation: 'durable-turn-prompt-echo' as const,
  structuredApprovalControl: false,
  launchScopedHooks: false,
  observesSubagentJournals: true,
});

export interface KimiInstallationDetection {
  executable: string;
  version: string;
  targetVersion: string;
  exactTarget: boolean;
  capabilities: typeof KIMI_ADAPTER_CAPABILITIES;
}

/** Resolve the adapter-owned native executable without leaking provider policy to consumers. */
export function resolveKimiExecutable(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? environment[KIMI_EXECUTABLE_ENV] ?? KIMI_DEFAULT_EXECUTABLE;
}

export function parseKimiVersion(output: string): string | undefined {
  return output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/m)?.[1];
}

export function detectKimiInstallation(
  explicitExecutable?: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<KimiInstallationDetection> {
  const executable = resolveKimiExecutable(explicitExecutable, options.env ?? process.env);
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ['--version'],
      {
        timeout: options.timeoutMs ?? 5_000,
        ...(options.env ? { env: options.env } : {}),
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`failed to execute ${executable} --version: ${error.message}`, { cause: error }));
          return;
        }
        const version = parseKimiVersion(`${stdout}\n${stderr}`);
        if (!version) {
          reject(new Error(`${executable} --version returned no semantic version`));
          return;
        }
        resolve({
          executable,
          version,
          targetVersion: KIMI_SURFACE_VERSION,
          exactTarget: version === KIMI_SURFACE_VERSION,
          capabilities: KIMI_ADAPTER_CAPABILITIES,
        });
      },
    );
  });
}
