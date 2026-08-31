import { describe, expect, it } from 'vitest';
import { auditSurfaceWorkflow, discoverVendorRoots } from './workflow.mjs';

describe('Layer 0 workflow inventory', () => {
  it('makes every upstream vendor visible and complete', () => {
    expect(discoverVendorRoots().map((root) => root.split('/').at(-1))).toEqual([
      'antigravity',
      'claude',
      'codex',
      'copilot',
      'grok',
      'hermes',
      'kimi',
      'opencode',
      'pi',
    ]);
    expect(auditSurfaceWorkflow()).toEqual([]);
  });
});
