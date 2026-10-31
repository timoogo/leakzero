// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeNoteHtml, noteToText } from '../src/notes/content';

describe('note content', () => {
  it('keeps headings, bold, italic, underline, lists and links', () => {
    const html = '<h2>Sujet</h2><p><strong>g</strong> <em>i</em> <u>s</u> <a href="https://example.com">lien</a></p><ul><li><p>un</p></li></ul><ol><li><p>deux</p></li></ol>';
    const clean = sanitizeNoteHtml(html);
    for (const fragment of ['<h2>Sujet</h2>', '<strong>g</strong>', '<em>i</em>', '<u>s</u>', 'href="https://example.com"', '<ul>', '<ol>']) {
      expect(clean).toContain(fragment);
    }
  });

  it('removes scripts, event handlers, styles, images, frames and unsafe links, keeping the text', () => {
    const clean = sanitizeNoteHtml(`
      <p onclick="alert(1)" style="color:red">texte<script>alert(1)</script></p>
      <img src="x" onerror="alert(1)"><iframe src="https://evil.example"></iframe>
      <a href="javascript:alert(1)">piège</a> <a href="data:text/html,<script>alert(1)</script>">data</a>
      <svg><script>alert(1)</script></svg><style>body{}</style><div>bloc</div>`);
    expect(clean).not.toMatch(/script|onclick|onerror|style|<img|<iframe|<svg|javascript:|data:/i);
    expect(clean).toContain('texte');
    expect(clean).toContain('piège');
    expect(clean).toContain('bloc');
  });

  it('returns an empty string for an empty note', () => {
    expect(sanitizeNoteHtml('')).toBe('');
    expect(sanitizeNoteHtml('<p></p>')).toBe('');
  });

  it('converts a note to readable plain text', () => {
    const text = noteToText('<h1>Titre</h1><p>Un <strong>mot</strong> et <a href="https://example.com">un lien</a>.</p><ul><li><p>a</p></li><li><p>b</p></li></ul><ol><li><p>premier</p></li><li><p>second</p></li></ol><p>fin<br>ligne</p>');
    expect(text).toBe('# Titre\n\nUn mot et un lien (https://example.com).\n\n- a\n- b\n\n1. premier\n2. second\n\nfin\nligne\n');
  });
});
