import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentHost } from '@vibefield/puppeteer-core';
import { createBuiltinProviders } from './providers.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const cwd = resolve('/repo');
const elsewhere = resolve('/elsewhere');
const inheriting = { spawnTerminal: vi.fn(), automateTerminal: vi.fn() } as unknown as AgentHost;
const composing: AgentHost = { ...inheriting, helperEnvironment: (env) => ({ PATH: '/bin', ...env }) };

/** The real codec over the real adapter: providers.test.ts mocks the capture, so its path to the home is read here. */
function recordedHome(host: AgentHost, agentOptions?: unknown): string | undefined {
  const grok = createBuiltinProviders().find((provider) => provider.descriptor.id === 'grok')!;
  const state = grok.launch!.continuation!.capture({ cwd, host, agentOptions });
  return state === undefined ? undefined : (JSON.parse(state) as { home?: string }).home;
}

describe('the Grok continuation records the home its run lives in', () => {
  it("records nothing of this process's own under a host that composes the helpers' environment", () => {
    vi.stubEnv('GROK_HOME', elsewhere);
    expect(recordedHome(composing)).toBeUndefined();
  });

  it('records the home a composing host hands its helpers', () => {
    vi.stubEnv('GROK_HOME', elsewhere);
    const agentHome = resolve('/agent/home');
    const host: AgentHost = { ...inheriting, helperEnvironment: (env) => ({ GROK_HOME: agentHome, ...env }) };
    expect(recordedHome(host)).toBe(agentHome);
  });

  it('records the inherited home under a host that does not compose: its helpers do inherit it', () => {
    vi.stubEnv('GROK_HOME', elsewhere);
    expect(recordedHome(inheriting)).toBe(elsewhere);
  });

  it("resolves a launch's own home against the cwd, under either host", () => {
    vi.stubEnv('GROK_HOME', elsewhere);
    const agentOptions = { appServerEnv: { GROK_HOME: '../h' } };
    expect(recordedHome(composing, agentOptions)).toBe(resolve(cwd, '../h'));
    expect(recordedHome(inheriting, agentOptions)).toBe(resolve(cwd, '../h'));
  });
});
