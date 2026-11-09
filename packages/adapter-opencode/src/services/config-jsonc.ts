// A bundler takes the ESM build, because the UMD main's inner requires are invisible to it.
// Node takes the UMD main, because the ESM build's extensionless imports are invalid there.
import { parse, type ParseError } from '#jsonc-parser';

/** Match OpenCode's ConfigParse.jsonc: comments and trailing commas, with no recovered partial documents. */
export function parseOpenCodeJsonc(source: string): unknown {
  const errors: ParseError[] = [];
  const document: unknown = parse(source, errors, { allowTrailingComma: true });
  // The parser recovers a value even from invalid input. Such a value is not config evidence.
  if (errors.length > 0) throw new SyntaxError('Invalid OpenCode JSONC');
  return document;
}
