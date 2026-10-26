/**
 * The imposter's one input path (docs/archive/IMPOSTER.md §4.1.1).
 *
 * The adapter injects prompts as a guarded bracketed paste, and this is the
 * ONLY place stdin is read: the TUI never reads it, so TTY and pipe modes
 * cannot drift apart in the most load-bearing place there is.
 *
 * It lives in its own module because there are now two invocations that own a
 * screen — one that runs a session and one that ATTACHES to somebody else's
 * (§11.5) — and a second copy of this would be a second set of paste bugs. What
 * differs between them is only where a submitted prompt goes, which is the
 * `submit` callback.
 */

import { createPasteDecoder } from '../session/channels/terminal.ts';

/** A prompt, not a document: enough for anything anyone types or pastes at one. */
const MAX_STAGED = 64 * 1024;

export interface PromptLineOptions {
  /** True when a real terminal is attached; drives raw mode and bracketed paste. */
  interactive: boolean;
  staged(text: string): void;
  submit(text: string): void;
  /**
   * Input the screen consumes itself before it reaches the prompt line — a
   * keypress answering a question the vendor's TUI is showing. Returns true
   * when the chunk was consumed.
   */
  intercept?(chunk: string): boolean;
  /** ^C on a real terminal, and stdin EOF. */
  interrupt(): void;
  end(): void;
  log(message: string): void;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export function installPromptLine(options: PromptLineOptions): void {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  // The prompt line lives here rather than in the decoder, which stays a pure
  // byte splitter. It has to hold staged text across operations because Enter
  // does not always arrive with the paste: terminal automation commonly writes
  // the paste and the newline separately, and the decoder's hold is 15 ms.
  // Without this a pasted prompt sat staged forever and the later Enter fell on
  // the floor — which is exactly what `ai --claude` did in a Godview pane
  // (found 2026-08-08 by running it, not by testing it).
  let staged = '';
  const submit = (text: string): void => {
    staged = '';
    options.staged('');
    options.submit(text);
  };

  const decoder = createPasteDecoder(
    (operation) => {
      const text = staged + operation.text;
      if (!operation.submit) {
        staged = text;
        options.staged(text);
        return;
      }
      submit(text);
    },
    (plain) => {
      // Unbracketed input: someone typing, or a terminal that pasted without
      // markers. Enter submits what is staged, exactly as any prompt behaves.
      //
      // This is a prompt line, NOT a line editor — only Enter and backspace are
      // interpreted, because anything more is the vendor TUI parity §4 rules
      // out. It exists because a pane is a real terminal with a real person in
      // front of it, and a screen where typing does nothing is not a screen.
      for (const character of plain) {
        if (character === '\r' || character === '\n') {
          if (staged) submit(staged);
          continue;
        }
        if (character === '\x7f' || character === '\b') {
          staged = staged.slice(0, -1);
        } else if (character >= ' ' && staged.length < MAX_STAGED) {
          staged += character;
        }
        options.staged(staged);
      }
    },
  );

  // A real terminal needs raw mode so a bracketed paste arrives as bytes rather
  // than line-buffered input. Raw mode also stops the kernel turning ^C into
  // SIGINT, so the interrupt is handled here as a byte — which is what the
  // vendor's own TUI does. Only a lone \x03 is a keypress; a larger chunk
  // containing it is paste payload.
  if (options.interactive && stdin.isTTY) {
    stdin.setRawMode(true);
    // Ask the terminal to bracket pastes. A terminal emits `ESC[200~` markers
    // ONLY for an application that has turned the mode on, so without this the
    // imposter received pastes as bare bytes and its decoder — built entirely
    // around those markers — never saw a paste at all. Real TUIs enable it;
    // the imposter has to as well, or it is not receiving what they receive.
    stdout.write('\x1b[?2004h');
  }
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    // Shape, never content: whether a paste arrived bracketed is the single
    // most useful thing to know when a prompt does not turn into a turn, and
    // the text itself is none of the log's business.
    options.log(`stdin: ${chunk.length}b${chunk.includes('\x1b[200~') ? ' bracketed' : ''}`);
    if (options.intercept?.(chunk)) return;
    if (options.interactive && chunk === '\x03') return options.interrupt();
    decoder.feed(chunk);
  });
  stdin.on('end', () => {
    decoder.flush();
    options.end();
  });
}
