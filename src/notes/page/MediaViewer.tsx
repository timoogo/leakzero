import { ChevronLeft, ChevronRight, EyeOff, Film, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { SelectedMessage } from '../model';

/** One media the viewer can show. */
export interface ViewerItem {
  /** Position in the message's `media`. */
  index: number;
  kind: 'image' | 'video';
  alt: string | null;
  spoiler: boolean;
  /** Still picture held by LeakZero (an image's preview), or null. */
  still: string | null;
  /** Local video file to play, or null: then the video is only described, never fetched. */
  video: string | null;
}

/**
 * The media of a message the viewer shows: images LeakZero copied, and videos. LeakZero never records a
 * video file (src/notes/selection.ts), so a video shows its still if one exists, else only what it is.
 * Images without preview have nothing to show and are left out.
 */
export function viewerItems(message: SelectedMessage): ViewerItem[] {
  return message.media.flatMap((media, index) => {
    if (media.kind === 'image' && !media.preview) return [];
    return [{ index, kind: media.kind, alt: media.alt, spoiler: media.kind === 'image' && media.spoiler, still: media.preview?.dataUrl ?? null, video: null }];
  });
}

const kindLabel = (item: ViewerItem) => (item.kind === 'image' ? 'Image' : 'Vidéo');

function Stage({ item, revealed, onReveal }: { item: ViewerItem; revealed: boolean; onReveal: (revealed: boolean) => void }) {
  const fit = 'max-h-[calc(100vh-10rem)] max-w-full object-contain';
  if (item.spoiler && !revealed) {
    return (
      <div data-viewer-spoiler className="flex min-h-48 w-full flex-col items-center justify-center gap-3 rounded bg-muted p-6 text-center text-sm text-muted-foreground">
        <EyeOff className="size-6" aria-hidden="true" />
        <p>Image masquée — spoiler</p>
        <Button type="button" variant="outline" size="sm" onClick={() => onReveal(true)}>Afficher l’image</Button>
      </div>
    );
  }
  if (item.kind === 'video' && item.video) {
    // Native controls: play, pause, volume, progress, full screen. A local file only.
    return <video data-viewer-video src={item.video} poster={item.still ?? undefined} controls preload="metadata" aria-label={item.alt ?? 'Vidéo du message'} className={fit} />;
  }
  if (item.kind === 'video') {
    return (
      <div data-viewer-unavailable className="flex w-full flex-col items-center gap-3 text-center text-sm text-muted-foreground">
        {item.still
          ? <img src={item.still} alt={item.alt ?? 'Aperçu de la vidéo'} className={fit} />
          : <Film className="size-10" aria-hidden="true" />}
        <p>{item.still ? 'Aperçu seulement : ' : ''}LeakZero n’a pas enregistré cette vidéo, elle ne peut pas être lue ici. Elle reste visible dans la conversation sur Snapchat Web.</p>
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <img data-viewer-image src={item.still!} alt={item.alt ?? 'Image du message'} className={fit} />
      {item.spoiler && <Button type="button" variant="outline" size="sm" onClick={() => onReveal(false)}>Masquer l’image</Button>}
    </div>
  );
}

/**
 * Viewer of a message's media, as a modal dialog: Escape or « Fermer » closes it and gives the focus back
 * to `opener`; ← and → (or the buttons) go to the previous or next media. A spoiler stays hidden until
 * « Afficher l'image », for as long as the viewer is open: its saved status is never changed here.
 */
export function MediaViewer({ items, start, opener, onClose }: {
  items: readonly ViewerItem[]; start: number; opener: HTMLElement | null; onClose: () => void;
}) {
  const [position, setPosition] = useState(start);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => setPosition(start), [start]);
  const item = items[position];
  if (!item) return null;
  const several = items.length > 1;
  const go = (step: number) => {
    setPosition((current) => (current + step + items.length) % items.length);
    // The focus stays in the dialog when the button that had it disappears (spoiler revealed, media changed).
    content.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // The video's own controls use the arrows (seek, volume).
    if (!several || (event.target as HTMLElement).tagName === 'VIDEO') return;
    if (event.key === 'ArrowLeft') go(-1);
    else if (event.key === 'ArrowRight') go(1);
    else return;
    event.preventDefault();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent ref={content} tabIndex={-1} onKeyDown={onKeyDown} className="max-w-5xl justify-items-center"
        onCloseAutoFocus={(event) => { event.preventDefault(); opener?.focus(); }}>
        <div className="flex w-full items-center gap-2">
          <DialogTitle className="min-w-0 flex-1 truncate">{kindLabel(item)}{item.alt ? ` — ${item.alt}` : ''}</DialogTitle>
          <span data-viewer-counter aria-live="polite" className="text-sm text-muted-foreground">{position + 1} / {items.length}</span>
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="sm" aria-label="Fermer la visionneuse"><X /></Button>
          </DialogClose>
        </div>
        <DialogDescription className="sr-only">
          {several ? 'Flèches gauche et droite : média précédent ou suivant. ' : ''}Échap : fermer.
        </DialogDescription>
        <Stage key={position} item={item} revealed={revealed.has(item.index)}
          onReveal={(on) => {
            setRevealed((current) => {
              const next = new Set(current);
              if (on) next.add(item.index);
              else next.delete(item.index);
              return next;
            });
            content.current?.focus();
          }} />
        {several && (
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => go(-1)} aria-label="Média précédent"><ChevronLeft /> Précédent</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => go(1)} aria-label="Média suivant">Suivant <ChevronRight /></Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
