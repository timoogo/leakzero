// jsdom has no layout. Ranges get one 18px-high line box so the overlay layer can be exercised;
// tests that need other geometry stub Range.prototype.getClientRects themselves.
if (typeof Range !== 'undefined' && !('getClientRects' in Range.prototype)) {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    writable: true,
    value(this: Range) {
      if (this.collapsed) return [];
      return [{ left: 10, top: 20, right: 110, bottom: 38, width: 100, height: 18, x: 10, y: 20 }];
    },
  });
}

// jsdom has no ResizeObserver either; Radix (e.g. Slider) only needs it to exist.
if (typeof window !== 'undefined' && !('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
