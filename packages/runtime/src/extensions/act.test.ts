import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extensionActUnavailable,
  extensionCommandPlan,
  type AgentProfile,
  type ExtensionInventory,
  type ExtensionProvider,
  type ExtensionService,
  type McpServerItem,
} from '@vibecook/puppeteer-core';
import type { UpdateCommandRequest } from '../distribution/update.js';
import { createExtensionActRunner } from './act.js';
import { createExtensionInventoryReader } from './inventory.js';

const PROVIDER: ExtensionProvider = {
  id: 'example',
  label: 'Example',
  support: {
    mcpServers: { store: 'profile', changes: 'command', read: true },
    skills: { store: 'profile', changes: 'protocol', read: true },
  },
};

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const server = (id: string, enabled: boolean): McpServerItem => ({
  kind: 'mcp-server',
  id,
  name: id,
  origin: 'own',
  enabled,
  transport: 'http',
  target: `https://${id}.example/mcp`,
});

/**
 * A fake agent: its "config" is a map the fake command and protocol edit, so
 * the receipt can only come from reading it again.
 */
async function setup(options: { plan?: ExtensionService['plan']; perform?: ExtensionService['perform'] } = {}) {
  root = await mkdtemp(join(tmpdir(), 'puppeteer-act-'));
  const work: AgentProfile = {
    id: 'work-example',
    provider: 'example',
    label: 'Work',
    kind: 'managed',
    dataRoot: root,
    createdAt: '1970-01-01T00:00:00.000Z',
  };
  const state = new Map<string, boolean>([
    ['linear', true],
    ['postgres', false],
  ]);
  const reads = vi.fn();
  const service: ExtensionService = {
    provider: PROVIDER,
    inventory: async (profile): Promise<ExtensionInventory> => {
      reads();
      return {
        provider: 'example',
        profileId: profile.id,
        fetchedAt: '2026-09-25T09:00:00.000Z',
        items: [...state].map(([id, enabled]) => server(id, enabled)),
        source: { kind: 'native-store', stability: 'documented' },
      };
    },
    plan:
      options.plan ??
      ((profile, item, act) =>
        act === 'remove'
          ? extensionActUnavailable({ kind: item.kind, id: item.id }, act, 'no-command', 'Example keeps it in a file')
          : extensionCommandPlan({
              target: { kind: item.kind, id: item.id },
              act,
              argv: ['example', 'mcp', act, item.id],
              env: { EXAMPLE_HOME: profile.dataRoot },
            })),
    ...(options.perform === undefined ? {} : { perform: options.perform }),
  };
  const providers = new Map([['example', { provider: PROVIDER, service }]]);
  const reader = createExtensionInventoryReader({
    providers,
    resolveProfile: async (_providerId, profileId) =>
      profileId === work.id ? { profile: work } : { error: `unknown account profile: ${profileId}` },
    nativeDefaultProfileId: () => undefined,
  });
  const commands: UpdateCommandRequest[] = [];
  let exit = 0;
  let edits = true;
  const run = vi.fn(async (request: UpdateCommandRequest) => {
    commands.push(request);
    request.onOutput(`${request.argv.join(' ')}\n`);
    const [, , act, id] = request.argv;
    if (edits && exit === 0 && id !== undefined) state.set(id, act === 'enable');
    return { exitCode: exit };
  });
  const report = vi.fn();
  const runner = createExtensionActRunner({
    providers,
    reader,
    resolveProfile: async (_providerId, profileId) =>
      profileId === work.id ? { profile: work } : { error: `unknown account profile: ${profileId}` },
    nativeDefaultProfileId: () => undefined,
    run,
    env: { PATH: '/usr/bin', HOME: '/Users/test', ANTHROPIC_API_KEY: 'sk-ant-secret', LANG: 'en_US.UTF-8' },
    report,
  });
  return {
    runner,
    work,
    state,
    commands,
    run,
    reads,
    report,
    fail: (code: number) => {
      exit = code;
    },
    ignore: () => {
      edits = false;
    },
  };
}

const LINEAR = { kind: 'mcp-server' as const, id: 'linear' };

describe('createExtensionActRunner', () => {
  it("plans from a fresh read, then runs the agent's own command in the clean environment and reads again", async () => {
    const t = await setup();
    const plan = await t.runner.plan({ providerId: 'example', profileId: t.work.id, target: LINEAR, act: 'disable' });
    expect(plan).toMatchObject({
      available: true,
      display: 'example mcp disable linear',
      runs: { kind: 'command', argv: ['example', 'mcp', 'disable', 'linear'] },
      reaches: [],
    });
    const output: string[] = [];
    const receipt = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: LINEAR,
      act: 'disable',
      onOutput: (chunk) => output.push(chunk),
    });
    expect(receipt).toMatchObject({
      provider: 'example',
      profileId: 'work-example',
      target: LINEAR,
      act: 'disable',
      status: 'changed',
      display: 'example mcp disable linear',
      exitCode: 0,
      message: 'turned off',
    });
    expect(t.state.get('linear')).toBe(false);
    expect(output).toEqual(['example mcp disable linear\n']);
    // the agent's own folder, the plan's variable, nothing the host inherited beyond the clean set
    const command = t.commands[0]!;
    expect(command.cwd).toBe(t.work.dataRoot);
    expect(command.env.EXAMPLE_HOME).toBe(t.work.dataRoot);
    expect(command.env.PATH).toBe('/usr/bin');
    expect(command.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(command.timeoutMs).toBe(120_000);
  });

  it('says unchanged when the agent accepted it and still holds it as before, and failed when it refused', async () => {
    const t = await setup();
    t.ignore();
    expect(
      await t.runner.run({ providerId: 'example', profileId: t.work.id, target: LINEAR, act: 'disable' }),
    ).toMatchObject({ status: 'unchanged', message: 'Example still holds it on' });
    t.fail(1);
    expect(
      await t.runner.run({ providerId: 'example', profileId: t.work.id, target: LINEAR, act: 'disable' }),
    ).toMatchObject({ status: 'failed', exitCode: 1, message: 'example mcp disable linear exited with 1' });
    // turning on what is already on changes nothing
    const again = await setup();
    expect(
      await again.runner.run({ providerId: 'example', profileId: again.work.id, target: LINEAR, act: 'enable' }),
    ).toMatchObject({ status: 'unchanged' });
  });

  it('never runs an act the agent cannot do, or one on an item the profile does not hold', async () => {
    const t = await setup();
    expect(
      await t.runner.run({ providerId: 'example', profileId: t.work.id, target: LINEAR, act: 'remove' }),
    ).toMatchObject({ status: 'unavailable', message: 'Example keeps it in a file' });
    expect(
      await t.runner.plan({
        providerId: 'example',
        profileId: t.work.id,
        target: { kind: 'mcp-server', id: 'sentry' },
        act: 'enable',
      }),
    ).toMatchObject({ available: false, reason: 'not-held' });
    expect(
      await t.runner.run({
        providerId: 'example',
        profileId: 'elsewhere',
        target: LINEAR,
        act: 'disable',
      }),
    ).toMatchObject({ status: 'failed', message: 'unknown account profile: elsewhere' });
    expect(await t.runner.run({ providerId: 'nobody', target: LINEAR, act: 'disable' })).toMatchObject({
      status: 'failed',
    });
    expect(t.run).not.toHaveBeenCalled();
  });

  it("hands a protocol plan to the adapter's own perform", async () => {
    let state: Map<string, boolean> | undefined;
    const perform = vi.fn<NonNullable<ExtensionService['perform']>>(async (_profile, plan) => {
      state?.set(plan.target.id, plan.act === 'enable');
      return { ok: true };
    });
    const t = await setup({
      plan: (_profile, item, act) => ({
        target: { kind: item.kind, id: item.id },
        act,
        available: true,
        runs: { kind: 'protocol', method: 'config/value/write', params: { keyPath: `mcp_servers.${item.id}.enabled` } },
        display: `config/value/write mcp_servers.${item.id}.enabled`,
        reaches: [],
      }),
      perform,
    });
    state = t.state;
    const receipt = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: { kind: 'mcp-server', id: 'postgres' },
      act: 'enable',
    });
    expect(receipt).toMatchObject({ status: 'changed', message: 'turned on' });
    expect(perform).toHaveBeenCalledTimes(1);
    expect(t.run).not.toHaveBeenCalled();
  });

  it('refuses a malformed plan without running anything', async () => {
    const t = await setup({
      plan: () => ({ available: true }) as never,
    });
    expect(
      await t.runner.run({ providerId: 'example', profileId: t.work.id, target: LINEAR, act: 'disable' }),
    ).toMatchObject({ status: 'failed', message: 'Example answered with a malformed act plan' });
    expect(t.run).not.toHaveBeenCalled();
  });
});

describe('planning every act for items a read found', () => {
  it('answers each item and each act without reading again, and leaves out a malformed answer', async () => {
    const t = await setup({
      plan: (_profile, item, act) =>
        item.id === 'postgres' && act === 'remove'
          ? ({ available: 'maybe' } as never)
          : extensionCommandPlan({
              target: { kind: item.kind, id: item.id },
              act,
              argv: ['example', 'mcp', act, item.id],
            }),
    });
    t.reads.mockClear();
    const plans = await t.runner.plans({
      providerId: 'example',
      profileId: t.work.id,
      items: [
        {
          kind: 'mcp-server',
          id: 'linear',
          name: 'linear',
          origin: 'own',
          enabled: true,
          transport: 'http',
          target: 'https://linear.example/mcp',
        },
        {
          kind: 'mcp-server',
          id: 'postgres',
          name: 'postgres',
          origin: 'own',
          enabled: false,
          transport: 'http',
          target: 'https://postgres.example/mcp',
        },
      ],
    });
    expect(Array.isArray(plans) && plans.map((plan) => `${plan.target.id} ${plan.act}`)).toEqual([
      'linear enable',
      'linear disable',
      'linear remove',
      'postgres enable',
      'postgres disable',
    ]);
    expect(t.reads).not.toHaveBeenCalled();
    expect(t.run).not.toHaveBeenCalled();
    expect(await t.runner.plans({ providerId: 'example', profileId: 'elsewhere', items: [] })).toMatchObject({
      status: 'not-found',
    });
  });
});

describe('the inventory reader, fresh', () => {
  it('starts a read of its own instead of joining one already under way', async () => {
    let release: (() => void) | undefined;
    const reads: string[] = [];
    const service: ExtensionService = {
      provider: PROVIDER,
      inventory: async (profile) => {
        reads.push(profile.id);
        if (reads.length === 1) await new Promise<void>((resolve) => (release = resolve));
        return {
          provider: 'example',
          profileId: profile.id,
          fetchedAt: '2026-09-25T09:00:00.000Z',
          items: [],
          source: { kind: 'native-store', stability: 'documented' },
        };
      },
    };
    const profile: AgentProfile = {
      id: 'work-example',
      provider: 'example',
      label: 'Work',
      kind: 'managed',
      dataRoot: '/profiles/work/example',
      createdAt: '1970-01-01T00:00:00.000Z',
    };
    const reader = createExtensionInventoryReader({
      providers: new Map([['example', { provider: PROVIDER, service }]]),
      resolveProfile: async () => ({ profile }),
      nativeDefaultProfileId: () => undefined,
    });
    const first = reader.inventory('example', profile.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const joined = reader.inventory('example', profile.id);
    const fresh = reader.inventory('example', profile.id, { fresh: true });
    await fresh;
    expect(reads).toHaveLength(2);
    release?.();
    await Promise.all([first, joined]);
    expect(reads).toHaveLength(2);
  });
});
