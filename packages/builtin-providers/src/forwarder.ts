/**
 * THE BUILTIN FORWARDER ENTRY. A host that cannot run a script (a single executable runs only its own sealed entry)
 * bundles this entry into itself and lends the program that runs it as `AgentHost.forwarderRuntime`; an agent's
 * hooks and status lines then run `<command> <args...> <word> <word args...>`. Importing it runs it, on
 * `process.argv.slice(2)`.
 *
 * A word is routed by its provider prefix to that adapter's own forwarder, whose word table is the protocol:
 * append-only across releases, since an agent launched by one build runs the entry a later build ships. Bundle it
 * into one CommonJS file (esbuild, node22): there is no top-level await, and it imports only the adapters'
 * self-contained forwarder modules.
 *
 * Launch environments carry bearer tokens: nothing here prints an argument or a variable.
 */
import { runClaudeForwarder } from '@vibefield/puppeteer-adapter-claude/forwarder';

/** A word no adapter here owns: the shell's own code for a command it cannot find. */
const EXIT_UNKNOWN_WORD = 127;

function forward(argv: readonly string[]): Promise<number> {
  const [word] = argv;
  if (word?.startsWith('claude.')) return runClaudeForwarder(argv);
  process.stderr.write('puppeteer: no forwarder here knows the word it was given; nothing was forwarded.\n');
  return Promise.resolve(EXIT_UNKNOWN_WORD);
}

forward(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`puppeteer: the forwarder failed: ${error instanceof Error ? error.name : 'error'}\n`);
    process.exitCode = 1;
  },
);
