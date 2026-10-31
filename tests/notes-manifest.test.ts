import { describe, expect, it } from 'vitest';
import manifest from '../manifest.config';

describe('Notes content script', () => {
  const notes = () => (manifest as unknown as chrome.runtime.ManifestV3).content_scripts!.find((script) => script.js?.includes('src/content/notes.ts'))!;

  it('is loaded on every Snapchat page, with or without www, so an SPA navigation into /web is followed', () => {
    expect(notes().matches).toEqual(['https://www.snapchat.com/*', 'https://snapchat.com/*']);
  });

  it('adds no permission', () => {
    expect((manifest as unknown as chrome.runtime.ManifestV3).permissions).toEqual(['storage', 'scripting']);
  });
});
