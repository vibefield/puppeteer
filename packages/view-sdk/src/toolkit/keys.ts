// A KEY'S LEGEND (MV-D8, M177 ruling 4). A view declares the keys it takes
// while focused; the host's bar prints them in the view's tooltip, and a view
// prints the key of one of its own controls on that control, under its glyph,
// the way a keyboard prints its legends. Both print it with this one table.

/** The keyboard's own legend for a key that has one. */
const KEY_LEGENDS: Readonly<Record<string, string>> = {
  Escape: '⎋',
  Enter: '↵',
  Tab: '⇥',
  ' ': '␣',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Home: '↖',
  End: '↘',
  PageUp: '⇞',
  PageDown: '⇟',
  Backspace: '⌫',
  '-': '−',
};

/** How a key (a `KeyboardEvent.key` value) is printed: its keyboard legend, else its character, upper case. */
export function keyLegend(key: string): string {
  return KEY_LEGENDS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}
