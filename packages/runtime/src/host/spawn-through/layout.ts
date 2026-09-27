import { join } from 'node:path';

/** The shim home a host chooses, and the kit's layout inside it (docs/guides/spawn-through-hosts.md). */
export interface SpawnThroughLayout {
  home: string;
  /** One launcher per command name; the only directory a shell puts on PATH (`PUPPETEER_SHIM_DIR`). */
  shimDirectory: string;
  /** The bundled shim every launcher runs. */
  script: string;
  /** The zsh integration's `ZDOTDIR`. */
  zshDirectory: string;
  zshenv: string;
}

export function spawnThroughLayout(home: string): SpawnThroughLayout {
  return {
    home,
    shimDirectory: join(home, 'bin'),
    script: join(home, 'lib', 'agent-shim.cjs'),
    zshDirectory: join(home, 'zsh'),
    zshenv: join(home, 'zsh', '.zshenv'),
  };
}
