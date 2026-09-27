import { basename, delimiter, resolve } from 'node:path';
import { spawnThroughLayout } from './layout.js';

/**
 * `<home>/zsh/.zshenv`: the only startup file of the host's that a shell reads.
 *
 * The host points `ZDOTDIR` here so this file runs first; it gives `ZDOTDIR`
 * back in its first lines, before anything of the person's runs. Left pointed
 * here, every later startup file would be looked for in the host's directory,
 * and macOS's `/etc/zshrc` (`HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history`) would
 * put the person's history — and compinit its dump — in the host's home.
 *
 * The shim directory goes first through a `precmd` hook rather than a PATH
 * edit here: the hook runs before every prompt, so after every startup file,
 * and a profile that reorders PATH (`path_helper`, a version manager) cannot
 * put the real executable ahead of the launcher. A non-interactive `zsh -c` is
 * not integrated, and neither is an interactive shell a person starts inside
 * this one (it reads only the person's own files).
 */
export const ZSH_INTEGRATION = `# puppeteer spawn-through — zsh integration (generated)
# ZDOTDIR is the person's again before anything of theirs runs: every later
# startup file, the history file and compinit's dump are theirs, not the host's.
if [[ -n "\${PUPPETEER_ORIGINAL_ZDOTDIR+x}" ]]; then
  if [[ -n "$PUPPETEER_ORIGINAL_ZDOTDIR" ]]; then export ZDOTDIR="$PUPPETEER_ORIGINAL_ZDOTDIR"; else unset ZDOTDIR; fi
  unset PUPPETEER_ORIGINAL_ZDOTDIR
fi
# Never this file again: a ZDOTDIR still naming this directory would source it without end.
[[ "\${\${ZDOTDIR:-$HOME}:A}" != "\${\${(%):-%x}:A:h}" && -r "\${ZDOTDIR:-$HOME}/.zshenv" ]] && source "\${ZDOTDIR:-$HOME}/.zshenv"
if [[ -o interactive && -n "\${PUPPETEER_SHIM_DIR:-}" ]]; then
  _puppeteer_shim_path() {
    emulate -L zsh
    [[ -n "\${PUPPETEER_SHIM_DIR:-}" ]] || return 0
    [[ "\${path[1]}" == "$PUPPETEER_SHIM_DIR" && \${path[(Ie)$PUPPETEER_SHIM_DIR]} -eq 1 ]] ||
      path=("$PUPPETEER_SHIM_DIR" \${path:#\${(b)PUPPETEER_SHIM_DIR}})
  }
  autoload -Uz add-zsh-hook && add-zsh-hook precmd _puppeteer_shim_path
fi
`;

export interface ShellIntegrationOptions {
  home: string;
  /** The shell the host births, as a path or a name; its basename chooses the integration. */
  shell: string;
  /** The environment the shell would be born with, before these overrides. */
  environment: Readonly<Record<string, string | undefined>>;
}

/** The variables a host adds to (or replaces in) the environment of a shell it births. */
export function shellIntegrationEnvironment({
  home,
  shell,
  environment,
}: ShellIntegrationOptions): Record<string, string> {
  const layout = spawnThroughLayout(home);
  if (basename(shell).replace(/^-/u, '') === 'zsh') {
    const original = environment.ZDOTDIR;
    // An environment that already names the integration (a shell born from
    // another host's) has no original of its own to give back: the person's is $HOME.
    const inherited = original !== undefined && original !== '' && resolve(original) === resolve(layout.zshDirectory);
    return {
      ZDOTDIR: layout.zshDirectory,
      PUPPETEER_ORIGINAL_ZDOTDIR: inherited ? '' : (original ?? ''),
      PUPPETEER_SHIM_DIR: layout.shimDirectory,
    };
  }
  // Bash and fish are not integrated yet (next slices: bash through `--posix`
  // and `ENV`, fish through a `vendor_conf.d` on `XDG_DATA_DIRS`). Best effort:
  // the shim directory first on the PATH the shell is born with, which the
  // shell's own startup files may reorder.
  const path = environment.PATH ?? '';
  const rest = path
    .split(delimiter)
    .filter((entry) => entry !== layout.shimDirectory)
    .join(delimiter);
  return {
    PUPPETEER_SHIM_DIR: layout.shimDirectory,
    PATH: path === '' ? layout.shimDirectory : `${layout.shimDirectory}${delimiter}${rest}`,
  };
}
