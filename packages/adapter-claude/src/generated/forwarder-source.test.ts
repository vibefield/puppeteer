/**
 * Freshness gate (the registry.test.ts pattern): forwarder-source.ts must be byte-identical to a fresh transpile of
 * launch/forwarder.ts and its tail. If this fails, run
 * `pnpm --filter @vibefield/puppeteer-adapter-claude generate:forwarder` and commit the result.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAUDE_FORWARDER_SOURCE } from './forwarder-source.js';
import { renderForwarderModule, renderForwarderSource } from '../../scripts/forwarder-render.js';

const forwarderPath = fileURLToPath(new URL('../launch/forwarder.ts', import.meta.url));
const generatedPath = fileURLToPath(new URL('./forwarder-source.ts', import.meta.url));

describe('generated forwarder source', () => {
  it('src/generated/forwarder-source.ts is byte-identical to a fresh transpile of launch/forwarder.ts', () => {
    expect(readFileSync(generatedPath, 'utf8')).toBe(renderForwarderSource(readFileSync(forwarderPath, 'utf8')));
  });

  it('stages one self-contained module that runs its words on its own arguments', () => {
    expect(CLAUDE_FORWARDER_SOURCE).toBe(renderForwarderModule(readFileSync(forwarderPath, 'utf8')));
    // Node's builtins only: a staged file beside the settings has nothing else to import.
    const imports = [...CLAUDE_FORWARDER_SOURCE.matchAll(/^import .* from '([^']+)';$/gmu)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier).toMatch(/^node:/u);
    expect(
      CLAUDE_FORWARDER_SOURCE.trimEnd().endsWith('process.exitCode = await runClaudeForwarder(process.argv.slice(2));'),
    ).toBe(true);
  });
});
