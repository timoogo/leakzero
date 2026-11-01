// Original files of the videos of selected messages. The Snapchat content script reads the `blob:` URL
// the page's own player already holds (never a remote URL: nothing is downloaded), checks that its bytes
// are a video, and sends them, unchanged, to the service worker, which stores them in the extension's
// IndexedDB (selections.ts). Nothing is transcoded; nothing of a video is ever logged.
//
// chrome.runtime messaging is JSON-only in Chrome (no Blob, no ArrayBuffer): the bytes travel as base64,
// and are decoded back to bytes by the service worker before being stored. Only the transport is base64.

/** Largest video kept: 32 MiB, i.e. ≈ 43 MiB of base64, under Chrome's 64 MiB limit for one message. */
export const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
export const MAX_VIDEO_BASE64 = Math.ceil(MAX_VIDEO_BYTES / 3) * 4;

export class VideoCaptureError extends Error {
  override name = 'VideoCaptureError';
}

/** ISO BMFF brands of still images (HEIC, AVIF…): `ftyp` alone does not make a video. */
const IMAGE_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis', 'jpeg', 'jpgs']);

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

/** The kind of video `bytes` start with (MP4/QuickTime, WebM/Matroska), or null: what the file is, not what it claims. */
export function sniffVideo(bytes: Uint8Array): 'video/mp4' | 'video/quicktime' | 'video/webm' | null {
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (IMAGE_BRANDS.has(brand)) return null;
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  return null;
}

/** MIME type as a Blob may carry it, codecs included (`video/mp4; codecs="hvc1"`). */
export const VIDEO_MIME = /^video\/[a-z0-9.+-]{1,100}(;[ -~]{0,150})?$/i;

/** A video of a message as captured: its original bytes (base64, for the transport) and what the page knew of it. */
export interface CapturedVideo {
  mime: string;
  size: number;
  data: string;
  /** From the player; null when it could not decode the video (HEVC on Linux…) or had not loaded it. */
  width: number | null;
  height: number | null;
  /** Seconds. */
  duration: number | null;
}

/** What is read of a `<video>` at selection, synchronously: Snapchat may reuse the element for another message later. */
export interface VideoSource {
  url: string;
  width: number | null;
  height: number | null;
  duration: number | null;
}

const positive = (value: number) => (Number.isFinite(value) && value > 0 ? value : null);

/**
 * The `blob:` URL of the page's own origin that `video` plays (its `src`, or a `<source>`), with what the
 * player knows of it; null for anything else: a remote URL is never requested, and a `blob:` URL of
 * another origin is not this page's.
 */
export function videoSource(video: HTMLVideoElement): VideoSource | null {
  const origin = video.ownerDocument.location.origin;
  const candidates = [video.currentSrc, video.getAttribute('src'), ...[...video.querySelectorAll('source')].map((source) => source.getAttribute('src'))];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      // A blob URL's origin is the origin that created it.
      if (url.protocol !== 'blob:' || url.origin !== origin) continue;
    } catch {
      continue;
    }
    return {
      url: candidate,
      width: positive(video.videoWidth),
      height: positive(video.videoHeight),
      duration: positive(video.duration) === null ? null : Math.round(video.duration * 1000) / 1000,
    };
  }
  return null;
}

/** Bytes as base64, by chunks (String.fromCharCode takes a bounded number of arguments). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

export function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Reads the video at `source.url` (a `blob:` URL of the page: `fetch` reads it from memory, without any
 * request). Content scripts share the page's origin, so they can read its blob URLs; a revoked one (the
 * page closed the player, the tab was reloaded) cannot be, and neither can a MediaSource stream.
 * Rejects with a VideoCaptureError saying why, never with any of the video's content.
 */
export async function captureVideo(source: VideoSource, read: (url: string) => Promise<Blob> = readBlob): Promise<CapturedVideo> {
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    throw new VideoCaptureError('adresse de vidéo invalide');
  }
  if (url.protocol !== 'blob:') throw new VideoCaptureError('la vidéo n’est pas en mémoire dans la page (adresse distante, non téléchargée)');
  let blob: Blob;
  try {
    blob = await read(source.url);
  } catch {
    throw new VideoCaptureError('vidéo inaccessible : son adresse blob: a expiré ou n’est pas un fichier (flux MediaSource)');
  }
  if (blob.size === 0) throw new VideoCaptureError('vidéo vide');
  if (blob.size > MAX_VIDEO_BYTES) throw new VideoCaptureError(`vidéo trop volumineuse (${blob.size} octets, au plus ${MAX_VIDEO_BYTES})`);
  if (blob.type && !VIDEO_MIME.test(blob.type)) throw new VideoCaptureError('le fichier n’est pas une vidéo');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch {
    throw new VideoCaptureError('lecture de la vidéo impossible');
  }
  const sniffed = sniffVideo(bytes);
  if (!sniffed) throw new VideoCaptureError('le fichier n’est pas une vidéo');
  return {
    mime: blob.type || sniffed,
    size: bytes.length,
    data: toBase64(bytes),
    width: source.width,
    height: source.height,
    duration: source.duration,
  };
}

async function readBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}
