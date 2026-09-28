import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibecook/puppeteer-core';
import {
  captureClaudeContinuationState,
  normalizeClaudeNativeInvocation,
  restoreClaudeContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'claude',
  cwd: '/repo',
  argv,
  environment: {},
  implementation: { kind: 'native' },
  ...over,
});

const imposter = { kind: 'imposter' as const, executable: '/opt/ai', stateRoot: '/tmp/claude-imposter' };

describe('Claude native invocation normalization', () => {
  // Every typed launch is marked `typed`: its recipe then names no permission mode of its own.
  it('normalizes explicit resume, picker resume, and supported launch intent', () => {
    const id = '64a61b19-f4d8-4f96-ba56-07024b470813';
    expect(normalizeClaudeNativeInvocation(invocation(['--resume', id]))).toEqual({
      status: 'accepted',
      resume: id,
      options: { typed: true },
    });
    expect(normalizeClaudeNativeInvocation(invocation(['--continue', '--model', 'sonnet']))).toEqual({
      status: 'accepted',
      options: { typed: true, model: 'sonnet', resumeInvocation: ['--continue'] },
    });
    expect(
      normalizeClaudeNativeInvocation(
        invocation(['--setting-sources', 'project,local'], { environment: { CLAUDE_CONFIG_DIR: '../profile' } }),
      ),
    ).toEqual({
      status: 'accepted',
      options: { typed: true, settingSources: ['project', 'local'], configDir: '/profile' },
    });
  });

  it('carries what the person typed: their arguments, their prompt, their name for the session', () => {
    expect(
      normalizeClaudeNativeInvocation(
        invocation(['-n', 'triage', '--dangerously-skip-permissions', 'fix the bug', '--add-dir', '../lib']),
      ),
    ).toEqual({
      status: 'accepted',
      options: {
        typed: true,
        title: 'triage',
        carriedArgs: ['--dangerously-skip-permissions', '--add-dir', '../lib'],
        prompt: ['fix the bug'],
      },
    });
    expect(normalizeClaudeNativeInvocation(invocation(['--restricted']))).toEqual({
      status: 'accepted',
      options: {
        typed: true,
        carriedArgs: ['--restricted'],
        existingStatusLine: null,
        existingSubagentStatusLine: null,
      },
    });
  });

  it('answers a passthrough, with its kind, for what is not a session', () => {
    expect(normalizeClaudeNativeInvocation(invocation(['--version']))).toEqual({
      status: 'passthrough',
      kind: 'utility',
      reason: 'it prints the version',
    });
    expect(normalizeClaudeNativeInvocation(invocation(['mcp', 'list']))).toMatchObject({
      status: 'passthrough',
      kind: 'utility',
    });
    expect(normalizeClaudeNativeInvocation(invocation(['-p', 'summarize']))).toMatchObject({
      status: 'passthrough',
      kind: 'one-shot',
    });
    expect(normalizeClaudeNativeInvocation(invocation(['--bg', 'write tests']))).toMatchObject({
      status: 'passthrough',
      kind: 'elsewhere',
    });
  });

  it('rejects unsupported or malformed native arguments, naming the argument', () => {
    expect(normalizeClaudeNativeInvocation(invocation(['--model']))).toEqual({
      status: 'rejected',
      reason: 'it needs a value',
      argument: '--model',
    });
    expect(normalizeClaudeNativeInvocation(invocation(['--setting-sources', 'managed'])).status).toBe('rejected');
    expect(normalizeClaudeNativeInvocation(invocation(['--bare']))).toEqual({
      status: 'rejected',
      reason: 'it turns off the hooks a managed session is observed through',
      argument: '--bare',
    });
    expect(normalizeClaudeNativeInvocation(invocation(['--yolo']))).toMatchObject({
      status: 'rejected',
      argument: '--yolo',
    });
    expect(normalizeClaudeNativeInvocation(invocation([], { providerId: 'codex' }))).toEqual({
      status: 'rejected',
      reason: 'provider mismatch',
    });
  });

  it('keeps an imposter launch to the options the imposter takes, carrying nothing', () => {
    expect(normalizeClaudeNativeInvocation(invocation([], { implementation: imposter }))).toEqual({
      status: 'accepted',
      options: {
        typed: true,
        executable: '/opt/ai',
        env: { AI_PERSONA: 'claude', PUPPETEER_IMPOSTER_HOME: imposter.stateRoot },
      },
    });
    expect(
      normalizeClaudeNativeInvocation(invocation(['-c', '--model', 'opus', '-n', 'x'], { implementation: imposter })),
    ).toMatchObject({ status: 'accepted', options: { model: 'opus', title: 'x', resumeInvocation: ['-c'] } });
    // `ai --claude --help` lists --session-id, --resume, --settings, -n/--name, --permission-mode and
    // --model; it ignores anything else, so a carried argument or a prompt would silently not happen.
    for (const [argv, argument] of [
      [['--verbose'], '--verbose'],
      [['fix the bug'], 'fix the bug'],
      [['--dangerously-skip-permissions'], '--dangerously-skip-permissions'],
      [['--from-pr', '42'], '--from-pr'],
    ] as const) {
      expect(normalizeClaudeNativeInvocation(invocation([...argv], { implementation: imposter }))).toEqual({
        status: 'rejected',
        reason: 'the Claude imposter does not take it',
        argument,
      });
    }
    // What is not a session is the same fact whichever implementation would run a session.
    expect(normalizeClaudeNativeInvocation(invocation(['--version'], { implementation: imposter }))).toMatchObject({
      status: 'passthrough',
      kind: 'utility',
    });
  });

  it('owns imposter environment and continuation state', () => {
    const imposterRoot = '/tmp/claude-imposter';
    const state = captureClaudeContinuationState({ configDir: '../profile' }, '/repo', {});
    expect(restoreClaudeContinuationState(state)).toEqual({ configDir: '/profile' });
    const imposterState = captureClaudeContinuationState(
      { env: { AI_PERSONA: 'claude', PUPPETEER_IMPOSTER_HOME: imposterRoot } },
      '/repo',
      {},
    );
    expect(restoreClaudeContinuationState(imposterState, { imposterExecutable: '/opt/ai' })).toEqual({
      executable: '/opt/ai',
      env: { AI_PERSONA: 'claude', PUPPETEER_IMPOSTER_HOME: imposterRoot },
    });
    expect(restoreClaudeContinuationState(JSON.stringify({ kind: 'claude', configDir: '/legacy' }))).toEqual({
      configDir: '/legacy',
    });
    expect(() =>
      restoreClaudeContinuationState(JSON.stringify({ version: 2, configDir: '/profile', extra: true })),
    ).toThrow('invalid Claude continuation state');
  });

  it('persists nothing a typed launch carried: those arguments belong to the launch that was typed, not a resume', () => {
    const typed = normalizeClaudeNativeInvocation(
      invocation(['-n', 'mine', '--dangerously-skip-permissions', '--add-dir', '../lib', 'fix it'], {
        environment: { CLAUDE_CONFIG_DIR: '/profile' },
      }),
    );
    if (typed.status !== 'accepted') throw new Error('expected an accepted invocation');
    const state = captureClaudeContinuationState(typed.options, '/repo', {});
    expect(JSON.parse(state!)).toEqual({ version: 2, configDir: '/profile' });
    expect(restoreClaudeContinuationState(state)).toEqual({ configDir: '/profile' });
    const prompted = normalizeClaudeNativeInvocation(invocation(['fix it']));
    if (prompted.status !== 'accepted') throw new Error('expected an accepted invocation');
    expect(captureClaudeContinuationState(prompted.options, '/repo', {})).toBeUndefined();
  });
});
