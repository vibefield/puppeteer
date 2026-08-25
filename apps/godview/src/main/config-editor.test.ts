import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ConfigSnapshot } from '@vibecook/ghosttea-protocol';
import {
  MAX_CONFIG_EDITOR_BYTES,
  assertConfigDocumentIncludesAuthorized,
  blockingConfigDiagnostics,
  serializeSupportedGhosttyConfig,
  trustedConfigEditorRendererUrl,
  validateConfigContents,
  validateConfigSaveRequest,
} from './config-editor.js';

describe('Godview terminal config editor boundary', () => {
  it('rejects oversized documents and malformed revisions', () => {
    expect(() => validateConfigContents('x'.repeat(MAX_CONFIG_EDITOR_BYTES + 1))).toThrow('maximum');
    expect(() => validateConfigSaveRequest({ expectedRevision: '', contents: '' })).toThrow('revision');
    expect(validateConfigSaveRequest({ expectedRevision: 'document-1', contents: 'font-size = 14\n' })).toEqual({
      expectedRevision: 'document-1',
      contents: 'font-size = 14\n',
    });
  });

  it('does not let renderer drafts introduce or reorder config-file reads', () => {
    const current = ['config-file = /private/dormant', 'config-file =', 'config-file = themes/current', ''].join('\n');
    expect(() => assertConfigDocumentIncludesAuthorized(current, current)).not.toThrow();
    expect(() => assertConfigDocumentIncludesAuthorized(current, '')).not.toThrow();
    expect(() => assertConfigDocumentIncludesAuthorized(current, 'config-file = /private/secrets\n')).toThrow(
      'cannot change active config-file directives',
    );
  });

  it('accepts only the top-level packaged renderer', () => {
    const renderer = '/Applications/Godview/resources/app/dist/index.html';
    expect(trustedConfigEditorRendererUrl(pathToFileURL(renderer).href, undefined, renderer)).toBe(true);
    expect(
      trustedConfigEditorRendererUrl(
        pathToFileURL('/Applications/Godview/resources/app/dist/other.html').href,
        undefined,
        renderer,
      ),
    ).toBe(false);
  });

  it('serializes supported settings without inherited source paths', () => {
    const config = {
      sources: [{ path: '/Users/private/.config/ghostty/config', kind: 'ghostty-default' }],
      terminal: { scrollbackBytes: 42_000 },
      renderer: {
        foreground: [240, 241, 242],
        background: [16, 17, 18],
        cursor: [171, 205, 239],
        cursorText: [1, 2, 3],
        selectionBackground: [32, 33, 34],
        selectionForeground: [224, 225, 226],
        palette: [{ index: 2, color: [4, 5, 6] }],
        backgroundOpacity: 0.73,
        backgroundOpacityCells: true,
        fontSize: 14,
        fontFamilies: ['JetBrains Mono'],
        paddingX: [3, 4],
        paddingY: [5, 5],
        postProcess: 'none',
        shaderEffects: ['ghosttea:crt'],
        customShaderAnimation: true,
      },
      workspace: { clearKeybindings: true, keybindings: [{ trigger: 'super+t', action: 'new_tab' }] },
    } as ConfigSnapshot;
    const result = serializeSupportedGhosttyConfig(config);
    expect(result).toContain('background-opacity = 0.73\n');
    expect(result).toContain('font-family = JetBrains Mono\n');
    expect(result).toContain('keybind = clear\nkeybind = super+t=new_tab\n');
    expect(result).not.toContain('/Users/private');
  });

  it('blocks local errors while tolerating unchanged inherited errors', () => {
    const inherited = {
      severity: 'error',
      code: 'invalid-value',
      message: 'inherited failure',
      source: '/Users/example/.config/ghostty/config',
      line: 4,
      key: 'font-size',
    } as const;
    const local = { ...inherited, message: 'local failure', source: '/profile/config.ghostty' } as const;
    expect(blockingConfigDiagnostics([inherited], [inherited, local], '/profile/config.ghostty')).toEqual([local]);
  });
});
