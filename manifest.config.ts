import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'LeakZero',
  version: '0.1.0',
  description: 'Masque numéros de téléphone, images et vidéos pendant vos livestreams.',
  // storage: settings sync to content scripts through chrome.storage.onChanged.
  // scripting + <all_urls> (same sites as the content script, so no new install warning): on install
  // and update, the background script injects the content script into tabs that are already open.
  permissions: ['storage', 'scripting'],
  host_permissions: ['<all_urls>'],
  action: { default_popup: 'src/popup/index.html', default_title: 'LeakZero' },
  // Initializes and migrates the stored settings on install/update (see src/shared/state.ts).
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [{
    matches: ['<all_urls>'],
    js: ['src/content/index.ts'],
    run_at: 'document_start',
    all_frames: true,
    match_about_blank: true,
  }, {
    // Notes module: reports the open Snapchat conversation (id from the URL, name from its header).
    matches: ['https://www.snapchat.com/web*'],
    js: ['src/content/notes.ts'],
    run_at: 'document_idle',
  }],
});
