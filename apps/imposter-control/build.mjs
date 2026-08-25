#!/usr/bin/env node

import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const requireFromControl = createRequire(import.meta.url);
const reactSingletonPlugin = {
  name: 'imposter-control-react-singleton',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({
      path: requireFromControl.resolve(args.path),
    }));
  },
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await Promise.all([
  build({
    bundle: true,
    sourcemap: true,
    logLevel: 'info',
    entryPoints: [join(root, 'src/main/main.ts')],
    outfile: join(dist, 'main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', '@parcel/watcher'],
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(dist, 'main.cjs')).href) },
  }),
  build({
    bundle: true,
    sourcemap: 'external',
    logLevel: 'info',
    entryPoints: [join(root, 'src/renderer/main.tsx')],
    outdir: join(dist, 'assets'),
    entryNames: 'renderer',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    plugins: [reactSingletonPlugin],
    footer: {
      js: '//# sourceMappingURL=/assets/renderer.js.map?token={ASSET_TOKEN}',
      css: '/*# sourceMappingURL=/assets/renderer.css.map?token={ASSET_TOKEN} */',
    },
  }),
]);

await cp(join(root, 'src/renderer/index.html'), join(dist, 'index.html'));
