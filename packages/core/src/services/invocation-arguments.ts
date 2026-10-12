import type { AgentNativeInvocationPassthroughKind } from './launch.js';

/** Pure argv mechanics. Adapters supply every name, arity and semantic decision. */
export interface NativeInvocationOption {
  readonly names: readonly string[];
  readonly arity: 'none' | 'one' | 'optional' | 'many';
  /** The spelling the adapter's launch mapper consumes; null means an equivalent default. */
  readonly mapped?: string | null;
  readonly passthrough?: AgentNativeInvocationPassthroughKind;
  /** A value-dependent mode. An absent value remains an unsupported session option. */
  readonly modes?: Readonly<Record<string, AgentNativeInvocationPassthroughKind | 'session'>>;
  readonly reason?: string;
  /** An unlisted native alias, with its source or probe. Census tests exclude it. */
  readonly hidden?: string;
  readonly optionLikeValues?: boolean;
}

export interface NativeInvocationCommand {
  readonly names: readonly string[];
  readonly passthrough?: AgentNativeInvocationPassthroughKind;
  /** A session subcommand with its own option grammar; the command itself is consumed. */
  readonly grammar?: NativeInvocationGrammar;
  readonly reason?: string;
}

/** An option after arity resolution; values cannot be mistaken for other flags. Order is preserved. */
export interface NativeInvocationOptionValue {
  readonly option: NativeInvocationOption;
  readonly name: string;
  readonly values: readonly string[];
  readonly booleanValue?: boolean;
}

export interface NativeInvocationGrammar {
  readonly options: readonly NativeInvocationOption[];
  readonly commands?: readonly NativeInvocationCommand[];
  /** Commander consumes option-looking required values; clap and argparse refuse them. */
  readonly optionLikeValues?: boolean;
  /** Some native parsers do not expand short option clusters. Exact multi-letter aliases always win. */
  readonly shortClusters?: boolean;
  /** Yargs and Go-style boolean options accept --flag=true/false. */
  readonly booleanEquals?: boolean;
  /** Some parsers also consume a following literal true/false for a boolean flag. */
  readonly booleanValues?: boolean;
  /** Parsed utility flags can be cancelled by later values; early-exit parsers leave this false. */
  readonly deferUtilityOptions?: boolean;
  /** Hand-written parsers may recognize commands only at argv[0]. */
  readonly commandFirst?: boolean;
  readonly equals?: boolean;
  /** A management command group that prints help when given no subcommand. */
  readonly defaultPassthrough?: AgentNativeInvocationPassthroughKind;
  /** Adapter-owned dependencies between options, evaluated only after all option arities are known. */
  readonly classifyOptions?: (
    options: readonly NativeInvocationOptionValue[],
  ) => Extract<NativeArgumentsReading, { status: 'passthrough' }> | undefined;
}

export type NativeArgumentsReading =
  | { status: 'accepted'; argv: string[] }
  | { status: 'passthrough'; kind: AgentNativeInvocationPassthroughKind; reason: string }
  | { status: 'rejected'; argument: string; reason: string };

/**
 * Read only arguments, never files or processes. A known unsupported option can precede a
 * utility or a one-shot. An unknown option stops the read: its unknown arity could consume the
 * apparent mode switch. Values and everything after `--` are never interpreted as switches.
 */
export function readNativeInvocationArguments(
  argv: readonly string[],
  initialGrammar: NativeInvocationGrammar,
): NativeArgumentsReading {
  let grammar = initialGrammar;
  const mapped: string[] = [];
  const options: NativeInvocationOptionValue[] = [];
  let refused: Extract<NativeArgumentsReading, { status: 'rejected' }> | undefined;
  const modes = new Map<NativeInvocationOption, Extract<NativeArgumentsReading, { status: 'passthrough' }>>();
  let sawOperand = false;
  const rejection = (argument: string, reason: string): Extract<NativeArgumentsReading, { status: 'rejected' }> => ({
    status: 'rejected',
    argument,
    reason,
  });
  const pass = (kind: AgentNativeInvocationPassthroughKind, reason: string) => ({
    status: 'passthrough' as const,
    kind,
    reason,
  });

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--') {
      if (index + 1 < argv.length)
        refused ??= rejection(
          argv[index + 1]!,
          'the managed launch cannot carry an initial prompt or positional argument',
        );
      break;
    }
    if (!argument.startsWith('-') || argument === '-') {
      const command =
        !sawOperand && (!grammar.commandFirst || index === 0)
          ? grammar.commands?.find((row) => row.names.includes(argument))
          : undefined;
      if (command?.passthrough)
        return pass(
          command.passthrough,
          command.reason ?? 'the native command does not run an interactive session here',
        );
      if (command?.grammar) {
        grammar = command.grammar;
        sawOperand = false;
        continue;
      }
      sawOperand = true;
      refused ??= rejection(argument, command?.reason ?? 'the managed launch cannot carry this positional argument');
      continue;
    }

    let remaining = argument;
    while (remaining) {
      let name = remaining;
      let inline: string | undefined;
      let row = grammar.options.find((option) => option.names.includes(name));
      if (!row && grammar.equals !== false && remaining.includes('=')) {
        const separator = remaining.indexOf('=');
        name = remaining.slice(0, separator);
        inline = remaining.slice(separator + 1);
        row = grammar.options.find((option) => option.names.includes(name));
      }
      if (!row && grammar.shortClusters !== false && /^-[^-].+/u.test(remaining)) {
        name = remaining.slice(0, 2);
        row = grammar.options.find((option) => option.names.includes(name));
        if (row) inline = remaining.slice(2);
      }
      if (!row) return rejection(argument, 'the adapter does not know this option or its arity');

      let booleanValue = row.arity === 'none' ? true : undefined;
      if (row.arity === 'none' && inline !== undefined) {
        if (name.length === 2 && !remaining.includes('=') && grammar.shortClusters !== false) {
          remaining = `-${inline}`;
          inline = undefined;
        } else if (grammar.booleanEquals && (inline === 'true' || inline === 'false')) {
          remaining = '';
          booleanValue = inline === 'true';
        } else return rejection(argument, 'this native flag does not take a value');
      } else remaining = '';

      if (row.arity === 'none' && grammar.booleanValues && inline === undefined && !remaining) {
        const next = argv[index + 1];
        if (next === 'true' || next === 'false') {
          booleanValue = next === 'true';
          index += 1;
        }
      }

      const values: string[] = [];
      if (row.arity !== 'none') {
        if (inline !== undefined) values.push(inline);
        else {
          const next = argv[index + 1];
          if (
            next !== undefined &&
            (next !== '--' || (row.arity === 'one' && (row.optionLikeValues ?? grammar.optionLikeValues))) &&
            (!next.startsWith('-') ||
              next === '-' ||
              (row.arity === 'one' && (row.optionLikeValues ?? grammar.optionLikeValues)))
          ) {
            values.push(next);
            index += 1;
          } else if (row.arity === 'one') return rejection(argument, 'this native option requires a value');
        }
        if (row.arity === 'many') {
          while (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith('-')) values.push(argv[++index]!);
        }
      }

      options.push({ option: row, name, values, ...(booleanValue === undefined ? {} : { booleanValue }) });
      if (booleanValue === false) {
        modes.delete(row);
        refused ??= rejection(argument, 'the managed launch cannot preserve an explicit false flag');
        continue;
      }

      const mode = row.modes
        ? Object.hasOwn(row.modes, values[0] ?? '')
          ? row.modes[values[0] ?? '']
          : undefined
        : row.passthrough;
      if (row.modes && mode === undefined)
        return rejection(argument, 'the adapter does not recognize this native mode');
      if (mode && mode !== 'session') {
        const result = pass(mode, row.reason ?? 'the native option selects a non-interactive or external operation');
        if (mode === 'utility' && !grammar.deferUtilityOptions) return result;
        modes.set(row, result);
      } else if (mode === 'session') modes.delete(row);

      if (row.mapped !== undefined) {
        if (row.mapped !== null) mapped.push(row.mapped, ...values);
      } else if (!mode || mode === 'session') {
        refused ??= rejection(argument, row.reason ?? 'the managed launch cannot preserve this option');
      }
    }
  }
  const mode = initialGrammar.classifyOptions?.(options) ?? modes.values().next().value;
  return (
    mode ??
    refused ??
    (grammar.defaultPassthrough
      ? pass(grammar.defaultPassthrough, 'the native command group runs no interactive session')
      : { status: 'accepted', argv: mapped })
  );
}
