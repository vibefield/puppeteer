import { describe, expect, it } from 'vitest';
import { isPictureDataUrl } from './picture.js';

describe('isPictureDataUrl', () => {
  it('admits an image data URL alone, so a picture never makes a view fetch', () => {
    expect(isPictureDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isPictureDataUrl('DATA:IMAGE/svg+xml;utf8,<svg/>')).toBe(true);
    for (const string of [
      'https://example.com/face.png',
      '//example.com/face.png',
      '/face.png',
      'face.png',
      'data:text/html,<p>',
      ' data:image/png;base64,iVBORw0KGgo=',
      '',
    ]) {
      expect(isPictureDataUrl(string)).toBe(false);
    }
  });
});
