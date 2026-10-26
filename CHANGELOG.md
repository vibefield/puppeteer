# Changelog

## [0.2.3](https://github.com/vibefield/puppeteer/compare/v0.2.2...v0.2.3) (2026-10-26)


### Features

* **adapter-codex:** a resumed thread starts at the chosen model and effort ([0e53080](https://github.com/vibefield/puppeteer/commit/0e530809418622eb084c07eb40ed435107b86bd1))
* **adapters:** declare which native resumes take a model selection ([0e53080](https://github.com/vibefield/puppeteer/commit/0e530809418622eb084c07eb40ed435107b86bd1))
* **runtime:** a resume starts at the session's own model selection ([0e53080](https://github.com/vibefield/puppeteer/commit/0e530809418622eb084c07eb40ed435107b86bd1))
* the dev line's content on the public line — PJ-6, SWF and d3e82aa..fa0d6cf ([#43](https://github.com/vibefield/puppeteer/issues/43)) ([0e53080](https://github.com/vibefield/puppeteer/commit/0e530809418622eb084c07eb40ed435107b86bd1))
* **views:** the swarm fits its field — spawns keep clear of the chrome, the words step down on three rungs, one shared scale fits the crowd, the centre's pull is radial, bodies shrink together (the SWF series, 10 commits) ([0e53080](https://github.com/vibefield/puppeteer/commit/0e530809418622eb084c07eb40ed435107b86bd1))


### Bug Fixes

* **deps:** zod 4.6.7 under the published packages for GHSA-mrhx-c7xc-m3w5, and the dev toolchain's 15 alerts ([#44](https://github.com/vibefield/puppeteer/issues/44)) ([7ec454d](https://github.com/vibefield/puppeteer/commit/7ec454d8a950ef379ee1415eccda62d01bd9163a))

## [0.2.2](https://github.com/vibefield/puppeteer/compare/v0.2.1...v0.2.2) (2026-10-26)


### Features

* **adapters:** adapt Claude Code 2.1.308, Codex 0.164.0 and Grok 1.0.70 ([#38](https://github.com/vibefield/puppeteer/issues/38)) ([a6f067c](https://github.com/vibefield/puppeteer/commit/a6f067ceb5ad1b0749ecb9672457b9238022aebe))

## [0.2.1](https://github.com/vibefield/puppeteer/compare/v0.2.0...v0.2.1) (2026-10-13)


### Bug Fixes

* **release:** verify npm consumers and harden trusted publishing ([#34](https://github.com/vibefield/puppeteer/issues/34)) ([85aa968](https://github.com/vibefield/puppeteer/commit/85aa968d2adb5dbc103cfc2756c6d396f371fa75))

## [0.2.0](https://github.com/vibefield/puppeteer/compare/v0.1.8...v0.2.0) (2026-10-13)


### ⚠ BREAKING CHANGES

* **release:** public packages now use @vibefield/puppeteer-* names. Testing helpers require Vitest >=4.1.11 <5; the View SDK uses the same optional Vitest peer range.
* **profiles:** @vibecook/puppeteer-adapter-kimi no longer exports findKimiAccessToken, resolveKimiAccessToken, kimiCredentialsPath, kimiUsageUrl or KimiCredentialOptions, and its usage options take `root` in place of `credentialsPath`. @vibecook/puppeteer-adapter-grok's GrokBillingTransport is now GrokAgentTransport, exported from transport/agent-client.
* **types:** adopt exactOptionalPropertyTypes and noUncheckedIndexedAccess across the workspace
* **monitor:** Remove planning:updated and delegation:task-* events, SessionRuntimeState.tasks, and monitor task/plan fields, notifications, bounds, and planning freshness. Monitor snapshots now use schema version 2.
* rename project to puppeteer

### Features

* **adapters:** support Antigravity Copilot and Pi ([adfe2ec](https://github.com/vibefield/puppeteer/commit/adfe2ec1d185736922a2ab18b01ab4f521c6ff92))
* add agent distribution and account profiles (RFC 006 phase 1) ([b5de1f7](https://github.com/vibefield/puppeteer/commit/b5de1f75da9b24353d23a058fd3540d354e554b6))
* add Kimi and Grok account usage limits ([3944e17](https://github.com/vibefield/puppeteer/commit/3944e17ae779818273247ab145e910fcde371fff))
* **antigravity:** add print-mode account usage limits ([2beb0c2](https://github.com/vibefield/puppeteer/commit/2beb0c23a3e6235f763ee051bd4843e18a946b28))
* **core:** carry the root agent's last reply and split usage samples by side ([3e70222](https://github.com/vibefield/puppeteer/commit/3e70222ad19689b32c7f41f90470954c2c92753c))
* **events:** normalize workspace file activity ([cd7520a](https://github.com/vibefield/puppeteer/commit/cd7520a9c1429d4b71c4489413ad6196aec431d5))
* **extensions:** a server's sign-in and sign-out — the agent's own login in a terminal the person answers, its own logout as an act ([1def18f](https://github.com/vibefield/puppeteer/commit/1def18f039c5e186a22c0291db2f326209f0182c))
* **extensions:** acts — a server or skill an agent holds turned on, off or out through its own command or protocol ([7926ca9](https://github.com/vibefield/puppeteer/commit/7926ca9cd648014eb0bce2d49032efd65bd0e85f))
* **extensions:** every agent's plugins, marketplaces, MCP servers and skills, read per profile from its own stores ([63bf175](https://github.com/vibefield/puppeteer/commit/63bf175da25f3ad70101cadb792e4440fb9aa097))
* **godview:** add the Agents drawer, profile-bound terminals, and account usage per profile ([97c0c72](https://github.com/vibefield/puppeteer/commit/97c0c72a313ba50633ae0373283e041b2261cdea))
* **godview:** deal each project one colour and let panes borrow it ([b23247f](https://github.com/vibefield/puppeteer/commit/b23247f390518155300ec994f74faa61fbca25be))
* **godview:** display and persist observed USD costs ([a7a0c4e](https://github.com/vibefield/puppeteer/commit/a7a0c4e456eac91a8388bdb420a4823cf20ae94c))
* **godview:** draw the deck's minimal pane frame ([3e199ac](https://github.com/vibefield/puppeteer/commit/3e199acfd4e913da887713bff08cbdfe09783d19))
* **godview:** enable Command-click terminal links ([1f2916b](https://github.com/vibefield/puppeteer/commit/1f2916b05d4b4fbdceff535595d4871f503fd5a8))
* **godview:** find an agent by what was said, through the history daemon ([d41a400](https://github.com/vibefield/puppeteer/commit/d41a4006b22e6a67ce4e5e5f9dcefd0498640fa8))
* **godview:** give each pane its own colour and mark the project with a bar ([f0d61ac](https://github.com/vibefield/puppeteer/commit/f0d61acc775a1c21490f9506a00f973152c0fbf9))
* **godview:** keep each conversation's usage ledger in the app cache ([5ca3c4b](https://github.com/vibefield/puppeteer/commit/5ca3c4b52adca917f842554b86611beb2c0b5848))
* **godview:** keep the UI's own token ledger and draw the burn from it ([8001bf9](https://github.com/vibefield/puppeteer/commit/8001bf93e4f9b6de24c1c8578a23560c01f15508))
* **godview:** move settings button to app header ([8a42202](https://github.com/vibefield/puppeteer/commit/8a42202ab3ea68529c37f69400696c9fb3e171cf))
* **godview:** port the vibe-field skin, draw the swarm on WebGPU, and add the bar, usage column and rain view ([28b6d70](https://github.com/vibefield/puppeteer/commit/28b6d701a670840f0afda709be8d81e112df7cfa))
* **godview:** split terminal panes evenly ([a572235](https://github.com/vibefield/puppeteer/commit/a572235fc23860599f74c2fcd2ac6fff65f767f4))
* **godview:** tune the terminal safe area per side from the system control panel ([4f208fa](https://github.com/vibefield/puppeteer/commit/4f208fa0d250115489760f0b83a080f534a11840))
* **imposter:** emulate Rosetta-backed agents ([62baf22](https://github.com/vibefield/puppeteer/commit/62baf22b1da8e55bf14d2011453e41648c4cc379))
* **profiles:** plans — what a profile set runs on, read from its sign-ins, and each company's mark to draw it ([74dc03a](https://github.com/vibefield/puppeteer/commit/74dc03acb1d9a43d7d0e583fdabda09eaa0047a0))
* **profiles:** sign-ins and the services they bill — every agent says who is signed in, and harnesses list what they hold ([16493b4](https://github.com/vibefield/puppeteer/commit/16493b434338c8bf83f13cc33521b045883c2fff))
* **profiles:** the observation root — where a profile's history lives, adapter-owned ([719d98d](https://github.com/vibefield/puppeteer/commit/719d98d9ba49b070020c16535e1e456159ccb12f))
* **release:** move public packages to [@vibefield](https://github.com/vibefield) ([5abe8f7](https://github.com/vibefield/puppeteer/commit/5abe8f75d4b370db4cd8d2418a55fcc971680fb8))
* **runtime:** estimate USD costs from native usage ([81d2a28](https://github.com/vibefield/puppeteer/commit/81d2a28ba2f8d21e1ade1ed3f0814a23c17fdf67))
* **runtime:** plan an update before it runs, and say which release an install would take ([ea90c34](https://github.com/vibefield/puppeteer/commit/ea90c34bfd697abf470d6e830fdc8b97a0e92256))
* **runtime:** profile sets — named places for accounts, one default, and a sign-out that waits for its sessions ([50ac021](https://github.com/vibefield/puppeteer/commit/50ac021183a67619a635e945c6095b31bb5a0329))
* **runtime:** stable ingress — host-pinnable bridge, attach to a running session, detaching dispose ([d013fef](https://github.com/vibefield/puppeteer/commit/d013fef8af613ed0dfb8645dc45107c81ad06237))
* **runtime:** updates run unattended, can be stopped, and never claim a currency they did not see ([497de8e](https://github.com/vibefield/puppeteer/commit/497de8ee7a1a2ae5447a0593eaadb449958ab8f3))
* **surface:** acquire source-installed agent artifacts ([9520880](https://github.com/vibefield/puppeteer/commit/9520880357550808a2a56c839149248eaf47a022))
* **surface:** add canonical ground truth layer ([b37ee73](https://github.com/vibefield/puppeteer/commit/b37ee736e53da3f1916d7df6f6fdcb222e01e7bb))
* **surface:** attest locked installed consoles ([009cc0d](https://github.com/vibefield/puppeteer/commit/009cc0d63628c087ae27d3ce83ba1c63381d9902))
* **surface:** attest source-built runtime bundles ([0a8a5a7](https://github.com/vibefield/puppeteer/commit/0a8a5a77af4af275e2f364829154c066b4ec27e0))
* **surface:** enforce fidelity-aware agent ground truth ([3d90bb3](https://github.com/vibefield/puppeteer/commit/3d90bb3a7ab192565fd173134aaa9831ad40877e))
* **surface:** import Rosetta truth for three agents ([9e71121](https://github.com/vibefield/puppeteer/commit/9e7112198774e1832ddd5719f136bf18e1b79ee3))
* **surface:** verify installed-console reconstruction ([ba3b8ca](https://github.com/vibefield/puppeteer/commit/ba3b8ca87639e685c401b14055c845d4cd02ccfe))
* **usage:** groups — each meter names the part of the plan it measures, and a reserve waits in standby ([2c874bf](https://github.com/vibefield/puppeteer/commit/2c874bf58a514f14baf8c2d4f904b922fd851c0c))
* **usage:** isolate live accounting from transcripts ([2ea46c7](https://github.com/vibefield/puppeteer/commit/2ea46c78c77e3c158f6c4c5f72d7251e9bf62697))
* **views:** a peer's session says its host — the name first, the write policy both ways ([5389449](https://github.com/vibefield/puppeteer/commit/5389449e5f021b8ceb20beec6e89be113612a182))
* **views:** profile tabs — a sliding segment of Agent Profiles for the instrument bar, and rows a host recedes in every view ([bf57141](https://github.com/vibefield/puppeteer/commit/bf57141ce900e5772b5f8ccb050f850a53d3071f))
* **views:** the Godview views become a package — the swarm on WebGPU, the list, the rain, the bar, the usage column and the find sheet behind injected ports ([f33da93](https://github.com/vibefield/puppeteer/commit/f33da9364b8343596e0d5b8e4f3f9c224c9ad02e))
* **views:** the palette reads from the Godview root it is given ([77f24fd](https://github.com/vibefield/puppeteer/commit/77f24fd99d2405fbd6d5f0d79ea7b37c59389acb))
* **views:** the pane frame becomes the package's — the badge, the readout, the meter and the verbs behind a port ([aa34eb1](https://github.com/vibefield/puppeteer/commit/aa34eb1b5605eb7d6fb30db8bd28855fe37c8f1a))
* **views:** the swarm body says one thing at a time — cost, state, identity and one ink ([29ce206](https://github.com/vibefield/puppeteer/commit/29ce2063631a65974cff2370825358cc73e6076f))


### Bug Fixes

* **adapter-claude:** tolerate status telemetry load ([6130c67](https://github.com/vibefield/puppeteer/commit/6130c6776d28d1f3f0021d8c7f01424a551c672c))
* **adapter-hermes:** give the updater the budget its gateway drain needs ([2cba428](https://github.com/vibefield/puppeteer/commit/2cba4289bb285f9cbcb2884d96151abed69445f4))
* **adapter-kimi:** update a native-installer install by running Kimi's install script again ([ddb6e34](https://github.com/vibefield/puppeteer/commit/ddb6e34aae604e9c27e54c84f8ef3ea001c0175c))
* **adapters:** harden resume and resource conformance ([e8260af](https://github.com/vibefield/puppeteer/commit/e8260af68d6449d60496f490b88cd937eba770ce))
* **claude:** bind a native resume to the session Claude announces ([83a5b2b](https://github.com/vibefield/puppeteer/commit/83a5b2bf480e871271c3a79066747844e8d819c4))
* **claude:** name and deduplicate account usage limits ([bb2720c](https://github.com/vibefield/puppeteer/commit/bb2720c0ccbfc010a8f712254eecc6542ae566fa))
* **claude:** prevent Godview freezes when resuming sessions ([0296565](https://github.com/vibefield/puppeteer/commit/02965650fb60e28d6482b27b8211d0a6413accd0))
* **claude:** refuse to resume a conversation that is not on disk ([2791f4f](https://github.com/vibefield/puppeteer/commit/2791f4f3ce184a4af9ed3bb3e5a36adca47e4179))
* **claude:** replay transcripts in causal order ([09c8d7a](https://github.com/vibefield/puppeteer/commit/09c8d7aafe996323295518bed630c6b897d5f055))
* **codex:** distinguish model-specific usage windows ([97b1a39](https://github.com/vibefield/puppeteer/commit/97b1a3969467cad96fa10bd867d4531e12bc4dfe))
* **codex:** finish normalized endpoint migration ([45afc87](https://github.com/vibefield/puppeteer/commit/45afc87810b86092906a97f4697514d972592e7a))
* **codex:** normalize app-server endpoints ([a8c3d38](https://github.com/vibefield/puppeteer/commit/a8c3d3880c32b9ced830dd285619f6cfc4c6b278))
* **codex:** restore accurate monitor state after resume ([4ddb9c4](https://github.com/vibefield/puppeteer/commit/4ddb9c4eee4319a45f15fd567d71e3a08f45be42))
* **godview:** one monitor row per identity after a crashed agent's handoff ([9e2ffda](https://github.com/vibefield/puppeteer/commit/9e2ffdaf3aceeadd171cac9e6056f67369306d82))
* **godview:** refresh monitor folder from live terminal cwd ([3e37813](https://github.com/vibefield/puppeteer/commit/3e3781304262901610d169bdc254e3ade445801b))
* **godview:** restore Rosetta search compatibility ([226faa2](https://github.com/vibefield/puppeteer/commit/226faa2e32ce234f7810f914861c25c3c08a0ca9))
* **godview:** the control reset weighs nothing — the instrument bar draws at §04's 9px 700 ([e447d00](https://github.com/vibefield/puppeteer/commit/e447d0084f97fd455ca359b8e94b63bdeb06933a))
* **godview:** the swarm lab builds again, and hands its controls to the page ([3e5f6a8](https://github.com/vibefield/puppeteer/commit/3e5f6a8d37efe5e799031e2852c97cc29cd5239a))
* **grok:** report live token usage and context metrics ([948bd9d](https://github.com/vibefield/puppeteer/commit/948bd9defd38a494b8443be9eb2856917c021793))
* **hermes:** bundle gateway host in published adapter ([84a7a33](https://github.com/vibefield/puppeteer/commit/84a7a33597a516ce7d74cfb263ebcefb47ad1812))
* **hermes:** share exact native TUI event rail ([0135ed1](https://github.com/vibefield/puppeteer/commit/0135ed1aa5e961c0daa049ee7d2fc7ca87d69447))
* **hermes:** unblock private native TUI startup ([486127e](https://github.com/vibefield/puppeteer/commit/486127e55af08415dad3d1682d14715b8b222a83))
* isolate agent observation and await launch cleanup ([9d70d35](https://github.com/vibefield/puppeteer/commit/9d70d35f389d4941f075b7b195ca6bdd8047d52d))
* **kimi:** keep live harness unpublished ([34c5651](https://github.com/vibefield/puppeteer/commit/34c5651afe7b44442f2e89164bcce0e660815c45))
* make session reattachment safe and restore verification ([d2b0600](https://github.com/vibefield/puppeteer/commit/d2b060042253eea3f033efb10ed65a499e346427))
* **runtime, adapter-claude:** stable ingress hardened — a release keeps the process's files, attach validates before it binds, a live claim survives a failed bind, a missed /clear is followed ([8402184](https://github.com/vibefield/puppeteer/commit/84021840c6d75816bd6c0f7c08ef4384261c2160))
* **runtime:** profile sets after review — writes that never lag the file, spawns an unreadable registry cannot stop, and sign-outs that claim no more than they did ([4240196](https://github.com/vibefield/puppeteer/commit/4240196e7a43b0a5a23c1e8070c97367fd2d928d))
* **surface:** keep source archives out of executable lanes ([8631c9c](https://github.com/vibefield/puppeteer/commit/8631c9c645749a77575063b90ea36bc51e6b11a4))
* **surface:** require artifact-bound live promotion proof ([b961eda](https://github.com/vibefield/puppeteer/commit/b961edacd0f3597bfa19a90271022f19b8ce7de7))
* **usage:** support scoped refresh with cooldown and backoff ([0e48233](https://github.com/vibefield/puppeteer/commit/0e48233e64dadd463c1a0b1cc22e9908607c1a7f))
* **views:** a facet may precede its first monitor state; the swarm names its renderer; the lab fixtures are exported ([b9a0ce9](https://github.com/vibefield/puppeteer/commit/b9a0ce973638471ae859c4f80ca7a92ff2843740))
* **views:** the find sheet gives focus back; a swarm body names its source ([8af9df9](https://github.com/vibefield/puppeteer/commit/8af9df9e45a9eab2fa106d1069d11ce00f19c409))
* **views:** the frame keeps a fresh split's folder, draws the line for a bare shell, and names its seams once ([73b2d64](https://github.com/vibefield/puppeteer/commit/73b2d646e19880ec192947031903ca349380ded2))
* **views:** the physics provider stays exported from the main entry ([b0f08ec](https://github.com/vibefield/puppeteer/commit/b0f08ec8f856ca1aa04f60970e0e70fa9137a3db))
* **views:** the review's findings — the column follows its port, a hit's root is never a guess, the physics subpath carries no React, the emitted types name their dependency ([4d734c9](https://github.com/vibefield/puppeteer/commit/4d734c93b8ba90d1248b71f8dfa129898fee6a8c))


### Performance Improvements

* **godview:** answer a keystroke with two daemon calls, not three ([b3019bd](https://github.com/vibefield/puppeteer/commit/b3019bd974c10f7bf712f7f805f5827ea440bd22))
* **godview:** prewarm Codex model cache ([99cf5fd](https://github.com/vibefield/puppeteer/commit/99cf5fd96527df8b85ce4b02e7db0579b8c53627))


### Miscellaneous Chores

* **types:** adopt exactOptionalPropertyTypes and noUncheckedIndexedAccess across the workspace ([0a9eb8f](https://github.com/vibefield/puppeteer/commit/0a9eb8f10c0977a21e8deb6d2b8275f5d10070d2))


### Code Refactoring

* **monitor:** remove todo, task, and plan tracking ([d44bcf9](https://github.com/vibefield/puppeteer/commit/d44bcf9277d212ef87e804923d98eef6f8904fb0))
* rename project to puppeteer ([6d3dc78](https://github.com/vibefield/puppeteer/commit/6d3dc78e4f08124e23935e530ad104e8896f048c))

## [0.1.8](https://github.com/vibecook-dev/puppeteer/compare/v0.1.7...v0.1.8) (2026-08-03)


### Features

* **godview:** open the agent monitor to more than one view ([2961a8b](https://github.com/vibecook-dev/puppeteer/commit/2961a8bec36ac398b361b8a6426bf850e2bc3c86))
* **godview:** open the agent monitor to more than one view ([f580e92](https://github.com/vibecook-dev/puppeteer/commit/f580e92192b597c84da42b658256db879fea92a7))

## [0.1.7](https://github.com/vibecook-dev/puppeteer/compare/v0.1.6...v0.1.7) (2026-08-01)


### Features

* **godview:** record what each window would need to come back ([c761b41](https://github.com/vibecook-dev/puppeteer/commit/c761b4195d3bc18120d0f02ac7d2cd59bedd873f))
* **godview:** record what each window would need to come back (reland) ([82ed33d](https://github.com/vibecook-dev/puppeteer/commit/82ed33de24794363e81569c5a8166c285b8a4fa7))
* **godview:** restore the previous session on launch ([af3a4a5](https://github.com/vibecook-dev/puppeteer/commit/af3a4a5dbd080d3c780dcb989df6beac6189da16))
* **godview:** restore the previous session on launch ([6325c0f](https://github.com/vibecook-dev/puppeteer/commit/6325c0fb9b8f7bcc745d5f8bf0adf8e99ffe8c7a))


### Bug Fixes

* **godview:** keep a window's pane layout across close and reopen ([65b1dd1](https://github.com/vibecook-dev/puppeteer/commit/65b1dd1c38ec65323ebfaa5950558ce7d6a69597))
* **godview:** keep a window's pane layout across close and reopen ([211766e](https://github.com/vibecook-dev/puppeteer/commit/211766ea88d176d6a063c5d17517126d90d22ed6))

## [0.1.6](https://github.com/vibecook-dev/puppeteer/compare/v0.1.5...v0.1.6) (2026-07-31)


### Bug Fixes

* **apps:** fail the smoke run when another instance holds the lock ([30ee611](https://github.com/vibecook-dev/puppeteer/commit/30ee611599abcbec53d3ba5d668ff25ab284ed0d))
* **apps:** fail the smoke run when another instance holds the lock ([4aae6a0](https://github.com/vibecook-dev/puppeteer/commit/4aae6a03ffa5acd7b2a386928577501ff92aa1ba))

## [0.1.5](https://github.com/vibecook-dev/puppeteer/compare/v0.1.4...v0.1.5) (2026-07-31)


### Bug Fixes

* **apps:** bundle the Ghosttea bridge so its imports resolve ([66bb92e](https://github.com/vibecook-dev/puppeteer/commit/66bb92e29ec7112380ad2d903877790139c08d29))
* **apps:** bundle the Ghosttea bridge so its imports resolve ([bc33ac1](https://github.com/vibecook-dev/puppeteer/commit/bc33ac1463399b5e36d33319620e9224fc73ce79))
* **apps:** stage the ghosttead binary, and move to Ghosttea 0.5.1 ([82efc9e](https://github.com/vibecook-dev/puppeteer/commit/82efc9e720c503c1df9cb7911dd236d7f8613310))
* **apps:** stage the ghosttead binary, and move to Ghosttea 0.5.1 ([09cf973](https://github.com/vibecook-dev/puppeteer/commit/09cf973f1e4cd689ab6435e88561941530d82237))

## [0.1.4](https://github.com/vibecook-dev/puppeteer/compare/v0.1.3...v0.1.4) (2026-07-28)


### Features

* add agent environment telemetry ([daeab4b](https://github.com/vibecook-dev/puppeteer/commit/daeab4b8735b65c4db5d282adb8baa398d201abc))
* add caller-owned terminal adoption ([a3aff40](https://github.com/vibecook-dev/puppeteer/commit/a3aff40cc18a9fe7e617fced1356399eddbb2b38))
* add cross-agent context telemetry ([ba28611](https://github.com/vibecook-dev/puppeteer/commit/ba28611b7dda14d545548c94448c2666dae99fda))
* add provider account usage limits ([808402e](https://github.com/vibecook-dev/puppeteer/commit/808402e59c6ae1d75b82475dc6e3f33a2e86485f))
* add truffle-enabled godview app ([5e92b55](https://github.com/vibecook-dev/puppeteer/commit/5e92b556aafb07b1f7d2866d98321ee43d9e0e2a))
* **apps:** surface terminal and agent activity ([41fc563](https://github.com/vibecook-dev/puppeteer/commit/41fc56381dec72e10956629fb291e04fdcfa74b4))
* **godview:** add agent mounting interactions ([45ac4f3](https://github.com/vibecook-dev/puppeteer/commit/45ac4f31645fee053309026080a9f224a52994a9))
* **godview:** add centered bubble spawn motion ([bd53215](https://github.com/vibecook-dev/puppeteer/commit/bd53215a34bd88d37bbcabfeeaa1f7cd730938fd))
* **godview:** add themes and pane color links ([c5985e2](https://github.com/vibecook-dev/puppeteer/commit/c5985e208eb4dda46d38d63563fa4826aed8e1f0))
* **godview:** match prototype physics and add tuning controls ([148e17d](https://github.com/vibecook-dev/puppeteer/commit/148e17db7fbd370ccede0e9639e5a47785c50682))
* **godview:** show agent usage limits ([7ce35df](https://github.com/vibecook-dev/puppeteer/commit/7ce35dfbe282a955b0135e938286c3a64b7805ea))


### Bug Fixes

* **apps:** bound agent state delivery ([1c44d00](https://github.com/vibecook-dev/puppeteer/commit/1c44d00a89e6c16e5a65d1006c6cb1fae1ca80fa))
* **apps:** preserve pane cwd and restore clipboard ([8aef161](https://github.com/vibecook-dev/puppeteer/commit/8aef161fcceaf14ba910b4e65105c6b9df202b92))
* **claude:** prefer statusline usage and refresh OAuth tokens ([3e494ce](https://github.com/vibecook-dev/puppeteer/commit/3e494ce35eaaa285417e64ce259cda5b186e638e))
* **godview:** finalize terminal activity cleanup ([1353bc9](https://github.com/vibecook-dev/puppeteer/commit/1353bc9fccc407e073e5ddbc67b40dd14173c66a))
* **godview:** show folder names in pane badges ([9024913](https://github.com/vibecook-dev/puppeteer/commit/9024913da6e50e44d713fd54feb8e3e3c1500692))
* harden runtime telemetry observers ([d30bc07](https://github.com/vibecook-dev/puppeteer/commit/d30bc07393fe210a886baa541e1e2c1d4596527b))
* harden session replay and terminal lifecycle ([7df3dfe](https://github.com/vibecook-dev/puppeteer/commit/7df3dfee32ad887bbe3b0fcad88de0dd7323a13d))
* project Grok terminal turns ([77b4279](https://github.com/vibecook-dev/puppeteer/commit/77b42792eeafb249774103ac12c5fa222550b2db))
* **runtime:** attach Git watchers before announcing state ([d28ec79](https://github.com/vibecook-dev/puppeteer/commit/d28ec7967b9bd7608da601a6361ee6a073f5a56f))
* stage transitive ghosttea bridge runtime ([c55749a](https://github.com/vibecook-dev/puppeteer/commit/c55749a598de72167548902b35e92235b8f0ab2e))

## [0.1.3](https://github.com/jamesyong-42/puppeteer/compare/v0.1.2...v0.1.3) (2026-07-19)


### Features

* complete unified agent launch options ([438d0a2](https://github.com/jamesyong-42/puppeteer/commit/438d0a2013400349f2b695b24651a839e7f498bb))

## [0.1.2](https://github.com/jamesyong-42/puppeteer/compare/v0.1.1...v0.1.2) (2026-07-19)


### Bug Fixes

* align release tags with publish guard ([8ae50ac](https://github.com/jamesyong-42/puppeteer/commit/8ae50acd81ca38a5e0f0b9bb5a0d91094f3a1c0c))
* load current tooling for release retries ([38fead0](https://github.com/jamesyong-42/puppeteer/commit/38fead09868ea1547363b1c232898ec2bba5798e))
* publish packages with oidc-capable npm ([e2fa39c](https://github.com/jamesyong-42/puppeteer/commit/e2fa39c58c8140da04393e53e789792c9bb7cff1))
* publish rewritten workspace tarballs ([83f4094](https://github.com/jamesyong-42/puppeteer/commit/83f409416d9fe1154ca6b3917a4103d074b4da5f))
* use OIDC-capable npm for releases ([30541d8](https://github.com/jamesyong-42/puppeteer/commit/30541d854ec6e56a3b53c81f59d6d70110a35608))

## [0.1.1](https://github.com/jamesyong-42/puppeteer/compare/puppeteer-v0.1.0...puppeteer-v0.1.1) (2026-07-19)


### Features

* **adapter-acp:** generic ACP structured driver + normalizer (M6 A2-A4) ([68a2460](https://github.com/jamesyong-42/puppeteer/commit/68a2460e36cbbb1c9ad493afd7b4ddb6f606a5cd))
* **adapter-claude:** createClaudeSession driver — hub-side composition (M2) ([ac80e6f](https://github.com/jamesyong-42/puppeteer/commit/ac80e6f15d433f2c578b27ef0d23458ead973353))
* **adapter-claude:** detection probe, registry-driven settings gen, session prepare (M2-1/M2-3) ([c568aa7](https://github.com/jamesyong-42/puppeteer/commit/c568aa7fe07af684d1489e68723a5650159f2a41))
* **adapter-claude:** hook registry, loopback hook bridge, event normalizer (M2-1/M2-2/M2-4 core) ([744952e](https://github.com/jamesyong-42/puppeteer/commit/744952e2c97167ef446f5877bd5192d778961bf0))
* **adapter-claude:** transcript observer over spaghetti + guarded prompt injection (M2-5/M2-6) ([b98ce4e](https://github.com/jamesyong-42/puppeteer/commit/b98ce4e969eec2f794093df0fec109aee2f9ae7e))
* **adapter-codex:** app-server notification normalizer (M5 C2) ([a50d914](https://github.com/jamesyong-42/puppeteer/commit/a50d91427d8045547fbd10c0bf0f386b8d1e2e24))
* **adapter-codex:** createCodexObserver — attach + observe a TUI thread (M5 C6-2) ([10c85d7](https://github.com/jamesyong-42/puppeteer/commit/10c85d70e3ae219aab4926f1dc2bd14d2d8cdaec))
* **adapter-codex:** createCodexSession structured driver (M5 C4) ([0d59cb3](https://github.com/jamesyong-42/puppeteer/commit/0d59cb37d07bda77c00ed163898c478270b3b25e))
* **adapter-codex:** WebSocket-over-UDS transport + app-server spawn (M5 C6-1) ([fca95e8](https://github.com/jamesyong-42/puppeteer/commit/fca95e8deceb415e2f5076ba69493c1e55b74ddd))
* add agent launch options and release pipeline ([37dd9c5](https://github.com/jamesyong-42/puppeteer/commit/37dd9c5dd95fa16f3ecd4294823bff489bad9764))
* **core:** full AgentEvent union + session state reducer (M0-2, M0-3) ([d06c8cb](https://github.com/jamesyong-42/puppeteer/commit/d06c8cb04032ed3448af412ecff76e82e9ae0cfb))
* migrate workbench terminals to Ghosttea ([1eea6db](https://github.com/jamesyong-42/puppeteer/commit/1eea6dbf777014f859219e7d37a099ae6efa1b25))
* **node:** @xterm/headless mirror sink with serialize snapshots (M1-3) ([efa5dd1](https://github.com/jamesyong-42/puppeteer/commit/efa5dd1f065d861bd222bff24b03f65b6c36135d))
* **node:** PTY transport, process-tree ladder, ordered terminal distributor (M1-1..M1-3 core) ([5518204](https://github.com/jamesyong-42/puppeteer/commit/5518204cf27f0fa3428eb8acd7b8b1dbe11c0e90))
* **record,adapter-claude:** own-action record + native resume (M4) ([f371f75](https://github.com/jamesyong-42/puppeteer/commit/f371f7522d439e90be42c07357118b744294e508))
* **testing:** fake terminal agent + Phase 0 hook fixtures (M0-4) ([1be5bf4](https://github.com/jamesyong-42/puppeteer/commit/1be5bf4f94c8207b2e5c41799058229491e6d18e))
* **workbench:** Claude sessions in the workbench — driver wiring + activity panel (M2) ([ad3a37a](https://github.com/jamesyong-42/puppeteer/commit/ad3a37a1ae922cdcb53498f5473b02f71bd102ef))
* **workbench:** Codex sessions — native TUI tab + structured observer (M5 C6-3) ([c8d18fa](https://github.com/jamesyong-42/puppeteer/commit/c8d18facd1c0e647ef713e2271c0efe80bea42af))
* **workbench:** control Codex from the panel — bracketed-paste injection (M5 C6-4) ([93e4e0a](https://github.com/jamesyong-42/puppeteer/commit/93e4e0aa44a571a13aebb8d1c84dd054ba0443ec))
* **workbench:** Electron dev app with system-Node pty-host (M1-4) ([6b8d5c4](https://github.com/jamesyong-42/puppeteer/commit/6b8d5c40ec65610fe1a122d120de2709f8cff39b))
* **workbench:** Ghostty-fashion terminal UI via avocado TerminalSurface ([9a8b39a](https://github.com/jamesyong-42/puppeteer/commit/9a8b39ad2d54b01b3fe573a0186b176c68f698e9))
* **workbench:** Grok tab — native TUI + leader coexistence (M6 A6c) ([64b11b8](https://github.com/jamesyong-42/puppeteer/commit/64b11b89903ea6b5528246e9742c60b875f0478e))
* **workbench:** own-action record wiring + resume affordance (M4) ([0316ec2](https://github.com/jamesyong-42/puppeteer/commit/0316ec230a8e619e19d27340589436c3445c3441))
* **workbench:** redesign the agent panel as a proper chat UI ([63ea1f1](https://github.com/jamesyong-42/puppeteer/commit/63ea1f1e7b724d988bcf68934dd1f246ba01ec16))
* **workbench:** workspace isolation for Claude sessions (M3) ([54fb120](https://github.com/jamesyong-42/puppeteer/commit/54fb120d6799f2fd997607fa1f0023cd17258d53))
* **workspaces:** shared / git-worktree / copy isolation with final-diff metadata (M3) ([87c1cda](https://github.com/jamesyong-42/puppeteer/commit/87c1cda80b683fadceca4918f9af239d32744576))


### Bug Fixes

* **adapter-codex:** own thread at spawn so panel leaves preparing immediately ([601a067](https://github.com/jamesyong-42/puppeteer/commit/601a067c6d75680a615b2c30b9d1ba5567e352d3))
* **adapter-codex:** retry thread attach until it materializes ([8d3970d](https://github.com/jamesyong-42/puppeteer/commit/8d3970d575c6361d3aeb1d92b1c6f1886207acb2))
* **node:** CJS interop for @xterm/headless under real ESM ([f8f5c94](https://github.com/jamesyong-42/puppeteer/commit/f8f5c94886fcd6e8a3cbf04060199db2f0a4856b))
* preserve interactive auth during publish ([bfad194](https://github.com/jamesyong-42/puppeteer/commit/bfad194b13af15d8fa702301fa940e9059ff67be))
* skip immutable package versions during publish ([b5b83e7](https://github.com/jamesyong-42/puppeteer/commit/b5b83e78c4929eb1adddeff1fedce66c33dcb66d))
* **workbench:** Codex resume — reopen the thread, and gate the button (M5 C6-5) ([b6ad259](https://github.com/jamesyong-42/puppeteer/commit/b6ad2594604926f81aebad5cc271f93ad536ed97))
* **workbench:** Grok tab — TUI-first session creation, faster spawn ([a7dbf50](https://github.com/jamesyong-42/puppeteer/commit/a7dbf50ba8e0a7a06d6b7be12a4a9d9d6b900c47))
* **workbench:** Grok TUI needs --leader to share the session (inject) ([7002a75](https://github.com/jamesyong-42/puppeteer/commit/7002a758e0d181dcb12fbf538873c5ba0a71b41a))
* **workbench:** match avocado ghostty terminal parity ([9e75803](https://github.com/jamesyong-42/puppeteer/commit/9e7580309da8b08622e72916564f76be43e47cbf))
* **workbench:** render agent panel messages from a single source ([8d10432](https://github.com/jamesyong-42/puppeteer/commit/8d10432cd8bab876d0df6a13dda708e9e45440e4))
* **workbench:** use restty auto renderer like ghostty ([fb41cb1](https://github.com/jamesyong-42/puppeteer/commit/fb41cb133c6e035abf4b14b99a2059b3b2ddd19a))
