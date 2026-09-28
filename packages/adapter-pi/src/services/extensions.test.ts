import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentProfileSchema,
  ExtensionActPlanSchema,
  ExtensionInventorySchema,
  ExtensionProviderSchema,
  type ExtensionInventory,
  type ExtensionItem,
  type PluginItem,
  type SkillItem,
} from '@vibecook/puppeteer-core';
import { createPiExtensionService } from './extensions.js';

const now = () => new Date('2026-09-25T09:00:00.000Z');
const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-extensions-')));
  made.push(dir);
  return dir;
}

async function write(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

const skill = (name: string, description?: string) =>
  `---\nname: ${name}\n${description ? `description: ${description}\n` : ''}---\n\n# ${name}\n`;

const managedProfile = (root: string) =>
  AgentProfileSchema.parse({
    id: 'work-pi',
    provider: 'pi',
    label: 'Work',
    kind: 'managed',
    dataRoot: root,
    createdAt: '2026-09-23T00:00:00.000Z',
  });

const nativeProfile = (home: string) =>
  AgentProfileSchema.parse({
    id: 'pi:native-default',
    provider: 'pi',
    label: 'Default',
    kind: 'native-default',
    dataRoot: join(home, '.pi', 'agent'),
    createdAt: '1970-01-01T00:00:00.000Z',
  });

const find = (inventory: ExtensionInventory, kind: ExtensionItem['kind'], id: string) =>
  inventory.items.find((item) => item.kind === kind && item.id === id);
const idsOf = (inventory: ExtensionInventory, kind: ExtensionItem['kind']) =>
  inventory.items.filter((item) => item.kind === kind).map((item) => item.id);

async function read(home: string, root: string): Promise<ExtensionInventory> {
  return ExtensionInventorySchema.parse(await createPiExtensionService({ home, now }).inventory(managedProfile(root)));
}

describe('Pi extensions', () => {
  it("declares packages as plugins, in Pi's own word, and skills, and no MCP servers or marketplaces", () => {
    const { provider } = createPiExtensionService({ home: '/nowhere', now });
    expect(ExtensionProviderSchema.parse(provider)).toEqual({
      id: 'pi',
      label: 'Pi',
      support: {
        plugins: { store: 'profile', changes: 'command', read: true, label: 'Packages' },
        skills: { store: 'mixed', changes: 'folder', read: true },
      },
    });
  });

  it('reads a managed agent directory: packages, loose extensions, and skills in Pi’s order, with its filters', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'pi-7c1e');
    const agent = join(root, 'agent');
    const tools = join(agent, 'npm', 'node_modules', '@acme', 'pi-tools');
    const review = join(agent, 'git', 'github.com', 'northlight', 'pi-review');
    await write(join(agent, 'settings.json'), {
      defaultProvider: 'anthropic',
      packages: [
        'npm:@acme/pi-tools@1.2.0',
        { source: 'git:github.com/northlight/pi-review@v2', skills: ['!skills/draft/SKILL.md'] },
        './local-ext.ts',
        'git:https://deploy:ghp_secret123@github.com/acme/private-pack',
      ],
      skills: ['-skills/sql-review/SKILL.md', '../extra-skills/deploy'],
      extensions: ['!old.ts'],
    });
    await write(join(tools, 'package.json'), {
      name: '@acme/pi-tools',
      version: '1.2.0',
      description: 'Lint and format tools for Pi',
      pi: { extensions: ['./ext.ts'], skills: ['./skills'] },
    });
    await write(join(tools, 'ext.ts'), 'export default () => {};\n');
    await write(join(tools, 'skills', 'lint', 'SKILL.md'), skill('lint', 'Lints the change'));
    await write(join(review, 'package.json'), { name: 'pi-review', version: '2.0.1' });
    await write(join(review, 'skills', 'review', 'SKILL.md'), skill('review', 'Reviews against the house style'));
    await write(join(review, 'skills', 'draft', 'SKILL.md'), skill('draft', 'Drafts a review'));
    await write(join(agent, 'local-ext.ts'), 'export default () => {};\n');
    await write(join(agent, 'extensions', 'notify.ts'), 'export default () => {};\n');
    await write(join(agent, 'extensions', 'old.ts'), 'export default () => {};\n');
    await write(join(agent, 'extensions', 'panel', 'index.ts'), 'export default () => {};\n');
    await write(join(agent, 'extensions', 'notes.md'), '# not an extension');
    await write(join(agent, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'Drafts release notes'));
    await write(join(agent, 'skills', 'sql-review', 'SKILL.md'), skill('sql-review', 'Reviews a migration'));
    await write(join(agent, 'skills', 'no-description', 'SKILL.md'), skill('no-description'));
    await write(join(agent, 'skills', 'handoff.md'), skill('handoff', 'Writes a handoff note'));
    await write(join(root, 'extra-skills', 'deploy', 'SKILL.md'), skill('deploy', 'Deploys the service'));
    await write(join(home, '.agents', 'skills', 'browser-use', 'SKILL.md'), skill('browser-use', 'Drives a browser'));
    await write(join(home, '.agents', 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'Shared copy'));
    await write(join(home, '.agents', 'skills', 'top-level.md'), skill('top-level', 'Not a skill at this level'));

    const inventory = await read(home, root);
    expect(JSON.stringify(inventory)).not.toContain('ghp_secret123');
    expect(inventory).toMatchObject({
      provider: 'pi',
      profileId: 'work-pi',
      fetchedAt: '2026-09-25T09:00:00.000Z',
      source: { kind: 'native-store', stability: 'documented' },
    });
    // The private git package is configured but not cloned into this profile yet.
    expect(inventory.unread).toEqual([
      {
        kind: 'skill',
        message: 'a configured npm or git package is not installed in this profile, so its skills are not listed',
      },
    ]);

    expect(find(inventory, 'plugin', 'npm:@acme/pi-tools')).toEqual({
      kind: 'plugin',
      id: 'npm:@acme/pi-tools',
      name: '@acme/pi-tools',
      origin: 'own',
      enabled: true,
      version: '1.2.0',
      description: 'Lint and format tools for Pi',
      location: tools,
    });
    expect(find(inventory, 'plugin', 'git:github.com/northlight/pi-review')).toMatchObject({
      name: 'pi-review',
      enabled: true,
      version: '2.0.1',
      location: review,
    });
    expect(find(inventory, 'plugin', `local:${join(agent, 'local-ext.ts')}`)).toMatchObject({
      name: 'local-ext',
      enabled: true,
    });
    expect(find(inventory, 'plugin', 'git:github.com/acme/private-pack')).toMatchObject({
      name: 'private-pack',
      enabled: true,
    });
    expect(find(inventory, 'plugin', 'git:github.com/acme/private-pack')).not.toHaveProperty('location');
    expect(find(inventory, 'plugin', `extension:${join(agent, 'extensions', 'notify.ts')}`)).toMatchObject({
      name: 'notify',
      enabled: true,
    });
    expect(find(inventory, 'plugin', `extension:${join(agent, 'extensions', 'old.ts')}`)).toMatchObject({
      enabled: false,
    });
    expect(find(inventory, 'plugin', `extension:${join(agent, 'extensions', 'panel')}`)).toMatchObject({
      name: 'panel',
      enabled: true,
    });
    expect(idsOf(inventory, 'plugin')).toHaveLength(7);

    expect(find(inventory, 'skill', 'release-notes')).toEqual({
      kind: 'skill',
      id: 'release-notes',
      name: 'release-notes',
      origin: 'own',
      enabled: true,
      description: 'Drafts release notes',
      location: join(agent, 'skills', 'release-notes'),
    });
    // `pi config` writes `-path`: switched off, still held.
    expect(find(inventory, 'skill', 'sql-review')).toMatchObject({ enabled: false });
    expect(find(inventory, 'skill', 'handoff.md')).toMatchObject({
      name: 'handoff',
      location: join(agent, 'skills', 'handoff.md'),
    });
    expect(find(inventory, 'skill', `path:${join(root, 'extra-skills', 'deploy')}`)).toMatchObject({
      name: 'deploy',
      origin: 'own',
      enabled: true,
    });
    expect(find(inventory, 'skill', 'shared:browser-use')).toMatchObject({
      origin: 'own',
      shared: true,
      enabled: true,
    });
    expect(find(inventory, 'skill', 'plugin:npm:@acme/pi-tools:lint')).toMatchObject({
      origin: 'plugin',
      plugin: 'npm:@acme/pi-tools',
      enabled: true,
    });
    expect(find(inventory, 'skill', 'plugin:git:github.com/northlight/pi-review:review')).toMatchObject({
      enabled: true,
    });
    expect(find(inventory, 'skill', 'plugin:git:github.com/northlight/pi-review:draft')).toMatchObject({
      enabled: false,
    });
    const names = inventory.items.filter((item) => item.kind === 'skill').map((item) => item.name);
    // The agent's release-notes wins the name over the shared copy; a skill needs a description; a loose
    // `.md` counts at the top of the agent's folder, not at the top of the shared one.
    expect(names.filter((name) => name === 'release-notes')).toHaveLength(1);
    expect(names).not.toContain('no-description');
    expect(names).not.toContain('top-level');
  });

  it('reads a linked shared skill as shared, with where its folder points', async () => {
    const home = await tempHome();
    const library = join(home, 'library', 'changelog');
    await write(join(library, 'SKILL.md'), skill('changelog', 'Writes the changelog entry'));
    await mkdir(join(home, '.agents', 'skills'), { recursive: true });
    await symlink(library, join(home, '.agents', 'skills', 'changelog'));

    const inventory = await read(home, join(home, 'profiles', 'work', 'pi-7c1e'));
    expect(inventory.items).toEqual([
      {
        kind: 'skill',
        id: 'shared:changelog',
        name: 'changelog',
        origin: 'own',
        shared: true,
        enabled: true,
        description: 'Writes the changelog entry',
        location: join(home, '.agents', 'skills', 'changelog'),
        linkTarget: library,
      },
    ]);
  });

  it('applies a glob exclusion, and an exact force-include over it', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'pi-7c1e');
    await write(join(root, 'agent', 'settings.json'), { skills: ['!wip-*', '+skills/wip-kept/SKILL.md'] });
    for (const name of ['wip-dropped', 'wip-kept', 'steady']) {
      await write(join(home, '.agents', 'skills', name, 'SKILL.md'), skill(name, `The ${name} skill`));
    }
    const inventory = await read(home, root);
    const enabled = Object.fromEntries(
      inventory.items.filter((item) => item.kind === 'skill').map((item) => [item.name, item.enabled]),
    );
    expect(enabled).toEqual({ 'wip-kept': true, steady: true, 'wip-dropped': false });
  });

  it('reads the native default from the home it was given', async () => {
    const home = await tempHome();
    await write(join(home, '.pi', 'agent', 'skills', 'triage', 'SKILL.md'), skill('triage', 'Triages an issue'));
    const inventory = ExtensionInventorySchema.parse(
      await createPiExtensionService({ home, now }).inventory(nativeProfile(home)),
    );
    expect(inventory.profileId).toBe('pi:native-default');
    expect(find(inventory, 'skill', 'triage')).toMatchObject({
      location: join(home, '.pi', 'agent', 'skills', 'triage'),
    });
  });

  it('says which kinds an unreadable settings file hides, and lists what the folders still hold', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'pi-7c1e');
    await write(join(root, 'agent', 'settings.json'), '{ "packages": [ not json');
    await write(join(root, 'agent', 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'Drafts notes'));
    await write(join(root, 'agent', 'extensions', 'notify.ts'), 'export default () => {};\n');

    const inventory = await read(home, root);
    expect(inventory.unread).toEqual([
      { kind: 'plugin', message: 'settings.json could not be read' },
      { kind: 'skill', message: 'settings.json could not be read' },
    ]);
    expect(inventory.items.map((item) => item.id)).toEqual([
      `extension:${join(root, 'agent', 'extensions', 'notify.ts')}`,
      'release-notes',
    ]);
  });

  it('reads a filter it cannot evaluate as unread, not as a guess', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'pi-7c1e');
    await write(join(root, 'agent', 'settings.json'), { skills: ['!+(wip|old)-*'] });
    await write(join(root, 'agent', 'skills', 'wip-a', 'SKILL.md'), skill('wip-a', 'Work in progress'));
    const inventory = await read(home, root);
    expect(inventory.unread).toEqual([
      { kind: 'skill', message: 'a filter in settings.json uses glob syntax this reader does not evaluate' },
    ]);
  });

  it('marks a missing local package off, since Pi loads nothing from it', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'pi-7c1e');
    await write(join(root, 'agent', 'settings.json'), { packages: ['../gone'] });
    const inventory = await read(home, root);
    expect(inventory.unread).toBeUndefined();
    expect(inventory.items).toEqual([
      { kind: 'plugin', id: `local:${join(root, 'gone')}`, name: 'gone', origin: 'own', enabled: false },
    ]);
  });

  it('reads an empty root as holding nothing', async () => {
    const home = await tempHome();
    const inventory = await read(home, join(home, 'fresh'));
    expect(inventory.items).toEqual([]);
    expect(inventory.unread).toBeUndefined();
  });
});

// ── acts (RFC 006 C2) ──

const actProfile = (kind: 'managed' | 'native-default', dataRoot: string) =>
  ({
    id: kind === 'managed' ? 'work-pi' : 'pi:native-default',
    provider: 'pi',
    label: kind === 'managed' ? 'Work' : 'Default',
    kind,
    dataRoot,
    createdAt: '2026-09-23T00:00:00.000Z',
  }) as const;
const actServer = (fields: Record<string, unknown> = {}) =>
  ({
    kind: 'mcp-server',
    id: 'linear',
    name: 'linear',
    origin: 'own',
    enabled: true,
    transport: 'http',
    target: 'https://mcp.linear.app/mcp',
    ...fields,
  }) as never;
const actSkill = (fields: Record<string, unknown> = {}) =>
  ({ kind: 'skill', id: 'release-notes', name: 'release-notes', origin: 'own', enabled: true, ...fields }) as never;
/** A skill as the runtime hands an add to the adapter: a link to the folder the host keeps. */
const placed = (name: string, folder: string): SkillItem => ({
  kind: 'skill',
  id: name,
  name,
  origin: 'own',
  enabled: true,
  linkTarget: folder,
});
const heldSkill = (inventory: ExtensionInventory, id: string): SkillItem => {
  const item = find(inventory, 'skill', id);
  if (item?.kind !== 'skill') throw new Error(`no skill ${id}`);
  return item;
};

describe('Pi extension acts', () => {
  it('filters skills only inside the app', () => {
    const pi = createPiExtensionService({ home: '/Users/test' });
    expect(pi.plan!(actProfile('managed', '/p'), actSkill(), 'disable')).toMatchObject({
      available: false,
      reason: 'in-app',
    });
  });

  it("places a kept skill as a link in the profile's own skills folder", async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'pi-7c1e');
    const kept = join(home, 'kept', 'release-notes');
    const pi = createPiExtensionService({ home, now });
    const work = managedProfile(root);
    expect(ExtensionActPlanSchema.parse(pi.plan!(work, placed('release-notes', kept), 'add'))).toEqual({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'add',
      available: true,
      runs: {
        kind: 'files',
        steps: [{ op: 'link', path: join(root, 'agent', 'skills', 'release-notes'), target: kept }],
      },
      display: 'link ~/kept/release-notes → ~/profiles/work/pi-7c1e/agent/skills/release-notes',
      reaches: [],
    });
    // The native default's folder is `~/.pi/agent/skills`, under the home it was given.
    expect(pi.plan!(nativeProfile(home), placed('release-notes', kept), 'add')).toMatchObject({
      available: true,
      runs: { steps: [{ op: 'link', path: join(home, '.pi', 'agent', 'skills', 'release-notes'), target: kept }] },
      display: 'link ~/kept/release-notes → ~/.pi/agent/skills/release-notes',
      reaches: [],
    });
    // Only a folder to link, under a name that stays one folder.
    expect(pi.plan!(work, actSkill(), 'add')).toMatchObject({ available: false, reason: 'unsupported' });
    for (const name of ['.hidden', 'team/notes']) {
      expect(pi.plan!(work, placed(name, kept), 'add'), name).toMatchObject({
        available: false,
        reason: 'unsupported',
      });
    }
  });

  it('takes away only a folder directly in its own skills folder: its link, or the folder itself to the host', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'pi-7c1e');
    const agent = join(root, 'agent');
    const skills = join(agent, 'skills');
    const tools = join(agent, 'npm', 'node_modules', '@acme', 'pi-tools');
    await write(join(agent, 'settings.json'), {
      packages: ['npm:@acme/pi-tools'],
      skills: ['../extra-skills/deploy'],
    });
    await write(join(tools, 'package.json'), { name: '@acme/pi-tools', version: '1.2.0' });
    await write(join(tools, 'skills', 'lint', 'SKILL.md'), skill('lint', 'Lints the change'));
    const library = join(home, 'library', 'linked');
    await write(join(library, 'SKILL.md'), skill('linked', 'Kept by the host'));
    await mkdir(skills, { recursive: true });
    await symlink(library, join(skills, 'linked'));
    await write(join(skills, 'mine', 'SKILL.md'), skill('mine', 'A folder of its own'));
    await write(join(skills, 'handoff.md'), skill('handoff', 'Writes a handoff note'));
    await write(join(skills, 'team', 'nested', 'SKILL.md'), skill('nested', 'Deeper down'));
    await write(join(root, 'extra-skills', 'deploy', 'SKILL.md'), skill('deploy', 'On a settings path'));
    await write(
      join(home, '.agents', 'skills', 'browser-use', 'SKILL.md'),
      skill('browser-use', 'Every agent reads it'),
    );

    const pi = createPiExtensionService({ home, now });
    const work = managedProfile(root);
    const inventory = await read(home, root);
    const remove = (id: string, keepIn?: string) =>
      ExtensionActPlanSchema.parse(
        pi.plan!(work, heldSkill(inventory, id), 'remove', keepIn === undefined ? {} : { keepIn }),
      );

    // A link goes, even where the host would keep a folder.
    expect(remove('linked', join(home, 'kept', 'linked'))).toEqual({
      target: { kind: 'skill', id: 'linked' },
      act: 'remove',
      available: true,
      runs: { kind: 'files', steps: [{ op: 'unlink', path: join(skills, 'linked') }] },
      display: 'unlink ~/profiles/work/pi-7c1e/agent/skills/linked',
      reaches: [],
    });
    const keepIn = join(home, 'kept', 'mine');
    expect(remove('mine', keepIn)).toMatchObject({
      available: true,
      runs: { kind: 'files', steps: [{ op: 'move', from: join(skills, 'mine'), to: keepIn }] },
      display: 'move ~/profiles/work/pi-7c1e/agent/skills/mine → ~/kept/mine',
      reaches: [],
    });
    // With nowhere to keep it, the person's own folder stays.
    expect(remove('mine')).toMatchObject({ available: false, reason: 'no-command' });
    // A loose skill is one file, not a folder: it stays, wherever the host would keep it.
    for (const keep of [join(home, 'kept', 'handoff'), undefined]) {
      expect(remove('handoff.md', keep)).toEqual({
        target: { kind: 'skill', id: 'handoff.md' },
        act: 'remove',
        available: false,
        reason: 'no-command',
        message: "handoff is a loose file in Pi's skills folder, and only a skill's folder is taken away",
      });
    }
    for (const [id, name] of [
      ['team/nested', 'nested'],
      [`path:${join(root, 'extra-skills', 'deploy')}`, 'deploy'],
      ['shared:browser-use', 'browser-use'],
    ] as const) {
      expect(remove(id, join(home, 'kept', name)), id).toEqual({
        target: { kind: 'skill', id },
        act: 'remove',
        available: false,
        reason: 'not-own',
        message: `${name} is not in Pi's own skills folder, and changes where it is`,
      });
    }
    expect(remove('plugin:npm:@acme/pi-tools:lint', join(home, 'kept', 'lint'))).toMatchObject({
      available: false,
      reason: 'not-own',
      message: 'It comes with the npm:@acme/pi-tools plugin and changes with it',
    });
    // Its switches are still `pi config`'s.
    expect(pi.plan!(work, heldSkill(inventory, 'mine'), 'disable')).toMatchObject({
      available: false,
      reason: 'in-app',
    });
  });

  it('reads the link it planned back as its own skill, and plans taking it away as an unlink', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'pi-7c1e');
    const folder = join(home, 'kept', 'release-notes');
    await write(join(folder, 'SKILL.md'), skill('release-notes', 'Drafts the notes'));
    const pi = createPiExtensionService({ home, now });
    const work = managedProfile(root);
    const plan = ExtensionActPlanSchema.parse(pi.plan!(work, placed('release-notes', folder), 'add'));
    const step = plan.available && plan.runs.kind === 'files' ? plan.runs.steps[0] : undefined;
    if (step?.op !== 'link') throw new Error('expected a link');
    // The runtime performs the step itself; here, by hand.
    await mkdir(dirname(step.path), { recursive: true });
    await symlink(step.target, step.path);

    const inventory = await read(home, root);
    expect(heldSkill(inventory, 'release-notes')).toEqual({
      kind: 'skill',
      id: 'release-notes',
      name: 'release-notes',
      origin: 'own',
      enabled: true,
      description: 'Drafts the notes',
      location: step.path,
      linkTarget: folder,
    });
    expect(pi.plan!(work, heldSkill(inventory, 'release-notes'), 'remove')).toMatchObject({
      available: true,
      runs: { kind: 'files', steps: [{ op: 'unlink', path: step.path }] },
    });
  });
});

describe('Pi package acts', () => {
  const PI = '/opt/pi/bin/pi';

  /** A managed agent directory holding an npm, a git and a local package and a loose extension, read. */
  async function readPackages() {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'pi-7c1e');
    const agent = join(root, 'agent');
    await write(join(agent, 'settings.json'), {
      packages: ['npm:@acme/pi-tools@1.2.0', 'git:github.com/northlight/pi-review@v2', './local-ext.ts'],
    });
    await write(join(agent, 'npm', 'node_modules', '@acme', 'pi-tools', 'package.json'), {
      name: '@acme/pi-tools',
      version: '1.2.0',
    });
    await write(join(agent, 'git', 'github.com', 'northlight', 'pi-review', 'package.json'), {
      name: 'pi-review',
      version: '2.0.1',
    });
    await write(join(agent, 'local-ext.ts'), 'export default () => {};\n');
    await write(join(agent, 'extensions', 'notify.ts'), 'export default () => {};\n');
    const pi = createPiExtensionService({ executable: PI, home, now });
    const inventory = ExtensionInventorySchema.parse(await pi.inventory(managedProfile(root)));
    const held = (id: string): PluginItem => {
      const item = find(inventory, 'plugin', id);
      if (item?.kind !== 'plugin') throw new Error(`no package ${id}`);
      return item;
    };
    return { home, agent, pi, work: managedProfile(root), held };
  }

  it('removes and updates a package by the source Pi keys it with, the removal offline', async () => {
    const { agent, pi, work, held } = await readPackages();
    const local = join(agent, 'local-ext.ts');
    for (const [id, source] of [
      ['npm:@acme/pi-tools', 'npm:@acme/pi-tools'],
      ['git:github.com/northlight/pi-review', 'git:github.com/northlight/pi-review'],
      [`local:${local}`, local],
    ] as const) {
      expect(ExtensionActPlanSchema.parse(pi.plan!(work, held(id), 'remove')), id).toEqual({
        target: { kind: 'plugin', id },
        act: 'remove',
        available: true,
        runs: { kind: 'command', argv: [PI, 'remove', source], env: { PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1' } },
        display: `${PI} remove ${source}`,
        reaches: [],
      });
      if (id.startsWith('local:')) continue;
      expect(ExtensionActPlanSchema.parse(pi.plan!(work, held(id), 'update')), id).toEqual({
        target: { kind: 'plugin', id },
        act: 'update',
        available: true,
        runs: { kind: 'command', argv: [PI, 'update', source], env: { PI_CODING_AGENT_DIR: agent } },
        display: `${PI} update ${source}`,
        reaches: [],
      });
    }
    // a package from a folder is used where it is: nothing newer to fetch
    expect(pi.plan!(work, held(`local:${local}`), 'update')).toEqual({
      target: { kind: 'plugin', id: `local:${local}` },
      act: 'update',
      available: false,
      reason: 'no-command',
      message: 'A package from a folder on this Mac changes where it is',
    });
  });

  it("points nothing elsewhere for the native default, whose directory is Pi's own", async () => {
    const { home, pi, held } = await readPackages();
    const native = nativeProfile(home);
    expect(pi.plan!(native, held('npm:@acme/pi-tools'), 'remove')).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: [PI, 'remove', 'npm:@acme/pi-tools'], env: { PI_OFFLINE: '1' } },
    });
    const update = ExtensionActPlanSchema.parse(pi.plan!(native, held('npm:@acme/pi-tools'), 'update'));
    expect(update).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: [PI, 'update', 'npm:@acme/pi-tools'] },
    });
    expect(update).not.toHaveProperty('runs.env');
  });

  it("switches a package's parts only in pi config, and has no removal that takes more", async () => {
    const { pi, work, held } = await readPackages();
    for (const act of ['enable', 'disable'] as const) {
      expect(ExtensionActPlanSchema.parse(pi.plan!(work, held('npm:@acme/pi-tools'), act))).toEqual({
        target: { kind: 'plugin', id: 'npm:@acme/pi-tools' },
        act,
        available: false,
        reason: 'in-app',
        message: "Pi turns a package's parts on and off only in `pi config`",
      });
    }
    expect(pi.plan!(work, held('git:github.com/northlight/pi-review'), 'purge')).toEqual({
      target: { kind: 'plugin', id: 'git:github.com/northlight/pi-review' },
      act: 'purge',
      available: false,
      reason: 'unsupported',
      message: "Pi's remove is its one way to take a package out",
    });
  });

  it('leaves a loose extension where it is: pi config filters it, and no command of Pi takes it', async () => {
    const { agent, pi, work, held } = await readPackages();
    const id = `extension:${join(agent, 'extensions', 'notify.ts')}`;
    for (const act of ['enable', 'disable'] as const) {
      expect(pi.plan!(work, held(id), act), act).toEqual({
        target: { kind: 'plugin', id },
        act,
        available: false,
        reason: 'in-app',
        message: 'Pi turns an extension on and off only in `pi config`',
      });
    }
    for (const act of ['remove', 'purge', 'update'] as const) {
      expect(pi.plan!(work, held(id), act), act).toEqual({
        target: { kind: 'plugin', id },
        act,
        available: false,
        reason: 'no-command',
        message: 'It is an extension Pi loads from where it is, and changes there',
      });
    }
  });

  it('refuses a source its commands could misread, and acts a package has none of', async () => {
    const { pi, work, held } = await readPackages();
    const pack = (id: string): PluginItem => ({ kind: 'plugin', id, name: 'pack', origin: 'own', enabled: true });
    for (const id of [
      'npm:',
      'npm:-g',
      'git:-oProxyCommand=touch/x',
      'local:',
      'local:relative/pack',
      'local:/tmp/pack\nrm',
      'npm:@acme/pi-tools\u0007',
      '-rf',
      'https://example.com/pack',
    ]) {
      for (const act of ['remove', 'update'] as const) {
        expect(pi.plan!(work, pack(id), act), JSON.stringify([id, act])).toEqual({
          target: { kind: 'plugin', id },
          act,
          available: false,
          reason: 'no-command',
          // a folder's package has no update whatever its path says
          message:
            act === 'update' && id.startsWith('local:')
              ? 'A package from a folder on this Mac changes where it is'
              : "Pi's commands do not take this package's source",
        });
      }
    }
    expect(pi.plan!(work, { ...pack('npm:org-pack'), origin: 'managed' }, 'remove')).toMatchObject({
      available: false,
      reason: 'not-own',
      message: "Pi's app or your organization adds it, and changes it",
    });
    expect(pi.plan!(work, held('npm:@acme/pi-tools'), 'add')).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: 'Pi installs a package from npm, git or a path',
    });
    for (const act of ['sign-in', 'sign-out'] as const) {
      expect(pi.plan!(work, held('npm:@acme/pi-tools'), act), act).toMatchObject({
        available: false,
        reason: 'unsupported',
        message: 'Pi has no sign-in for a package',
      });
    }
  });
});
