import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPersonaSessionId, loadPersona, personaDirectory } from './load.ts';
import { OP_NAMES } from './types.ts';

describe('loadPersona', () => {
  it('loads the claude persona against the Surface-owned ASM', () => {
    const persona = loadPersona('claude');
    expect(persona.vendor).toBe('claude');
    // Version comes from the ASM manifest, never from persona.json — the
    // captured model is the single source of vendor truth (§3.3).
    expect(persona.version).toBe('2.1.226');
    expect(persona.channels).toEqual(['argv', 'hook', 'transcript', 'statusline', 'subagentStatusLine', 'terminal']);
  });

  it('exposes ASM payload validation over the full wire payload, envelope included', () => {
    const persona = loadPersona('claude');
    // `validate` sees exactly what hits the bridge: the session merges its
    // envelope (session_id/transcript_path/cwd) and the emitter appends
    // hook_event_name, so a payload missing them is genuinely off-model.
    const envelope = {
      session_id: 's',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp',
      hook_event_name: 'Notification',
    };
    expect(
      persona.validate('Notification', {
        ...envelope,
        message: 'fine',
        notification_type: 'idle_prompt',
        prompt_id: 'p',
      }),
    ).toEqual([]);
    expect(persona.validate('Notification', { ...envelope, message: 42 })).toContain(
      'field "message" is number, expected string',
    );
    expect(persona.validate('Notification', { message: 'fine' })).toContain('missing required field "session_id"');
  });

  it('reads argv flag aliases out of detection.json rather than hardcoding them', () => {
    const persona = loadPersona('claude');
    expect(persona.flagsFor('name', '--name')).toEqual(['-n', '--name']);
    expect(persona.flagsFor('sessionId', '--session-id')).toEqual(['--session-id']);
    expect(persona.flagsFor('resume', '--resume')).toEqual(['--resume']);
    // Unknown keys fall back rather than throwing: a persona may reference a
    // flag a given vendor version does not advertise.
    expect(persona.flagsFor('nonesuch', '--fallback')).toEqual(['--fallback']);
  });

  it('mints session identities from each persona instead of leaking vendor conventions to callers', () => {
    expect(createPersonaSessionId('opencode')).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(createPersonaSessionId('claude')).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  });

  it('binds every op it declares to a channel the ASM knows', () => {
    const persona = loadPersona('claude');
    for (const [op, bindings] of Object.entries(persona.ops)) {
      expect(OP_NAMES).toContain(op);
      for (const binding of bindings) {
        if (binding.channel === 'hook') expect(persona.schemaFor(binding.event!)).toBeDefined();
      }
    }
    // session.ready is the driver's boot-finished signal; without it a spawned
    // session never reaches `ready`.
    expect(persona.ops['session.ready']).toBeDefined();
  });

  it('declares boot ops that all exist in the ops document', () => {
    const persona = loadPersona('claude');
    for (const invocation of persona.document.boot) {
      expect(persona.ops[invocation.op], `boot op ${invocation.op} is unmapped`).toBeDefined();
    }
  });

  it('loads curated runflows as references to executable scenario truth', () => {
    const claude = loadPersona('claude');
    const claudeResearch = claude.runflows.find((flow) => flow.id === 'deep-research');
    expect(claudeResearch).toMatchObject({
      intent: 'workflow.research.deep',
      scenario: 'deep-research',
      steps: 30,
      requiresClient: false,
    });
    expect(claudeResearch?.events).toEqual(
      expect.arrayContaining(['SubagentStart', 'PreToolUse', 'PreCompact', 'PostCompact', 'Stop']),
    );
    const codexApproval = loadPersona('codex').runflows.find((flow) => flow.id === 'cross-layer-implementation');
    expect(codexApproval).toMatchObject({
      intent: 'workflow.implementation.cross-layer',
      steps: 30,
      requiresClient: true,
    });
    expect(codexApproval?.channels).toContain('appserver');
    expect(loadPersona('grok').runflows.map((flow) => flow.intent)).toEqual([
      'session.compaction',
      'subagent.lifecycle',
    ]);
    expect(loadPersona('synthetic').runflows).toEqual([]);
  });

  it('resolves personas by name only, rejecting traversal', () => {
    expect(() => personaDirectory('../../etc')).toThrow(/lowercase letters/);
    expect(() => personaDirectory('Claude')).toThrow(/lowercase letters/);
  });
});

describe('loadPersona validation', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'puppeteer-persona-'));
    mkdirSync(join(dir, 'broken'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (persona: unknown, ops: unknown): string => {
    writeFileSync(join(dir, 'broken', 'persona.json'), JSON.stringify(persona));
    writeFileSync(join(dir, 'broken', 'ops.json'), JSON.stringify(ops));
    return join(dir, 'broken');
  };

  const validPersona = {
    vendor: 'broken',
    asm: {
      package: '@vibecook/puppeteer-surface',
      path: 'vendors/claude',
    },
    shimNames: ['broken'],
    envelope: { session_id: '$sessionId' },
    eventNameField: 'hook_event_name',
    boot: [],
  };

  it('rejects an op bound to a hook event the ASM has never seen', () => {
    const directory = write(validPersona, {
      'turn.end': [{ channel: 'hook', event: 'NoSuchHookEvent', with: {} }],
    });
    expect(() => loadPersona('broken', { directory })).toThrow(/not in the ASM/);
  });

  it('rejects an event binding placed on a native rail the ASM does not declare for it', () => {
    const directory = write(validPersona, {
      'turn.end': [{ channel: 'transcript', event: 'Stop', with: {} }],
    });
    expect(() => loadPersona('broken', { directory })).toThrow(
      /binds Stop to transcript, but the ASM declares it on hook/,
    );
  });

  it('rejects an unknown op name', () => {
    const directory = write(validPersona, { 'turn.teleport': [{ channel: 'hook', event: 'Stop' }] });
    expect(() => loadPersona('broken', { directory })).toThrow(/unknown op/);
  });

  it('rejects a persona whose declared vendor does not match its directory', () => {
    const directory = write({ ...validPersona, vendor: 'somethingelse' }, {});
    expect(() => loadPersona('broken', { directory })).toThrow(/declares vendor/);
  });

  it('rejects a served method that is not a modeled client request', () => {
    const directory = write({ ...validPersona, asm: { ...validPersona.asm, path: 'vendors/codex' } }, {});
    writeFileSync(join(directory, 'serve.json'), JSON.stringify({ 'thread/started': { result: {} } }));
    expect(() => loadPersona('broken', { directory })).toThrow(/not declare it as a client-to-agent JSON-RPC request/);
  });

  it('rejects a served request whose result is not modeled', () => {
    const directory = write({ ...validPersona, asm: { ...validPersona.asm, path: 'vendors/codex' } }, {});
    writeFileSync(join(directory, 'serve.json'), JSON.stringify({ 'account/read': { result: {} } }));
    expect(() => loadPersona('broken', { directory })).toThrow(/has no result schema/);
  });

  it('rejects a runflow whose scenario reference is missing', () => {
    const directory = write(validPersona, {});
    writeFileSync(
      join(directory, 'runflows.json'),
      JSON.stringify({
        version: 1,
        flows: [
          {
            id: 'missing',
            intent: 'turn.basic',
            scenario: 'missing',
            title: 'Missing flow',
            summary: 'Must never silently become a dead button.',
            kind: 'typical',
          },
        ],
      }),
    );
    expect(() => loadPersona('broken', { directory })).toThrow(/references missing scenario/);
  });

  it('derives runflow facts from the referenced scenario instead of catalog prose', () => {
    const directory = write(validPersona, {});
    mkdirSync(join(directory, 'scenarios'));
    writeFileSync(
      join(directory, 'scenarios', 'one-event.json'),
      JSON.stringify({ name: 'one-event', steps: [{ emit: { event: 'Notification', with: {} } }] }),
    );
    writeFileSync(
      join(directory, 'runflows.json'),
      JSON.stringify({
        version: 1,
        flows: [
          {
            id: 'one-event',
            intent: 'turn.notification',
            scenario: 'one-event',
            title: 'One event',
            summary: 'Executable metadata comes from the scenario.',
            kind: 'typical',
          },
        ],
      }),
    );
    expect(loadPersona('broken', { directory }).runflows[0]).toMatchObject({
      steps: 1,
      events: ['Notification'],
      channels: ['hook'],
      requiresClient: false,
    });
  });
});
