// What Codex makes of an MCP server configured `auth = "ema_auth"` (enterprise-managed), with no account and no
// enterprise IdP profile: what `config/read` returns for it, what `codex mcp list --json` reports, and what
// `codex mcp login` and `codex mcp logout` answer. The adapter's sign-in acts rest on it (services/extensions.ts).
//
//   node ema-auth-probe.mjs <codex executable> <an empty directory of your own>
//
// Run it with an allowlisted environment and no network, e.g. under
// `sandbox-exec -p '(version 1)(allow default)(deny network-outbound (remote ip))'` on macOS: nothing here needs the
// network, and the app-server's curated-plugin sync would otherwise reach it. HOME, CODEX_HOME and TMPDIR are
// pointed into the directory; nothing outside it is read or written. The output names no path. The executable is
// taken as a path, never looked up on PATH (the operator's own, signed-in codex), and PATH keeps no other codex.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hermeticPath, resolveCodexExecutable } from '../../census/harness.mjs';

const [named, root] = process.argv.slice(2);
if (!named || !root) throw new Error('usage: ema-auth-probe.mjs <codex executable> <empty directory>');
const bin = resolveCodexExecutable({ bin: named });
if (readdirSync(root).length > 0) throw new Error(`${root} is not empty`);
const home = join(root, 'home');
const codexHome = join(root, 'codex-home');
const tmp = join(root, 'tmp');
const cwd = join(root, 'workspace');
for (const directory of [home, codexHome, tmp, cwd]) mkdirSync(directory, { recursive: true });
writeFileSync(
  join(codexHome, 'config.toml'),
  [
    '[mcp_servers.ema-docs]',
    'url = "https://mcp.invalid/ema-docs"',
    'auth = "ema_auth"',
    '',
    '[mcp_servers.plain]',
    'url = "https://mcp.invalid/plain"',
    '',
  ].join('\n'),
);
const env = {
  PATH: hermeticPath(process.env.PATH ?? '/usr/bin:/bin', bin),
  HOME: home,
  CODEX_HOME: codexHome,
  TMPDIR: tmp,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_CACHE_HOME: join(home, '.cache'),
};
const firstLine = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
const run = (args) => {
  const result = spawnSync(bin, args, { cwd, env, encoding: 'utf8', input: '', timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, firstStderrLine: firstLine(result.stderr ?? '') };
};

async function configRead() {
  const child = spawn(bin, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let buffer = '';
  let id = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
      } catch {
        // not protocol
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    await request('initialize', { clientInfo: { name: 'ema-auth-probe', version: '0.0.0' }, capabilities: {} });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const read = await request('config/read', {});
    const servers = read.result?.config?.mcp_servers ?? {};
    return {
      error: read.error ? { code: read.error.code, firstLine: firstLine(read.error.message) } : null,
      auth: Object.fromEntries(
        Object.keys(servers)
          .sort()
          .map((name) => [name, servers[name]?.auth ?? null]),
      ),
      originKeys: Object.keys(read.result?.origins ?? {})
        .filter((key) => key.startsWith('mcp_servers.'))
        .sort(),
    };
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
  }
}

const version = run(['--version']).stdout.trim();
const list = run(['mcp', 'list', '--json']);
let listed = null;
try {
  listed = JSON.parse(list.stdout).map((entry) => ({ name: entry.name, auth_status: entry.auth_status }));
} catch {
  // reported through status and stderr
}
const login = run(['mcp', 'login', 'ema-docs']);
const logout = run(['mcp', 'logout', 'ema-docs']);
console.log(
  JSON.stringify(
    {
      version,
      configRead: await configRead(),
      mcpList: { status: list.status, servers: listed, firstStderrLine: listed ? null : list.firstStderrLine },
      mcpLogin: { status: login.status, firstStderrLine: login.firstStderrLine },
      mcpLogout: { status: logout.status, firstStderrLine: logout.firstStderrLine },
    },
    null,
    2,
  ),
);
