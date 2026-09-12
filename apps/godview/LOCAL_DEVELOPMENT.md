# Godview with the sibling Ghosttea checkout

The temporary `overrides` block in `pnpm-workspace.yaml` links Ghosttea packages
to `../electron-ghostty`. Keep both repositories next to each other and keep the
Ghosttea checkout's npm dependencies installed. The package.json release pins
remain the fallback when these overrides are removed.

From the Puppeteer repository:

```sh
pnpm install
pnpm godview:local
```

`godview:local` builds the sibling Ghosttea SDK, bundles Godview against it, and
starts Godview. To rebuild while Godview is already open:

```sh
pnpm godview:local:build
```

Reload the Godview window after renderer changes. Restart Godview after changes
to main/preload, the terminal daemon, or native addons. Builds do not reload or
restart running sessions automatically.

Godview warms Codex's native model cache in the background on startup and when
opening a new terminal tab, using that pane's selected account profile. The
probe creates no thread or model turn and closes its helper process afterwards.
Repeated requests for the same account are coalesced and throttled for one minute;
failed probes can be retried. Probes have a five-second request budget and are
cancelled on shutdown. A launch that races prewarming still uses the normal
Codex startup path, and per-thread initialization still happens at launch.

The terminal link feature needs both the updated SDK and daemon. After staging
the rebuilt daemon (or setting `GHOSTTEAD_BIN`), run `pnpm godview:local:build`
and restart Godview. Command-hover and Command-click on macOS (Ctrl elsewhere)
support plain URLs and OSC 8 links, including wrapped links. `link-url = false`
disables automatic URL matching while keeping explicit OSC 8 links available.
File and folder paths also match, including Codex's `~/…` footer, absolute paths,
and relative source references such as `src/main.rs:42`. Relative paths use the
terminal's working directory; `~` uses the terminal process's home directory.
File destinations open in the desktop's default application.

Run `pnpm --filter godview links-smoke` to exercise the complete link path in an
isolated Godview profile with a mouse-reporting TUI fixture. It records URL
opening requests without launching a browser or opening a file. Set `GODVIEW_KEEP_LINK_SMOKE=1`
to retain the screenshot and fixture artifacts.
With Codex installed, run `GODVIEW_LINK_SMOKE_CODEX=1 pnpm --filter godview links-smoke`
to verify Command-hover and Command-click on the real Codex footer directory.
This launches an idle Codex session without submitting an agent prompt.

The local command uses Ghosttea's standard `build:sdk` script. It does not
compile Rust or native addons.

For a quicker cycle when only Godview changed:

```sh
pnpm godview:bundle
```

The local checkout must have its native assets staged. On macOS, the tabs addon
is produced by `npm run build:ghosttea-native-tabs` inside Ghosttea. The daemon
resolver uses the checkout's staged platform package, or `GHOSTTEAD_BIN` when set.
For Rust daemon changes, build Ghosttea's `ghosttead` crate and set `GHOSTTEAD_BIN`
to that output before building and starting Godview.

On this machine, Ghosttea's `target`, `native/build`, and `.build` directories
are local symlinks to `cargo`, `native`, and `swift` under
`/Volumes/SamsungRed/ghosttea-builds`. Keep the SSD mounted for native builds;
do not replace these links with internal-disk output directories. Explicit
`CARGO_TARGET_DIR` or `--target-dir` overrides must also point to the SSD.

To return to published dependencies, remove the temporary `overrides` block,
run `pnpm install`, then run `pnpm godview` as usual.
