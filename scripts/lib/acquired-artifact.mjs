/** Fixture corpora, source pins and retired builds cannot satisfy an acquired-artifact gate. */
export function acquiredArtifactForPlatform(evidence, platform) {
  const candidates = (evidence?.artifacts ?? []).filter(
    (artifact) =>
      artifact.platform === platform &&
      artifact.kind === undefined &&
      artifact.integrity?.status === 'verified' &&
      /^sha256:[0-9a-f]{64}$/.test(artifact.integrity.sha256 ?? ''),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
