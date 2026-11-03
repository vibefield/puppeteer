import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadModel } from '@vibefield/puppeteer-surface';

const version = '0.21.5';
const vendorRoot = dirname(fileURLToPath(import.meta.url));
const model = loadModel(vendorRoot);
const sourceReference = JSON.parse(
  readFileSync(`${vendorRoot}/references/hermes@${version}/gateway-surface.json`, 'utf8'),
);

describe(`the Hermes ${version} candidate ASM`, () => {
  it('keeps argv, terminal, gateway, hooks, webhooks, state, and ACP rails distinct', () => {
    expect(Object.keys(model.channels.channels).sort()).toEqual([
      'acp',
      'argv',
      'outbound-webhook',
      'plugin-hook',
      'shell-hook',
      'state-db',
      'terminal',
      'tui-gateway',
    ]);
  });

  it('retains the complete contract inventory while keeping runtime occurrence separate', () => {
    const events = new Map(model.events.map((event) => [event.event, event]));
    expect(model.manifest.asmVersion).toBe(3);
    expect(model.manifest.vendorVersion).toBe(version);
    expect(sourceReference).toMatchObject({
      referenceVersion: 3,
      contract: { registryCrossCheck: { registeredMethods: 237, contractMethods: 237, agrees: true } },
    });
    expect(sourceReference.gateway.methods).toHaveLength(237);
    expect(sourceReference.gateway.serverRequests).toHaveLength(13);
    expect(sourceReference.gateway.events).toHaveLength(73);
    expect(sourceReference.hooks.events).toHaveLength(41);
    expect(model.events).toHaveLength(237 + 13 + 73 + 41);
    expect(sourceReference.workspaceMutation).toMatchObject({
      event: 'tool.complete',
      detailField: 'inline_diff',
      representation: 'ansi-rendered-diff-preview',
      maximumFiles: 6,
      maximumRenderedLines: 80,
      mayBeTruncated: true,
      singlePathTools: [
        { name: 'patch', pathField: 'path' },
        { name: 'write_file', pathField: 'path' },
      ],
      dynamicPathTools: ['skill_manage'],
    });
    expect(events.get('prompt.submit')?.resultSchema).toBeDefined();
    expect(JSON.stringify(events.get('prompt.submit')?.resultSchema)).not.toContain('prompt_id');
    expect(
      events
        .get('message.complete')
        ?.variants?.map((variant) => `${variant.match.status}:${variant.confidence}`)
        .sort(),
    ).toEqual(['complete:verified-headless', 'error:unverified', 'interrupted:verified-headless']);
    expect(events.get('session.compress')).toMatchObject({
      channel: 'tui-gateway',
      transport: 'jsonrpc-request',
      confidence: 'unverified',
    });
    expect(events.get('tool.complete')?.payloadRefinements).toEqual([
      expect.objectContaining({ match: { name: 'patch' }, path: 'args', fidelity: 'structural' }),
      expect.objectContaining({ match: { name: 'write_file' }, path: 'args', fidelity: 'structural' }),
    ]);
  });

  it('models 0.21 approvals and clarifications as server→client requests, not events', () => {
    const events = new Map(model.events.map((event) => [event.event, event]));
    expect(events.has('approval.request')).toBe(false);
    expect(events.has('clarify.request')).toBe(false);
    expect(events.get('approval')).toMatchObject({
      transport: 'jsonrpc-request',
      direction: 'agent-to-client',
      confidence: 'verified-headless',
      fixture: `captures/hermes@${version}/permission-deny/rpc.jsonl`,
    });
    expect(events.get('approval')?.payloadSchema?.$defs?.ApprovalRequestParams?.required).toEqual([
      'session_id',
      'request_id',
    ]);
    expect(events.get('clarify')).toMatchObject({ direction: 'agent-to-client', confidence: 'unverified' });
    expect(events.get('request.cancel')).toMatchObject({ transport: 'jsonrpc-notification' });
  });

  it('declares the closed session.resume params that refuse an unread cwd', () => {
    const resume = model.events.find((event) => event.event === 'session.resume');
    const params = resume?.payloadSchema?.$defs?.SessionResumeParams;
    expect(params?.additionalProperties).toBe(false);
    expect(Object.keys(params?.properties ?? {})).not.toContain('cwd');
    expect(resume?.confidence).toBe('verified-headless');
  });
});
