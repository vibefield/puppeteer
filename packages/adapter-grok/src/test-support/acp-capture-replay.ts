/**
 * Replays a committed Grok ACP wire capture (Surface
 * `captures/grok@<version>/<scenario>/acp-*.jsonl`) as an in-memory ACP agent,
 * so the adapter's real control composition consumes the exact frames the
 * pinned binary sent. A client request returns its captured result after every
 * agent frame recorded before that result has reached the client handler, in
 * capture order; `drain()` delivers the frames that follow the last result.
 * Unpublished test support.
 */

import { readFileSync } from 'node:fs';
import type { AcpConnector } from '@vibefield/puppeteer-adapter-acp';

type ToClient = Parameters<AcpConnector>[0];
type AcpClient = ReturnType<ToClient>;
type AcpAgent = Parameters<ToClient>[0];

export interface CapturedAcpFrame {
  direction: 'client-to-agent' | 'agent-to-client';
  message: {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: unknown;
  };
}

export function readAcpCapture(path: string): CapturedAcpFrame[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CapturedAcpFrame);
}

export interface AcpCaptureReplay {
  connector: AcpConnector;
  /** Deliver every remaining agent frame (those after the last client request's result). */
  drain(): Promise<void>;
}

export function replayAcpCapture(frames: readonly CapturedAcpFrame[]): AcpCaptureReplay {
  let cursor = 0;
  let client: AcpClient | undefined;

  async function deliver(frame: CapturedAcpFrame): Promise<void> {
    const { id, method, params = {} } = frame.message;
    if (!client || frame.direction !== 'agent-to-client' || method === undefined) return;
    if (id !== undefined) {
      // The captured client answer is not replayed; the composition under test answers.
      if (method === 'session/request_permission') await client.requestPermission(params as never);
      return;
    }
    if (method === 'session/update') await client.sessionUpdate(params as never);
    else await client.extNotification?.(method, params);
  }

  async function respond(method: string): Promise<never> {
    const request = frames.findIndex(
      (frame, index) =>
        index >= cursor &&
        frame.direction === 'client-to-agent' &&
        frame.message.method === method &&
        frame.message.id !== undefined,
    );
    if (request < 0) throw new Error(`the capture has no further ${method} request`);
    const id = frames[request]!.message.id;
    while (cursor < frames.length) {
      const frame = frames[cursor]!;
      cursor += 1;
      if (
        cursor - 1 > request &&
        frame.direction === 'agent-to-client' &&
        frame.message.method === undefined &&
        frame.message.id === id
      ) {
        if (frame.message.error !== undefined) throw new Error(JSON.stringify(frame.message.error));
        return frame.message.result as never;
      }
      await deliver(frame);
    }
    throw new Error(`the capture has no result for ${method}`);
  }

  const connector: AcpConnector = (toClient) => {
    const agent = {
      initialize: () => respond('initialize'),
      newSession: () => respond('session/new'),
      loadSession: () => respond('session/load'),
      prompt: () => respond('session/prompt'),
      cancel: async () => undefined,
    } as unknown as AcpAgent;
    client = toClient(agent);
    return { agent, onClose: () => undefined, close: () => undefined };
  };

  return {
    connector,
    async drain() {
      while (cursor < frames.length) {
        const frame = frames[cursor]!;
        cursor += 1;
        await deliver(frame);
      }
    },
  };
}
