import { describe, expect, it } from 'vitest';
import { profileSetPlans, type ProfileSetPlansInput } from './profile-plans.js';
import type { AgentProfile, ProfileIdentity, ProfileSignIn, SignInService } from './profiles.js';

const AT = '2026-09-24T09:00:00.000Z';
const SOURCE = { kind: 'native-status', stability: 'documented' } as const;
const ANTHROPIC: SignInService = { id: 'anthropic', label: 'Anthropic' };
const OPENAI: SignInService = { id: 'openai', label: 'OpenAI' };
const GITHUB: SignInService = { id: 'github', label: 'GitHub' };
const KIMI: SignInService = { id: 'kimi', label: 'Moonshot AI' };
const OPENCODE: SignInService = { id: 'opencode', label: 'OpenCode' };

// Only `support.service` is read; a harness like Pi declares none.
const PROVIDERS = [
  { id: 'claude', support: { service: ANTHROPIC } },
  { id: 'codex', support: { service: OPENAI } },
  { id: 'copilot', support: { service: GITHUB } },
  { id: 'opencode', support: { service: OPENCODE } },
  { id: 'pi', support: {} },
  { id: 'hermes', support: {} },
];

function identity(fields: Partial<ProfileIdentity>): ProfileIdentity {
  return { loggedIn: true, verifiedAt: AT, source: SOURCE, ...fields };
}

function harness(signIns: ProfileSignIn[]): ProfileIdentity {
  return identity({ loggedIn: signIns.length > 0, signIns });
}

function profile(id: string, provider: string, set: string, who?: ProfileIdentity): AgentProfile {
  return {
    id,
    provider,
    label: set,
    kind: set === 'native' ? 'native-default' : 'managed',
    dataRoot: `/profiles/${set}/${provider}`,
    createdAt: AT,
    set,
    ...(who !== undefined ? { identity: who } : {}),
  };
}

function set(id: string, profiles: AgentProfile[]): ProfileSetPlansInput {
  return { set: { id }, profiles };
}

describe('profileSetPlans', () => {
  it('reads each vendor agent as one sign-in to its own service, named by it', () => {
    const [work] = profileSetPlans(
      [
        set('work', [
          profile(
            'w-claude',
            'claude',
            'work',
            identity({ email: 'kim@work.example', plan: 'max', method: 'claude.ai' }),
          ),
          profile('w-codex', 'codex', 'work', identity({ email: 'kim@work.example', plan: 'pro' })),
        ]),
      ],
      PROVIDERS,
    );
    expect(work!.plans).toEqual([
      {
        id: 'anthropic',
        service: ANTHROPIC,
        account: { email: 'kim@work.example', plan: 'max' },
        namedBy: 'w-claude',
        holders: ['w-claude'],
        alsoIn: [],
      },
      {
        id: 'openai',
        service: OPENAI,
        account: { email: 'kim@work.example', plan: 'pro' },
        namedBy: 'w-codex',
        holders: ['w-codex'],
        alsoIn: [],
      },
    ]);
    expect(work!.holdings['w-claude']).toEqual([
      {
        service: ANTHROPIC,
        method: 'claude.ai',
        email: 'kim@work.example',
        plan: 'max',
        key: false,
        planId: 'anthropic',
        runsOn: true,
      },
    ]);
  });

  it('puts a harness sign-in that names no account on the plan its company’s agent named, and a key on none', () => {
    const [work] = profileSetPlans(
      [
        set('work', [
          profile('w-codex', 'codex', 'work', identity({ email: 'kim@work.example', plan: 'pro' })),
          profile(
            'w-opencode',
            'opencode',
            'work',
            harness([
              { service: OPENCODE, method: 'console', email: 'kim@work.example', organization: 'Northlight' },
              { service: OPENAI, method: 'oauth', subscription: true },
              { service: ANTHROPIC, method: 'api-key' },
            ]),
          ),
        ]),
      ],
      PROVIDERS,
    );
    expect(work!.plans.map((plan) => [plan.id, plan.holders, plan.namedBy])).toEqual([
      ['openai', ['w-codex', 'w-opencode'], 'w-codex'],
      ['opencode', ['w-opencode'], 'w-opencode'],
    ]);
    // the first subscription is the one it runs on; the key is on no plan
    expect(
      work!.holdings['w-opencode']!.map((held) => [held.service.id, held.planId ?? null, held.key, held.runsOn]),
    ).toEqual([
      ['opencode', 'opencode', false, false],
      ['openai', 'openai', false, true],
      ['anthropic', null, true, false],
    ]);
  });

  it('gives a sign-in no agent names an unnamed plan of its service, and follows the one in use', () => {
    const [personal] = profileSetPlans(
      [
        set('personal', [
          profile('p-claude', 'claude', 'personal', identity({ email: 'kim@home.example', plan: 'max' })),
          profile(
            'p-pi',
            'pi',
            'personal',
            harness([
              { service: KIMI, method: 'oauth', subscription: true },
              { service: ANTHROPIC, method: 'oauth', subscription: true, inUse: true },
            ]),
          ),
        ]),
      ],
      PROVIDERS,
    );
    expect(personal!.plans).toEqual([
      {
        id: 'anthropic',
        service: ANTHROPIC,
        account: { email: 'kim@home.example', plan: 'max' },
        namedBy: 'p-claude',
        holders: ['p-claude', 'p-pi'],
        alsoIn: [],
      },
      { id: 'kimi', service: KIMI, holders: ['p-pi'], alsoIn: [] },
    ]);
    expect(personal!.holdings['p-pi']!.map((held) => [held.planId, held.runsOn])).toEqual([
      ['kimi', false],
      ['anthropic', true],
    ]);
  });

  it('says a borrowed sign-in is the machine’s: the same account in every set that borrows it', () => {
    const plans = profileSetPlans(
      [
        set('native', [
          profile(
            'copilot:native-default',
            'copilot',
            'native',
            identity({ method: 'user', account: 'kim', plan: 'individual' }),
          ),
        ]),
        set('work', [
          profile(
            'w-copilot',
            'copilot',
            'work',
            identity({ method: 'gh-cli', account: 'Kim', borrowedFrom: 'GitHub CLI' }),
          ),
          profile(
            'w-hermes',
            'hermes',
            'work',
            harness([{ service: GITHUB, method: 'gh-cli', borrowedFrom: 'GitHub CLI', inUse: true }]),
          ),
        ]),
        set('personal', [
          profile(
            'p-hermes',
            'hermes',
            'personal',
            harness([{ service: GITHUB, method: 'gh-cli', borrowedFrom: 'GitHub CLI', inUse: true }]),
          ),
        ]),
      ],
      PROVIDERS,
    );
    const [native, work, personal] = plans;
    // a GitHub login is one account whatever its case
    expect(work!.plans).toEqual([
      {
        id: 'github',
        service: GITHUB,
        account: { account: 'Kim' },
        namedBy: 'w-copilot',
        borrowedFrom: 'GitHub CLI',
        holders: ['w-copilot', 'w-hermes'],
        alsoIn: ['native', 'personal'],
      },
    ]);
    expect(native!.plans[0]!.alsoIn).toEqual(['work']);
    expect(personal!.plans).toEqual([
      { id: 'github', service: GITHUB, borrowedFrom: 'GitHub CLI', holders: ['p-hermes'], alsoIn: ['work'] },
    ]);
  });

  it('keeps two accounts with one company apart, and puts an unnamed sign-in on its own agent’s', () => {
    const [work] = profileSetPlans(
      [
        set('work', [
          profile(
            'w-hermes',
            'hermes',
            'work',
            harness([
              { service: OPENAI, method: 'oauth', subscription: true, email: 'other@work.example', inUse: true },
            ]),
          ),
          profile('w-codex', 'codex', 'work', identity({ email: 'kim@work.example', plan: 'pro' })),
          profile(
            'w-pi',
            'pi',
            'work',
            harness([{ service: OPENAI, method: 'oauth', subscription: true, inUse: true }]),
          ),
        ]),
      ],
      PROVIDERS,
    );
    expect(work!.plans.map((plan) => [plan.id, plan.account?.email, plan.namedBy, plan.holders])).toEqual([
      ['openai', 'other@work.example', 'w-hermes', ['w-hermes']],
      ['openai-2', 'kim@work.example', 'w-codex', ['w-codex', 'w-pi']],
    ]);
    expect(work!.holdings['w-pi']![0]!.planId).toBe('openai-2');
  });

  it('prefers the service’s own agent when two agents name the same account', () => {
    const [work] = profileSetPlans(
      [
        set('work', [
          profile(
            'w-hermes',
            'hermes',
            'work',
            harness([{ service: OPENAI, method: 'oauth', email: 'Kim@Work.example', plan: 'plus', inUse: true }]),
          ),
          profile('w-codex', 'codex', 'work', identity({ email: 'kim@work.example', plan: 'pro' })),
        ]),
      ],
      PROVIDERS,
    );
    expect(work!.plans).toEqual([
      {
        id: 'openai',
        service: OPENAI,
        account: { email: 'kim@work.example', plan: 'pro' },
        namedBy: 'w-codex',
        holders: ['w-hermes', 'w-codex'],
        alsoIn: [],
      },
    ]);
  });

  it('holds nothing for an agent that is unread, signed out, or has no service to be signed in to', () => {
    const [work] = profileSetPlans(
      [
        set('work', [
          profile('w-claude', 'claude', 'work'),
          profile('w-codex', 'codex', 'work', identity({ loggedIn: false })),
          profile('w-pi', 'pi', 'work', harness([])),
          profile('w-other', 'unknown-agent', 'work', identity({ email: 'kim@work.example' })),
        ]),
      ],
      PROVIDERS,
    );
    expect(work).toEqual({ setId: 'work', plans: [], holdings: {} });
  });

  it('runs on a key when the agent uses one', () => {
    const [work] = profileSetPlans(
      [
        set('work', [
          profile(
            'w-pi',
            'pi',
            'work',
            harness([
              { service: ANTHROPIC, method: 'oauth', subscription: true },
              { service: OPENAI, method: 'api-key', inUse: true },
            ]),
          ),
        ]),
      ],
      PROVIDERS,
    );
    expect(
      work!.holdings['w-pi']!.map((held) => [held.service.id, held.key, held.runsOn, held.planId ?? null]),
    ).toEqual([
      ['anthropic', false, false, 'anthropic'],
      ['openai', true, true, null],
    ]);
    expect(work!.plans.map((plan) => plan.id)).toEqual(['anthropic']);
  });
});
