import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { materializeNodeRuntimeBundle } from './lib/materialize-runtime-bundle.mjs';

const policy = {
  strategy: 'node-npm-lock-bundle',
  nodeVersion: '22.22.0',
  npmVersion: '10.9.4',
  packageFile: 'package.json',
  lockFile: 'package-lock.json',
  workspace: 'ui-tui',
  workspacePackageFile: 'ui-tui/package.json',
  buildFile: 'ui-tui/scripts/build.mjs',
  outputFile: 'ui-tui/dist/entry.js',
  environmentVariable: 'HERMES_TUI_DIR',
  maxBytes: 1_024,
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'puppeteer-materialize-runtime-'));
  const projectRoot = join(root, 'project');
  const artifactRoot = join(root, 'artifact');
  mkdirSync(join(projectRoot, 'ui-tui', 'scripts'), { recursive: true });
  writeFileSync(join(projectRoot, 'package.json'), '{"workspaces":["ui-tui"]}\n');
  writeFileSync(join(projectRoot, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(projectRoot, 'ui-tui', 'package.json'), '{"name":"fake-tui"}\n');
  writeFileSync(join(projectRoot, 'ui-tui', 'scripts', 'build.mjs'), '// reviewed build\n');
  return { root, projectRoot, artifactRoot };
}

function runner(projectRoot, calls, { mutate = false } = {}) {
  return (_command, args, options) => {
    calls.push({ args, label: options.label });
    if (options.label === 'Node identity probe') return 'v22.22.0\n';
    if (options.label === 'npm identity probe') return '10.9.4\n';
    if (options.label === 'Node executable probe') return `${process.execPath}\n`;
    if (options.label === 'locked npm workspace install') return '';
    if (options.label === 'reviewed runtime bundle build') {
      mkdirSync(join(projectRoot, 'ui-tui', 'dist'), { recursive: true });
      writeFileSync(join(projectRoot, 'ui-tui', 'dist', 'entry.js'), 'export const bundled = true;\n');
      if (mutate) writeFileSync(join(projectRoot, 'package.json'), '{"mutated":true}\n');
      return '';
    }
    throw new Error(`unexpected command ${options.label}`);
  };
}

test('runtime materialization uses a locked script-free install and emits only the reviewed bundle', () => {
  const { projectRoot, artifactRoot } = fixture();
  const calls = [];
  const manifest = materializeNodeRuntimeBundle({
    projectRoot,
    artifactRoot,
    policy,
    node: 'node',
    npm: 'npm',
    environment: { PATH: process.env.PATH },
    run: runner(projectRoot, calls),
  });

  const install = calls.find((call) => call.label === 'locked npm workspace install');
  assert.deepEqual(install.args.slice(0, 3), ['ci', '--workspace', 'ui-tui']);
  assert.ok(install.args.includes('--ignore-scripts'));
  assert.equal(manifest.materialization.lifecycleScripts, false);
  assert.equal(manifest.artifact.entry, 'runtime/dist/entry.js');
  assert.equal(
    readFileSync(join(artifactRoot, 'runtime', 'dist', 'entry.js'), 'utf8'),
    'export const bundled = true;\n',
  );
});

test('runtime materialization rejects build scripts that change reviewed source', () => {
  const { projectRoot, artifactRoot } = fixture();
  assert.throws(
    () =>
      materializeNodeRuntimeBundle({
        projectRoot,
        artifactRoot,
        policy,
        node: 'node',
        npm: 'npm',
        environment: { PATH: process.env.PATH },
        run: runner(projectRoot, [], { mutate: true }),
      }),
    /changed reviewed source file package\.json/,
  );
});
