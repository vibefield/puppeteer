#!/usr/bin/env node
/** Embed tui-gateway-host.py in the adapter's code, so a host that bundles the adapter still has the script. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const adapterRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = readFileSync(join(adapterRoot, 'scripts/tui-gateway-host.py'), 'utf8');
const literal = script.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const target = join(adapterRoot, 'src/generated/tui-gateway-host.ts');
writeFileSync(
  target,
  `/** Generated from scripts/tui-gateway-host.py by scripts/generate-gateway-host-source.mjs. Edit the script. */
export const TUI_GATEWAY_HOST_SOURCE = \`${literal}\`;
`,
);
console.log(`generated ${target}`);
