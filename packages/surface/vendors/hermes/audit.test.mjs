import { describe, expect, it } from 'vitest';
import { auditHermes } from './audit.mjs';

describe('Hermes Surface audit', () => {
  it('keeps the source-revision policy and committed identity probes internally joined', () => {
    expect(auditHermes().problems).toEqual([]);
  });
});
