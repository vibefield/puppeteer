/** Bind newly captured release journals without rewriting the older Rosetta source provenance. */
export function bindReleaseCapture(evidence, receipt) {
  if (!receipt) return evidence;
  if (
    receipt.vendor !== evidence.vendor ||
    receipt.version !== evidence.vendorVersion ||
    receipt.platform !== 'linux-x64' ||
    receipt.sandbox?.kind !== 'docker-network-none' ||
    receipt.sandbox?.nonLoopbackRoutes !== 0 ||
    !Number.isInteger(receipt.sandbox?.publicDestinationErrno) ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.artifactSha256 ?? '') ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.entrySha256 ?? '') ||
    !Number.isFinite(Date.parse(receipt.capturedAt)) ||
    !Number.isFinite(Date.parse(receipt.startedAt)) ||
    Date.parse(receipt.capturedAt) < Date.parse(receipt.startedAt)
  )
    throw new Error('release capture provenance is incomplete or mismatched');
  const id = `${evidence.vendor}-${evidence.vendorVersion}-${receipt.platform}`;
  const artifact = {
    id,
    artifactKind: 'release-bundle',
    platform: receipt.platform,
    versionOutput: receipt.version,
    integrity: { status: 'verified', sha256: receipt.artifactSha256 },
  };
  return {
    ...evidence,
    artifacts: [...evidence.artifacts.filter((item) => item.id !== id), artifact],
    claims: evidence.claims.map((claim) =>
      claim.kind === 'runtime-capture'
        ? {
            ...claim,
            artifact: id,
            platform: receipt.platform,
            capturedAt: receipt.capturedAt,
            harness: receipt.harness,
            notes:
              'Type-preserving journals from the complete official release bundle, captured with the pinned Rosetta loopback scenarios in Docker with no external network. Source and observed-schema claims retain their original Rosetta corpus identity.',
          }
        : claim,
    ),
  };
}
