import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const helper = resolve(root, 'scripts', 'lib', 'python-console-tool.py');
const python = process.platform === 'win32' ? 'python' : 'python3';

function normalizedHash(path, attestedRoot) {
  const source = [
    'import importlib.util',
    'import pathlib',
    'import sys',
    'spec = importlib.util.spec_from_file_location("python_console_tool", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'print(module.normalized_file_sha256(pathlib.Path(sys.argv[2]), [pathlib.Path(sys.argv[3])]))',
  ].join(';');
  return spawnSync(python, ['-c', source, helper, path, attestedRoot], { encoding: 'utf8' });
}

test('normalized installed-file hashes are independent of attested root length and chunk boundaries', (context) => {
  const fixture = mkdtempSync(join(tmpdir(), 'puppeteer-python-console-'));
  const roots = [join(fixture, 'a'), join(fixture, 'a-much-longer-environment-root')];
  const files = roots.map((attestedRoot, index) => {
    mkdirSync(attestedRoot, { recursive: true });
    const path = join(fixture, `content-${index}.bin`);
    const utf8 = Buffer.from(attestedRoot);
    const utf16 = Buffer.from(attestedRoot, 'utf16le');
    writeFileSync(
      path,
      Buffer.concat([Buffer.alloc(1024 * 1024 - 3, 120), utf8, Buffer.from('|'), utf16, Buffer.from('|stable')]),
    );
    return { path, attestedRoot };
  });
  const results = files.map(({ path, attestedRoot }) => normalizedHash(path, attestedRoot));
  if (results.some((result) => result.error?.code === 'ENOENT')) {
    context.skip(`${python} is unavailable`);
    return;
  }
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(results[0].stdout.trim(), results[1].stdout.trim());
  assert.match(results[0].stdout.trim(), /^sha256:[0-9a-f]{64}$/);
});
