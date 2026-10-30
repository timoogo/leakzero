// Pure CSS masking: the stylesheet applies to every matching element, including ones added
// later, before they are painted. `object-position` pushes the pixels out of the element box
// so only the opaque background remains, while the layout is preserved.
// Images are masked until proven to be a Bitmoji avatar (fail closed), see `markAvatar`.
export const AVATAR_ATTRIBUTE = 'data-leakzero-avatar';
export const MEDIA_MASK_CSS = `
img:not([${AVATAR_ATTRIBUTE}]), video, input[type="image"] {
  object-position: -100000px -100000px !important;
  background: #000 !important;
  background-image: none !important;
}
video::cue { visibility: hidden !important; }
`;

// Bitmoji avatars are rendered by Bitmoji's own servers (e.g. https://sdk.bitmoji.com/render/panel/…,
// legacy https://render.bitstrips.com/…). Photos and videos sent by people are never served from
// these domains, so the origin of the image is the criterion, not the page's CSS classes.
const AVATAR_HOST = /(?:^|\.)bitmoji\.com$|^render\.bitstrips\.com$/;
// Snapchat Web serves avatars from its general CDN, e.g.
// https://cf-st.sc-cdn.net/3d/render/10226021-101442658079_1-s5-v1.webp?scale=0&ua=2.
// Only that render path is allowed: every other image of the CDN stays masked.
const SNAPCHAT_AVATAR = { host: 'cf-st.sc-cdn.net', pathPrefix: '/3d/render/' };

function isAvatarUrl(url: string, base: string): boolean {
  try {
    const parsed = new URL(url, base);
    if (parsed.protocol !== 'https:') return false;
    // `pathname` is normalised by URL ("..", "%2e%2e"), so a prefix check cannot be escaped.
    if (parsed.hostname === SNAPCHAT_AVATAR.host) return parsed.pathname.startsWith(SNAPCHAT_AVATAR.pathPrefix);
    return AVATAR_HOST.test(parsed.hostname);
  } catch {
    return false;
  }
}

/** True when every image source the browser may display comes from a Bitmoji render host. */
export function isBitmojiAvatar(img: HTMLImageElement): boolean {
  // <picture> may display a <source> instead of the img's own src.
  if (img.parentElement?.tagName === 'PICTURE') return false;
  const src = img.getAttribute('src');
  if (!src || !isAvatarUrl(src, img.baseURI)) return false;
  const srcset = img.getAttribute('srcset');
  if (!srcset) return true;
  return srcset.split(',').every((candidate) => isAvatarUrl(candidate.trim().split(/\s+/)[0], img.baseURI));
}

/** Flags (or unflags) an image as a Bitmoji avatar, which the mask stylesheet leaves visible. */
export function markAvatar(img: HTMLImageElement): void {
  const avatar = isBitmojiAvatar(img);
  if (avatar !== img.hasAttribute(AVATAR_ATTRIBUTE)) img.toggleAttribute(AVATAR_ATTRIBUTE, avatar);
}
