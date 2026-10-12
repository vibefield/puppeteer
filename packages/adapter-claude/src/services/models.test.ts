import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createClaudeModelService } from './models.js';

it('initializes only metadata under the requested account, without prompts or credential leakage', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-models-'));
  const executable = join(cwd, 'claude.mjs');
  await writeFile(
    executable,
    `import {appendFileSync} from 'node:fs'; import {createInterface} from 'node:readline';
    if (process.argv.includes('--version')) { console.log('2.1.296 (Claude Code)'); process.exit(0); }
    appendFileSync('requests', JSON.stringify({args:process.argv.slice(2),root:process.env.CLAUDE_CONFIG_DIR, borrowedCredential:!!process.env.ANTHROPIC_API_KEY})+'\\n');
    createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line); appendFileSync('requests', JSON.stringify(request)+'\\n');
      if(request.request?.subtype!=='initialize') process.exit(9);
      console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:[{value:'sonnet',displayName:'Sonnet',supportsEffort:true,supportedEffortLevels:['high'],apiKey:'secret'}],apiKey:'secret'}}}));
    });`,
  );
  try {
    const result = await createClaudeModelService({
      executable,
      env: { ...process.env, ANTHROPIC_API_KEY: 'host-secret', CLAUDE_CONFIG_DIR: '/wrong-profile' },
    }).discover({
      cwd,
      profile: {
        id: 'account',
        provider: 'claude',
        label: 'Account',
        kind: 'managed',
        dataRoot: join(cwd, 'profile'),
        createdAt: new Date().toISOString(),
      },
    });
    expect(result).toMatchObject({
      status: 'available',
      catalog: { profileId: 'account', models: [{ id: 'sonnet' }] },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    const records = (await readFile(join(cwd, 'requests'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      root: join(cwd, 'profile'),
      borrowedCredential: false,
      args: expect.arrayContaining(['--no-session-persistence', '--strict-mcp-config', '{"disableAllHooks":true}']),
    });
    expect(records[1].request.subtype).toBe('initialize');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
