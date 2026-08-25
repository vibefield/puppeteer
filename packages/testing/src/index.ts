/**
 * @vibecook/chopsticks-testing — vendor-neutral harness pieces for runtime and
 * adapter tests.
 *
 * - `fakeAgentBin`: a spawnable fixture TUI (DESIGN §26.1); see bin/fake-agent.mjs
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path to the fake agent executable; spawn with process.execPath. */
export const fakeAgentBin = join(packageRoot, 'bin', 'fake-agent.mjs');
