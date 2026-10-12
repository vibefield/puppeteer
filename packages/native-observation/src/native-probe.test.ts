import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeRpc, nativeModelEnvironment, nativeVersion, runNativeCommand } from './native-probe.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(body: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'native-metadata-test-'));
  roots.push(cwd);
  const executable = join(cwd, 'native.mjs');
  await writeFile(executable, body);
  return { executable, cwd, args: [], env: { ...process.env }, timeoutMs: 2_000 };
}

describe('bounded native metadata processes', () => {
  it('extracts a leading v-prefixed CLI version before dates or dependency versions', async () => {
    expect(
      await nativeVersion(await fixture(`console.log('Native Agent v0.21.4 (2026.9.21)\\nDependency: 2.24.0');`)),
    ).toBe('0.21.4');
    expect(await nativeVersion(await fixture(`console.log('GitHub Copilot CLI 1.0.88.');`))).toBe('1.0.88');
  });

  it('reads fragmented header frames using UTF-8 byte lengths', async () => {
    const opts = await fixture(`process.stdin.once('data', () => {
      const body = JSON.stringify({id:1,result:{label:'模型 🌱'}});
      const frame = Buffer.from('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body);
      let n = 0; const timer = setInterval(() => { if(n === frame.length) clearInterval(timer); else process.stdout.write(frame.subarray(n, ++n)); }, 1);
    });`);
    const rpc = createNativeRpc(opts, { framing: 'headers' });
    try {
      expect(await rpc.request('models.list')).toEqual({ label: '模型 🌱' });
    } finally {
      await rpc.close();
    }
  });

  it.each(['not json\\n', 'Content-Length: 999999999\\r\\n\\r\\n'])(
    'rejects malformed native output and closes the process (%s)',
    async (output) => {
      const rpc = createNativeRpc(
        await fixture(
          `process.stdin.on('data', () => process.stdout.write(${JSON.stringify(output.replaceAll('\\n', '\n').replaceAll('\\r', '\r'))}));`,
        ),
        { framing: output.startsWith('Content') ? 'headers' : 'lines' },
      );
      try {
        await expect(rpc.request('models')).rejects.toMatchObject({ code: 'invalid-response' });
      } finally {
        await rpc.close();
      }
    },
  );

  it('times out and reaps a child that ignores SIGTERM', async () => {
    const opts = await fixture(
      `import {writeFileSync} from 'node:fs'; writeFileSync('pid', String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`,
    );
    await expect(runNativeCommand({ ...opts, timeoutMs: 300 })).rejects.toMatchObject({ code: 'timeout' });
    const pid = Number(await readFile(join(opts.cwd, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('cancels in-flight RPC and rejects calls made after it has closed', async () => {
    const opts = await fixture(`process.stdin.on('data',()=>{});`);
    const controller = new AbortController();
    const rpc = createNativeRpc({ ...opts, signal: controller.signal });
    const pending = rpc.request('models');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await rpc.close();
    await expect(rpc.request('models')).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('bounds native output and never embeds diagnostics in errors', async () => {
    await expect(
      runNativeCommand({ ...(await fixture(`process.stdout.write('x'.repeat(1025));`)), maxOutputBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(
      runNativeCommand(await fixture(`process.stderr.write('secret-key: do not publish'); process.exit(1);`)),
    ).rejects.toMatchObject({ code: 'native-error', message: 'Native metadata probe: native-error' });
    await expect(
      runNativeCommand({ ...(await fixture('')), executable: '/missing-native-agent' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('binds a named profile without borrowing host credentials or altering the ambient environment', () => {
    const ambient = {
      PATH: '/bin',
      ROOT: '/host',
      OPENAI_API_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
      SAFE_SETTING: 'value',
    };
    expect(nativeModelEnvironment(ambient, { ROOT: '/account' }, 'ROOT')).toEqual({
      PATH: '/bin',
      ROOT: '/account',
      SAFE_SETTING: 'value',
    });
    expect(nativeModelEnvironment(ambient, {}, 'ROOT')).toEqual({ PATH: '/bin', SAFE_SETTING: 'value' });
    expect(nativeModelEnvironment(ambient)).toEqual(ambient);
    expect(ambient.OPENAI_API_KEY).toBe('secret');
  });
});
