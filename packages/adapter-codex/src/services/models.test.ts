import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createCodexModelService } from './models.js';

it.each([false, true])(
  'reads all native pages without a thread and rejects cursor cycles (cycle=%s)',
  async (cycle) => {
    const cwd = await mkdtemp(join(tmpdir(), 'codex-models-'));
    const executable = join(cwd, 'codex.mjs');
    await writeFile(
      executable,
      `import {appendFileSync} from 'node:fs'; import {createInterface} from 'node:readline';
    if (process.argv.includes('--version')) { console.log('codex-cli 0.162.1'); process.exit(0); }
    createInterface({input:process.stdin}).on('line', line => {
      const r=JSON.parse(line); appendFileSync('requests', r.method+'\\n');
      if(!['initialize','initialized','model/list'].includes(r.method)) process.exit(9);
      if(r.id===undefined) return;
      const second=!!r.params?.cursor;
      const result=r.method==='initialize'?{}:{data:[{id:second?'b':'a',model:second?'model-b':'model-a',displayName:second?'B':'A',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:${cycle}?'next':second?null:'next'};
      console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
    });`,
    );
    try {
      const result = await createCodexModelService({ executable }).discover({ cwd });
      if (cycle) expect(result).toMatchObject({ status: 'error', code: 'invalid-response' });
      else
        expect(result).toMatchObject({
          status: 'available',
          catalog: { models: [{ id: 'model-a' }, { id: 'model-b' }] },
        });
      expect((await readFile(join(cwd, 'requests'), 'utf8')).trim().split('\n')).toEqual([
        'initialize',
        'initialized',
        'model/list',
        'model/list',
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
