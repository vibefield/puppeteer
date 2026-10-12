/**
 * Opt-in probe: what a typed `codex <args>` means when it runs plainly (the control), and what the
 * managed recipe makes of the same arguments (the treatment) — a private app-server, a thread the
 * controller starts and materializes, and `codex resume <thread> … --remote <addr>` in a PTY.
 * Hermetic: an isolated CODEX_HOME and HOME and a loopback Responses endpoint, so no account and no
 * model is reached. What the TUI sends is read through the adapter's own tap; what the session
 * means is read from the request that reaches the model. The cases, their results and what they
 * settled are recorded in packages/surface/vendors/codex/probes/codex@0.157.1/.
 *
 *   CODEX_INVOCATION_LIVE=1 CODEX_INVOCATION_CASES=<cases.json> CODEX_INVOCATION_OUT=<out.json> \
 *     CODEX_INVOCATION_ROOT=<an empty directory of your own> TMPDIR=/tmp \
 *     pnpm vitest run src/launch/invocation-probe.live.test.ts
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { resolveCodexExecutable } from '../detection.js';
import { normalizeCodexNativeInvocation } from './native-invocation.js';
import { prepareCodexTuiSession, type PreparedCodexTuiSession } from './tui-session.js';
import { AppServerClient } from '../transport/app-server-client.js';
import { spawnAppServer } from '../transport/app-server-process.js';
import {
  appServerRemoteAddress,
  connectAppServerEndpoint,
  createWebSocketTapProxy,
} from '../transport/ws-transport.js';
import {
  isolatedCodexLiveEnvironment,
  startCodexLoopbackProvider,
  writeCodexLiveConfiguration,
} from '../test-support/live-model.js';
import { CodexLivePtyHost, delay, waitFor } from '../test-support/live-pty-host.js';

const live = process.env.CODEX_INVOCATION_LIVE === '1';
const PROMPT = 'Reply with the single word ok.';

interface ProbeCase {
  id: string;
  /**
   * `control` runs `codex <typed>` plainly; `managed` runs the recipe; `typed-remote` runs
   * `codex --remote <tap> <typed>`, a typed TUI that starts its OWN thread on a server we tap —
   * the path a typed `codex` takes to the shared daemon — so its thread/start is visible. Such a
   * TUI sends no cwd, so the server works in ITS directory: a typed-remote case must name `-C`.
   * `recipe` runs the production path: the adapter's normalizer, then `prepareCodexTuiSession`.
   */
  mode: 'control' | 'managed' | 'typed-remote' | 'recipe';
  typed?: string[];
  start?: Record<string, unknown>;
  /** Arguments after `resume <thread>` and before `--remote` (a prompt goes here). */
  beforeRemote?: string[];
  /** Arguments after `--remote <addr>`. */
  afterRemote?: string[];
  /** Paste the harmless prompt once the TUI is up (when the argv carries none). */
  paste?: boolean;
  /** Extra config.toml lines. */
  config?: string[];
  /** Files to create in the workspace (relative path → content; `b64:` prefix for binary). */
  files?: Record<string, string>;
  /** Arguments for the private `codex app-server`, ahead of `--listen`. */
  appServerArgs?: string[];
  /** Directories to create under the case root (for `--add-dir`); `<root>` in any argument is the case root. */
  dirs?: string[];
}

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function rawOutput(host: CodexLivePtyHost, id: string): string {
  const records = (host as unknown as { records: Map<string, { output: string }> }).records;
  return records.get(id)?.output ?? '';
}

function exited(host: CodexLivePtyHost, id: string): boolean {
  const records = (host as unknown as { records: Map<string, { exited: boolean }> }).records;
  return records.get(id)?.exited ?? true;
}

function processesUnder(root: string): number[] {
  try {
    const table = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    return table
      .split('\n')
      .filter((line) => line.includes(root))
      .map((line) => Number(line.trim().split(/\s+/u)[0]))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

function descendants(pid: number): number[] {
  try {
    const table = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
    const children = new Map<number, number[]>();
    for (const line of table.split('\n')) {
      const [p, pp] = line.trim().split(/\s+/u).map(Number);
      if (!p || pp === undefined) continue;
      children.set(pp, [...(children.get(pp) ?? []), p]);
    }
    const out: number[] = [];
    const walk = (at: number): void => {
      for (const child of children.get(at) ?? []) {
        out.push(child);
        walk(child);
      }
    };
    walk(pid);
    return out;
  } catch {
    return [];
  }
}

function summarizeModelRequest(body: unknown, root: string): Record<string, unknown> {
  const scrub = (text: string): string => text.split(root).join('<root>');
  const record = body as {
    model?: unknown;
    tools?: unknown[];
    input?: unknown[];
    instructions?: unknown;
    reasoning?: unknown;
    text?: unknown;
  };
  const tools = Array.isArray(record.tools)
    ? record.tools.map((tool) => {
        const t = tool as { type?: unknown; name?: unknown };
        return `${String(t.type)}${t.name ? `:${String(t.name)}` : ''}`;
      })
    : [];
  const webSearch = Array.isArray(record.tools)
    ? record.tools.find((tool) => (tool as { type?: unknown }).type === 'web_search')
    : undefined;
  const markers: string[] = [];
  let promptDelivered = false;
  const images: string[] = [];
  // The exact text codex writes for the model about permissions and the filesystem: equal
  // digests between a typed run and the managed recipe mean the model was told the same thing.
  const blocks: Record<string, string> = {};
  for (const item of Array.isArray(record.input) ? record.input : []) {
    const message = item as { role?: unknown; content?: unknown; type?: unknown };
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      const p = part as { type?: unknown; text?: unknown };
      if (p.type === 'input_image') images.push(String(message.role));
      if (typeof p.text !== 'string') continue;
      if (p.text.includes(PROMPT)) promptDelivered = true;
      for (const [name, pattern] of [
        ['permissions', /<permissions instructions>[\s\S]*?<\/permissions instructions>/u],
        ['filesystem', /<filesystem>[\s\S]*?<\/filesystem>/u],
      ] as const) {
        const found = pattern.exec(p.text)?.[0];
        if (found && blocks[name] === undefined) blocks[name] = scrub(found);
      }
      for (const line of p.text.split('\n')) {
        if (
          /sandbox_mode|approval_policy|approval|writable roots|network access|<cwd>|permission_profile/iu.test(line)
        ) {
          markers.push(`${String(message.role)}: ${scrub(line.trim()).slice(0, 600)}`);
        }
      }
    }
  }
  const digest = (text: string | undefined): string | undefined =>
    text === undefined ? undefined : createHash('sha256').update(text).digest('hex').slice(0, 16);
  return {
    model: record.model,
    tools,
    webSearch,
    reasoning: record.reasoning,
    text: record.text,
    instructionsLength: typeof record.instructions === 'string' ? record.instructions.length : undefined,
    promptDelivered,
    images,
    markers,
    permissionsDigest: digest(blocks.permissions),
    filesystemDigest: digest(blocks.filesystem),
    blocks,
  };
}

describe.runIf(live)('codex invocation probe (live, hermetic)', () => {
  it('runs each case', async () => {
    const cases = JSON.parse(readFileSync(process.env.CODEX_INVOCATION_CASES!, 'utf8')) as ProbeCase[];
    const results: Record<string, unknown>[] = [];
    const executable = resolveCodexExecutable();
    for (const probe of cases) {
      const root = realpathSync(mkdtempSync(join(realpathSync(process.env.CODEX_INVOCATION_ROOT!), 'p-')));
      const at = (argument: string): string => argument.split('<root>').join(root);
      const codexHome = join(root, 'codex-home');
      const cwd = join(root, 'workspace');
      mkdirSync(cwd, { recursive: true });
      for (const dir of probe.dirs ?? []) mkdirSync(at(dir), { recursive: true });
      for (const [path, content] of Object.entries(probe.files ?? {})) {
        mkdirSync(join(cwd, path, '..'), { recursive: true });
        if (content === 'png') writeFileSync(join(cwd, path), Buffer.from(ONE_PIXEL_PNG, 'base64'));
        else writeFileSync(join(cwd, path), content);
      }
      const provider = await startCodexLoopbackProvider();
      writeCodexLiveConfiguration(codexHome, cwd, provider.baseUrl);
      if (probe.config) {
        const path = join(codexHome, 'config.toml');
        writeFileSync(path, `${probe.config.join('\n')}\n${readFileSync(path, 'utf8')}`);
      }
      const environment = isolatedCodexLiveEnvironment(root, codexHome);
      const host = new CodexLivePtyHost();
      const tapped: Array<{ method: string; params: unknown }> = [];
      const result: Record<string, unknown> = { id: probe.id, mode: probe.mode, startedAt: new Date().toISOString() };
      const scrub = (value: unknown): unknown =>
        JSON.parse(
          JSON.stringify(value ?? null)
            .split(root)
            .join('<root>'),
        );
      let server: ReturnType<typeof spawnAppServer> | undefined;
      let controller: AppServerClient | undefined;
      let tap: ReturnType<typeof createWebSocketTapProxy> | undefined;
      let terminalId: string | undefined;
      let prepared: PreparedCodexTuiSession | undefined;
      try {
        if (probe.mode === 'control') {
          const args = (probe.typed ?? []).map(at);
          result.argv = probe.typed ?? [];
          ({ runtimeSessionId: terminalId } = await host.spawnTerminal({
            command: executable,
            args,
            cwd,
            env: environment,
          }));
        } else if (probe.mode === 'recipe') {
          const typed = (probe.typed ?? []).map(at);
          result.argv = probe.typed ?? [];
          const resolution = normalizeCodexNativeInvocation({
            providerId: 'codex',
            cwd,
            argv: typed,
            environment: {},
            implementation: { kind: 'native' },
          });
          if (resolution.status !== 'accepted') throw new Error(`not accepted: ${JSON.stringify(resolution)}`);
          const carried = resolution.options ?? {};
          result.carried = JSON.parse(JSON.stringify(carried).split(root).join('<root>'));
          prepared = await prepareCodexTuiSession({
            ...carried,
            cwd,
            executable,
            host,
            env: environment,
            appServerEnv: environment,
            appServerTransport: 'websocket',
            ...(resolution.resume ? { resume: resolution.resume } : {}),
          });
          result.launch = prepared.launch.args.map((argument) =>
            argument === prepared!.sessionId
              ? '<thread>'
              : argument.startsWith('ws://')
                ? '<addr>'
                : argument.split(root).join('<root>'),
          );
          ({ runtimeSessionId: terminalId } = await host.spawnTerminal(prepared.launch));
        } else if (probe.mode === 'typed-remote') {
          if (!(probe.typed ?? []).some((argument) => argument === '-C' || argument.startsWith('--cd'))) {
            throw new Error('a typed-remote case must name -C: the TUI sends no cwd to a bare --remote');
          }
          server = spawnAppServer({ executable, transport: 'websocket', env: environment });
          await server.ready(30_000);
          const endpoint = server.endpoint();
          tap = createWebSocketTapProxy(endpoint, (message) => {
            const m = message as { method?: unknown; params?: unknown };
            if (typeof m.method === 'string') tapped.push({ method: m.method, params: m.params });
          });
          await tap.ready();
          const args = ['--remote', appServerRemoteAddress(tap.endpoint()), ...(probe.typed ?? []).map(at)];
          result.argv = ['--remote', '<addr>', ...(probe.typed ?? [])];
          ({ runtimeSessionId: terminalId } = await host.spawnTerminal({
            command: executable,
            args,
            cwd,
            env: environment,
          }));
        } else {
          server = spawnAppServer({
            executable,
            transport: 'websocket',
            env: environment,
            ...(probe.appServerArgs ? { args: probe.appServerArgs.map(at) } : {}),
          });
          result.appServerArgs = probe.appServerArgs ?? [];
          await server.ready(30_000);
          const endpoint = server.endpoint();
          controller = new AppServerClient(connectAppServerEndpoint(endpoint));
          await controller.request('initialize', {
            clientInfo: { name: 'puppeteer-probe', version: '0' },
            capabilities: {},
          });
          controller.notify('initialized');
          const startParams = JSON.parse(
            JSON.stringify(probe.start ?? {})
              .split('<root>')
              .join(root),
          ) as Record<string, unknown>;
          const started = (await controller.request('thread/start', { cwd, ...startParams })) as {
            thread?: { id?: string };
            model?: unknown;
            sandbox?: unknown;
            approvalPolicy?: unknown;
            approvalsReviewer?: unknown;
          };
          const threadId = started.thread?.id;
          if (!threadId) throw new Error('no thread id');
          result.start = probe.start ?? {};
          result.startResponse = scrub({
            model: started.model,
            sandbox: started.sandbox,
            approvalPolicy: started.approvalPolicy,
            approvalsReviewer: started.approvalsReviewer,
          });
          await controller.request('thread/inject_items', { threadId, items: [{ type: 'text', text: '' }] });
          const resumed = (await controller.request('thread/resume', { threadId })) as Record<string, unknown>;
          result.controllerResume = scrub({
            model: resumed.model,
            sandbox: resumed.sandbox,
            approvalPolicy: resumed.approvalPolicy,
          });
          tap = createWebSocketTapProxy(endpoint, (message) => {
            const m = message as { method?: unknown; params?: unknown };
            if (typeof m.method === 'string') tapped.push({ method: m.method, params: m.params });
          });
          await tap.ready();
          const args = [
            'resume',
            threadId,
            ...(probe.beforeRemote ?? []).map(at),
            '--remote',
            appServerRemoteAddress(tap.endpoint()),
            ...(probe.afterRemote ?? []).map(at),
          ];
          result.argv = [
            'resume',
            '<thread>',
            ...(probe.beforeRemote ?? []),
            '--remote',
            '<addr>',
            ...(probe.afterRemote ?? []),
          ];
          ({ runtimeSessionId: terminalId } = await host.spawnTerminal({
            command: executable,
            args,
            cwd,
            env: environment,
          }));
        }
        const id = terminalId;
        await delay(4_000);
        if (probe.paste) {
          await waitFor(() => host.output(id).length > 200 || exited(host, id), 'TUI drawn', 60_000);
          if (exited(host, id)) throw new Error('the TUI exited before the prompt could be pasted');
          await delay(2_000);
          await host.automateTerminal(id, { kind: 'paste', text: PROMPT, submit: true });
        }
        try {
          await waitFor(
            () => provider.requests.some(({ kind }) => kind === 'turn') || exited(host, id),
            'a model turn request',
            60_000,
          );
          if (exited(host, id)) result.tuiExited = true;
          await delay(2_000);
        } catch {
          result.noTurn = true;
        }
        const turns = provider.requests.filter(({ kind }) => kind === 'turn');
        if (turns[0]) result.request = summarizeModelRequest(turns[0].body, root);
        result.turnRequests = turns.length;
        result.requestCount = provider.requests.length;
        result.tui = tapped
          .filter(({ method }) => ['thread/resume', 'turn/start', 'thread/start'].includes(method))
          .map(({ method, params }) => ({ method, params: scrub(params) }));
        result.tuiMethods = tapped.map(({ method }) => method);
      } catch (error) {
        result.error = String(error instanceof Error ? error.message : error)
          .split(root)
          .join('<root>')
          .slice(0, 2_000);
      } finally {
        if (terminalId) {
          result.altScreen = rawOutput(host, terminalId).includes('\u001b[?1049h');
          result.screen = host.output(terminalId).split(root).join('<root>').slice(-2_500);
        }
        const terminalPid = terminalId ? Number(terminalId.replace('codex-live-terminal-', '')) : undefined;
        const owned = [
          ...(terminalPid ? [terminalPid, ...descendants(terminalPid)] : []),
          ...(server?.process.pid ? descendants(server.process.pid) : []),
        ];
        await host.dispose();
        await prepared?.dispose().catch(() => undefined);
        await controller?.close().catch(() => undefined);
        await tap?.dispose().catch(() => undefined);
        await server?.dispose().catch(() => undefined);
        await provider.close();
        await delay(1_000);
        const alive = (pid: number): boolean => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        // A plain codex may start a detached daemon under its CODEX_HOME: every process whose
        // command line names this case's root is ours, and none may outlive the case.
        const survivors = [...new Set([...owned.filter(alive), ...processesUnder(root)])];
        for (const pid of survivors) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
        result.ownedProcesses = owned.length;
        result.survivorsKilled = survivors.length;
        result.root = root;
      }
      results.push(result);
      writeFileSync(process.env.CODEX_INVOCATION_OUT!, JSON.stringify(results, null, 2));
    }
  }, 1_800_000);
});
