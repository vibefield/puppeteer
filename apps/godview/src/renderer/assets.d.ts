// esbuild bundles `.png` files as data URLs (see build.mjs and swarm-lab.mjs); this is the matching type.
declare module '*.png' {
  const url: string;
  export default url;
}
