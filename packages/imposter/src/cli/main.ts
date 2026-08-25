/**
 * The `ai` entry point (draft/IMPOSTER.md §6).
 *
 * Answers the vendor's detection surface from the ASM (`--version`, `--help`),
 * then brings up a session on the vendor's real channels. The TUI is not here:
 * presentation is a sink the session writes frames to, and until phase I4 that
 * sink is a plain append-only stdout log. Headless is not a fallback — CI runs
 * it (§4.2).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { connectControl, type ImposterControl } from '../control/client.ts';
import { ControlError, nativeEventsFromModel, NOT_FOUND, opsFromPersona } from '../control/protocol.ts';
import { loadPersona, personaDirectory, shimNameMap } from '../persona/load.ts';
import type { Persona } from '../persona/types.ts';
import {
  createAppServerChannel,
  METHOD_NOT_FOUND,
  RpcError,
  type AppServerChannel,
} from '../session/channels/jsonrpc.ts';
import { connectUnixWebSocket, listenUnixWebSocket } from '../session/channels/ws-unix.ts';
import { connectLeaderAcp, listenLeaderRelay } from '../session/channels/leader-ipc.ts';
import { installPromptLine } from './prompt-line.ts';
import { createServeDispatcher, matchesInvocation } from '../session/serve.ts';
import { createImposterSession, type BehaviorDocument } from '../session/session.ts';
import { substitute } from '../session/template.ts';
import { createPresentation, type Presentation } from '../tui/mount.ts';
import { flagValue, hasFlag, PersonaSelectionError, selectPersona } from './argv.ts';
import { runHttpPersonaAttached, runHttpPersonaServer } from './http-persona.ts';

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/i;

function safeName(name: string, what: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`${what} must contain only letters, numbers, and hyphens`);
  return name;
}

function loadBehavior(persona: Persona, name: string): BehaviorDocument {
  const path = join(personaDirectory(persona.vendor), 'behavior', `${safeName(name, 'behavior name')}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as BehaviorDocument;
}

/** Named scenarios are persona-owned data; the control channel addresses them by name. */
function loadScenario(persona: Persona, name: string): unknown {
  const path = join(personaDirectory(persona.vendor), 'scenarios', `${safeName(name, 'scenario name')}.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ControlError(NOT_FOUND, `no scenario named ${name}`);
    }
    throw error;
  }
}

function detectionText(persona: Persona, field: string, fallback: string): string {
  const value = persona.model.detection[field];
  return typeof value === 'string' ? value : fallback;
}

/** Address schemes this build can actually serve. A persona may declare only these. */
const IMPLEMENTED_TRANSPORTS = new Set(['unix']);

/**
 * Own the coordination socket used by a leader-based vendor.
 *
 * Grok's controller and TUI both connect using the public leader framing. The
 * relay namespaces viewer request ids and routes them to the one controller
 * that owns the materialized session; it does not create another timeline.
 */
async function runLeader(persona: Persona, argv: readonly string[], log: (message: string) => void): Promise<number> {
  const spec = persona.serve?.$server?.leader;
  if (!spec) return 2;
  const socketPath = flagValue(argv, [spec.socketFlag]);
  if (!socketPath) {
    process.stderr.write(`${spec.socketFlag} requires a socket path\n`);
    return 2;
  }

  if (process.platform === 'win32') {
    process.stderr.write(`persona ${persona.vendor} leader sockets are not implemented on Windows\n`);
    return 2;
  }
  if (!existsSync(dirname(socketPath))) {
    process.stderr.write(`leader socket directory does not exist: ${dirname(socketPath)}\n`);
    return 2;
  }

  // The adapter gives every backend a private directory, so an existing name
  // means the invocation is malformed or stale. Refuse it: deleting a
  // caller-supplied socket could disconnect an unrelated local service.
  if (existsSync(socketPath)) {
    process.stderr.write(`leader socket path already exists: ${socketPath}\n`);
    return 2;
  }
  const relay = await listenLeaderRelay(socketPath, persona.version, log);
  log(`leader listening on ${socketPath}`);

  const close = (): void => {
    void relay.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  await new Promise(() => {});
  return 0;
}

/** A Grok terminal is an ACP client of the leader, never a second session. */
async function runLeaderViewer(
  persona: Persona,
  socketPath: string,
  sessionId: string,
  log: (message: string) => void,
): Promise<number> {
  let connection;
  try {
    connection = await connectLeaderAcp(socketPath, 'viewer', sessionId, persona.version, log);
  } catch (error) {
    process.stderr.write(
      `could not join leader at ${socketPath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const screen = await createPresentation({
    vendor: persona.vendor,
    version: persona.version,
    sessionId,
    channels: [persona.channelFor('jsonrpc') ?? 'acp', 'leader', 'terminal'],
  });
  let closing = false;
  let finish!: (exitCode: number) => void;
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const shutdown = async (exitCode = 0): Promise<void> => {
    if (closing) return;
    closing = true;
    if (screen.interactive && process.stdin.isTTY) process.stdout.write('\x1b[?2004l');
    connection.close();
    await screen.stop();
    finish(exitCode);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  const channel = createAppServerChannel({
    input: connection.input,
    output: connection.output,
    jsonrpc: '2.0',
    serve: (method) => Promise.reject(new RpcError(METHOD_NOT_FOUND, `a viewer cannot answer ${method}`)),
    notified: (method, params) => screen.frame({ at: new Date().toISOString(), op: method, with: params }),
    onClose: () => void shutdown(),
    log,
  });
  const failed = (what: string, error: unknown): void => {
    const message = `${what}: ${error instanceof Error ? error.message : String(error)}`;
    screen.notice(message);
    log(message);
  };

  try {
    await channel.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    await channel.request('session/load', { sessionId, cwd: process.cwd(), mcpServers: [] });
  } catch (error) {
    failed('leader attach failed', error);
    await shutdown(1);
    return finished;
  }
  screen.scenario('leader-attached');

  installPromptLine({
    interactive: screen.interactive,
    staged: (text) => screen.staged(text),
    submit: (text) => {
      log(`session/prompt on ${sessionId} (${text.length} chars)`);
      void channel
        .request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
        .catch((error: unknown) => failed('turn failed', error));
    },
    interrupt: () => void shutdown(),
    end: () => void shutdown(),
    log,
  });

  return finished;
}

/**
 * Where a serving invocation should listen, read from the persona's own
 * declaration rather than a hardcoded flag (serve.ts `ServeServer.listen`).
 *
 * No flag means stdio, which is the vendor's own default. An address the
 * imposter cannot honour is an error and never a quiet fallback to stdio: the
 * adapter waits for a socket file that would never appear, and "hung" is a much
 * worse thing to debug than "refused".
 */
function listenTarget(persona: Persona, argv: readonly string[]): { socketPath?: string } | { error: string } {
  const spec = persona.serve?.$server?.listen;
  if (!spec) return {};
  const address = flagValue(argv, [spec.flag]);
  if (address === undefined) return {};

  const match = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(address);
  if (!match) {
    return { error: `${spec.flag} expects an address like ${spec.transports[0] ?? 'unix'}:///path/to.sock` };
  }
  const scheme = match[1]!.toLowerCase();
  if (!spec.transports.includes(scheme)) {
    return {
      error: `persona ${persona.vendor} does not serve over ${scheme}:// (declares ${spec.transports.join(', ')})`,
    };
  }
  if (!IMPLEMENTED_TRANSPORTS.has(scheme)) {
    return { error: `the imposter cannot serve over ${scheme}:// yet (has ${[...IMPLEMENTED_TRANSPORTS].join(', ')})` };
  }
  return { socketPath: match[2]! };
}

/**
 * Join a session another process owns, and draw it (§11.5).
 *
 * The vendor's own TUI is a CLIENT of its app-server — `codex resume <id>
 * --remote unix://…` renders a thread the server is running. The imposter is
 * the same shape here: no session, no op timeline, no scenario driver. It sends the
 * prompt the person types and draws the notifications that come back, which is
 * exactly as much as the real one does over this connection.
 *
 * Nothing is inferred from what arrives. A notification is drawn under the
 * method name the server used, and the ADAPTER — which has its own connection
 * to the same server — remains the only thing deriving semantics (ADR-003).
 */
async function runAttached(
  persona: Persona,
  argv: readonly string[],
  address: string,
  log: (message: string) => void,
): Promise<number> {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(address);
  if (!match || match[1]!.toLowerCase() !== 'unix') {
    process.stderr.write(`the imposter can only attach over unix:// (got "${address}")\n`);
    return 2;
  }
  // `resume <id>` — the id the server already owns. Bare `--remote` would ask
  // for a new thread, which is the mistake tui-session.ts calls out: it creates
  // a second, unmaterialized thread nobody is observing.
  const threadId = flagValue(argv, persona.flagsFor('resume', 'resume')) ?? '(unnamed thread)';

  let connection;
  try {
    connection = await connectUnixWebSocket(match[2]!);
  } catch (error) {
    process.stderr.write(`could not attach to ${address}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const screen = await createPresentation({
    vendor: persona.vendor,
    version: persona.version,
    sessionId: threadId,
    channels: [persona.channelFor('jsonrpc') ?? 'jsonrpc', 'terminal'],
  });

  let closing = false;
  const shutdown = async (exitCode = 0): Promise<never> => {
    if (closing) await new Promise(() => {});
    closing = true;
    if (screen.interactive && process.stdin.isTTY) process.stdout.write('\x1b[?2004l');
    connection.close();
    await screen.stop();
    process.exit(exitCode);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  const channel = createAppServerChannel({
    input: connection.input,
    output: connection.output,
    // A viewer answers nothing. Approvals belong to the client that drives the
    // session, and the server sends them there (see `driver` below); an error
    // is the honest reply if one ever arrives here anyway.
    serve: (method) => Promise.reject(new RpcError(METHOD_NOT_FOUND, `a viewer cannot answer ${method}`)),
    notified: (method, params) => screen.frame({ at: new Date().toISOString(), op: method, with: params }),
    onClose: () => void shutdown(),
    log,
  });

  // Both, not either. A notice reaches whoever is looking at the pane; the log
  // reaches whoever is debugging one they cannot see — and for a viewer inside
  // a Godview pane, the second is the only one anybody can read.
  const failed = (what: string, error: unknown): void => {
    const message = `${what}: ${error instanceof Error ? error.message : String(error)}`;
    screen.notice(message);
    log(message);
  };

  screen.scenario('attached');
  log(`attaching to ${threadId} on ${match[2]!}`);
  await channel.request('thread/resume', { threadId }).catch((error: unknown) => failed('resume failed', error));

  installPromptLine({
    interactive: screen.interactive,
    staged: (text) => screen.staged(text),
    // The same request the adapter's own driver sends, field for field: the
    // server cannot tell the two apart, which is what makes a prompt typed in
    // the pane and one injected by chopsticks the same event.
    submit: (text) => {
      log(`turn/start on ${threadId} (${text.length} chars)`);
      void channel
        .request('turn/start', {
          threadId,
          input: [{ type: 'text', text }],
          clientUserMessageId: `imposter-tui-${Date.now()}`,
        })
        .catch((error: unknown) => failed('turn failed', error));
    },
    interrupt: () => void shutdown(),
    end: () => void shutdown(),
    log,
  });

  await new Promise(() => {});
  return 0;
}

export async function main(argv: readonly string[], argv0?: string): Promise<number> {
  // `ai` has no subcommands of its own. Everything after persona selection
  // belongs to the vendor, which is what lets the adapter's real launch recipe
  // through untouched — and is why the tool has nothing to collide with.
  const shims = shimNameMap();

  let selection;
  try {
    selection = selectPersona(argv, { argv0, env: process.env, shims });
  } catch (error) {
    if (error instanceof PersonaSelectionError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const persona = loadPersona(selection.vendor);
  const rest = selection.rest;

  // Detection surface, answered from the ASM so it cannot drift from what the
  // adapter's probe expects (ADAPTING-AN-AGENT step 4).
  const versionFlag = detectionText(persona, 'versionFlag', '--version');
  const helpFlag = detectionText(persona, 'helpFlag', '--help');
  if (hasFlag(rest, versionFlag)) {
    process.stdout.write(`${detectionText(persona, 'versionOutput', `${persona.version} (imposter)`)}\n`);
    return 0;
  }
  if (hasFlag(rest, helpFlag)) {
    const flags = ['sessionId', 'resume', 'settings', 'name', 'permissionMode', 'model'] as const;
    process.stdout.write(`Usage: ${persona.vendor} [options]\n`);
    for (const key of flags) {
      const aliases = persona.flagsFor(key, '');
      if (aliases.length > 0) process.stdout.write(`  ${aliases.join(', ')} <value>\n`);
    }
    return 0;
  }

  const behaviorName = flagValue(rest, ['--behavior']) ?? 'happy-turn';
  const log = (message: string): void => {
    if (process.env.CHOPSTICKS_IMPOSTER_DEBUG) process.stderr.write(`[imposter] ${message}\n`);
  };

  const httpServer = persona.httpServe?.$server;
  if (httpServer && rest[0] === httpServer.command) {
    return runHttpPersonaServer({
      persona,
      argv: rest,
      behavior: loadBehavior(persona, behaviorName),
      env: process.env,
      cwd: process.cwd(),
      log,
    });
  }
  if (httpServer && rest[0] === httpServer.attach.command) {
    return runHttpPersonaAttached({
      persona,
      argv: rest,
      behavior: loadBehavior(persona, behaviorName),
      env: process.env,
      cwd: process.cwd(),
      log,
    });
  }

  const leader = persona.serve?.$server?.leader;
  if (leader && matchesInvocation(rest, leader)) return runLeader(persona, rest, log);

  // ATTACH comes before everything else, because it is the one invocation that
  // owns no session at all (§11.5). `codex resume <id> --remote unix://…` is a
  // window onto a thread another process owns, and an imposter that started its
  // own session here would put a second, unobserved authored flow on the screen
  // while the adapter watched the first — the screen contradicting the wire,
  // which is the single thing §2 exists to prevent.
  //
  // The flag is the ASM's, not ours: `launchFlags.remote` is captured vendor
  // truth, so this cannot drift from what the adapter actually spawns.
  const attachAddress = flagValue(rest, persona.flagsFor('remote', '--remote'));
  if (attachAddress !== undefined) return runAttached(persona, rest, attachAddress, log);

  // `control` and `screen` are assigned below, after the session exists; the
  // callbacks close over them and stay inert until then. Nothing is emitted
  // before boot, which is after both.
  let control: ImposterControl | undefined;
  let screen: Presentation | undefined;
  let closing = false;
  /** Torn down on the way out, after the session has said its last word. */
  const closers: Array<() => Promise<void>> = [];

  // The trigger fork (§9.3). For claude the trigger is stdin bytes; for codex
  // it is inbound RPC. Everything downstream — the op timeline and its sinks —
  // is genuinely shared, which is the whole claim the two families test.
  //
  // Which fork is taken comes from ARGV, not from whether the persona owns a
  // serve table: `codex` opens a screen and `codex app-server` speaks the
  // protocol, so an imposter that always served would be unfaithful in the
  // most visible way there is — you could not run it by hand.
  const serverSpec = persona.serve?.$server;
  const serveCommand = serverSpec?.command;
  const viewing = serverSpec?.viewer ? matchesInvocation(rest, serverSpec.viewer) : false;
  const serving =
    persona.serve !== undefined &&
    (serverSpec?.match
      ? matchesInvocation(rest, serverSpec.match)
      : serveCommand === undefined || rest[0] === serveCommand);

  if (viewing && leader && serverSpec?.viewer) {
    const socketPath = flagValue(rest, [leader.socketFlag]);
    if (!socketPath) {
      process.stderr.write(`${leader.socketFlag} requires a socket path\n`);
      return 2;
    }
    const sessionId = flagValue(rest, [serverSpec.viewer.sessionFlag]);
    if (!sessionId) {
      process.stderr.write(`${serverSpec.viewer.sessionFlag} requires a session id\n`);
      return 2;
    }
    return runLeaderViewer(persona, socketPath, sessionId, log);
  }

  // A socket server has MANY clients where stdio has exactly one: the adapter
  // brings up a controller connection, and the native TUI joins the same server
  // beside it. Notifications fan out to all of them.
  //
  // Server-initiated requests do NOT fan out — an approval answered twice is
  // not an approval. They go to the first client to speak, which is always the
  // controller: the adapter owns the thread and connects before the TUI it then
  // launches, and it is the side with an approval policy at all. A viewer that
  // later starts a turn still does not inherit the decision, which is the point
  // (over stdio there is one client and it is trivially first).
  const clients = new Set<AppServerChannel>();
  let driver: AppServerChannel | undefined;

  const session = createImposterSession({
    persona,
    argv: rest,
    env: process.env,
    cwd: process.cwd(),
    behavior: loadBehavior(persona, behaviorName),
    present: (frame) => screen?.frame(frame),
    ...(serving
      ? {
          jsonrpc: {
            notify: (method: string, params: Record<string, unknown>) => {
              for (const client of clients) client.notify(method, params);
            },
            request: (method: string, params: Record<string, unknown>) => {
              const target = driver ?? [...clients][0];
              return target
                ? target.request(method, params)
                : Promise.reject(new Error('app-server channel is not open'));
            },
          },
        }
      : {}),
    onEmitted: (entry) => control?.pushEmitted(entry),
    onChannels: (channels) => {
      control?.pushChannels(channels);
      screen?.channels(channels);
    },
    // Scenario intent has two debug projections (console + TUI), while native
    // truth is independently projected from the versioned Surface model.
    onScenarioDriver: (snapshot) => {
      control?.pushScenarioDriver(snapshot);
      screen?.scenario(snapshot.state);
    },
    onScenarioRun: (progress) => control?.pushScenarioRun(progress),
    halt: (kind, exitCode) => {
      if (kind === 'hang') {
        process.stdin.pause();
        return;
      }
      // setImmediate so the control reply flushes first. A crash sends no
      // goodbye on purpose: a vendor that dies does not say goodbye, and the
      // plane is meant to learn it from the socket closing (§5).
      setImmediate(() => {
        if (kind === 'crash') process.exit(exitCode);
        else void shutdown(exitCode);
      });
    },
    log,
  });

  const shutdown = async (exitCode = 0): Promise<never> => {
    if (closing) await new Promise(() => {});
    closing = true;
    // Leave the terminal as it was found; a shell inheriting bracketed-paste
    // mode from a dead child is a real and confusing mess.
    if (screen?.interactive && process.stdin.isTTY) process.stdout.write('\x1b[?2004l');
    await session.end();
    // After session.end, so a listening server is still up to carry the last
    // ops to whoever is connected.
    for (const close of closers) await close().catch(() => undefined);
    await control?.close('other');
    await screen?.stop();
    process.exit(exitCode);
  };

  // The TUI is chrome and nothing more (§4): it renders the same lines the
  // headless sink writes, and never reads input.
  //
  // When the persona SERVES, stdout is the protocol — a banner written there
  // would sit in the middle of the adapter's NDJSON stream. So presentation
  // goes to stderr and the TUI never mounts, whatever the terminal looks like.
  // A serve persona run WITHOUT its server subcommand has no client on the
  // other end of that channel, so it is reported detached rather than live. The
  // screen still runs the ops; they simply reach no wire, which is the truth of
  // the mode and visible as such (`ai --codex` is a preview, not a session).
  const detached = !serving
    ? persona.serve !== undefined
      ? persona.channelFor('jsonrpc')
      : persona.httpServe !== undefined
        ? persona.channelFor('sse')
        : undefined
    : undefined;
  if (detached) session.dropChannel(detached);

  screen = await createPresentation({
    vendor: persona.vendor,
    version: persona.version,
    sessionId: session.sessionId,
    channels: session.liveChannels,
    ...(serving ? { interactive: false, write: (text: string) => void process.stderr.write(text) } : {}),
  });

  // Joining the control plane MUST complete before the stdin listeners attach:
  // under ELECTRON_RUN_AS_NODE (how apps spawn script recipes) a flowing stdin
  // wedges later async I/O initiation, and the connect never resolves — probed
  // 2026-08-07 against the PoC's register fetch (§7.3 item 1).
  control = await connectControl({
    vendor: persona.vendor,
    version: persona.version,
    sessionId: session.sessionId,
    cwd: process.cwd(),
    nativeBehavior: persona.model.behavior,
    nativeEvents: nativeEventsFromModel(persona.model),
    ops: opsFromPersona(persona),
    runflows: persona.runflows,
    channels: () => session.liveChannels,
    scenarioDriver: () => session.scenarioDriver,
    emitted: () => session.emitted,
    trigger: (event, payload, channel) => session.emit(event, payload, channel),
    runOp: (op, argument) => session.runOp(op, argument),
    runScenario: (request) =>
      session.runScenario(request.script ?? loadScenario(persona, request.name!), {
        ...(request.stimulus === undefined ? {} : { stimulus: request.stimulus }),
        ...(request.name === undefined ? {} : { scenario: request.name }),
        ...(request.runflowId === undefined ? {} : { runflowId: request.runflowId }),
        speed: request.speed,
        mode: request.mode,
      }),
    scenarioControl: (action) => session.scenarioControl(action),
    fault: (request) => session.applyFault(request),
    log,
  });

  // Boot is what the vendor does when a PERSON launches it, so it belongs to
  // the interactive fork alone. A server has no session until a client asks for
  // one — codex's own lifecycle starts at `thread/start`, which is why the serve
  // table runs `session.start` from there (§9.3). Booting a server would push
  // `thread/started` at a client that never asked, and the adapter would be
  // learning a lie about when threads come into existence.
  if (!serving) await session.boot();

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  if (serving) {
    // The JSON-RPC family's trigger: inbound RPC, answered synchronously, with
    // any resulting ops scheduled onto the SAME timeline the paste path uses.
    const dispatcher = createServeDispatcher({
      persona,
      document: persona.serve!,
      bindings: session.bindings,
      runOps: (invocations) => session.timeline.runAll(invocations),
      runBehavior: (stimulus) => session.turn(typeof stimulus.text === 'string' ? stimulus.text : ''),
      // Inbound params are held to the ASM exactly like outbound payloads, so
      // the imposter is a conformance test of the adapter's client (§9.3).
      validateParams: (method, params) => persona.validate(method, params),
      validateResult: (method, result) => persona.validateResult(method, result),
      log,
    });

    let leaderController: Awaited<ReturnType<typeof connectLeaderAcp>> | undefined;
    let leaderChannel: AppServerChannel | undefined;
    const ensureLeaderController = async (): Promise<void> => {
      if (!leader || leaderController) return;
      const socketPath = flagValue(rest, [leader.socketFlag]);
      if (!socketPath) throw new Error(`${leader.socketFlag} requires a socket path`);
      const sessionId = session.bindings.$sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('leader controller cannot register before the session id is bound');
      }
      leaderController = await connectLeaderAcp(socketPath, 'controller', sessionId, persona.version, log);
      leaderChannel = attach(
        { input: leaderController.input, output: leaderController.output },
        () => {
          if (leaderChannel) clients.delete(leaderChannel);
          leaderChannel = undefined;
          leaderController = undefined;
        },
        false,
      );
      closers.push(async () => leaderController?.close());
    };

    // One channel per client, whatever carried it here. The transport decides
    // where the bytes come from and nothing else: same dispatcher, same serve
    // table, same op timeline behind every connection.
    function attach(
      streams: { input: Readable; output: Writable },
      onClose: () => void,
      direct = true,
    ): AppServerChannel {
      let channel: AppServerChannel;
      channel = createAppServerChannel({
        input: streams.input,
        output: streams.output,
        serve: async (method, params) => {
          if (direct) driver ??= channel;
          const result = await dispatcher.serve(method, params, {
            restoreSession: () => session.restore((event, payload) => channel.notify(event, payload)),
          });
          if (method === 'session/new' || method === 'session/load') await ensureLeaderController();
          return result;
        },
        notified: dispatcher.notified,
        jsonrpc: persona.serve?.$server?.jsonrpc,
        notificationFields: () =>
          substitute(persona.serve?.$server?.notification ?? {}, { bindings: session.bindings }) as Record<
            string,
            unknown
          >,
        validateOutbound: (method, record) => persona.validateRecord(method, record, persona.channelFor('jsonrpc')),
        validateResult: (method, result) => persona.validateResult(method, result),
        onClose: () => {
          clients.delete(channel);
          if (driver === channel) driver = undefined;
          onClose();
        },
        log,
      });
      clients.add(channel);
      return channel;
    }

    const listener = listenTarget(persona, rest);
    if ('error' in listener) {
      process.stderr.write(`${listener.error}\n`);
      return 2;
    }

    if (listener.socketPath === undefined) {
      // stdio: the client IS the parent process, so its EOF ends the session.
      attach({ input: process.stdin, output: process.stdout }, () => void shutdown());
      await new Promise(() => {});
      return 0;
    }

    // A listening server outlives any one client — the adapter's controller and
    // the native TUI connect and disconnect independently, and a real
    // app-server does not exit when one of them leaves. It ends on the signal
    // its owner sends, which `dispose()` already does.
    const server = await listenUnixWebSocket({
      socketPath: listener.socketPath,
      onConnection: (connection) => attach(connection, () => connection.close()),
      log,
    });
    log(`app-server listening on ${server.socketPath}`);
    screen.notice(`serving ${server.socketPath}`);
    closers.push(() => server.close());
    await new Promise(() => {});
    return 0;
  }

  installPromptLine({
    interactive: screen.interactive,
    staged: (text) => screen?.staged(text),
    submit: (text) =>
      void session.turn(text).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // Both, not either: the notice is for whoever is looking at the pane,
        // and the log is for whoever is debugging one they cannot see.
        screen?.notice(`turn failed: ${message}`);
        log(`turn failed: ${message}`);
      }),
    interrupt: () => void shutdown(),
    end: () => void shutdown(),
    log,
  });

  // Hold the process open; the session ends on signal or stdin EOF.
  await new Promise(() => {});
  return 0;
}

// No auto-run on import: `bin/ai.mjs` owns invocation, so tests can import
// `main` without a module-load side effect spawning a session.
