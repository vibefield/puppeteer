import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extensionActUnavailable,
  extensionCommandPlan,
  extensionSkillFolderPlan,
  extensionTerminalPlan,
  type AgentHost,
  type AgentProfile,
  type ExtensionCatalog,
  type ExtensionInventory,
  type ExtensionProvider,
  type ExtensionService,
  type MarketplaceItem,
  type McpServerItem,
  type PluginItem,
  type SkillItem,
  type TerminalSpec,
} from '@vibefield/puppeteer-core';
import type { UpdateCommandRequest } from '../distribution/update.js';
import { createExtensionActRunner } from './act.js';
import { createExtensionCatalogReader } from './catalog.js';
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

  it('answers held for a name the agent holds, and invalid without a definition or a skill without its folder', async () => {
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
    // a skill is added from the folder the host keeps it in, never from a server's definition
    expect(await ask({ id: 'notes', kind: 'skill', definition: CONTEXT7 })).toMatchObject({ status: 'invalid' });
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

/**
 * A fake agent whose skills are real folders: it reads `<root>/skills` (links
 * followed, as the agents do) and plans with Core's folder placing, so every
 * receipt comes from reading the folder again after the runtime's own steps.
 */
async function skillAgent(options: { named?: (folder: string) => string; skips?: (folder: string) => boolean } = {}) {
  root = await mkdtemp(join(tmpdir(), 'puppeteer-skill-act-'));
  const agentRoot = join(root, 'agent');
  const skills = join(agentRoot, 'skills');
  const kept = join(root, 'kept');
  await mkdir(skills, { recursive: true });
  await mkdir(kept, { recursive: true });
  const work: AgentProfile = {
    id: 'work-example',
    provider: 'example',
    label: 'Work',
    kind: 'managed',
    dataRoot: agentRoot,
    createdAt: '1970-01-01T00:00:00.000Z',
  };
  const provider: ExtensionProvider = {
    id: 'example',
    label: 'Example',
    support: { skills: { store: 'profile', changes: 'folder', read: true } },
  };
  const service: ExtensionService = {
    provider,
    inventory: async (profile): Promise<ExtensionInventory> => {
      const items: SkillItem[] = [];
      for (const name of (await readdir(skills)).sort()) {
        if (options.skips?.(name) === true) continue;
        const location = join(skills, name);
        const linked = (await lstat(location)).isSymbolicLink();
        try {
          await readFile(join(location, 'SKILL.md'), 'utf8');
        } catch {
          continue;
        }
        const named = options.named?.(name) ?? name;
        items.push({
          kind: 'skill',
          id: named,
          name: named,
          origin: 'own',
          enabled: true,
          location,
          ...(linked ? { linkTarget: await readlink(location) } : {}),
        });
      }
      return {
        provider: 'example',
        profileId: profile.id,
        fetchedAt: '2026-09-27T09:00:00.000Z',
        items,
        source: { kind: 'native-store', stability: 'documented' },
      };
    },
    plan: (_profile, item, act, options) =>
      item.kind === 'skill' && (act === 'add' || act === 'remove')
        ? extensionSkillFolderPlan({
            label: 'Example',
            folder: skills,
            item,
            act,
            ...(options?.keepIn === undefined ? {} : { keepIn: options.keepIn }),
            home: root!,
          })
        : extensionActUnavailable({ kind: item.kind, id: item.id }, act, 'no-command', 'Example has no switch'),
  };
  const providers = new Map([['example', { provider, service }]]);
  const resolveProfile = async (_providerId: string, profileId: string) =>
    profileId === work.id ? { profile: work } : { error: `unknown account profile: ${profileId}` };
  const reader = createExtensionInventoryReader({ providers, resolveProfile, nativeDefaultProfileId: () => undefined });
  const run = vi.fn();
  const runner = createExtensionActRunner({
    providers,
    reader,
    resolveProfile,
    nativeDefaultProfileId: () => undefined,
    run,
    env: { PATH: '/usr/bin', HOME: root },
  });
  const skill = async (folder: string, body = 'Write the notes.') => {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'SKILL.md'), `---\nname: ${basename(folder)}\n---\n${body}\n`);
  };
  return { runner, work, skills, kept, skill, run };
}

describe('createExtensionActRunner, skills placed', () => {
  it("links a kept skill where the agent looks, says each step, and the second read's link is the receipt", async () => {
    const t = await skillAgent();
    const folder = join(t.kept, 'release-notes');
    await t.skill(folder);
    const output: string[] = [];
    const receipt = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: { kind: 'skill', id: 'release-notes' },
      act: 'add',
      folder,
      onOutput: (chunk) => output.push(chunk),
    });
    expect(receipt).toMatchObject({
      status: 'changed',
      message: 'added',
      display: 'link ~/kept/release-notes → ~/agent/skills/release-notes',
    });
    expect(output.join('')).toBe('link ~/kept/release-notes → ~/agent/skills/release-notes\n');
    expect(await readlink(join(t.skills, 'release-notes'))).toBe(folder);
    // no command ran: the runtime placed the link itself
    expect(t.run).not.toHaveBeenCalled();

    // a second add finds it held, and the link taken away is the receipt of a remove
    await expect(
      t.runner.plan({
        providerId: 'example',
        profileId: t.work.id,
        target: { kind: 'skill', id: 'release-notes' },
        act: 'add',
        folder,
      }),
    ).resolves.toMatchObject({ available: false, reason: 'held' });
    const removed = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: { kind: 'skill', id: 'release-notes' },
      act: 'remove',
    });
    expect(removed).toMatchObject({ status: 'changed', message: 'removed' });
    await expect(lstat(join(t.skills, 'release-notes'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(folder, 'SKILL.md'), 'utf8')).toContain('Write the notes.');
  });

  it('finds the skill where its link went, for an agent that names skills in their own words', async () => {
    // OpenCode keys a skill by its SKILL.md `name`, which need not be its folder's
    const t = await skillAgent({ named: (folder) => folder.replace(/-/gu, ' ').toUpperCase() });
    const folder = join(t.kept, 'release-notes');
    await t.skill(folder);
    const receipt = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: { kind: 'skill', id: 'release-notes' },
      act: 'add',
      folder,
    });
    expect(receipt).toMatchObject({ status: 'changed', message: 'added' });
  });

  it('takes back a link the agent does not read, so nothing blocks the next try', async () => {
    // Kimi skips a SKILL.md with no name or description; Grok, a path its settings ignore
    const t = await skillAgent({ skips: (folder) => folder === 'unread' });
    const folder = join(t.kept, 'unread');
    await t.skill(folder);
    const output: string[] = [];
    const receipt = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: { kind: 'skill', id: 'unread' },
      act: 'add',
      folder,
      onOutput: (chunk) => output.push(chunk),
    });
    expect(receipt).toMatchObject({
      status: 'unchanged',
      message: 'Example does not hold it, so what was placed was taken back',
    });
    await expect(lstat(join(t.skills, 'unread'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(output.join('')).toBe(
      'link ~/kept/unread → ~/agent/skills/unread\nundone: link ~/kept/unread → ~/agent/skills/unread\n',
    );
  });

  it("moves the agent's own folder to where the host keeps it, and a refused step is the failed receipt", async () => {
    const t = await skillAgent();
    await t.skill(join(t.skills, 'changelog'), 'mine');
    const keepIn = join(t.kept, 'changelog');
    const plans = await t.runner.plans({
      providerId: 'example',
      profileId: t.work.id,
      items: [
        {
          kind: 'skill',
          id: 'changelog',
          name: 'changelog',
          origin: 'own',
          enabled: true,
          location: join(t.skills, 'changelog'),
        },
      ],
      skills: [
        { name: 'changelog', folder: keepIn },
        { name: 'release-notes', folder: join(t.kept, 'release-notes') },
      ],
      keep: t.kept,
    });
    expect(Array.isArray(plans) ? plans.map((plan) => [plan.act, plan.target.id, plan.available]) : plans).toEqual([
      ['enable', 'changelog', false],
      ['disable', 'changelog', false],
      ['remove', 'changelog', true],
      ['add', 'changelog', false],
      ['add', 'release-notes', true],
    ]);
    const remove = Array.isArray(plans) ? plans.find((plan) => plan.act === 'remove') : undefined;
    expect(remove).toMatchObject({
      runs: { kind: 'files', steps: [{ op: 'move', from: join(t.skills, 'changelog'), to: keepIn }] },
    });

    const moved = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: { kind: 'skill', id: 'changelog' },
      act: 'remove',
      folder: keepIn,
    });
    expect(moved).toMatchObject({ status: 'changed', message: 'removed' });
    expect(await readFile(join(keepIn, 'SKILL.md'), 'utf8')).toContain('mine');

    // something already where the link would go: nothing is overwritten, and the read says so
    await t.skill(join(t.kept, 'other'));
    await mkdir(join(t.skills, 'other'));
    const refused = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: { kind: 'skill', id: 'other' },
      act: 'add',
      folder: join(t.kept, 'other'),
    });
    expect(refused).toMatchObject({
      status: 'failed',
      message: 'the link at ~/agent/skills/other could not be made: something is already there',
    });
    // a relative folder is never planned at all
    await expect(
      t.runner.plan({
        providerId: 'example',
        profileId: t.work.id,
        target: { kind: 'skill', id: 'x' },
        act: 'add',
        folder: 'kept/x',
      }),
    ).resolves.toMatchObject({ status: 'invalid' });
  });
});

describe('createExtensionActRunner, plugins', () => {
  /**
   * A fake agent holding plugins: its "store" maps a key to whether the plugin
   * is on and its version; the fake command edits it the way the agent's own
   * would, and the newest version its marketplace has is `newest`.
   */
  async function plugins() {
    root = await mkdtemp(join(tmpdir(), 'puppeteer-act-plugins-'));
    const work: AgentProfile = {
      id: 'work-example',
      provider: 'example',
      label: 'Work',
      kind: 'managed',
      dataRoot: root,
      createdAt: '1970-01-01T00:00:00.000Z',
    };
    const store = new Map<string, { enabled: boolean; version: string }>([
      ['review@northlight', { enabled: true, version: '1.2.0' }],
    ]);
    let newest = '1.3.0';
    const provider: ExtensionProvider = {
      ...PROVIDER,
      support: { ...PROVIDER.support, plugins: { store: 'profile', changes: 'command', read: true } },
    };
    const plugin = (id: string, fields: { enabled: boolean; version: string }): PluginItem => ({
      kind: 'plugin',
      id,
      name: id.split('@')[0]!,
      origin: 'own',
      marketplace: 'northlight',
      ...fields,
    });
    const service: ExtensionService = {
      provider,
      inventory: async (profile): Promise<ExtensionInventory> => ({
        provider: 'example',
        profileId: profile.id,
        fetchedAt: '2026-09-27T09:00:00.000Z',
        items: [server('linear', true), ...[...store].map(([id, fields]) => plugin(id, fields))],
        source: { kind: 'native-store', stability: 'documented' },
      }),
      plan: (profile, item, act) => {
        const target = { kind: item.kind, id: item.id };
        const verb = act === 'remove' ? 'uninstall --keep-data' : act === 'purge' ? 'uninstall' : act;
        return extensionCommandPlan({
          target,
          act,
          argv: ['example', item.kind === 'plugin' ? 'plugin' : 'mcp', ...verb.split(' '), item.id],
          env: { EXAMPLE_HOME: profile.dataRoot },
        });
      },
    };
    const providers = new Map([['example', { provider, service }]]);
    const resolveProfile = async (_providerId: string, profileId: string) =>
      profileId === work.id ? { profile: work } : { error: `unknown account profile: ${profileId}` };
    const reader = createExtensionInventoryReader({
      providers,
      resolveProfile,
      nativeDefaultProfileId: () => undefined,
    });
    const commands: string[][] = [];
    const run = vi.fn(async (request: UpdateCommandRequest) => {
      commands.push([...request.argv]);
      const [, , verb, ...rest] = request.argv;
      const id = rest[rest.length - 1]!;
      const held = store.get(id);
      if (held !== undefined) {
        if (verb === 'enable' || verb === 'disable') store.set(id, { ...held, enabled: verb === 'enable' });
        else if (verb === 'update') store.set(id, { ...held, version: newest });
        else if (verb === 'uninstall') store.delete(id);
      }
      return { exitCode: 0 };
    });
    const runner = createExtensionActRunner({
      providers,
      reader,
      resolveProfile,
      nativeDefaultProfileId: () => undefined,
      run,
      env: { PATH: '/usr/bin', HOME: '/Users/test' },
    });
    return {
      runner,
      work,
      store,
      commands,
      newest: (version: string) => {
        newest = version;
      },
    };
  }

  const REVIEW = { kind: 'plugin' as const, id: 'review@northlight' };

  it("turns a plugin off and on with the agent's own command, and the second read is the receipt", async () => {
    const t = await plugins();
    const off = await t.runner.run({ providerId: 'example', profileId: t.work.id, target: REVIEW, act: 'disable' });
    expect(off).toMatchObject({
      status: 'changed',
      message: 'turned off',
      display: 'example plugin disable review@northlight',
    });
    expect(t.store.get('review@northlight')?.enabled).toBe(false);
    const on = await t.runner.run({ providerId: 'example', profileId: t.work.id, target: REVIEW, act: 'enable' });
    expect(on).toMatchObject({ status: 'changed', message: 'turned on' });
  });

  it('says an update moved the version, and that there was none newer when it did not', async () => {
    const t = await plugins();
    const updated = await t.runner.run({ providerId: 'example', profileId: t.work.id, target: REVIEW, act: 'update' });
    expect(updated).toMatchObject({ act: 'update', status: 'changed', message: 'updated 1.2.0 → 1.3.0' });
    const again = await t.runner.run({ providerId: 'example', profileId: t.work.id, target: REVIEW, act: 'update' });
    expect(again).toMatchObject({ status: 'unchanged', message: 'Example still holds 1.3.0' });
  });

  it('removes a plugin keeping its data, or with it, each by the command its plan names', async () => {
    const t = await plugins();
    const purged = await t.runner.run({ providerId: 'example', profileId: t.work.id, target: REVIEW, act: 'purge' });
    expect(purged).toMatchObject({ status: 'changed', message: 'removed with its data' });
    expect(t.commands.at(-1)).toEqual(['example', 'plugin', 'uninstall', 'review@northlight']);
    t.store.set('review@northlight', { enabled: true, version: '1.3.0' });
    const removed = await t.runner.run({ providerId: 'example', profileId: t.work.id, target: REVIEW, act: 'remove' });
    expect(removed).toMatchObject({ status: 'changed', message: 'removed' });
    expect(t.commands.at(-1)).toEqual(['example', 'plugin', 'uninstall', '--keep-data', 'review@northlight']);
  });

  it("plans a held plugin's five acts beside a server's, and refuses what a plugin or a server cannot take", async () => {
    const t = await plugins();
    const inventory = [
      server('linear', true),
      {
        kind: 'plugin' as const,
        id: 'review@northlight',
        name: 'review',
        origin: 'own' as const,
        enabled: true,
        version: '1.2.0',
      },
    ];
    const plans = await t.runner.plans({ providerId: 'example', profileId: t.work.id, items: inventory });
    expect(Array.isArray(plans)).toBe(true);
    const acts = (plans as Array<{ target: { kind: string }; act: string }>)
      .filter((plan) => plan.target.kind === 'plugin')
      .map((plan) => plan.act);
    expect(acts).toEqual(['enable', 'disable', 'remove', 'purge', 'update']);
    expect(
      await t.runner.plan({ providerId: 'example', profileId: t.work.id, target: LINEAR, act: 'update' }),
    ).toMatchObject({ available: false, reason: 'unsupported', message: 'only a plugin is updated' });
    expect(
      await t.runner.plan({ providerId: 'example', profileId: t.work.id, target: REVIEW, act: 'add' }),
    ).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: 'only a server or a skill is added; a plugin is installed',
    });
    expect(
      await t.runner.plan({ providerId: 'example', profileId: t.work.id, target: REVIEW, act: 'sign-in' }),
    ).toMatchObject({ available: false, reason: 'no-sign-in', message: 'a plugin has no sign-in' });
    // a plugin the agent no longer holds is not planned from memory
    t.store.delete('review@northlight');
    expect(
      await t.runner.plan({ providerId: 'example', profileId: t.work.id, target: REVIEW, act: 'remove' }),
    ).toMatchObject({ available: false, reason: 'not-held' });
  });
});

describe('createExtensionActRunner, installs and marketplaces', () => {
  /**
   * A fake agent with marketplaces: its catalog lists what they hold, its
   * "store" what it installed; the fake command edits both the way the
   * agent's own would — an install from a source names the plugin its own way,
   * and a marketplace takes the name its catalog gives it.
   */
  async function markets(options: { sources?: boolean } = {}) {
    root = await mkdtemp(join(tmpdir(), 'puppeteer-act-markets-'));
    const work: AgentProfile = {
      id: 'work-example',
      provider: 'example',
      label: 'Work',
      kind: 'managed',
      dataRoot: root,
      createdAt: '1970-01-01T00:00:00.000Z',
    };
    const installed = new Map<string, string>([['review@northlight', '1.2.0']]);
    const from = new Map<string, string>();
    const along = new Map<string, string>();
    const marketplaces = new Map<string, { source: string; updatedAt?: string }>([
      ['northlight', { source: 'northlight/plugins', updatedAt: '2026-09-27T09:00:00.000Z' }],
    ]);
    let fetchedAt = '2026-09-27T10:00:00.000Z';
    let moves = true;
    const provider: ExtensionProvider = {
      ...PROVIDER,
      support: {
        ...PROVIDER.support,
        plugins: {
          store: 'profile',
          changes: 'command',
          read: true,
          ...(options.sources === true ? { sources: 'A package, or a folder' } : {}),
        },
        marketplaces: { store: 'profile', changes: 'command', read: true, sources: 'A repository' },
      },
    };
    const catalogReads = vi.fn();
    const catalog = async (profile: AgentProfile): Promise<ExtensionCatalog> => {
      catalogReads();
      return {
        provider: 'example',
        profileId: profile.id,
        fetchedAt: '2026-09-27T11:00:00.000Z',
        marketplaces: [...marketplaces].map(([id, market]) => ({
          id,
          name: id,
          source: market.source,
          origin: 'own',
          ...(market.updatedAt === undefined ? {} : { updatedAt: market.updatedAt }),
        })),
        plugins: [
          { id: 'review@northlight', name: 'review', marketplace: 'northlight', version: '1.3.0' },
          { id: 'lint@northlight', name: 'lint', marketplace: 'northlight', version: '2.0.0', description: 'Lints' },
          {
            id: 'telemetry@northlight',
            name: 'telemetry',
            marketplace: 'northlight',
            blocked: 'Your organization turned telemetry off',
          },
        ].filter((plugin) => marketplaces.has(plugin.marketplace)),
        source: { kind: 'native-store', stability: 'documented' },
      };
    };
    const service: ExtensionService = {
      provider,
      inventory: async (profile): Promise<ExtensionInventory> => ({
        provider: 'example',
        profileId: profile.id,
        fetchedAt: '2026-09-27T09:00:00.000Z',
        items: [
          ...[...marketplaces].map(([id, market]): MarketplaceItem => ({
            kind: 'marketplace',
            id,
            name: id,
            origin: 'own',
            enabled: true,
            source: market.source,
            ...(market.updatedAt === undefined ? {} : { updatedAt: market.updatedAt }),
          })),
          ...[...installed].map(([id, version]): PluginItem => ({
            kind: 'plugin',
            id,
            name: id.split('@')[0]!,
            origin: 'own',
            enabled: true,
            version,
            ...(from.has(id) ? { marketplace: from.get(id)! } : {}),
          })),
        ],
        source: { kind: 'native-store', stability: 'documented' },
      }),
      catalog,
      plan: (profile, item, act, planOptions) => {
        const target = { kind: item.kind, id: item.id };
        const env = { EXAMPLE_HOME: profile.dataRoot };
        if (item.kind === 'marketplace') {
          const verb = act === 'add' ? 'add' : act === 'update' ? 'update' : 'remove';
          return extensionCommandPlan({
            target,
            act,
            argv: ['example', 'marketplace', verb, act === 'add' ? item.source! : item.id],
            env,
            ...(act === 'remove' ? { reaches: ['every-profile' as const] } : {}),
          });
        }
        const verb = act === 'install' && planOptions?.source !== undefined ? 'install-from' : act;
        return extensionCommandPlan({ target, act, argv: ['example', 'plugin', verb, item.id], env });
      },
    };
    const providers = new Map([['example', { provider, service }]]);
    const resolveProfile = async (_providerId: string, profileId: string) =>
      profileId === work.id ? { profile: work } : { error: `unknown account profile: ${profileId}` };
    const reader = createExtensionInventoryReader({
      providers,
      resolveProfile,
      nativeDefaultProfileId: () => undefined,
    });
    const catalogs = createExtensionCatalogReader({
      providers,
      resolveProfile,
      nativeDefaultProfileId: () => undefined,
    });
    const commands: string[][] = [];
    const run = vi.fn(async (request: UpdateCommandRequest) => {
      commands.push([...request.argv]);
      const [, noun, verb, id] = request.argv;
      if (noun === 'plugin' && verb === 'install') installed.set(id!, id === 'lint@northlight' ? '2.0.0' : '1.3.0');
      if (noun === 'plugin' && verb === 'install-from' && id === '/Users/test/bundle') {
        // a folder of several plugins installs each of them
        installed.set('alpha@local', '1.0.0');
        installed.set('beta@local', '1.0.0');
      } else if (noun === 'plugin' && verb === 'install-from') {
        installed.set(`${id!.replace(/^npm:/u, '')}@npm`, '0.1.0');
      }
      if (noun === 'marketplace' && verb === 'add') marketplaces.set('northlight-extra', { source: id! });
      if (noun === 'marketplace' && verb === 'update' && moves) {
        marketplaces.set(id!, { ...marketplaces.get(id!)!, updatedAt: fetchedAt });
        for (const [plugin, version] of along) installed.set(plugin, version);
      }
      if (noun === 'marketplace' && verb === 'remove') marketplaces.delete(id!);
      return { exitCode: 0 };
    });
    const runner = createExtensionActRunner({
      providers,
      reader,
      catalogs,
      resolveProfile,
      nativeDefaultProfileId: () => undefined,
      run,
      env: { PATH: '/usr/bin', HOME: '/Users/test' },
    });
    return {
      runner,
      catalogs,
      catalogReads,
      work,
      installed,
      marketplaces,
      commands,
      fetched: (at: string | undefined, move = true) => {
        if (at !== undefined) fetchedAt = at;
        moves = move;
      },
      installedFrom: (plugin: string, marketplace: string) => from.set(plugin, marketplace),
      alsoUpdates: (plugin: string, version: string) => along.set(plugin, version),
    };
  }

  const LINT = { kind: 'plugin' as const, id: 'lint@northlight' };
  const NORTHLIGHT = { kind: 'marketplace' as const, id: 'northlight' };

  it('installs a plugin its catalog lists, planned from the entry, and the second read holding it is the receipt', async () => {
    const t = await markets();
    const plan = await t.runner.plan({ providerId: 'example', profileId: t.work.id, target: LINT, act: 'install' });
    expect(plan).toMatchObject({ available: true, display: `example plugin install lint@northlight` });
    const receipt = await t.runner.run({ providerId: 'example', profileId: t.work.id, target: LINT, act: 'install' });
    expect(receipt).toMatchObject({ act: 'install', status: 'changed', message: 'installed 2.0.0' });
    expect(t.installed.get('lint@northlight')).toBe('2.0.0');
  });

  it('refuses an install of a plugin it holds, one no catalog lists, and one its organization blocks', async () => {
    const t = await markets();
    expect(
      await t.runner.plan({
        providerId: 'example',
        profileId: t.work.id,
        target: { kind: 'plugin', id: 'review@northlight' },
        act: 'install',
      }),
    ).toMatchObject({ available: false, reason: 'held', message: 'Example already has review' });
    expect(
      await t.runner.plan({
        providerId: 'example',
        profileId: t.work.id,
        target: { kind: 'plugin', id: 'ghost@northlight' },
        act: 'install',
      }),
    ).toMatchObject({
      status: 'not-found',
      message: 'no marketplace Example knows lists ghost@northlight in this profile',
    });
    expect(
      await t.runner.plan({
        providerId: 'example',
        profileId: t.work.id,
        target: { kind: 'plugin', id: 'telemetry@northlight' },
        act: 'install',
      }),
    ).toMatchObject({ available: false, reason: 'blocked', message: 'Your organization turned telemetry off' });
    const refused = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: { kind: 'plugin', id: 'ghost@northlight' },
      act: 'install',
    });
    expect(refused).toMatchObject({ status: 'failed' });
    expect(t.commands).toEqual([]);
  });

  it('installs from a source only where the agent takes one, and finds the plugin it named its own way', async () => {
    const plain = await markets();
    const source = { kind: 'plugin' as const, id: 'npm:pi-web' };
    expect(
      await plain.runner.plan({
        providerId: 'example',
        profileId: plain.work.id,
        target: source,
        act: 'install',
        source: 'npm:pi-web',
      }),
    ).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: 'Example installs plugins only from its marketplaces',
    });

    const t = await markets({ sources: true });
    const receipt = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: source,
      act: 'install',
      source: 'npm:pi-web',
    });
    expect(receipt).toMatchObject({
      status: 'changed',
      message: 'installed 0.1.0',
      display: 'example plugin install-from npm:pi-web',
    });
    const bundle = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: { kind: 'plugin', id: '/Users/test/bundle' },
      act: 'install',
      source: '/Users/test/bundle',
    });
    expect(bundle).toMatchObject({ status: 'changed', message: 'installed alpha, beta' });
    for (const bad of [
      '--global',
      'https://me:secret@example.com/repo',
      'git+https://example.com/repo?token=x',
      'two words',
    ]) {
      expect(
        await t.runner.plan({
          providerId: 'example',
          profileId: t.work.id,
          target: { kind: 'plugin', id: bad },
          act: 'install',
          source: bad,
        }),
      ).toMatchObject({ status: 'invalid' });
    }
  });

  it('adds a marketplace from its source, found by the name its catalog gives it; one it has answers held', async () => {
    const t = await markets();
    const target = { kind: 'marketplace' as const, id: 'northlight/extra' };
    const receipt = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target,
      act: 'add',
      source: 'northlight/extra',
    });
    expect(receipt).toMatchObject({
      status: 'changed',
      message: 'added northlight-extra',
      display: 'example marketplace add northlight/extra',
    });
    expect(
      await t.runner.plan({
        providerId: 'example',
        profileId: t.work.id,
        target: { kind: 'marketplace', id: 'northlight/plugins' },
        act: 'add',
        source: 'northlight/plugins',
      }),
    ).toMatchObject({ available: false, reason: 'held', message: 'Example already has northlight' });
  });

  it("fetches a marketplace's catalog again, decided by the time the agent keeps for it", async () => {
    const t = await markets();
    const fetched = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: NORTHLIGHT,
      act: 'update',
    });
    expect(fetched).toMatchObject({ status: 'changed', message: 'fetched its catalog again' });
    t.fetched(undefined, false);
    const same = await t.runner.run({ providerId: 'example', profileId: t.work.id, target: NORTHLIGHT, act: 'update' });
    expect(same).toMatchObject({ status: 'unchanged', message: 'Example holds the catalog it had' });
    t.marketplaces.set('northlight', { source: 'northlight/plugins' });
    const untimed = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: NORTHLIGHT,
      act: 'update',
    });
    expect(untimed).toMatchObject({ status: 'unconfirmed', message: 'Example does not say when it last fetched it' });
    // a fetch that also moved a plugin installed from it says so
    t.fetched('2026-09-27T12:00:00.000Z', true);
    t.installedFrom('review@northlight', 'northlight');
    t.alsoUpdates('review@northlight', '1.4.0');
    const along = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: NORTHLIGHT,
      act: 'update',
    });
    expect(along).toMatchObject({
      status: 'changed',
      message: 'fetched its catalog again; Example also updated review 1.2.0 → 1.4.0',
    });
    const removed = await t.runner.run({
      providerId: 'example',
      profileId: t.work.id,
      target: NORTHLIGHT,
      act: 'remove',
    });
    expect(removed).toMatchObject({ status: 'changed', message: 'removed' });
    expect(
      await t.runner.plan({ providerId: 'example', profileId: t.work.id, target: NORTHLIGHT, act: 'purge' }),
    ).toMatchObject({ available: false, reason: 'unsupported' });
  });

  it("plans a marketplace's fetch and removal with the items, and each listed plugin's install", async () => {
    const t = await markets();
    const catalog = await t.catalogs.catalog('example', t.work.id);
    expect('status' in catalog).toBe(false);
    const items: Array<MarketplaceItem | PluginItem> = [
      {
        kind: 'marketplace',
        id: 'northlight',
        name: 'northlight',
        origin: 'own',
        enabled: true,
        source: 'northlight/plugins',
      },
      { kind: 'plugin', id: 'review@northlight', name: 'review', origin: 'own', enabled: true, version: '1.2.0' },
    ];
    const plans = await t.runner.plans({
      providerId: 'example',
      profileId: t.work.id,
      items,
      installs: (catalog as ExtensionCatalog).plugins,
    });
    expect(Array.isArray(plans)).toBe(true);
    const said = (
      plans as Array<{ target: { kind: string; id: string }; act: string; available: boolean; reason?: string }>
    )
      .filter((plan) => plan.target.kind === 'marketplace' || plan.act === 'install')
      .map((plan) => `${plan.act} ${plan.target.id} ${plan.available ? 'available' : plan.reason}`);
    expect(said).toEqual([
      'update northlight available',
      'remove northlight available',
      'install review@northlight held',
      'install lint@northlight available',
      'install telemetry@northlight blocked',
    ]);
  });

  it('plans a typed source without reading the agent: an install from it, and a marketplace added from it', async () => {
    const t = await markets({ sources: true });
    const items: Array<MarketplaceItem | PluginItem> = [
      {
        kind: 'marketplace',
        id: 'northlight',
        name: 'northlight',
        origin: 'own',
        enabled: true,
        source: 'northlight/plugins',
      },
    ];
    const plans = await t.runner.plans({
      providerId: 'example',
      profileId: t.work.id,
      items,
      sources: { plugins: ['npm:pi-web'], marketplaces: ['northlight/extra', 'northlight/plugins'] },
    });
    const said = (
      plans as Array<{ target: { id: string }; act: string; available: boolean; reason?: string; display?: string }>
    )
      .filter((plan) => plan.act === 'install' || plan.act === 'add')
      .map((plan) => `${plan.act} ${plan.target.id} ${plan.available ? plan.display : plan.reason}`);
    expect(said).toEqual([
      'install npm:pi-web example plugin install-from npm:pi-web',
      'add northlight/extra example marketplace add northlight/extra',
      'add northlight/plugins held',
    ]);
  });

  it('reads a catalog through the adapter, coalesced, and refuses one that names a marketplace it does not list', async () => {
    const t = await markets();
    const [a, b] = await Promise.all([
      t.catalogs.catalog('example', t.work.id),
      t.catalogs.catalog('example', t.work.id),
    ]);
    expect(a).toBe(b);
    expect(t.catalogReads).toHaveBeenCalledTimes(1);
    expect(await t.catalogs.catalog('nobody', t.work.id)).toMatchObject({ status: 'unsupported' });
    expect(await t.catalogs.catalog('example', 'elsewhere')).toMatchObject({ status: 'not-found' });
  });
});

describe('the catalog reader, checked', () => {
  it('answers invalid for a plugin whose marketplace the catalog does not list, and unsupported without a catalog', async () => {
    const work: AgentProfile = {
      id: 'work-example',
      provider: 'example',
      label: 'Work',
      kind: 'managed',
      dataRoot: '/tmp/none',
      createdAt: '1970-01-01T00:00:00.000Z',
    };
    const withMarkets: ExtensionProvider = {
      ...PROVIDER,
      support: { ...PROVIDER.support, marketplaces: { store: 'profile', changes: 'command', read: true } },
    };
    const service: ExtensionService = {
      provider: withMarkets,
      inventory: async () => ({ status: 'unavailable', message: 'unused', retryable: false }),
      catalog: async (profile) => ({
        provider: 'example',
        profileId: profile.id,
        fetchedAt: '2026-09-27T11:00:00.000Z',
        marketplaces: [],
        plugins: [{ id: 'lint@elsewhere', name: 'lint', marketplace: 'elsewhere' }],
        source: { kind: 'native-store', stability: 'documented' },
      }),
    };
    const resolveProfile = async () => ({ profile: work });
    const reader = createExtensionCatalogReader({
      providers: new Map([['example', { provider: withMarkets, service }]]),
      resolveProfile,
      nativeDefaultProfileId: () => undefined,
    });
    expect(await reader.catalog('example', work.id)).toMatchObject({
      status: 'invalid',
      message: expect.stringContaining('names a marketplace the catalog does not'),
    });
    const bare = createExtensionCatalogReader({
      providers: new Map([
        ['example', { provider: PROVIDER, service: { provider: PROVIDER, inventory: service.inventory } }],
      ]),
      resolveProfile,
      nativeDefaultProfileId: () => undefined,
    });
    expect(await bare.catalog('example', work.id)).toMatchObject({
      status: 'unsupported',
      message: 'Example has no catalog to read',
    });
  });
});
