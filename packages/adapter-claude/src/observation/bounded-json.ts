/**
 * Bounded JSON body — what the hook bridge keeps of an authenticated post.
 *
 * Nothing in Claude's hook protocol bounds a body: PostToolUse carries the whole tool_response (an Edit's
 * originalFile, a Write's content twice, an image Read's base64), and it is the only event that closes its tool. So
 * the bridge bounds what it retains, never what a token holder may post:
 * - a body up to `retainBytes` is buffered and read whole by JSON.parse;
 * - a larger one streams through a byte-level scanner that writes a reduced JSON text instead, in which
 *   - a string or number longer than `maxStringBytes` (as posted) reads null,
 *   - once the reduced text reaches `retainBytes`, a top-level container reads null and anything deeper is left
 *     out, so the top-level scalars (hook_event_name, session_id, tool_use_id, duration_ms…) survive whatever their
 *     key order,
 *   - once it reaches twice `retainBytes`, every further member is left out,
 *   - a member whose key is longer than `maxStringBytes` is left out (a key cannot read null).
 *
 * Every value nulled or left out is counted and the first ones' paths are named. A body holds O(retainBytes +
 * nesting depth) bytes. The structural characters are ASCII, so the scanner copies raw UTF-8 bytes as posted and
 * the reduced text is decoded once, at the end; it validates the whole body, elided parts included.
 */

export interface BoundedJsonOptions {
  /** A body up to this many bytes is kept whole; a larger one is reduced to about this many. */
  retainBytes: number;
  /** In a reduced body, a string or number longer than this many bytes (as posted) reads null. Default 4 KiB. */
  maxStringBytes?: number | undefined;
}

/** What a reduced body lost. */
export interface BodyReduction {
  /** Bytes the sender posted. */
  receivedBytes: number;
  /** Values that read null or were left out; a container counts once. */
  elided: number;
  /** The first elided values' key paths (`tool_response.originalFile`, `lines[3]`), at most 16. */
  paths: string[];
}

export type ParsedJsonObject =
  { kind: 'whole'; body: Record<string, unknown> } | { kind: 'malformed'; message: string };

export type BoundedJsonResult =
  ParsedJsonObject | { kind: 'reduced'; body: Record<string, unknown>; reduced: BodyReduction };

export interface BoundedJsonBody {
  push(chunk: Uint8Array): void;
  end(): BoundedJsonResult;
}

const DEFAULT_MAX_STRING_BYTES = 4 * 1024;
const MAX_PATHS = 16;
const MAX_PATH_CHARS = 256;

function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

/** The whole read: JSON.parse over the UTF-8 text. A hook body is an object; any other top level is malformed. */
export function parseJsonObject(bytes: Uint8Array): ParsedJsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8(bytes));
  } catch (error) {
    return { kind: 'malformed', message: error instanceof Error ? error.message : String(error) };
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? { kind: 'whole', body: parsed as Record<string, unknown> }
    : { kind: 'malformed', message: 'not an object' };
}

export function createBoundedJsonBody(options: BoundedJsonOptions): BoundedJsonBody {
  const maxStringBytes = options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES;
  let held: Uint8Array[] = [];
  let receivedBytes = 0;
  let scanner: ReducingScanner | undefined;
  return {
    push(chunk) {
      receivedBytes += chunk.length;
      if (scanner) {
        scanner.push(chunk);
        return;
      }
      if (receivedBytes <= options.retainBytes) {
        held.push(chunk);
        return;
      }
      // Past the budget: the held prefix streams through the scanner first, then is let go.
      scanner = new ReducingScanner(options.retainBytes, maxStringBytes);
      for (const piece of held) scanner.push(piece);
      held = [];
      scanner.push(chunk);
    },
    end() {
      return scanner ? scanner.end(receivedBytes) : parseJsonObject(Buffer.concat(held));
    },
  };
}

// Where the scanner stands in the grammar.
const VALUE = 0; // a value is due: the top level, after ':', after ',' in an array
const VALUE_OR_CLOSE = 1; // after '['
const KEY_OR_CLOSE = 2; // after '{'
const KEY = 3; // after ',' in an object
const AFTER_KEY = 4; // ':' is due
const AFTER_VALUE = 5; // ',' or the open container's close is due
const DONE = 6; // the top-level object closed: only whitespace may follow
const IN_STRING = 7;
const IN_NUMBER = 8;
const IN_LITERAL = 9;

// What becomes of a value in the reduced text.
const KEPT = 0;
const NULLED = 1; // its member stays and reads null
const LEFT_OUT = 2; // its member is not written
const INSIDE_ELIDED = 3; // it lies inside a nulled or left-out container

const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const NULL_TEXT = new Uint8Array([0x6e, 0x75, 0x6c, 0x6c]);
const TRUE_TEXT = new Uint8Array([0x74, 0x72, 0x75, 0x65]);
const FALSE_TEXT = new Uint8Array([0x66, 0x61, 0x6c, 0x73, 0x65]);
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function isPlainStringByte(byte: number): boolean {
  return byte !== QUOTE && byte !== BACKSLASH && byte >= 0x20;
}

function isEscapeByte(byte: number): boolean {
  // " \ / b f n r t (u is read apart: four hex digits follow it)
  return (
    byte === QUOTE ||
    byte === BACKSLASH ||
    byte === 0x2f ||
    byte === 0x62 ||
    byte === 0x66 ||
    byte === 0x6e ||
    byte === 0x72 ||
    byte === 0x74
  );
}

function isHexByte(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

function isNumberByte(byte: number): boolean {
  // 0-9 - + . E e: the number's own grammar is checked once it ends
  return (
    (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2b || byte === 0x2e || byte === 0x45 || byte === 0x65
  );
}

/** An open container the reduced text is writing. */
interface Frame {
  /** OPEN_OBJECT or OPEN_ARRAY. */
  kind: number;
  /** The path segment it was entered by; the top level's is empty. */
  segment: string;
  /** Members written into it so far, for the commas. */
  written: number;
  /** Arrays: the index of the element being read. */
  index: number;
}

class ReducingScanner {
  private state = VALUE;
  private error: string | undefined;
  /** The containers being written, the top-level object first. */
  private readonly frames: Frame[] = [];
  /** The kinds of the containers open inside a nulled or left-out one: only their brackets are matched. */
  private elidedKinds = new Uint8Array(16);
  private elidedDepth = 0;
  private out: Uint8Array;
  private outLength = 0;
  private elided = 0;
  private readonly paths: string[] = [];
  /** The key read last in the open object, raw as posted; undefined when it was too long to keep. */
  private key: Uint8Array | undefined;
  // The token being read: a key, a string, a number or a literal.
  private readonly token: Uint8Array;
  private tokenLength = 0;
  private tokenOverflow = false;
  private tokenIsKey = false;
  private tokenKept = false;
  private escape = false;
  private hexDue = 0;
  private literal = TRUE_TEXT;
  private literalIndex = 0;

  constructor(
    private readonly retainBytes: number,
    private readonly maxStringBytes: number,
  ) {
    this.out = new Uint8Array(Math.max(64, Math.min(retainBytes, 64 * 1024)));
    this.token = new Uint8Array(maxStringBytes);
  }

  push(chunk: Uint8Array): void {
    let at = 0;
    while (at < chunk.length && this.error === undefined) {
      if (this.state === IN_STRING && !this.escape && this.hexDue === 0) {
        // The common run inside a string: plain bytes up to the next quote, backslash or control byte.
        let end = at;
        while (end < chunk.length && isPlainStringByte(chunk[end]!)) end += 1;
        if (end > at) {
          this.keep(chunk.subarray(at, end));
          at = end;
          continue;
        }
      }
      if (this.step(chunk[at]!)) at += 1;
    }
  }

  end(receivedBytes: number): BoundedJsonResult {
    if (this.error !== undefined) return { kind: 'malformed', message: this.error };
    if (this.state !== DONE) return { kind: 'malformed', message: 'unexpected end of JSON input' };
    const parsed = parseJsonObject(this.out.subarray(0, this.outLength));
    if (parsed.kind === 'malformed') return parsed;
    return {
      kind: 'reduced',
      body: parsed.body,
      reduced: { receivedBytes, elided: this.elided, paths: [...this.paths] },
    };
  }

  /** Reads one byte; false when the byte ended a number and must be read again where the number left off. */
  private step(byte: number): boolean {
    switch (this.state) {
      case IN_STRING:
        this.stringByte(byte);
        return true;
      case IN_NUMBER:
        if (isNumberByte(byte)) {
          this.keepByte(byte);
          return true;
        }
        this.endNumber();
        return false;
      case IN_LITERAL:
        if (byte !== this.literal[this.literalIndex]) return this.fail(`unexpected byte ${byte} in a literal`);
        this.literalIndex += 1;
        if (this.literalIndex === this.literal.length) this.endScalar(false, this.literal);
        return true;
      default:
        break;
    }
    if (isWhitespace(byte)) return true;
    switch (this.state) {
      case VALUE:
        this.beginValue(byte);
        return true;
      case VALUE_OR_CLOSE:
        if (byte === CLOSE_ARRAY) this.close(OPEN_ARRAY);
        else this.beginValue(byte);
        return true;
      case KEY_OR_CLOSE:
        if (byte === CLOSE_OBJECT) this.close(OPEN_OBJECT);
        else this.beginKey(byte);
        return true;
      case KEY:
        this.beginKey(byte);
        return true;
      case AFTER_KEY:
        if (byte === COLON) this.state = VALUE;
        else return this.fail(`expected ':' after a key, read byte ${byte}`);
        return true;
      case AFTER_VALUE:
        if (byte === COMMA) this.state = this.openKind() === OPEN_OBJECT ? KEY : VALUE;
        else if (byte === CLOSE_OBJECT) this.close(OPEN_OBJECT);
        else if (byte === CLOSE_ARRAY) this.close(OPEN_ARRAY);
        else return this.fail(`expected ',' or a close, read byte ${byte}`);
        return true;
      default:
        return this.fail('unexpected data after the top-level object');
    }
  }

  private fail(message: string): true {
    this.error ??= message;
    return true;
  }

  private stringByte(byte: number): void {
    if (this.escape) {
      this.escape = false;
      if (byte === 0x75) this.hexDue = 4;
      else if (!isEscapeByte(byte)) {
        this.fail('a bad escape in a string');
        return;
      }
    } else if (this.hexDue > 0) {
      if (!isHexByte(byte)) {
        this.fail('a bad \\u escape in a string');
        return;
      }
      this.hexDue -= 1;
    } else if (byte === QUOTE) {
      this.endString();
      return;
    } else if (byte === BACKSLASH) {
      this.escape = true;
    } else if (byte < 0x20) {
      this.fail('a control character in a string');
      return;
    }
    this.keepByte(byte);
  }

  /** Token bytes are kept up to the string cap; past it the token only remembers that it overflowed. */
  private keep(bytes: Uint8Array): void {
    if (this.tokenOverflow) return;
    if (this.tokenLength + bytes.length > this.maxStringBytes) {
      this.tokenOverflow = true;
      return;
    }
    this.token.set(bytes, this.tokenLength);
    this.tokenLength += bytes.length;
  }

  private keepByte(byte: number): void {
    if (this.tokenOverflow) return;
    if (this.tokenLength === this.maxStringBytes) {
      this.tokenOverflow = true;
      return;
    }
    this.token[this.tokenLength] = byte;
    this.tokenLength += 1;
  }

  private beginToken(state: number, isKey: boolean, kept: boolean): void {
    this.state = state;
    this.tokenIsKey = isKey;
    this.tokenKept = kept;
    this.tokenLength = 0;
    this.tokenOverflow = false;
    this.escape = false;
    this.hexDue = 0;
  }

  private beginKey(byte: number): void {
    if (byte !== QUOTE) {
      this.fail(`expected a key, read byte ${byte}`);
      return;
    }
    this.beginToken(IN_STRING, true, this.elidedDepth === 0);
  }

  private beginValue(byte: number): void {
    const container = byte === OPEN_OBJECT || byte === OPEN_ARRAY;
    const literalText = byte === 0x74 ? TRUE_TEXT : byte === 0x66 ? FALSE_TEXT : byte === 0x6e ? NULL_TEXT : undefined;
    const startsNumber = byte === 0x2d || (byte >= 0x30 && byte <= 0x39);
    if (!container && !literalText && !startsNumber && byte !== QUOTE) {
      this.fail(`unexpected byte ${byte} where a value is due`);
      return;
    }
    if (this.frames.length === 0) {
      if (byte !== OPEN_OBJECT) {
        this.fail('not an object');
        return;
      }
      this.writeByte(OPEN_OBJECT);
      this.frames.push({ kind: OPEN_OBJECT, segment: '', written: 0, index: 0 });
      this.state = KEY_OR_CLOSE;
      return;
    }

    const fate = this.elidedDepth > 0 ? INSIDE_ELIDED : this.fate(container);
    if (fate === NULLED || fate === LEFT_OUT) this.elide();
    if (fate === NULLED) {
      this.writeMemberPrefix();
      this.write(NULL_TEXT);
    }
    if (container) {
      if (fate === KEPT) {
        const segment = this.segment();
        this.writeMemberPrefix();
        this.writeByte(byte);
        this.frames.push({ kind: byte, segment, written: 0, index: 0 });
      } else {
        this.pushElided(byte);
      }
      this.state = byte === OPEN_OBJECT ? KEY_OR_CLOSE : VALUE_OR_CLOSE;
      return;
    }
    if (byte === QUOTE) {
      this.beginToken(IN_STRING, false, fate === KEPT);
    } else if (literalText) {
      this.beginToken(IN_LITERAL, false, fate === KEPT);
      this.literal = literalText;
      this.literalIndex = 1;
    } else {
      this.beginToken(IN_NUMBER, false, fate === KEPT);
      this.keepByte(byte);
    }
  }

  /** What becomes of the value starting in the open container being written. */
  private fate(container: boolean): number {
    const parent = this.frames[this.frames.length - 1]!;
    // a key too long to keep cannot be written, so neither can its member
    if (parent.kind === OPEN_OBJECT && this.key === undefined) return LEFT_OUT;
    if (this.outLength >= 2 * this.retainBytes) return LEFT_OUT;
    if (this.outLength < this.retainBytes) return KEPT;
    if (this.frames.length > 1) return LEFT_OUT;
    return container ? NULLED : KEPT;
  }

  private endString(): void {
    if (this.tokenIsKey) {
      if (this.tokenKept) this.key = this.tokenOverflow ? undefined : this.token.slice(0, this.tokenLength);
      this.state = AFTER_KEY;
      return;
    }
    this.endScalar(true, this.token.subarray(0, this.tokenLength));
  }

  private endNumber(): void {
    const text = this.token.subarray(0, this.tokenLength);
    // a number past the cap is elided unread; it is held to the number bytes only
    if (!this.tokenOverflow && !NUMBER.test(utf8(text))) {
      this.fail('a malformed number');
      return;
    }
    this.endScalar(false, text);
  }

  private endScalar(quoted: boolean, text: Uint8Array): void {
    if (this.tokenKept) {
      if (this.tokenOverflow) this.elide();
      this.writeMemberPrefix();
      if (this.tokenOverflow) {
        this.write(NULL_TEXT);
      } else {
        if (quoted) this.writeByte(QUOTE);
        this.write(text);
        if (quoted) this.writeByte(QUOTE);
      }
    }
    this.valueEnded();
  }

  private close(kind: number): void {
    if (this.openKind() !== kind) {
      this.fail('a mismatched close');
      return;
    }
    if (this.elidedDepth > 0) {
      this.elidedDepth -= 1;
      this.valueEnded();
      return;
    }
    this.frames.pop();
    this.writeByte(kind === OPEN_OBJECT ? CLOSE_OBJECT : CLOSE_ARRAY);
    if (this.frames.length === 0) this.state = DONE;
    else this.valueEnded();
  }

  private valueEnded(): void {
    this.state = AFTER_VALUE;
    if (this.elidedDepth > 0) return;
    const parent = this.frames[this.frames.length - 1]!;
    if (parent.kind === OPEN_ARRAY) parent.index += 1;
  }

  private openKind(): number | undefined {
    return this.elidedDepth > 0 ? this.elidedKinds[this.elidedDepth - 1] : this.frames[this.frames.length - 1]?.kind;
  }

  private pushElided(kind: number): void {
    if (this.elidedDepth === this.elidedKinds.length) {
      const grown = new Uint8Array(this.elidedKinds.length * 2);
      grown.set(this.elidedKinds);
      this.elidedKinds = grown;
    }
    this.elidedKinds[this.elidedDepth] = kind;
    this.elidedDepth += 1;
  }

  /** The path segment of the member being read in the open container being written. */
  private segment(): string {
    const parent = this.frames[this.frames.length - 1]!;
    if (parent.kind === OPEN_ARRAY) return `[${parent.index}]`;
    return this.key === undefined ? '…' : utf8(this.key);
  }

  private elide(): void {
    this.elided += 1;
    if (this.paths.length >= MAX_PATHS) return;
    let path = '';
    for (let depth = 1; depth <= this.frames.length; depth += 1) {
      const segment = depth < this.frames.length ? this.frames[depth]!.segment : this.segment();
      path = path === '' || segment.startsWith('[') ? path + segment : `${path}.${segment}`;
      if (path.length > MAX_PATH_CHARS) {
        path = `${path.slice(0, MAX_PATH_CHARS)}…`;
        break;
      }
    }
    this.paths.push(path);
  }

  private writeMemberPrefix(): void {
    const parent = this.frames[this.frames.length - 1]!;
    if (parent.written > 0) this.writeByte(COMMA);
    parent.written += 1;
    if (parent.kind === OPEN_OBJECT && this.key !== undefined) {
      this.writeByte(QUOTE);
      this.write(this.key);
      this.writeByte(QUOTE);
      this.writeByte(COLON);
    }
  }

  private writeByte(byte: number): void {
    this.reserve(1);
    this.out[this.outLength] = byte;
    this.outLength += 1;
  }

  private write(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.out.set(bytes, this.outLength);
    this.outLength += bytes.length;
  }

  private reserve(length: number): void {
    if (this.outLength + length <= this.out.length) return;
    let capacity = this.out.length * 2;
    while (capacity < this.outLength + length) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.out.subarray(0, this.outLength));
    this.out = grown;
  }
}
