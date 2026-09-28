import { execFile } from 'node:child_process';

/** Runs `ps` with these arguments and answers what it printed; a failure rejects. Injected by tests. */
export type RunPs = (args: readonly string[]) => Promise<string>;

/**
 * `ps` in the C locale, whose dates are the one format `Date.parse` reads.
 * The environment is the caller's: a shim passes a PATH without its own
 * directory, so no launcher is ever taken for `ps`.
 */
export function runPs(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      [...args],
      { env: { ...environment, LC_ALL: 'C' }, timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * A `ps -o lstart=` date (second resolution, local time) as an ISO instant,
 * or `undefined`. `ps` and `Date.parse` read the same TZ in one process, so a
 * host and a shim with different TZ values still agree on the instant.
 *
 * This is `processStartedAt`'s reading, and must stay it: a host lists its
 * shells with that function and the shim finds them with this one. It is a
 * copy because process-watch.ts keeps no relative import (a test loads it
 * alone under type stripping); terminals.test.ts's real-`ps` row holds the
 * two to the same answer.
 */
export function startedAtFromPs(text: string): string | undefined {
  const started = text ? Date.parse(text) : Number.NaN;
  return Number.isNaN(started) ? undefined : new Date(started).toISOString();
}
