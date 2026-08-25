import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadModel } from '@vibecook/chopsticks-surface';

const version = '0.20.0';
const vendorRoot = dirname(fileURLToPath(import.meta.url));
const model = loadModel(join(vendorRoot, 'model', `hermes@${version}`));

describe(`the Hermes ${version} candidate ASM`, () => {
  it('keeps argv, terminal, gateway, hooks, webhooks, state, and ACP rails distinct', () => {
    expect(Object.keys(model.channels.channels).sort()).toEqual([
      'acp',
      'argv',
      'outbound-webhook',
      'plugin-hook',
      'state-db',
      'terminal',
      'tui-gateway',
    ]);
  });

  it('models observed JSON-RPC methods and does not claim a prompt receipt id', () => {
    const events = new Map(model.events.map((event) => [event.event, event]));
    expect(events.get('prompt.submit')?.resultSchema?.properties?.status).toMatchObject({ enum: ['streaming'] });
    expect(events.get('message.complete')?.variants?.map((variant) => variant.match.status).sort()).toEqual([
      'complete',
      'interrupted',
    ]);
    expect(events.has('session.compress')).toBe(false);
  });
});
