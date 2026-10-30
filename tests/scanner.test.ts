// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createScanner, type Scanner } from '../src/core/scanner';
import { DIGITS_MASK, PHONE_MASK } from '../src/maskers/text';
import { overlayState } from '../src/maskers/overlay';

/** Number of phone masks currently protected by the visual layers. */
const protectedPhones = () => overlayState().phones.length;
import { AVATAR_ATTRIBUTE, MEDIA_MASK_CSS } from '../src/maskers/media';
import { PHONE_HIGHLIGHT_CSS } from '../src/maskers/highlight';

const ALL_CSS = PHONE_HIGHLIGHT_CSS + MEDIA_MASK_CSS;

const ON = { maskPhones: true, reinforcedPhones: false, maskMedia: true };
const OFF = { maskPhones: false, reinforcedPhones: false, maskMedia: false };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let scanner: Scanner | undefined;

function start(html: string, settings = ON) {
  document.body.innerHTML = html;
  scanner = createScanner(document, ['FR']);
  scanner.apply(settings);
  return scanner;
}

function mediaCss() {
  return [...document.querySelectorAll('style[data-leakzero]')].map((s) => s.textContent);
}

afterEach(() => {
  scanner?.stop();
  scanner = undefined;
  document.querySelectorAll('style[data-leakzero]').forEach((s) => s.remove());
});

describe('phone masking', () => {
  it('masks only the number, keeping the rest of the message and the same text node', () => {
    start('<p id="m">Mon num: 06 12 34 56 78, merci !</p>');
    const p = document.getElementById('m')!;
    const node = p.firstChild;
    expect(p.textContent).toBe(`Mon num: ${PHONE_MASK}, merci !`);
    expect(protectedPhones()).toBe(1);
    expect(p.firstChild).toBe(node);
    expect(p.childNodes).toHaveLength(1);
  });

  it('restores the exact original text when disabled, and masks again when re-enabled', () => {
    const original = 'A: +44 20 7946 0958 / B: 0612345678';
    const s = start(`<p id="m">${original}</p>`);
    const p = document.getElementById('m')!;
    expect(p.textContent).toBe(`A: ${PHONE_MASK} / B: ${PHONE_MASK}`);
    s.apply({ ...ON, maskPhones: false });
    expect(p.textContent).toBe(original);
    expect(protectedPhones()).toBe(0);
    s.apply(ON);
    expect(p.textContent).toBe(`A: ${PHONE_MASK} / B: ${PHONE_MASK}`);
    expect(protectedPhones()).toBe(2);
  });

  it('masks text added dynamically and text nodes updated in place', async () => {
    start('<div id="chat"></div>');
    const chat = document.getElementById('chat')!;
    const msg = document.createElement('div');
    msg.innerHTML = '<span>écris au <b>+33 6 12 34 56 78</b></span>';
    chat.append(msg);
    await flush();
    expect(chat.textContent).toBe(`écris au ${PHONE_MASK}`);

    const text = document.createTextNode('rien ici');
    chat.append(text);
    await flush();
    text.data = 'nouveau : 07 98 76 54 32';
    await flush();
    expect(text.data).toBe(`nouveau : ${PHONE_MASK}`);
    expect(protectedPhones()).toBe(2);
  });

  it('does not restore over text the page rewrote after masking', async () => {
    const s = start('<p id="m">06 12 34 56 78</p>');
    const node = document.getElementById('m')!.firstChild as Text;
    node.data = 'message modifié';
    await flush();
    s.apply(OFF);
    expect(node.data).toBe('message modifié');
  });

  it('leaves false positives, scripts, textareas and editors untouched', () => {
    start(`
      <p id="fp">Le 12/05/2024 à 14:30, 1 234 567 € pour 25 ans, en 2024</p>
      <textarea id="ta">06 12 34 56 78</textarea>
      <div id="ce" contenteditable="true">06 12 34 56 78</div>`);
    expect(document.getElementById('fp')!.textContent).toBe('Le 12/05/2024 à 14:30, 1 234 567 € pour 25 ans, en 2024');
    expect(document.getElementById('ta')!.textContent).toBe('06 12 34 56 78');
    expect(document.getElementById('ce')!.textContent).toBe('06 12 34 56 78');
  });

  it('does not loop on its own mutations', async () => {
    start('<div id="chat"></div>');
    const chat = document.getElementById('chat')!;
    let records = 0;
    const spy = new MutationObserver((m) => { records += m.length; });
    spy.observe(chat, { childList: true, subtree: true, characterData: true });
    chat.append(document.createTextNode('+33 6 12 34 56 78'));
    for (let i = 0; i < 5; i++) await flush();
    spy.disconnect();
    // One insertion by the page + one characterData write by the masker, nothing more.
    expect(records).toBe(2);
    expect(chat.textContent).toBe(PHONE_MASK);
  });

  it('masks generic sequences of 3+ digits, keeps 1-2 digit numbers, and restores them', () => {
    const original = 'Code 4821, salle 12, réf 123-456 et 7 chats';
    const s = start(`<p id="m">${original}</p>`);
    const p = document.getElementById('m')!;
    expect(p.textContent).toBe(`Code ${DIGITS_MASK}, salle 12, réf ${DIGITS_MASK} et 7 chats`);
    s.apply({ ...ON, maskPhones: false });
    expect(p.textContent).toBe(original);
  });

  it('distinguishes phone numbers from generic sequences in the same text', () => {
    start('<p id="m">Appelle le 07.98.76.54.32 code 9876</p>');
    expect(document.getElementById('m')!.textContent).toBe(`Appelle le ${PHONE_MASK} code ${DIGITS_MASK}`);
    expect(protectedPhones()).toBe(1);
  });

  it('masks every digit of numbers without "+" and of fictitious international numbers', async () => {
    start('<div id="chat"></div>');
    const chat = document.getElementById('chat')!;
    chat.innerHTML = '<p>33000000000</p><p>+33000000000</p><p>tel 0061.7474 8002 ok</p><p>+1 (202) 555-0123</p>';
    await flush();
    const texts = [...chat.querySelectorAll('p')].map((p) => p.textContent);
    expect(texts).toEqual([DIGITS_MASK, PHONE_MASK, `tel ${PHONE_MASK} ok`, PHONE_MASK]);
    expect(chat.textContent).not.toMatch(/\d/);
  });

  it('scans open shadow roots', async () => {
    start('<div id="host"></div>');
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<p>+33 6 12 34 56 78</p>';
    // The shadow root is discovered when its host (or an ancestor) is (re)inserted.
    const host = document.getElementById('host')!;
    host.remove();
    document.body.append(host);
    await flush();
    expect(root.querySelector('p')!.textContent).toBe(PHONE_MASK);
    expect(root.querySelector('style[data-leakzero]')?.textContent).toBe(ALL_CSS);
  });
});

describe('media masking', () => {
  it('injects the mask stylesheet when enabled and clears it when disabled', () => {
    const s = start('<img src="x.png"><video></video>');
    expect(mediaCss()).toEqual([ALL_CSS]);
    s.apply({ ...ON, maskMedia: false });
    expect(mediaCss()).toEqual([PHONE_HIGHLIGHT_CSS]);
    s.apply(ON);
    expect(mediaCss()).toEqual([ALL_CSS]);
  });

  it('re-inserts the stylesheet if the page removes it', async () => {
    start('');
    document.querySelector('style[data-leakzero]')!.remove();
    document.body.append(document.createElement('img'));
    await flush();
    expect(mediaCss()).toEqual([ALL_CSS]);
  });

  it('masks media added dynamically through the same stylesheet rule', () => {
    start('');
    expect(MEDIA_MASK_CSS).toMatch(/img:not\(\[data-leakzero-avatar\]\), video/);
    expect(MEDIA_MASK_CSS).toMatch(/object-position: -100000px -100000px !important/);
  });
});

describe('Bitmoji avatars', () => {
  const BITMOJI = 'https://sdk.bitmoji.com/render/panel/10220709-99_2-s5-v1.png?transparent=1&palette=1';
  const masked = (img: Element) => img.matches(MEDIA_MASK_CSS.trim().split('{')[0].split(',')[0]);

  it('leaves Bitmoji render images visible and keeps ordinary images masked', () => {
    start(`
      <img id="avatar" src="${BITMOJI}">
      <img id="legacy" src="https://render.bitstrips.com/v2/cpanel/1-2-v1.png">
      <img id="photo" src="https://cf-st.sc-cdn.net/d/photo.jpg">
      <img id="blob" src="blob:https://web.snapchat.com/1234">
      <img id="query" src="https://example.com/x.png?u=https://sdk.bitmoji.com/render/panel/1.png">
      <img id="lookalike" src="https://sdk.bitmoji.com.example.com/render/panel/1.png">
      <img id="http" src="http://sdk.bitmoji.com/render/panel/1.png">
      <img id="srcset" src="${BITMOJI}" srcset="https://example.com/photo.jpg 2x">
      <picture><source srcset="https://example.com/photo.jpg"><img id="picture" src="${BITMOJI}"></picture>
      <img id="nosrc">`);
    const avatars = [...document.querySelectorAll(`[${AVATAR_ATTRIBUTE}]`)].map((img) => img.id);
    expect(avatars).toEqual(['avatar', 'legacy']);
    expect(masked(document.getElementById('avatar')!)).toBe(false);
    expect(masked(document.getElementById('photo')!)).toBe(true);
  });

  it('classifies images added dynamically and re-checks them when their source changes', async () => {
    start('<div id="chat"></div>');
    const chat = document.getElementById('chat')!;
    chat.innerHTML = `<img id="a" src="${BITMOJI}"><img id="b" src="https://example.com/photo.jpg">`;
    await flush();
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    expect([masked(a), masked(b)]).toEqual([false, true]);

    // An avatar slot reused for a photo must be masked again, and vice versa.
    a.setAttribute('src', 'https://example.com/photo.jpg');
    b.setAttribute('src', BITMOJI);
    await flush();
    expect([masked(a), masked(b)]).toEqual([true, false]);
    a.setAttribute('srcset', 'https://example.com/x.jpg 2x');
    a.setAttribute('src', BITMOJI);
    await flush();
    expect(masked(a)).toBe(true);
  });
});

describe('Bitmoji avatars served by the Snapchat CDN', () => {
  const AVATAR = 'https://cf-st.sc-cdn.net/3d/render/10226021-101442658079_1-s5-v1.webp?scale=0&ua=2';
  const AVATAR_1X = 'https://cf-st.sc-cdn.net/3d/render/10226021-101442658079_1-s5-v1.webp?scale=1&ua=2';
  const PHOTO = 'https://cf-st.sc-cdn.net/d/abc123?bo=Eg0aABoAMgF9OgFCQAZIAlASYAE%3D&uc=18';
  const masked = (img: Element) => img.matches(MEDIA_MASK_CSS.trim().split('{')[0].split(',')[0]);

  function image(attributes: Record<string, string>) {
    start('<div id="c"></div>');
    const img = document.createElement('img');
    for (const [name, value] of Object.entries(attributes)) img.setAttribute(name, value);
    document.getElementById('c')!.append(img);
    return img;
  }

  it.each([
    ['real URL', { src: AVATAR }],
    ['srcset variants', { src: AVATAR, srcset: `${AVATAR_1X} 1x, ${AVATAR} 2x` }],
    ['srcset mixing Snapchat and Bitmoji render hosts', { src: AVATAR, srcset: `${AVATAR_1X} 1x, https://sdk.bitmoji.com/render/panel/1.png 2x` }],
  ])('leaves the avatar visible: %s', async (_name, attributes) => {
    const img = image(attributes);
    await flush();
    expect(masked(img)).toBe(false);
  });

  it.each([
    ['another CDN path', { src: PHOTO }],
    ['a path that only contains the render path', { src: 'https://cf-st.sc-cdn.net/d/3d/render/x.webp' }],
    ['a path escaping the render folder', { src: 'https://cf-st.sc-cdn.net/3d/render/../../d/photo.jpg' }],
    ['an encoded escape', { src: 'https://cf-st.sc-cdn.net/3d/render/%2e%2e/%2e%2e/d/photo.jpg' }],
    ['a near-miss path', { src: 'https://cf-st.sc-cdn.net/3d/renderer/x.webp' }],
    ['the root render path without slash', { src: 'https://cf-st.sc-cdn.net/3d/render' }],
    ['HTTP', { src: 'http://cf-st.sc-cdn.net/3d/render/10226021-1_1-s5-v1.webp' }],
    ['another sc-cdn host', { src: 'https://bolt-gcdn.sc-cdn.net/3d/render/10226021-1_1-s5-v1.webp' }],
    ['a lookalike host', { src: 'https://cf-st.sc-cdn.net.example.com/3d/render/x.webp' }],
    ['a host suffix', { src: 'https://evil-cf-st.sc-cdn.net/3d/render/x.webp' }],
    ['URL in the query', { src: `https://example.com/p.jpg?u=${encodeURIComponent(AVATAR)}` }],
    ['user info trick', { src: 'https://cf-st.sc-cdn.net@example.com/3d/render/x.webp' }],
    ['one srcset entry from another path', { src: AVATAR, srcset: `${AVATAR_1X} 1x, ${PHOTO} 2x` }],
  ])('keeps the image masked: %s', async (_name, attributes) => {
    const img = image(attributes);
    await flush();
    expect(masked(img)).toBe(true);
  });

  it('re-checks avatars when src or srcset change dynamically', async () => {
    const img = image({ src: AVATAR });
    await flush();
    expect(masked(img)).toBe(false);
    img.setAttribute('src', PHOTO);
    await flush();
    expect(masked(img)).toBe(true);
    img.setAttribute('src', AVATAR_1X);
    await flush();
    expect(masked(img)).toBe(false);
    img.setAttribute('srcset', `${AVATAR} 1x, ${PHOTO} 2x`);
    await flush();
    expect(masked(img)).toBe(true);
    img.removeAttribute('srcset');
    await flush();
    expect(masked(img)).toBe(false);
  });
});
