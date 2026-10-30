export interface InjectedStyles {
  /** Injects LeakZero's stylesheet into a document or open shadow root (idempotent). */
  attach(root: Document | ShadowRoot): void;
  setCss(css: string): void;
  /** Re-inserts style elements the page removed (e.g. when it rewrites <head>). */
  ensureAttached(): void;
}

// One <style> per root: document stylesheets do not apply inside shadow roots.
export function createInjectedStyles(): InjectedStyles {
  const styles = new Map<Document | ShadowRoot, HTMLStyleElement>();
  let css = '';

  function insert(root: Document | ShadowRoot, style: HTMLStyleElement) {
    const parent = root instanceof Document ? (root.documentElement ?? root) : root;
    parent.appendChild(style);
  }

  return {
    attach(root) {
      if (styles.has(root)) return;
      const doc = root instanceof Document ? root : root.ownerDocument;
      const style = doc.createElement('style');
      style.dataset.leakzero = '';
      style.textContent = css;
      styles.set(root, style);
      insert(root, style);
    },
    setCss(next) {
      css = next;
      for (const style of styles.values()) style.textContent = css;
    },
    ensureAttached() {
      for (const [root, style] of styles) {
        if (style.isConnected) continue;
        if (root instanceof ShadowRoot && !root.host.isConnected) continue;
        insert(root, style);
      }
    },
  };
}
