// src/srcset changes can turn a Bitmoji avatar into an ordinary image (see maskers/media.ts).
const OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['src', 'srcset'],
};

export interface DomObserver {
  observe(root: Document | ShadowRoot): void;
  disconnect(): void;
}

/**
 * Reports added nodes, changed text nodes and elements whose src/srcset changed. The handler runs synchronously in the
 * MutationObserver callback (a microtask, before the next paint), and mutations caused by
 * the handler itself are discarded so masking never re-triggers itself.
 */
export function createDomObserver(handle: (nodes: Set<Node>) => void): DomObserver {
  const observer = new MutationObserver((mutations) => {
    const nodes = new Set<Node>();
    for (const mutation of mutations) {
      if (mutation.type === 'characterData' || mutation.type === 'attributes') nodes.add(mutation.target);
      else for (const node of mutation.addedNodes) nodes.add(node);
    }
    handle(nodes);
    observer.takeRecords();
  });
  return {
    observe: (root) => observer.observe(root, OPTIONS),
    disconnect: () => observer.disconnect(),
  };
}
