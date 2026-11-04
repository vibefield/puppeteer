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

test('Windows inventory excludes declared generated launchers but retains package and unrelated executable bytes', (context) => {
  const source = `
import importlib.util, pathlib, tempfile
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('console_tool', ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory).resolve()
    hashes = []
    for name in ['short', 'a-longer-independent-build-root']:
        prefix = root / name
        scripts = prefix / 'Scripts'
        site = prefix / 'Lib' / 'site-packages'
        scripts.mkdir(parents=True)
        site.mkdir(parents=True)
        (scripts / 'fake.exe').write_text('generated launcher ZIP offsets: ' + name)
        (scripts / 'unrelated.exe').write_text('vendor executable')
        (site / 'package.py').write_text('exact package code')
        distribution = SimpleNamespace(
            metadata={'Name': 'fake'},
            files=['Scripts/fake.exe', 'Scripts/unrelated.exe', 'Lib/site-packages/package.py'],
            locate_file=lambda path: prefix / path,
            entry_points=[SimpleNamespace(group='console_scripts', name='fake')],
        )
        excluded = m.generated_console_launchers(distribution, scripts, True)
        count, digest = m.stable_distribution_files(distribution, [prefix, site], [prefix], excluded)
        assert count == 2
        hashes.append(digest)
    assert hashes[0] == hashes[1]
    (scripts / 'unrelated.exe').write_text('changed vendor executable')
    assert m.stable_distribution_files(distribution, [prefix, site], [prefix], excluded)[1] != hashes[1]
    (scripts / 'unrelated.exe').write_text('vendor executable')
    (site / 'package.py').write_text('changed package code')
    assert m.stable_distribution_files(distribution, [prefix, site], [prefix], excluded)[1] != hashes[1]
    distribution.entry_points = [SimpleNamespace(group='console_scripts', name='../outside')]
    try:
        m.generated_console_launchers(distribution, scripts, True)
    except ValueError:
        pass
    else:
        raise AssertionError('unsafe entry-point name accepted')
print('declared launcher isolation verified')
`;
  const result = spawnSync(python, ['-c', source], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    context.skip(`${python} is unavailable`);
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /declared launcher isolation verified/);
});
