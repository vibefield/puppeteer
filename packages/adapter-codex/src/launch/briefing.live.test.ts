/** Opt-in native thread proof: isolated profile, local MCP fixture, no model turn. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createCodexLiveProfile, requireCodexLiveExecutable } from '../test-support/live-profile.js';
import { prepareCodexTuiSession } from './tui-session.js';

it.skipIf(process.env.PUPPETEER_LIVE_BRIEFING !== '1')(
  'native Codex starts and resumes per-run MCP servers without changing config',
  async () => {
    const executable = requireCodexLiveExecutable('PUPPETEER_LIVE_BRIEFING');
    const profile = await createCodexLiveProfile('codex-run-briefing-', 'loopback');
    const configPath = join(profile.codexHome, 'config.toml');
    const before = await readFile(configPath, 'utf8');
    const seen = join(profile.root, 'mcp-starts.jsonl');
    const server = join(profile.root, 'mcp.mjs');
    await writeFile(
      server,
      `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(seen)}, JSON.stringify({token:process.env.BRIEFING_TEST,ppid:process.ppid})+'\\n');
for await(const line of createInterface({input:process.stdin})) { const r=JSON.parse(line); if(r.id===undefined)continue;
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'briefing-fixture',version:'1'}}:r.method==='tools/list'?{tools:[{name:'ping',description:'Local fixture',inputSchema:{type:'object'}}]}:{}})+'\\n'); }
`,
    );
    try {
      let sessionId: string | undefined;
      for (const role of ['FIRST_ROLE_52', 'RESUMED_ROLE_52']) {
        const prepared = await prepareCodexTuiSession({
          cwd: profile.cwd,
          executable,
          env: profile.environment,
          appServerEnv: profile.environment,
          host: {
            helperEnvironment: (extra) => ({ ...profile.environment, ...extra }),
            async spawnTerminal() {
              throw new Error('No terminal is needed for this proof.');
            },
            async automateTerminal() {
              throw new Error('No model turn is allowed.');
            },
          },
          ...(sessionId ? { resume: sessionId } : {}),
          mcpServers: { briefing: { command: process.execPath, args: [server], env: { BRIEFING_TEST: role } } },
          allowTools: ['briefing/ping'],
          instructions: role,
        });
        sessionId = prepared.sessionId;
        await prepared.dispose();
      }
      const starts = (await readFile(seen, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { token: string });
      expect(starts.map((start) => start.token)).toEqual(expect.arrayContaining(['FIRST_ROLE_52', 'RESUMED_ROLE_52']));
      expect(await readFile(configPath, 'utf8')).toBe(before);
      expect(profile.provider!.requests.filter((request) => request.kind === 'turn')).toHaveLength(0);
    } finally {
      await profile.dispose();
    }
  },
  100_000,
);
