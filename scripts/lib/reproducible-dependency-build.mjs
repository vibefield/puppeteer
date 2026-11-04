/** Reviewed normalization recipe for a source-built Rust dependency and its CycloneDX metadata. */
export function validateDependencyBuilds(builds) {
  if (builds === undefined) return;
  if (!builds || typeof builds !== 'object' || Array.isArray(builds)) throw new Error('invalid dependency builds');
  for (const [platform, recipe] of Object.entries(builds)) {
    if (
      platform !== 'darwin-x64' ||
      Object.keys(recipe ?? {}).some(
        (key) => !['strategy', 'distribution', 'version', 'sbom', 'normalizedRoot', 'sourceDateEpoch'].includes(key),
      ) ||
      recipe?.strategy !== 'rust-cyclonedx-v1' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(recipe.distribution ?? '') ||
      !/^\d+\.\d+\.\d+$/.test(recipe.version ?? '') ||
      !/^sboms\/[A-Za-z0-9_-]+\.cyclonedx\.json$/.test(recipe.sbom ?? '') ||
      !/^\/[a-z][a-z0-9-]*$/.test(recipe.normalizedRoot ?? '') ||
      !Number.isSafeInteger(recipe.sourceDateEpoch) ||
      recipe.sourceDateEpoch < 0 ||
      recipe.sourceDateEpoch > 4102444800
    )
      throw new Error(`invalid reproducible dependency build for ${platform}`);
  }
}

export function dependencyBuildEnvironment(recipe, workRoot) {
  if (!recipe) return {};
  // Cargo's encoded form keeps a workspace path containing spaces in one rustc argument.
  if (/[\x00\x1f\r\n]/.test(workRoot)) throw new Error('invalid dependency build root');
  return {
    CARGO_ENCODED_RUSTFLAGS: `--remap-path-prefix=${workRoot}=${recipe.normalizedRoot}`,
    SOURCE_DATE_EPOCH: String(recipe.sourceDateEpoch),
  };
}
