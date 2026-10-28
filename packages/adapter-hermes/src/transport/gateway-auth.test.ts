import { describe, expect, it } from 'vitest';
import { authorizedGatewayUrl, createHermesGatewayToken } from './gateway-auth.js';

describe('Hermes gateway bearer', () => {
  it('mints a fresh URL-safe token for every launch', () => {
    const tokens = new Set(Array.from({ length: 8 }, () => createHermesGatewayToken()));
    expect(tokens.size).toBe(8);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('presents the token as the query Hermes clients already send', () => {
    expect(authorizedGatewayUrl('ws://127.0.0.1:41234/api/ws', 'launch-token_0')).toBe(
      'ws://127.0.0.1:41234/api/ws?token=launch-token_0',
    );
    expect(authorizedGatewayUrl('ws://127.0.0.1:41234/api/ws?token=stale', 'launch-token_0')).toBe(
      'ws://127.0.0.1:41234/api/ws?token=launch-token_0',
    );
  });

  it('leaves the URL as given when there is no token', () => {
    expect(authorizedGatewayUrl('ws://127.0.0.1:41234/api/ws', undefined)).toBe('ws://127.0.0.1:41234/api/ws');
  });
});
