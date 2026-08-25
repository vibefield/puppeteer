import { describe, expect, it } from 'vitest';
import { claudePermissionMode } from './provider-modes.js';

describe('Claude permission modes', () => {
  it('preserves native values and maps the manual/default alias for display', () => {
    expect(claudePermissionMode('manual')).toEqual({ raw: 'manual', normalized: 'Manual' });
    expect(claudePermissionMode('default')).toEqual({ raw: 'default', normalized: 'Manual' });
    expect(claudePermissionMode('acceptEdits')).toEqual({ raw: 'acceptEdits', normalized: 'Accept Edits' });
  });

  it('keeps future provider values open-ended', () => {
    expect(claudePermissionMode('future-manual-plus')).toEqual({ raw: 'future-manual-plus' });
  });
});
