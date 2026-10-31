import { modules } from '../modules/registry';
import { registerNotesBackground } from '../notes/background';
import { initializeState } from '../shared/state';

/**
 * Chrome neither injects content scripts into tabs that are already open, nor stops those of the
 * previous version on update: they keep masking with stale settings and no longer receive changes.
 * Injecting the current version makes it take over (see content/protection.ts).
 */
async function injectIntoOpenTabs(): Promise<void> {
  // Each script only goes where the manifest runs it (the Notes script on Snapchat only).
  await Promise.all((chrome.runtime.getManifest().content_scripts ?? []).map(async (script) => {
    const tabs = await chrome.tabs.query(script.matches ? { url: script.matches } : {});
    await Promise.all(tabs.map((tab) => tab.id === undefined ? undefined : chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: script.js ?? [], injectImmediately: true })
      // Pages extensions cannot access (chrome://, the Web Store, discarded tabs…).
      .catch(() => undefined)));
  }));
}

// Registered at startup, so that Chrome can wake the service worker for Notes messages.
registerNotesBackground();

chrome.runtime.onInstalled.addListener(({ reason }) => {
  const { INSTALL, UPDATE } = chrome.runtime.OnInstalledReason;
  // Only the browser knows whether this is a fresh install or an update of an install whose settings
  // may never have been saved, so the storage migration runs here (the popup re-runs it, idempotently).
  // It runs first, so injected scripts read migrated settings.
  initializeState(modules, reason === INSTALL ? 'install' : 'update')
    .catch((error: unknown) => console.error('LeakZero: storage initialization failed', error))
    .then(() => (reason === INSTALL || reason === UPDATE ? injectIntoOpenTabs() : undefined))
    .catch((error: unknown) => console.error('LeakZero: injection into open tabs failed', error));
});
