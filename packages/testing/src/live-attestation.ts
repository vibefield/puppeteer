/** Artifact-bound receipt emitted only by an adapter's executed live test. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const platforms = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'windows-x64']);

export interface LiveAdapterAttestation {
  vendor: string;
  artifact: string;
  testId: string;
}

export interface LiveAdapterReceipt {
  schemaVersion: 1;
  check: 'adapter-real';
  vendor: string;
  platform: string;
  artifactSha256: string;
  testId: string;
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return `sha256:${digest.digest('hex')}`;
}

function confinedPath(path: string, workspace: string): string {
  const absolute = resolve(path);
  const fromRoot = relative(resolve(workspace), absolute);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('live adapter receipt must stay inside the workspace');
  }
  return absolute;
}

/**
 * Write the protected-promotion receipt after real assertions pass.
 * Ordinary opt-in live runs omit PUPPETEER_LIVE_RECEIPT and perform no write.
 */
export async function attestLiveAdapter(
  attestation: LiveAdapterAttestation,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LiveAdapterReceipt | undefined> {
  const destination = environment.PUPPETEER_LIVE_RECEIPT;
  if (!destination) return undefined;
  const expectedVendor = environment.PUPPETEER_LIVE_VENDOR;
  const platform = environment.PUPPETEER_LIVE_PLATFORM;
  const expectedArtifact = environment.PUPPETEER_LIVE_ARTIFACT;
  const workspace = environment.GITHUB_WORKSPACE;
  if (
    !/^[a-z][a-z0-9-]*$/.test(attestation.vendor) ||
    attestation.vendor !== expectedVendor ||
    !platform ||
    !platforms.has(platform) ||
    !expectedArtifact ||
    !workspace ||
    resolve(attestation.artifact) !== resolve(expectedArtifact) ||
    !/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/.test(attestation.testId) ||
    !attestation.testId.startsWith(`${attestation.vendor}:`)
  ) {
    throw new Error('live adapter attestation differs from the protected workflow identity');
  }
  const artifact = resolve(attestation.artifact);
  const artifactStat = await lstat(artifact);
  if (!artifactStat.isFile() || artifactStat.size < 1) throw new Error('live adapter artifact is not a regular file');
  const receipt: LiveAdapterReceipt = {
    schemaVersion: 1,
    check: 'adapter-real',
    vendor: attestation.vendor,
    platform,
    artifactSha256: await sha256File(artifact),
    testId: attestation.testId,
  };
  const output = confinedPath(destination, workspace);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return receipt;
}
