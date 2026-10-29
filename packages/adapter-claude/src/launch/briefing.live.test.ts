/** Opt-in native flag proof, using a local model fixture and a throwaway HOME; no account or paid inference. */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createHookBridge } from '../observation/hook-bridge.js';
import { requireClaudeLiveExecutable, isolatedClaudeExec } from '../test-support/live-executable.js';
import {
  isolatedClaudeLiveEnvironment,
  startClaudeLoopbackProvider,
  CLAUDE_LIVE_MODEL,
  CLAUDE_LIVE_RESPONSE_MARKER,
} from '../test-support/live-model.js';
import { createClaudeLaunchPreflight } from '../detection.js';
import { prepareClaudeSession, cleanupClaudeSession } from './prepare.js';

it.skipIf(process.env.PUPPETEER_LIVE_BRIEFING !== '1')(
  'native Claude receives MCP environment and fresh resume instructions',
  async () => {
    const executable = requireClaudeLiveExecutable();
    const root = await mkdtemp(join(tmpdir(), 'claude-run-briefing-'));
    const cwd = join(root, 'work');
    await mkdir(cwd);
    const configDir = join(root, 'config');
    const provider = await startClaudeLoopbackProvider();
    const bridge = createHookBridge({ allowSession: () => true });
    const seen = join(root, 'mcp-starts.jsonl');
    const server = join(root, 'mcp.mjs');
    await writeFile(
      server,
      `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(seen)}, JSON.stringify({token:process.env.BRIEFING_TEST,ppid:process.ppid})+'\\n');
for await(const line of createInterface({input:process.stdin})) { const r=JSON.parse(line); if(r.id===undefined)continue;
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'briefing-fixture',version:'1'}}:r.method==='tools/list'?{tools:[{name:'ping',description:'Local fixture',inputSchema:{type:'object'}}]}:{}})+'\\n'); }
`,
    );
    try {
      const environment = isolatedClaudeLiveEnvironment(root, configDir, cwd, provider.baseUrl);
      await createClaudeLaunchPreflight(isolatedClaudeExec(environment))({
        executable,
        freshSession: true,
        mcpServers: true,
        allowTools: true,
        instructions: true,
      });
      await bridge.start();
      let sessionId: string | undefined;
      for (const role of ['FIRST_ROLE_52', 'RESUMED_ROLE_52']) {
        const from = provider.requests.length;
        const prepared = await prepareClaudeSession({
          cwd,
          executable,
          configDir,
          env: environment,
          endpoint: bridge.endpoint(),
          tokenEnvVar: 'BRIEFING_HOOK_TOKEN',
          token: bridge.token,
          ...(sessionId ? { resume: sessionId } : {}),
          mcpServers: { briefing: { command: process.execPath, args: [server], env: { BRIEFING_TEST: role } } },
          allowTools: ['briefing/*'],
          instructions: role,
        });
        sessionId = prepared.sessionId;
        try {
          await promisify(execFile)(
            prepared.command,
            [...prepared.args, '--model', CLAUDE_LIVE_MODEL, '--print', '--', `Reply ${CLAUDE_LIVE_RESPONSE_MARKER}`],
            { cwd, env: prepared.env, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 },
          );
          const turns = provider.requests.slice(from).filter((request) => request.kind === 'turn');
          expect(turns.length).toBeGreaterThan(0);
          const system = (turns.at(-1)!.body as { system: unknown }).system;
          expect(JSON.stringify(system)).toContain(role);
          if (role === 'RESUMED_ROLE_52') expect(JSON.stringify(system)).not.toContain('FIRST_ROLE_52');
          expect(JSON.stringify(turns.at(-1)!.body)).toContain('mcp__briefing__ping');
        } finally {
          await cleanupClaudeSession(prepared);
        }
      }
      const starts = (await readFile(seen, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { token: string });
      expect(starts.map((start) => start.token)).toEqual(expect.arrayContaining(['FIRST_ROLE_52', 'RESUMED_ROLE_52']));
    } finally {
      await bridge.dispose();
      await provider.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  100_000,
);
