import { describe, expect, it } from 'vitest';
import { buildPaneAttachments } from './pane-attachments.js';

const panes = [
  { id: 'pane-a', session: { id: 'shared-session' } },
  { id: 'pane-b', session: { id: 'shared-session' } },
  { id: 'pane-c', session: { id: 'other-session' } },
] as const;

describe('pane attachments', () => {
  it('puts the active pane first and keeps the rest in tree order', () => {
    expect(buildPaneAttachments(panes, 'pane-b').get('shared-session')).toEqual({
      primaryPaneId: 'pane-b',
      paneIds: ['pane-b', 'pane-a'],
    });
  });

  it('uses the first pane when that session is not selected', () => {
    const attachments = buildPaneAttachments(panes, 'pane-c');
    expect(attachments.get('shared-session')).toEqual({ primaryPaneId: 'pane-a', paneIds: ['pane-a', 'pane-b'] });
    expect(attachments.get('other-session')).toEqual({ primaryPaneId: 'pane-c', paneIds: ['pane-c'] });
    expect(attachments.has('unmounted-session')).toBe(false);
  });
});
