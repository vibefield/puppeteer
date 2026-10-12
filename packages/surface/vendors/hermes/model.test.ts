import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadModel } from '@vibefield/puppeteer-surface';

const version = '0.20.0';
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

  it('retains the complete source inventory while keeping runtime occurrence separate', () => {
    const events = new Map(model.events.map((event) => [event.event, event]));
    expect(model.manifest.asmVersion).toBe(3);
    expect(sourceReference.gateway.methods).toHaveLength(130);
    expect(sourceReference.gateway.events).toHaveLength(60);
    expect(sourceReference.hooks.events).toHaveLength(23);
    expect(sourceReference).toMatchObject({
      referenceVersion: 2,
      workspaceMutation: {
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
      },
    });
    expect(events.get('prompt.submit')?.resultSchema?.properties?.status).toMatchObject({ type: 'string' });
    expect(events.get('prompt.submit')?.resultSchema?.properties).not.toHaveProperty('prompt_id');
    expect(
      events
        .get('message.complete')
        ?.variants?.map((variant) => variant.match.status)
        .sort(),
    ).toEqual(['complete', 'error', 'interrupted']);
    expect(events.get('session.compress')).toMatchObject({
      channel: 'tui-gateway',
      transport: 'jsonrpc-request',
      confidence: 'unverified',
    });
    expect(events.get('tool.complete')?.payloadSchema?.properties).toMatchObject({
      args: { type: 'object' },
      result: {},
      inline_diff: {
        type: 'string',
        description: expect.stringContaining('not a raw unified patch'),
      },
    });
    expect(events.get('tool.complete')?.payloadRefinements).toEqual([
      expect.objectContaining({
        match: { name: 'patch' },
        path: 'args',
        fidelity: 'structural',
        schema: expect.objectContaining({ required: ['path'] }),
      }),
      expect.objectContaining({
        match: { name: 'write_file' },
        path: 'args',
        fidelity: 'structural',
        schema: expect.objectContaining({ required: ['path'] }),
      }),
    ]);
  });
});
