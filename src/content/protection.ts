import { createScanner } from '../core/scanner';
import { countriesFromLanguages } from '../detectors/phone';
import { FAIL_CLOSED, watchProtectionSettings } from '../shared/settings';

/**
 * Sent by every instance when it starts. When the extension is reloaded or updated, Chrome keeps the
 * previous content script running in open tabs, cut off from the extension: it no longer receives
 * setting changes but keeps masking with its last settings. The background script injects the new
 * version into those tabs; this event tells the orphan to restore the page and stop.
 */
export const TAKEOVER_EVENT = 'leakzero:takeover';

/** Starts protecting `doc`. Returns a function that stops and restores the page. */
export function startProtection(doc: Document, api: typeof chrome = chrome): () => void {
  // Dispatched before this instance listens: the orphan restores the text and this instance masks it
  // again below, in the same task, so the original numbers are never painted in between.
  doc.dispatchEvent(new Event(TAKEOVER_EVENT));

  // Protection starts immediately (everything masked) so nothing is shown unprotected while the
  // stored settings load; they are applied right after.
  // Nothing analysed here leaves the page: no messaging, no storage writes, no network.
  const scanner = createScanner(doc, countriesFromLanguages(navigator.languages));
  scanner.apply(FAIL_CLOSED);
  let stopped = false;
  const unwatch = watchProtectionSettings((settings) => {
    if (!stopped) scanner.apply(settings);
  }, api.storage);

  function stop() {
    if (stopped) return;
    stopped = true;
    doc.removeEventListener(TAKEOVER_EVENT, onTakeover);
    unwatch();
    scanner.stop();
  }

  function onTakeover() {
    // Only an orphan gives way: `runtime.id` disappears once the extension context is invalidated.
    // A live instance ignores the event, so a page cannot turn the protection off by sending it.
    let orphaned: boolean;
    try {
      orphaned = !api.runtime?.id;
    } catch {
      orphaned = true;
    }
    if (orphaned) stop();
  }

  doc.addEventListener(TAKEOVER_EVENT, onTakeover);
  return stop;
}
