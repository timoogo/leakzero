import type { CountryCode } from 'libphonenumber-js/max';
import { detectSensitiveNumbers } from '../detectors/numbers';
import { applyStyle, forgetText, isMaskedByUs, maskText, restoreText, type PhoneStyle } from '../maskers/text';
import { pruneDetachedHighlights, PHONE_HIGHLIGHT_CSS } from '../maskers/highlight';
import { clearOverlays, ensureOverlayAttached, pruneDetachedOverlays } from '../maskers/overlay';
import { MEDIA_MASK_CSS, markAvatar } from '../maskers/media';
import { createInjectedStyles } from '../maskers/styles';
import { createDomObserver } from './observer';
import type { ProtectionSettings } from '../shared/types';

// Text in these elements is never displayed as page text, or belongs to an editor the user types in.
const SKIPPED = 'script, style, noscript, template, textarea, [contenteditable]:not([contenteditable="false"])';

export interface Scanner {
  apply(settings: ProtectionSettings): void;
  stop(): void;
}

/** Wires the DOM observer, detectors and maskers for one document and its open shadow roots. */
export function createScanner(doc: Document, countries: readonly CountryCode[]): Scanner {
  const roots = new Set<Document | ShadowRoot>();
  const styles = createInjectedStyles();
  const observer = createDomObserver((nodes) => {
    styles.ensureAttached();
    ensureOverlayAttached();
    for (const node of nodes) scan(node);
    // Last, so that boxes refreshed for nodes reported in this batch but since detached are dropped too.
    pruneDetachedHighlights();
    pruneDetachedOverlays();
  });
  let maskPhones = false;
  let phoneStyle: PhoneStyle = 'classic';

  function addRoot(root: Document | ShadowRoot) {
    if (roots.has(root)) return;
    roots.add(root);
    styles.attach(root);
    observer.observe(root);
    scan(root);
  }

  function processText(node: Text) {
    if (!maskPhones) {
      // A node masked earlier may come back (e.g. re-inserted) after protection was turned off.
      restoreText(node);
      return;
    }
    if (isMaskedByUs(node)) {
      // Re-inserted node, or one detached while the mode changed.
      applyStyle(node, phoneStyle);
      return;
    }
    forgetText(node);
    const matches = detectSensitiveNumbers(node.data, countries);
    if (matches.length > 0 && !node.parentElement?.closest(SKIPPED)) maskText(node, matches, phoneStyle);
  }

  function processElement(element: Element) {
    if (element.shadowRoot) addRoot(element.shadowRoot);
    if (element.tagName === 'IMG') markAvatar(element as HTMLImageElement);
  }

  function scan(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      processText(node as Text);
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) processElement(node as Element);
    const walker = doc.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current.nodeType === Node.TEXT_NODE) {
        processText(current as Text);
      } else {
        processElement(current as Element);
      }
    }
  }

  function forEachText(action: (node: Text) => void) {
    for (const root of roots) {
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let current = walker.nextNode(); current; current = walker.nextNode()) action(current as Text);
    }
  }

  function restoreAll() {
    forEachText(restoreText);
  }

  addRoot(doc);

  return {
    apply(settings) {
      styles.setCss(PHONE_HIGHLIGHT_CSS + (settings.maskMedia ? MEDIA_MASK_CSS : ''));
      const nextStyle: PhoneStyle = settings.reinforcedPhones ? 'reinforced' : 'classic';
      const styleChanged = nextStyle !== phoneStyle;
      phoneStyle = nextStyle;
      if (settings.maskPhones !== maskPhones) {
        maskPhones = settings.maskPhones;
        if (maskPhones) for (const root of roots) scan(root);
        else restoreAll();
      } else if (maskPhones && styleChanged) {
        // Only the visual layers change: the text is not rewritten during a mode change.
        forEachText((node) => applyStyle(node, phoneStyle));
      }
    },
    stop() {
      observer.disconnect();
      restoreAll();
      clearOverlays();
      styles.setCss('');
    },
  };
}
