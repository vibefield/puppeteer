import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentsDrawer } from './AgentsDrawer.js';
import type { AgentProfilesState } from './agent-profiles.js';

const PROFILES: AgentProfilesState = {
  profiles: [],
  defaults: {},
  labels: new Map(),
  setDefault: () => Promise.resolve(),
  reload: () => undefined,
};

describe('AgentsDrawer', () => {
  it('renders nothing while it is closed', () => {
    expect(renderToStaticMarkup(<AgentsDrawer open={false} profiles={PROFILES} onClose={() => undefined} />)).toBe('');
  });

  it('opens on the installs section with both tabs reachable', () => {
    const markup = renderToStaticMarkup(<AgentsDrawer open profiles={PROFILES} onClose={() => undefined} />);
    expect(markup).toContain('aria-label="Installed agents and accounts"');
    expect(markup).toContain('INSTALLS');
    expect(markup).toContain('ACCOUNTS');
    expect(markup).toContain('INSPECTING');
  });
});
