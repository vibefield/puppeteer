import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNoEgress, egressDestination, startEgressRecorder } from './egress-guard.mjs';
import {
  createIsolatedRoot,
  egressEnvironment,
  FAIL_CLOSED_BASE_URL,
  FAIL_CLOSED_PROXY_URL,
  isolatedEnvironment,
  removeIsolatedRoot,
} from './isolation.mjs';

const PROXY_VARIABLES = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'];

/** Send one proxy request the way an HTTP(S) client honoring the proxy variables would. */
function viaProxy(proxyUrl, { method, path, headers = {} }) {
  const { hostname, port } = new URL(proxyUrl);
  return new Promise((resolveStatus, rejectStatus) => {
    const outgoing = request({ hostname, port, method, path, headers });
    outgoing.on('connect', (response, socket) => {
      socket.destroy();
      resolveStatus(response.statusCode);
    });
    outgoing.on('response', (response) => {
      response.resume();
      resolveStatus(response.statusCode);
    });
    outgoing.on('error', rejectStatus);
    outgoing.end();
  });
}

describe('census egress recorder', () => {
  let recorder;
  afterEach(async () => {
    await recorder?.close();
    recorder = undefined;
  });

  it('refuses CONNECT and absolute-form requests and keeps only their destination', async () => {
    recorder = await startEgressRecorder();
    recorder.lane = 'interactive';
    expect(
      await viaProxy(recorder.url, {
        method: 'CONNECT',
        path: 'api.anthropic.com:443',
        headers: { authorization: 'Bearer census-secret' },
      }),
    ).toBe(403);
    recorder.lane = 'resume';
    expect(await viaProxy(recorder.url, { method: 'GET', path: 'http://platform.claude.com/v1/oauth/token?x=1' })).toBe(
      403,
    );
    expect(recorder.attempts).toEqual([
      { lane: 'interactive', destination: 'api.anthropic.com:443' },
      { lane: 'resume', destination: 'platform.claude.com:80' },
    ]);
    expect(JSON.stringify(recorder.attempts)).not.toMatch(/census-secret|oauth|x=1/);
    expect(() => assertNoEgress(recorder, 'interactive')).toThrow(/interactive -> api\.anthropic\.com:443/);
    expect(() => assertNoEgress(recorder)).toThrow(/2 non-loopback/);
  });

  it('does not fail a lane whose only attempts were loopback', async () => {
    recorder = await startEgressRecorder();
    recorder.lane = 'api-error-500';
    expect(await viaProxy(recorder.url, { method: 'CONNECT', path: '127.0.0.1:9' })).toBe(403);
    expect(recorder.attempts).toHaveLength(1);
    expect(() => assertNoEgress(recorder, 'api-error-500')).not.toThrow();
  });

  it('records an unparseable target without echoing it', () => {
    expect(egressDestination('CONNECT', 'user:pass@host:443')).toBe('unparsed');
    expect(egressDestination('GET', '/relative/path')).toBe('unparsed');
    expect(egressDestination('GET', 'https://Example.com/a')).toBe('example.com:443');
  });
});

describe('isolated environment egress defaults', () => {
  it('closes the model endpoint and every proxy variable, exempting only loopback', () => {
    const layout = createIsolatedRoot();
    try {
      const environment = isolatedEnvironment(layout);
      expect(environment.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL).toBe('1');
      expect(environment.ANTHROPIC_BASE_URL).toBe(FAIL_CLOSED_BASE_URL);
      for (const name of PROXY_VARIABLES) expect(environment[name]).toBe(FAIL_CLOSED_PROXY_URL);
      expect(environment.NO_PROXY).toBe('127.0.0.1,localhost,::1');
      const recorded = isolatedEnvironment(layout, egressEnvironment('http://127.0.0.1:4100'));
      for (const name of PROXY_VARIABLES) expect(recorded[name]).toBe('http://127.0.0.1:4100');
    } finally {
      removeIsolatedRoot(layout);
    }
  });
});
