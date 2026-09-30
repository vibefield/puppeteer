import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import body from './body.wgsl.js';
import clearing from './clearing.wgsl.js';
import common from './common.wgsl.js';
import field from './field.wgsl.js';
import glow from './glow.wgsl.js';
import hub from './hub.wgsl.js';
import shadow from './shadow.wgsl.js';
import text from './text.wgsl.js';

// The `.wgsl` files are the authoring copies (an editor highlights them); the
// `.wgsl.ts` twins are what ships, so no bundler needs a text loader. This is
// the drift guard: a shader edited in one place and not the other fails here.
const here = dirname(fileURLToPath(import.meta.url));
const twins: Record<string, string> = { body, clearing, common, field, glow, hub, shadow, text };

describe('the shader string modules', () => {
  for (const [name, source] of Object.entries(twins)) {
    it(`${name}.wgsl.ts is ${name}.wgsl, byte for byte`, () => {
      expect(source).toBe(readFileSync(join(here, `${name}.wgsl`), 'utf8'));
    });
  }
});

describe('the shaders', () => {
  // `smoothstep(hi, lo, x)` is undefined in Metal, and Chrome's and Node's Dawn
  // lower it differently: a falling edge is written `1.0 - smoothstep(lo, hi, x)`.
  it('never write a descending smoothstep', () => {
    const literal = /^-?\d+(\.\d*)?$/;
    for (const [name, source] of Object.entries(twins)) {
      for (const call of source.matchAll(/smoothstep\(([^,()]+),([^,()]+),/g)) {
        const [low, high] = [call[1]!.trim(), call[2]!.trim()];
        if (!literal.test(low) || !literal.test(high)) continue;
        expect(Number(low), `${name}: ${call[0]}`).toBeLessThan(Number(high));
      }
    }
  });

  it('draw the hold ring in its own pass, never in the field under the bodies', () => {
    expect(field).not.toContain('frame.pointer');
    expect(hub).toContain('frame.pointer');
  });
});
