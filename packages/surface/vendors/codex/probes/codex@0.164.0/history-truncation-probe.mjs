// Runtime evidence for the persisted command-output cap in paginated history (rust-v0.162.0 #50427; findings C8).
//
//   node history-truncation-probe.mjs --version <semver> --package-root <extracted release package> [<results.json>]
//
// One command prints 100 000 bytes of `a`; the probe compares the live `item/completed`
// `commandExecution.aggregatedOutput` with the same item read back through `thread/turns/list`
// (`itemsView: 'full'`) and `thread/read` (`includeTurns: true`) on the same connection. The harness's
// hermetic machinery runs it (census/harness.mjs: isolated HOME and CODEX_HOME, a loopback model). The
// output is synthetic; what the record keeps is lengths, digests and the in-band marker codex inserts.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  CODEX_VERSION,
  codexArtifactIdentity,
  resolveCodexExecutable,
  runScenario,
  scenarioFailures,
} from '../../census/harness.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const output = argv.find((value, index) => !value.startsWith('--') && !argv[index - 1]?.startsWith('--'));

const executable = resolveCodexExecutable({ bin: flag('--bin'), packageRoot: flag('--package-root') });
const identity = codexArtifactIdentity(executable);
if (identity.versionOutput !== `codex-cli ${CODEX_VERSION}`) {
  throw new Error(`${executable} reports "${identity.versionOutput}", not codex-cli ${CODEX_VERSION}`);
}

const BYTES = 100_000;
const command = `head -c ${BYTES} /dev/zero | tr '\\0' a`;
const scenario = {
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
  prompt: 'print a lot',
  items: [
    (turn) => ({
      type: 'custom_tool_call',
      id: `fc_${turn}`,
      call_id: `call_${turn}`,
      status: 'completed',
      name: 'exec',
      input: `await tools.exec_command({cmd: ${JSON.stringify(command)}})`,
    }),
  ],
  afterTurn: [
    {
      method: 'thread/turns/list',
      params: ({ threadId }) => ({ threadId, itemsView: 'full', sortDirection: 'asc' }),
    },
    { method: 'thread/read', params: ({ threadId }) => ({ threadId, includeTurns: true }) },
  ],
  expect: {
    items: ['agentMessage', 'commandExecution', 'userMessage'],
    serverRequests: [],
    methods: ['turn/completed'],
    results: ['thread/turns/list', 'thread/read'],
  },
};

const result = await runScenario('history-truncation', { bin: executable, scenario });
const failures = scenarioFailures('history-truncation', result, scenario);
if (failures.length > 0) throw new Error(`history-truncation scenario failed:\n${failures.join('\n')}`);

const answer = (method) => {
  const entry = result.requested.find((request) => request.method === method);
  return result.messages.find((message) => message.id === entry?.id && message.method === undefined)?.result;
};
const commandItem = (items) => (items ?? []).find((item) => item.type === 'commandExecution');
const live = result.messages.find(
  (message) => message.method === 'item/completed' && message.params?.item?.type === 'commandExecution',
)?.params?.item;
const paged = commandItem(answer('thread/turns/list')?.data?.flatMap((turn) => turn.items ?? []));
const read = commandItem(answer('thread/read')?.thread?.turns?.flatMap((turn) => turn.items ?? []));

function describe(text) {
  if (typeof text !== 'string') return null;
  const head = /^a*/.exec(text)[0].length;
  const tail = /a*$/.exec(text)[0].length;
  return {
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex').slice(0, 16),
    leadingRun: head,
    trailingRun: head === text.length ? 0 : tail,
    // Everything between the retained head and tail: codex's own in-band truncation marker.
    marker: head === text.length ? null : text.slice(head, text.length - tail),
  };
}

const record = {
  codex: CODEX_VERSION,
  probe: `probes/codex@${CODEX_VERSION}/history-truncation-probe.mjs`,
  artifact: { versionOutput: identity.versionOutput, executableSha256: identity.executable.sha256 },
  printedBytes: BYTES,
  live: {
    status: live?.status ?? null,
    exitCode: live?.exitCode ?? null,
    aggregatedOutput: describe(live?.aggregatedOutput),
  },
  turnsListFull: { status: paged?.status ?? null, aggregatedOutput: describe(paged?.aggregatedOutput) },
  threadReadIncludeTurns: { status: read?.status ?? null, aggregatedOutput: describe(read?.aggregatedOutput) },
  deprecationNotices: result.messages.filter((message) => message.method === 'deprecationNotice').length,
};
const serialized = `${JSON.stringify(record, null, 2)}\n`;
if (output) writeFileSync(output, serialized);
else process.stdout.write(serialized);
