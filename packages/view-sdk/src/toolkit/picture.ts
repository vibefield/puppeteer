/**
 * Whether a host's colour picture given as a string may be drawn (`Picture`): a `data:image/…` URL alone, which a
 * view decodes without reaching any address. Any other string, a path or an http(s) address among them, is never
 * drawn, so a mark can never make a view fetch.
 */
export function isPictureDataUrl(image: string): boolean {
  return /^data:image\//iu.test(image);
}
