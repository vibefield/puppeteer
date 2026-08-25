import { describe, expect, it } from 'vitest';
import { auditAntigravity } from './audit.mjs';

describe('Antigravity offline Surface audit', () => {
  it('keeps the public release policy and committed offline probes internally joined', () => {
    expect(auditAntigravity().problems).toEqual([]);
  });
});
