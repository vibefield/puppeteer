import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHADER_CLOCK_PERIOD_S } from '../src/views/swarm/gpu/frame-layout.js';
import body from '../src/views/swarm/gpu/shaders/body.wgsl.js';
import common from '../src/views/swarm/gpu/shaders/common.wgsl.js';
import erase from '../src/views/swarm/gpu/shaders/erase.wgsl.js';
import field from '../src/views/swarm/gpu/shaders/field.wgsl.js';
import glow from '../src/views/swarm/gpu/shaders/glow.wgsl.js';
import hub from '../src/views/swarm/gpu/shaders/hub.wgsl.js';
import shadow from '../src/views/swarm/gpu/shaders/shadow.wgsl.js';
import text from '../src/views/swarm/gpu/shaders/text.wgsl.js';

// The `.wgsl` files are the authoring copies (an editor highlights them); the
// `.wgsl.ts` twins are what ships, so no bundler needs a text loader. This is
// the drift guard: a shader edited in one place and not the other fails here.
const here = dirname(fileURLToPath(import.meta.url));
const twins: Record<string, string> = { body, common, erase, field, glow, hub, shadow, text };

describe('the shader string modules', () => {
  for (const [name, source] of Object.entries(twins)) {
    it(`${name}.wgsl.ts is ${name}.wgsl, byte for byte`, () => {
      expect(source).toBe(readFileSync(join(here, '../src/views/swarm/gpu/shaders', `${name}.wgsl`), 'utf8'));
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

  // The clock reaches every shader wrapped at SHADER_CLOCK_PERIOD_S (frame-layout.ts), and a periodic term
  // runs on across the wrap without a seam only if its period divides the wrap. So the clock is read once,
  // into `time`, and `time` only as `time * TAU / X` or `fract(time / X)` with a literal X: a period the
  // wrap does not divide fails here instead of stuttering once a wrap. The division is a ratio, never a
  // float `%`: 42 % 1.2 and 42 % 1.4 are about 1.6e-15 and 2.7e-15 in doubles.
  it('read time only through periods that divide the clock’s wrap', () => {
    const declaration = 'let time = frame.viewport.w;';
    const shapes = [/^time \* TAU \/ (\d+(?:\.\d+)?)\s*[-+),;]/, /^fract\(time \/ (\d+(?:\.\d+)?)\)/];
    for (const [name, source] of Object.entries(twins)) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const clockReads = code.match(/\bviewport\.\w*w/g)?.length ?? 0;
      const declared = code.split(declaration).length - 1;
      expect(clockReads, `${name} reads the clock outside \`${declaration}\``).toBe(declared);
      const reads = code.replaceAll(declaration, '');
      for (const read of reads.matchAll(/\btime\b/g)) {
        const at = reads.startsWith('fract(', read.index - 6) ? read.index - 6 : read.index;
        const term = reads.slice(at, reads.indexOf('\n', at)).trim();
        const period = shapes.map((shape) => shape.exec(term)?.[1]).find((value) => value !== undefined);
        expect(period, `${name}: ${term}`).toBeDefined();
        expect(/[*/]\s*$/.test(reads.slice(0, at)), `${name}: ${term} scales the clock first`).toBe(false);
        const turns = SHADER_CLOCK_PERIOD_S / Number(period);
        const wrap = `${name}: a ${period} s period against the ${SHADER_CLOCK_PERIOD_S} s wrap`;
        expect(Math.abs(turns - Math.round(turns)), wrap).toBeLessThan(1e-9);
      }
    }
  });
});
