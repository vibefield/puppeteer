import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import body from './body.wgsl.js';
import common from './common.wgsl.js';
import field from './field.wgsl.js';
import glow from './glow.wgsl.js';
import shadow from './shadow.wgsl.js';
import text from './text.wgsl.js';

// The `.wgsl` files are the authoring copies (an editor highlights them); the
// `.wgsl.ts` twins are what ships, so no bundler needs a text loader. This is
// the drift guard: a shader edited in one place and not the other fails here.
const here = dirname(fileURLToPath(import.meta.url));
const twins: Record<string, string> = { body, common, field, glow, shadow, text };

describe('the shader string modules', () => {
  for (const [name, source] of Object.entries(twins)) {
    it(`${name}.wgsl.ts is ${name}.wgsl, byte for byte`, () => {
      expect(source).toBe(readFileSync(join(here, `${name}.wgsl`), 'utf8'));
    });
  }
});
