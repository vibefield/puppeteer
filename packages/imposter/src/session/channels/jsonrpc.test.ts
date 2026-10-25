import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createAppServerChannel, requestFirstAnswer } from './jsonrpc.ts';

/** One server-side channel and the client end that reads its requests and writes replies. */
function client(log: string[] = []) {
  const toClient = new PassThrough();
  const toServer = new PassThrough();
  const channel = createAppServerChannel({
    input: toServer,
    output: toClient,
    jsonrpc: '2.0',
    serve: async () => ({}),
    log: (message) => log.push(message),
  });
  const requests: Array<{ id: number; method: string }> = [];
  let buffer = '';
  toClient.setEncoding('utf8');
  toClient.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      requests.push(JSON.parse(buffer.slice(0, newline)) as { id: number; method: string });
      buffer = buffer.slice(newline + 1);
    }
  });
  const reply = (id: number, body: Record<string, unknown>) =>
    toServer.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
  return { channel, requests, reply, log };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('requestFirstAnswer', () => {
  it('takes the first answer, abandons the others, and logs a late answer instead of applying it', async () => {
    const controller = client();
    const viewer = client();
    const answer = requestFirstAnswer([controller.channel, viewer.channel], 'session/request_permission', {});
    await tick();
    expect(controller.requests).toHaveLength(1);
    expect(viewer.requests).toHaveLength(1);

    viewer.reply(viewer.requests[0]!.id, { result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    controller.reply(controller.requests[0]!.id, { result: { outcome: { outcome: 'cancelled' } } });
    await tick();
    expect(controller.log).toContain(`received response for unknown request id: ${controller.requests[0]!.id}`);
  });

  it('lets a refusal lose rather than win, and fails only when every client refused', async () => {
    const controller = client();
    const viewer = client();
    const answer = requestFirstAnswer([controller.channel, viewer.channel], 'session/request_permission', {});
    await tick();
    viewer.reply(viewer.requests[0]!.id, { error: { code: -32601, message: 'a viewer cannot answer' } });
    await tick();
    controller.reply(controller.requests[0]!.id, { result: { outcome: { outcome: 'selected', optionId: 'deny' } } });
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });

    const refused = requestFirstAnswer([controller.channel, viewer.channel], 'session/request_permission', {});
    await tick();
    controller.reply(controller.requests[1]!.id, { error: { code: -32601, message: 'no' } });
    viewer.reply(viewer.requests[1]!.id, { error: { code: -32601, message: 'no' } });
    await expect(refused).rejects.toThrow('no');
  });
});
