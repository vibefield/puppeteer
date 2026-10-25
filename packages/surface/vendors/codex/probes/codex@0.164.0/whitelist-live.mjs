// Project the raw output of packages/adapter-codex/src/launch/invocation-probe.live.test.ts into the
// committed live-results.json (the same record shape as probes/codex@0.157.1/live-results.json).
//
//   node whitelist-live.mjs <live-cases.json> <raw results.json> <live-results.json> <codex version>
//
// Kept: what each case typed and started, what the server answered, what the TUI sent (methods, and the
// settings fields of thread/resume, thread/start and turn/start), what reached the loopback model
// (model, tools, reasoning, permission lines and their digests, images, whether the prompt arrived),
// the TUI's own error lines, and the process sweep. Dropped: screens, directories, thread and message
// ids, prompt and instruction text, and every other field. The case root is already `<root>` in the
// raw output; the detector in `@vibefield/puppeteer-surface/sanitize` must find nothing in the result.
import { readFileSync, writeFileSync } from 'node:fs';

const [casesPath, rawPath, outputPath, version] = process.argv.slice(2);
if (!version) throw new Error('usage: whitelist-live.mjs <cases> <raw> <output> <codex version>');
const cases = new Map(JSON.parse(readFileSync(casesPath, 'utf8')).map((entry) => [entry.id, entry]));
const raw = JSON.parse(readFileSync(rawPath, 'utf8'));

const TITLE_PROMPT = 'Generate a concise, single-line task title';
const PERMISSION_LINE =
  /Filesystem sandboxing|No filesystem sandboxing|writable roots are|Approval policy is currently|<filesystem>/u;

function projectRequest(request) {
  if (!request) return null;
  return {
    model: request.model ?? null,
    tools: request.tools ?? [],
    webSearch: request.webSearch ?? null,
    reasoningEffort: request.reasoning?.effort ?? null,
    reasoningSummary: request.reasoning?.summary ?? null,
    promptDelivered: request.promptDelivered,
    imagesFrom: request.images ?? [],
    permissionLines: (request.markers ?? []).filter((line) => PERMISSION_LINE.test(line)),
    permissionsDigest: request.permissionsDigest ?? null,
    filesystemDigest: request.filesystemDigest ?? null,
  };
}

function projectParams(method, params = {}) {
  if (method === 'thread/resume') {
    return {
      model: params.model ?? null,
      sandbox: params.sandbox ?? null,
      approvalPolicy: params.approvalPolicy ?? null,
      config: params.config ?? null,
      excludeTurns: params.excludeTurns ?? null,
    };
  }
  if (method === 'turn/start') {
    const input = Array.isArray(params.input) ? params.input : [];
    const title = input.some((item) => typeof item.text === 'string' && item.text.startsWith(TITLE_PROMPT));
    return {
      purpose: title ? 'thread title' : 'the turn',
      approvalPolicy: params.approvalPolicy ?? null,
      model: params.model ?? null,
      effort: params.effort ?? null,
      sandboxPolicy: params.sandboxPolicy?.type ?? params.sandboxPolicy ?? null,
      workspaceRoots: Array.isArray(params.runtimeWorkspaceRoots) ? params.runtimeWorkspaceRoots.length : null,
      inputTypes: input.map((item) => item.type),
    };
  }
  const titleThread = params.threadSource === 'thread_title';
  return {
    model: params.model ?? null,
    approvalPolicy: params.approvalPolicy ?? null,
    approvalsReviewer: params.approvalsReviewer ?? null,
    sandbox: params.sandbox ?? null,
    cwdSent: params.cwd !== undefined && params.cwd !== null,
    config: titleThread ? '(the title thread’s own feature switches)' : (params.config ?? null),
    threadSource: params.threadSource ?? null,
    ephemeral: params.ephemeral ?? null,
    dynamicTools: Array.isArray(params.dynamicTools)
      ? params.dynamicTools.map((tool) => `${tool.type}:${tool.name}`)
      : null,
  };
}

function projectTui(result) {
  const detailed = [...(result.tui ?? [])];
  return (result.tuiMethods ?? []).map((method) => {
    if (!['thread/resume', 'turn/start', 'thread/start'].includes(method)) return { method };
    const index = detailed.findIndex((entry) => entry.method === method);
    const [entry] = index >= 0 ? detailed.splice(index, 1) : [];
    return entry ? { method, params: projectParams(method, entry.params) } : { method };
  });
}

const screenErrors = (screen = '') => [...new Set(screen.match(/Error: [^.\n]*\./gu) ?? [])];

const sessions = raw.map((result) => {
  const entry = cases.get(result.id) ?? {};
  const session = {
    session: result.id.split('-')[0],
    case: result.id,
    batch: entry.batch ?? null,
    startedAt: result.startedAt ?? null,
    mode: result.mode,
    typed: result.argv ?? [],
  };
  if (result.start) session.threadStart = result.start;
  if (result.startResponse) session.threadStartAnswer = result.startResponse;
  if (result.appServerArgs?.length) session.appServerArguments = result.appServerArgs;
  // The carried prompt is the harness's own fixed text; it is redacted as in the 0.157.1 record (the
  // TUI launch line below still shows it as typed).
  if (result.carried) {
    session.normalized =
      typeof result.carried.prompt === 'string' ? { ...result.carried, prompt: '<redacted:prompt>' } : result.carried;
  }
  if (result.launch) session.tuiLaunch = result.launch;
  if (result.error) session.outcome = result.error;
  const errors = screenErrors(result.screen);
  if (errors.length > 0) session.tuiErrors = errors;
  if (result.noTurn) session.noTurn = true;
  if (result.tuiExited) session.tuiExited = true;
  session.request = projectRequest(result.request);
  session.turnRequests = result.turnRequests ?? 0;
  session.tuiSent = projectTui(result);
  session.alternateScreen = result.altScreen ?? null;
  session.processesSweptAfter = result.survivorsKilled ?? 0;
  return session;
});

writeFileSync(outputPath, `${JSON.stringify({ codex: version, sessions }, null, 2)}\n`);
console.log(`${sessions.length} session(s) -> ${outputPath}`);
