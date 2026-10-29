import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAgentEnvironment } from '../host/environment.js';
import type { UpdateCommandResult, UpdateCommandRunner } from './update.js';

/**
 * The one way a distribution operation — an update or a first install — runs
 * the vendor's command: in the clean agent environment, unattended, its output
 * kept as an opaque 0600 transcript that nothing parses. Internal to the
 * runtime; `update.ts` and `install.ts` judge the outcome by re-inspection.
 */

/** Vendor updaters and installers download and verify archives; a short timeout would abort healthy runs. */
export const OPERATION_TIMEOUT_MS = 15 * 60_000;
const TRANSCRIPT_DIRECTORY_MODE = 0o700;
const TRANSCRIPT_FILE_MODE = 0o600;

/** The vendor's documented `curl … | bash` (or `| sh`), with the URL as a positional parameter (never spliced
 * into the script), https only, and pipefail so a failed download fails the run. */
const INSTALLER_SCRIPT = {
  bash: 'set -o pipefail; curl --proto =https --tlsv1.2 -fsSL "$1" | bash',
  sh: 'set -o pipefail; curl --proto =https --tlsv1.2 -fsSL "$1" | sh',
} as const;

/** `$0` names the operation in a process listing; `$1` is the script's URL. */
export function installerScriptArgv(
  url: string,
  operation: 'puppeteer-update' | 'puppeteer-install',
  shell: 'bash' | 'sh' = 'bash',
): string[] {
  return ['/bin/bash', '-c', INSTALLER_SCRIPT[shell], operation, url];
}

export function operationEnvironment(options: {
  path: string | undefined;
  /** Variables an installer script itself documents. */
  scriptEnv?: Record<string, string> | undefined;
  /**
   * The person's login shell. A first install is the vendor's whole install, as
   * a person running its command gets it — an installer reads SHELL to choose
   * the rc file it edits — while an update leaves it out.
   */
  shell?: string | undefined;
}): Record<string, string> {
  return {
    ...buildAgentEnvironment({
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(process.env.HOME === undefined ? {} : { home: process.env.HOME }),
    }),
    // Output reaches the observer as it is printed: a Python updater's own lines
    // would otherwise wait in a pipe's buffer until it exits.
    PYTHONUNBUFFERED: '1',
    ...(options.shell === undefined ? {} : { SHELL: options.shell }),
    ...(options.scriptEnv ?? {}),
  };
}

interface TranscriptSink {
  path?: string;
  write(chunk: string): void;
  close(): Promise<void>;
}

async function openTranscript(directory: string, providerId: string): Promise<TranscriptSink> {
  await mkdir(directory, { recursive: true, mode: TRANSCRIPT_DIRECTORY_MODE });
  const path = join(directory, `${providerId}-${Date.now()}-${randomUUID()}.log`);
  // 'ax' fails rather than truncating; the mode applies because the file is new.
  const handle = await open(path, 'ax', TRANSCRIPT_FILE_MODE);
  let chain: Promise<unknown> = Promise.resolve();
  return {
    path,
    write(chunk) {
      chain = chain.then(() => handle.write(chunk)).catch(() => undefined);
    },
    async close() {
      await chain;
      await handle.close().catch(() => undefined);
    },
  };
}

export interface OperationRequest {
  providerId: string;
  argv: string[];
  env: Record<string, string>;
  timeoutMs: number;
  transcriptsDirectory: string;
  run: UpdateCommandRunner;
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string) => void) | undefined;
  report(error: unknown): void;
}

export interface OperationOutcome {
  result: UpdateCommandResult;
  transcriptPath?: string;
}

export async function runOperation(request: OperationRequest): Promise<OperationOutcome> {
  let transcript: TranscriptSink;
  try {
    transcript = await openTranscript(request.transcriptsDirectory, request.providerId);
  } catch (error) {
    // A missing transcript must not block an operation the person asked for.
    request.report(error);
    transcript = { write: () => undefined, close: async () => undefined };
  }

  let result: UpdateCommandResult;
  try {
    result = await request.run({
      argv: request.argv,
      env: request.env,
      cwd: request.env.HOME ?? process.cwd(),
      timeoutMs: request.timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onOutput: (chunk) => {
        transcript.write(chunk);
        if (request.onOutput === undefined) return;
        try {
          request.onOutput(chunk);
        } catch (error) {
          // The person asked for the operation; a host's display failing must not stop it.
          request.report(error);
        }
      },
    });
  } catch (error) {
    request.report(error);
    result = { exitCode: null, error: 'could not be started' };
  } finally {
    await transcript.close();
  }
  return transcript.path === undefined ? { result } : { result, transcriptPath: transcript.path };
}
