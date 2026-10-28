/**
 * The bearer of Puppeteer's Hermes gateway host.
 *
 * The host drives one AIAgent and its tools, so it admits only the clients of
 * the one launch that minted its token: the adapter's JSON-RPC client and the
 * native TUI. Both present the token in the URL's query, the form Hermes's own
 * dashboard hands the TUI in `HERMES_TUI_GATEWAY_URL` (`?token=`); the TUI
 * connects to that URL verbatim, reconnects to it, and redacts the query from
 * its logs. `scripts/tui-gateway-host.py` checks the same parameter.
 */

import { randomBytes } from 'node:crypto';

export const HERMES_GATEWAY_TOKEN_PARAM = 'token';

/** A fresh token for one host. Never reused across launches. */
export function createHermesGatewayToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The URL a client dials. Without a token it is the URL as given, for a gateway that admits anyone. */
export function authorizedGatewayUrl(url: string, token: string | undefined): string {
  if (token === undefined) return url;
  const authorized = new URL(url);
  authorized.searchParams.set(HERMES_GATEWAY_TOKEN_PARAM, token);
  return authorized.toString();
}
