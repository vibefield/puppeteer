// esbuild bundles `.wgsl` files as text (see build.mjs); this is the matching type.
declare module '*.wgsl' {
  const source: string;
  export default source;
}
