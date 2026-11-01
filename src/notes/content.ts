import { generateHTML, generateJSON, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

const SAFE_LINK = /^(https?:|mailto:)/i;

/** What a link typed by the user points to: `example.com` → `https://example.com`; null if not allowed. */
export function linkTarget(input: string): string | null {
  const url = input.trim();
  if (!url) return null;
  const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  return SAFE_LINK.test(href) ? href : null;
}

/**
 * Schema of a note: headings, bold, italic, underline, lists and links (http, https, mailto). The editor,
 * the import and the exports all go through it, so a note can never hold anything else: no script, no
 * event handler, no style, no image, no frame.
 */
export const noteExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    blockquote: false,
    code: false,
    codeBlock: false,
    horizontalRule: false,
    strike: false,
    link: {
      openOnClick: true,
      autolink: true,
      defaultProtocol: 'https',
      isAllowedUri: (url, { defaultValidate }) => SAFE_LINK.test(url) && defaultValidate(url),
    },
  }),
];

function isEmpty(doc: JSONContent): boolean {
  return (doc.content ?? []).every((node) => node.type === 'paragraph' && !node.content?.length);
}

/** Untrusted HTML (an imported note) reduced to the note schema. Parsing never runs scripts. */
export function sanitizeNoteHtml(html: string): string {
  const doc = generateJSON(html, noteExtensions) as JSONContent;
  return isEmpty(doc) ? '' : generateHTML(doc, noteExtensions);
}

function inline(nodes: JSONContent[] = []): string {
  let text = '';
  let href: string | undefined;
  const closeLink = () => {
    if (href) text += ` (${href})`;
    href = undefined;
  };
  for (const node of nodes) {
    const link = node.marks?.find((mark) => mark.type === 'link')?.attrs?.href as string | undefined;
    if (link !== href) closeLink();
    href = link;
    text += node.type === 'hardBreak' ? '\n' : (node.text ?? '');
  }
  closeLink();
  return text;
}

function block(node: JSONContent): string {
  switch (node.type) {
    case 'heading': return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${inline(node.content)}`;
    case 'bulletList':
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1);
      return (node.content ?? []).map((item, index) => {
        const marker = node.type === 'bulletList' ? '- ' : `${start + index}. `;
        const body = (item.content ?? []).map(block).join('\n');
        return marker + body.replaceAll('\n', `\n${' '.repeat(marker.length)}`);
      }).join('\n');
    }
    default: return inline(node.content);
  }
}

/** A note as plain text, readable without LeakZero: Markdown-like headings and lists, links in brackets. */
export function noteToText(html: string): string {
  const doc = generateJSON(html, noteExtensions) as JSONContent;
  if (isEmpty(doc)) return '';
  return `${(doc.content ?? []).map(block).join('\n\n')}\n`;
}
