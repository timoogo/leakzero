// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNotesBackground } from '../src/notes/background';
import { NOTES_ENABLED, type Message } from '../src/notes/model';
import { MediaViewer, type ViewerItem } from '../src/notes/page/MediaViewer';
import { SelectedMessages } from '../src/notes/page/SelectedMessages';
import { createSelectionStore, type SelectionStore } from '../src/notes/selections';
import { fakeChrome } from './helpers/chrome';

// Media viewer of « Messages sélectionnés »: a modal dialog over the note, nothing fetched.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });

const PAGE = 'chrome-extension://leakzero-test/notes.html';
const ALICE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const still = (data: string) => ({ dataUrl: `data:image/jpeg;base64,${data}`, width: 480, height: 360 });

/** Copied image, image without copy (not viewable), copied image, video (never recorded by LeakZero). */
const message: Message = {
  conversationId: ALICE, key: 'p:0', text: 'regarde', author: 'Alice', sentAt: null, timeLabel: null, type: 'media', links: [],
  media: [
    { kind: 'image', alt: 'Plage', preview: still('AAE=') },
    { kind: 'image', alt: null, preview: null },
    { kind: 'image', alt: 'Fin du film', preview: still('AAI=') },
    { kind: 'video', alt: 'Vidéo de la plage', preview: null },
  ],
};

let selections: SelectionStore;
let root: Root | undefined;
let fetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  selections = createSelectionStore(() => new IDBFactory());
  const storage = fakeChrome({ [NOTES_ENABLED]: true });
  storage.setSender({ url: PAGE });
  registerNotesBackground(storage.api, selections);
  fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
});

afterEach(async () => {
  root?.unmount();
  root = undefined;
  document.body.innerHTML = '';
  await selections.close();
  vi.unstubAllGlobals();
});

async function show() {
  root?.unmount();
  document.body.innerHTML = '';
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root!.render(<SelectedMessages conversationId={ALICE} version={0} />));
  await vi.waitFor(() => expect(document.querySelectorAll('[data-selected-message]')).toHaveLength(1));
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const counter = () => dialog()!.querySelector('[data-viewer-counter]')!.textContent;
const title = () => dialog()!.querySelector('h2')!.textContent;
const named = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const withText = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll('button')].find((button) => button.textContent === text);
const opener = (media: number) => document.querySelector<HTMLButtonElement>(`[data-image="${media}"] [data-open-viewer], [data-video] [data-open-viewer]`)!;

/** What a user does: the button takes the focus, then is pressed. */
async function press(button: HTMLElement) {
  button.focus();
  await act(async () => button.click());
}

async function key(name: string) {
  await act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });
}

describe('media viewer', () => {
  it('opens an image large from its thumbnail, and closes with « Fermer » or Escape, giving the focus back', async () => {
    await selections.select(message);
    await show();
    expect(dialog()).toBeNull();
    const thumbnail = opener(0);
    expect(thumbnail.getAttribute('aria-label')).toBe('Agrandir l’image 1');
    await press(thumbnail);
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector<HTMLImageElement>('[data-viewer-image]')!.getAttribute('src')).toBe(still('AAE=').dataUrl);
    expect(dialog()!.querySelector('[data-viewer-image]')!.getAttribute('alt')).toBe('Plage');
    expect(title()).toBe('Image — Plage');
    // Images LeakZero holds and the video: the image without copy has nothing to show.
    expect(counter()).toBe('1 / 3');
    // Modal, described, with the focus inside.
    expect(dialog()!.getAttribute('aria-describedby')).toBeTruthy();
    expect(dialog()!.contains(document.activeElement)).toBe(true);

    await press(named('Fermer la visionneuse'));
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(thumbnail));

    await press(thumbnail);
    await key('Escape');
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(thumbnail));
  });

  it('goes through the media of the message with the buttons and the arrow keys, around', async () => {
    await selections.select(message);
    await show();
    await press(opener(0));
    await press(named('Média suivant'));
    expect([counter(), title()]).toEqual(['2 / 3', 'Image — Fin du film']);
    await press(named('Média suivant'));
    expect([counter(), title()]).toEqual(['3 / 3', 'Vidéo — Vidéo de la plage']);
    await press(named('Média suivant'));
    expect(counter()).toBe('1 / 3');
    await press(named('Média précédent'));
    expect(counter()).toBe('3 / 3');
    // Keyboard only.
    await key('ArrowLeft');
    expect(counter()).toBe('2 / 3');
    await key('ArrowRight');
    await key('ArrowRight');
    expect(counter()).toBe('1 / 3');
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    // Opened from another media: starts on it.
    await key('Escape');
    await press(opener(2));
    expect(counter()).toBe('2 / 3');
  });

  it('keeps a spoiler hidden until « Afficher l’image », without changing its saved status', async () => {
    await selections.select(message);
    await selections.setSpoiler(ALICE, 'p:0', 2, true);
    await show();
    const cover = opener(2);
    expect(cover.getAttribute('aria-label')).toBe('Agrandir l’image 3 (masquée — spoiler)');
    await press(cover);
    expect(dialog()!.querySelector('[data-viewer-spoiler]')!.textContent).toContain('Image masquée — spoiler');
    expect(dialog()!.querySelector('img')).toBeNull();

    await press(withText('Afficher l’image', dialog()!)!);
    expect(dialog()!.querySelector('[data-viewer-image]')!.getAttribute('src')).toBe(still('AAI=').dataUrl);
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    await press(withText('Masquer l’image', dialog()!)!);
    expect(dialog()!.querySelector('img')).toBeNull();

    // Revealed, then the viewer closed and opened again: hidden again.
    await press(withText('Afficher l’image', dialog()!)!);
    await key('Escape');
    expect(document.querySelector('[data-image="2"] [data-spoiler-cover]')).not.toBeNull();
    await press(opener(2));
    expect(dialog()!.querySelector('[data-viewer-spoiler]')).not.toBeNull();
    // Reached by navigation too.
    await key('Escape');
    await press(opener(0));
    await press(named('Média suivant'));
    expect(dialog()!.querySelector('[data-viewer-spoiler]')).not.toBeNull();
    expect((await selections.list(ALICE))[0].media.map((item) => item.spoiler)).toEqual([false, false, true, false]);
  });

  it('follows the spoiler switched on in the note, before it is even saved', async () => {
    await selections.select(message);
    await show();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-image="0"] [role="switch"]')!.click());
    await press(opener(0));
    expect(dialog()!.querySelector('[data-viewer-spoiler]')).not.toBeNull();
    await vi.waitFor(async () => expect((await selections.list(ALICE))[0].media[0].spoiler).toBe(true));
  });

  it('describes a video LeakZero has no file of, without pretending to play it nor fetching it', async () => {
    await selections.select(message);
    await show();
    const tile = opener(3);
    expect(tile.getAttribute('aria-label')).toBe('Ouvrir la vidéo 1 (Vidéo de la plage) dans la visionneuse');
    await press(tile);
    expect(counter()).toBe('3 / 3');
    expect(dialog()!.querySelector('video')).toBeNull();
    expect(dialog()!.querySelector('[data-viewer-unavailable]')!.textContent).toContain('LeakZero n’a pas enregistré cette vidéo, elle ne peut pas être lue ici.');
    expect(fetch).not.toHaveBeenCalled();
    await key('Escape');
    await vi.waitFor(() => expect(document.activeElement).toBe(tile));
  });

  describe('given a local video file', () => {
    const items: ViewerItem[] = [
      { index: 0, kind: 'video', alt: 'Clip', spoiler: false, still: still('AAE=').dataUrl, video: 'blob:chrome-extension://leakzero-test/clip' },
      { index: 1, kind: 'video', alt: null, spoiler: false, still: still('AAI=').dataUrl, video: null },
    ];

    async function view(start: number) {
      const button = document.body.appendChild(document.createElement('button'));
      button.focus();
      root = createRoot(document.body.appendChild(document.createElement('div')));
      await act(async () => root!.render(<MediaViewer items={items} start={start} opener={button} onClose={() => root!.render(null)} />));
      return button;
    }

    it('plays it with the native controls', async () => {
      const button = await view(0);
      const video = dialog()!.querySelector('video')!;
      expect(video.getAttribute('src')).toBe(items[0].video);
      expect(video.hasAttribute('controls')).toBe(true);
      expect(video.getAttribute('aria-label')).toBe('Clip');
      expect(video.getAttribute('preload')).toBe('metadata');
      // The arrows are the player's (seek, volume), not the viewer's.
      // Focusable in Chrome with its controls; jsdom needs to be told.
      video.tabIndex = 0;
      video.focus();
      await key('ArrowRight');
      expect(counter()).toBe('1 / 2');
      await key('Escape');
      expect(dialog()).toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(button));
    });

    it('shows only the still of a video without file, saying so', async () => {
      await view(1);
      expect(dialog()!.querySelector('video')).toBeNull();
      const unavailable = dialog()!.querySelector('[data-viewer-unavailable]')!;
      expect(unavailable.querySelector('img')!.getAttribute('src')).toBe(items[1].still);
      expect(unavailable.textContent).toContain('Aperçu seulement : LeakZero n’a pas enregistré cette vidéo');
    });
  });
});
