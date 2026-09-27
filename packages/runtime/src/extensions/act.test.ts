import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extensionActUnavailable,
  extensionCommandPlan,
  extensionTerminalPlan,
  type AgentHost,
  type AgentProfile,
  type ExtensionInventory,
  type ExtensionProvider,
  type ExtensionService,
  type McpServerItem,
  type TerminalSpec,
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
 * the receipt can only come from reading it again; its sign-ins another, which
 * a test changes the way a person finishing a login in the terminal would.
 */
async function setup(
  options: { plan?: ExtensionService['plan']; perform?: ExtensionService['perform']; host?: AgentHost | null } = {},
) {
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
  const auth = new Map<string, NonNullable<McpServerItem['auth']>>();
  const reads = vi.fn();
  const service: ExtensionService = {
    provider: PROVIDER,
    inventory: async (profile): Promise<ExtensionInventory> => {
      reads();
      return {
        provider: 'example',
        profileId: profile.id,
        fetchedAt: '2026-09-25T09:00:00.000Z',
        items: [...state].map(([id, enabled]) => {
          const signIn = auth.get(id);
          return { ...server(id, enabled), ...(signIn === undefined ? {} : { auth: signIn }) };
        }),
        source: { kind: 'native-store', stability: 'documented' },
      };
    },
    plan:
      options.plan ??
      ((profile, item, act) => {
        const target = { kind: item.kind, id: item.id };
        const env = { EXAMPLE_HOME: profile.dataRoot };
        if (act === 'remove') return extensionActUnavailable(target, act, 'no-command', 'Example keeps it in a file');
        if (act === 'sign-in') {
          return extensionTerminalPlan({
            target,
            act,
            argv: ['example', 'mcp', 'login', item.id],
            env,
            reaches: ['every-profile'],
          });
        }
        const verb = act === 'sign-out' ? 'logout' : act;
        return extensionCommandPlan({ target, act, argv: ['example', 'mcp', verb, item.id], env });
      }),
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
    const [, , verb, id] = request.argv;
    if (edits && exit === 0 && id !== undefined) {
      if (verb === 'logout') auth.set(id, 'needs-sign-in');
      else state.set(id, verb === 'enable' || verb === 'add');
    }
    return { exitCode: exit };
  });
  const spawnTerminal = vi.fn(async (_spec: TerminalSpec) => ({ runtimeSessionId: 'pty-1' }));
  // only the terminal is asked of a host here
  const host = options.host === undefined ? ({ spawnTerminal } as unknown as AgentHost) : options.host;
  const report = vi.fn();
  const runner = createExtensionActRunner({
    providers,
    reader,
    resolveProfile: async (_providerId, profileId) =>
      profileId === work.id ? { profile: work } : { error: `unknown account profile: ${profileId}` },
    nativeDefaultProfileId: () => undefined,
    run,
    env: { PATH: '/usr/bin', HOME: '/Users/test', ANTHROPIC_API_KEY: 'sk-ant-secret', LANG: 'en_US.UTF-8' },
    ...(host === null ? {} : { host }),
    report,
  });
  return {
    runner,
    work,
    state,
    auth,
    spawnTerminal,
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
const CONTEXT7 = {
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@upstash/context7-mcp'],
  env: ['CONTEXT7_API_KEY'],
};

describe('createExtensionActRunner, add', () => {
  it('adds a server the agent does not hold, planned from the server as it would hold it, and reads again', async () => {
    const planned: McpServerItem[] = [];
    const t = await setup({
      plan: (profile, item, act) => {
        if (item.kind === 'mcp-server') planned.push(item);
        return extensionCommandPlan({
          target: { kind: item.kind, id: item.id },
          act,
          argv: ['example', 'mcp', act, item.id],
          env: { EXAMPLE_HOME: profile.dataRoot },
        });
      },
    });
    const target = { kind: 'mcp-server' as const, id: 'context7' };
    const receipt = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target,
      act: 'add',
      definition: CONTEXT7,
    });
    expect(planned).toEqual([
      {
        kind: 'mcp-server',
        id: 'context7',
        name: 'context7',
        origin: 'own',
        enabled: true,
        transport: 'stdio',
        target: 'npx -y @upstash/context7-mcp',
        env: ['CONTEXT7_API_KEY'],
        definition: CONTEXT7,
      },
    ]);
    expect(receipt).toMatchObject({
      act: 'add',
      target,
      status: 'changed',
      message: 'added',
      display: 'example mcp add context7',
    });
    expect(t.state.get('context7')).toBe(true);
    // a fresh read before, and the second read that decided the receipt
    expect(t.reads).toHaveBeenCalledTimes(2);
  });

  it('says unchanged when the agent ran it and still does not hold it', async () => {
    const t = await setup();
    t.ignore();
    const receipt = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: { kind: 'mcp-server', id: 'context7' },
      act: 'add',
      definition: CONTEXT7,
    });
    expect(receipt).toMatchObject({ status: 'unchanged', message: 'Example does not hold it' });
  });

  it('answers held for a name the agent holds, unsupported for a skill, and invalid without a definition', async () => {
    const t = await setup();
    const ask = (fields: { id: string; kind?: 'mcp-server' | 'skill'; definition?: typeof CONTEXT7 }) =>
      t.runner.plan({
        providerId: 'example',
        profileId: t.work.id,
        target: { kind: fields.kind ?? 'mcp-server', id: fields.id },
        act: 'add',
        ...(fields.definition === undefined ? {} : { definition: fields.definition }),
      });
    expect(await ask({ id: 'linear', definition: CONTEXT7 })).toMatchObject({
      available: false,
      reason: 'held',
      message: 'Example already has a server named linear',
    });
    expect(await ask({ id: 'notes', kind: 'skill', definition: CONTEXT7 })).toMatchObject({
      available: false,
      reason: 'unsupported',
    });
    expect(await ask({ id: 'context7' })).toMatchObject({ status: 'invalid' });
    expect(t.commands).toEqual([]);
  });

  it('plans adds beside the acts on what the agent holds, without reading again', async () => {
    const t = await setup();
    const plans = await t.runner.plans({
      providerId: 'example',
      profileId: t.work.id,
      items: [server('linear', true)],
      adds: [
        { name: 'context7', definition: CONTEXT7 },
        { name: 'linear', definition: { transport: 'http', url: 'https://mcp.linear.app/mcp' } },
      ],
    });
    expect(Array.isArray(plans)).toBe(true);
    const adds = (plans as Array<{ act: string }>).filter((plan) => plan.act === 'add');
    expect(adds).toMatchObject([
      { target: { id: 'context7' }, available: true, display: 'example mcp add context7' },
      { target: { id: 'linear' }, available: false, reason: 'held' },
    ]);
    expect(t.reads).not.toHaveBeenCalled();
  });
});

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

describe("a server's sign-in and sign-out", () => {
  it("opens the agent's own login in the host's terminal, and settles it by reading the agent again", async () => {
    const t = await setup();
    t.auth.set('linear', 'needs-sign-in');
    const started = await t.runner.start({
      providerId: 'example',
      profileId: t.work.id,
      target: LINEAR,
      act: 'sign-in',
    });
    expect(started).toMatchObject({
      runtimeSessionId: 'pty-1',
      profileId: 'work-example',
      act: 'sign-in',
      display: 'example mcp login linear',
      reaches: ['every-profile'],
      before: { id: 'linear', auth: 'needs-sign-in' },
    });
    // the agent's own folder, the plan's variables; the host merges them over its clean environment
    expect(t.spawnTerminal).toHaveBeenCalledWith({
      command: 'example',
      args: ['mcp', 'login', 'linear'],
      cwd: t.work.dataRoot,
      env: { EXAMPLE_HOME: t.work.dataRoot },
    });
    expect(t.run).not.toHaveBeenCalled();
    if (!('runtimeSessionId' in started)) throw new Error('the sign-in did not start');

    // the person finishes in the browser; the terminal ends
    t.auth.set('linear', 'signed-in');
    expect(await t.runner.settle(started, { exitCode: 0 })).toMatchObject({
      status: 'changed',
      message: 'signed in',
      display: 'example mcp login linear',
      exitCode: 0,
    });
  });

  it('says a cancelled sign-in left things as they were, and a refused one failed', async () => {
    const t = await setup();
    t.auth.set('linear', 'needs-sign-in');
    const started = await t.runner.start({
      providerId: 'example',
      profileId: t.work.id,
      target: LINEAR,
      act: 'sign-in',
    });
    if (!('runtimeSessionId' in started)) throw new Error('the sign-in did not start');
    expect(await t.runner.settle(started, { exitCode: null, stopped: true })).toMatchObject({
      status: 'unchanged',
      message: 'Example still asks you to sign in',
    });
    expect(await t.runner.settle(started, { exitCode: 1 })).toMatchObject({
      status: 'failed',
      exitCode: 1,
      message: 'example mcp login linear exited with 1',
    });
    // the host stopped waiting: the read alone decides
    expect(await t.runner.settle(started)).toMatchObject({ status: 'unchanged' });
  });

  it('leaves it unconfirmed where the agent keeps its sign-ins out of any read', async () => {
    const t = await setup();
    const started = await t.runner.start({
      providerId: 'example',
      profileId: t.work.id,
      target: LINEAR,
      act: 'sign-in',
    });
    if (!('runtimeSessionId' in started)) throw new Error('the sign-in did not start');
    expect(await t.runner.settle(started, { exitCode: 0 })).toMatchObject({
      status: 'unconfirmed',
      message: 'Example says whether it is signed in only inside a session',
    });
  });

  it('runs a sign-out as a command, decided by the read', async () => {
    const t = await setup();
    t.auth.set('linear', 'signed-in');
    expect(
      await t.runner.run({ providerId: 'example', profileId: t.work.id, target: LINEAR, act: 'sign-out' }),
    ).toMatchObject({ status: 'changed', message: 'signed out', display: 'example mcp logout linear' });
    expect(t.auth.get('linear')).toBe('needs-sign-in');
    // a second one has nothing to forget
    expect(
      await t.runner.run({ providerId: 'example', profileId: t.work.id, target: LINEAR, act: 'sign-out' }),
    ).toMatchObject({ status: 'unchanged', message: 'Example still asks you to sign in' });
  });

  it('runs a terminal plan only in a terminal, and a terminal only for a terminal plan', async () => {
    const t = await setup();
    expect(
      await t.runner.run({ providerId: 'example', profileId: t.work.id, target: LINEAR, act: 'sign-in' }),
    ).toMatchObject({ status: 'failed', message: 'example mcp login linear runs in a terminal the person answers' });
    expect(
      await t.runner.start({ providerId: 'example', profileId: t.work.id, target: LINEAR, act: 'sign-out' }),
    ).toMatchObject({ status: 'failed', message: 'example mcp logout linear runs without a terminal' });
    expect(
      await t.runner.start({ providerId: 'example', profileId: t.work.id, target: LINEAR, act: 'remove' }),
    ).toMatchObject({ status: 'unavailable', message: 'Example keeps it in a file' });
    expect(t.spawnTerminal).not.toHaveBeenCalled();
    expect(t.run).not.toHaveBeenCalled();

    const hostless = await setup({ host: null });
    expect(
      await hostless.runner.start({
        providerId: 'example',
        profileId: hostless.work.id,
        target: LINEAR,
        act: 'sign-in',
      }),
    ).toMatchObject({ status: 'failed', message: 'there is no terminal to run it in' });
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
      'linear sign-in',
      'linear sign-out',
      'postgres enable',
      'postgres disable',
      'postgres sign-in',
      'postgres sign-out',
    ]);
    // a skill has no sign-in: it is never asked for one
    const skillPlans = await t.runner.plans({
      providerId: 'example',
      profileId: t.work.id,
      items: [{ kind: 'skill', id: 'release-notes', name: 'release-notes', origin: 'own', enabled: true }],
    });
    expect(Array.isArray(skillPlans) && skillPlans.map((plan) => plan.act)).toEqual(['enable', 'disable', 'remove']);
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
