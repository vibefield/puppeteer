import { describe, expect, it } from 'vitest';
import type { AgentHost } from '@vibefield/puppeteer-core';
import { createBuiltinAgentRuntime } from './runtime.js';

const live = process.env.PUPPETEER_DISTRIBUTION_LIVE === '1';

/**
 * Opt-in proof against the real machine: discovers installed agents, reads
 * their versions, runs a native update oracle, and lists native-default
 * profiles. It is read-only: it never creates a profile, never updates an
 * install, never logs in, and never spawns a terminal.
 */
describe.skipIf(!live)('distribution and profiles against installed agents (PUPPETEER_DISTRIBUTION_LIVE=1)', () => {
  it('inspects installations, plans their updates, runs the Grok oracle, and lists native-default profiles', async () => {
    const host: AgentHost = {
      async spawnTerminal() {
        throw new Error('the live distribution proof never spawns terminals');
      },
      async automateTerminal() {
        return { accepted: false, reason: 'live distribution proof' };
      },
    };
    const runtime = createBuiltinAgentRuntime({ host, defaultCwd: process.cwd() });
    try {
      const installations = await runtime.inspectInstallations({ refresh: true });
      console.log(
        installations
          .map(
            (install) =>
              `${install.provider}\t${install.version ?? '?'}\t${install.method}\tactive=${install.active}\t${install.origin}\t${install.realPath}` +
              (install.warnings.length ? `\twarnings=${install.warnings.join(' | ')}` : ''),
          )
          .join('\n'),
      );
      expect(installations.length).toBeGreaterThan(0);
      expect(installations.filter((install) => install.active).length).toBeGreaterThan(0);

      // The release line each adapter maps, and what Update would run — planned, never run.
      for (const install of installations) {
        const plan = await runtime.planUpdate({ providerId: install.provider, executable: install.executable });
        console.log(
          `${install.provider}\tline=${install.releaseChannel ?? '?'}\t` +
            ('status' in plan
              ? `no plan (${plan.status}): ${plan.message}`
              : `${plan.recipe.kind}\t${plan.argv?.join(' ') ?? '(manual)'}`),
        );
        if (!('status' in plan)) expect(plan.executable).toBe(install.executable);
      }

      const grok = await runtime.checkReleases({ providerId: 'grok', network: false });
      console.log(JSON.stringify(grok, null, 1));

      const profiles = await runtime.profiles();
      console.log(
        profiles
          .map((profile) => `${profile.provider}\t${profile.kind}\t${profile.label}\t${profile.dataRoot}`)
          .join('\n'),
      );
      expect(profiles.some((profile) => profile.kind === 'native-default')).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 180_000);
});

describe.skipIf(!live)(
  'managed profile lifecycle against the installed Claude CLI (PUPPETEER_DISTRIBUTION_LIVE=1)',
  () => {
    it('creates a managed profile in a temporary registry, verifies it as logged out, and removes it', async () => {
      const { mkdtemp, rm, readFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const scratch = await mkdtemp(join(tmpdir(), 'puppeteer-profile-live-'));
      const host: AgentHost = {
        async spawnTerminal() {
          throw new Error('the live profile proof never spawns terminals');
        },
        async automateTerminal() {
          return { accepted: false, reason: 'live profile proof' };
        },
      };
      const storePath = join(scratch, 'profiles.json');
      const registry = {
        async load() {
          try {
            return JSON.parse(await readFile(storePath, 'utf8'));
          } catch {
            return undefined;
          }
        },
        async save(snapshot: unknown) {
          const { writeFile } = await import('node:fs/promises');
          await writeFile(storePath, JSON.stringify(snapshot), { mode: 0o600 });
        },
      };
      const runtime = createBuiltinAgentRuntime({
        host,
        defaultCwd: process.cwd(),
        profiles: { store: registry, rootsDirectory: join(scratch, 'roots') },
      });
      try {
        const created = await runtime.createProfile({ providerId: 'claude', label: 'Live proof' });
        expect('id' in created).toBe(true);
        if (!('id' in created)) return;
        expect(created.dataRoot.startsWith(join(scratch, 'roots'))).toBe(true);
        const binding = await runtime.profileBindingEnvironment([created.id]);
        console.log(
          'binding variables:',
          Object.keys(binding).join(','),
          '→ root under scratch:',
          binding[Object.keys(binding)[0]!] === created.dataRoot,
        );
        const identity = await runtime.verifyProfile(created.id);
        console.log('identity:', JSON.stringify(identity));
        expect('loggedIn' in identity && identity.loggedIn === false).toBe(true);
        const stored = await runtime.profile(created.id);
        expect(stored?.identity?.loggedIn).toBe(false);
        expect(await runtime.removeProfile(created.id)).toBe(true);
        expect(await runtime.profile(created.id)).toBeUndefined();
      } finally {
        await runtime.dispose();
        await rm(scratch, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
