import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnHermesStdioGateway } from '../transport/stdio.js';
import type { HermesGatewayTransport } from '../transport/jsonrpc.js';

export interface HermesImposterFixture {
  root: string;
  cwd: string;
  home: string;
  transport: HermesGatewayTransport;
}

/** Drive the real Hermes Imposter persona as a stdio tui_gateway. */
export function createHermesImposterFixture(): HermesImposterFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chopsticks-hermes-adapter-')));
  const cwd = join(root, 'workspace');
  const home = join(root, 'imposter-home');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  const imposter = resolve(dirname(fileURLToPath(import.meta.url)), '../../../imposter/bin/ai.mjs');
  const transport = spawnHermesStdioGateway(
    process.execPath,
    [imposter, '--hermes', 'tui-gateway'],
    {
      CHOPSTICKS_IMPOSTER_HOME: home,
      CHOPSTICKS_IMPOSTER_TOKEN_FILE: join(home, 'absent.token'),
    },
    cwd,
  );
  return { root, cwd, home, transport };
}
