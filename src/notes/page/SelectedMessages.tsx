import { EyeOff, Film } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { sendNotesCommand } from '../messages';
import type { SelectedMessage } from '../model';
import { formatDateTime, MESSAGE_TYPE_LABELS, mediaLabel, sentLabel } from '../selected';
import { MediaViewer, viewerItems } from './MediaViewer';

type Image = SelectedMessage['media'][number];

const tile = 'block w-full rounded focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * One image of a selected message, on the right of its details. « Spoiler » is saved (IndexedDB, through
 * the service worker); « Afficher l'image » only reveals it on this screen, until hidden again, the
 * spoiler turned on again, or the page reopened. A click on it opens the viewer.
 */
function ImageItem({ image, index, number, spoiler, onSpoiler, onOpen }: {
  image: Image; index: number; number: number; spoiler: boolean;
  onSpoiler: (value: boolean) => void; onOpen: (opener: HTMLElement) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const switchId = useId();
  const imageId = useId();
  const label = `image ${number}`;
  useEffect(() => { if (spoiler) setRevealed(false); }, [spoiler]);

  if (!image.preview) {
    return (
      <figure data-image={index} data-unavailable className="flex h-20 w-32 items-center justify-center rounded border border-dashed p-1 text-center text-xs text-muted-foreground">
        Image indisponible
      </figure>
    );
  }
  const shown = !spoiler || revealed;
  return (
    <figure data-image={index} className="w-32 space-y-1">
      <div id={imageId}>
        <button type="button" data-open-viewer className={tile} onClick={(event) => onOpen(event.currentTarget)}
          aria-label={`Agrandir l’${label}${shown ? '' : ' (masquée — spoiler)'}`}>
          {shown ? (
            <img src={image.preview.dataUrl} width={image.preview.width} height={image.preview.height}
              alt={image.alt ?? `Image ${number} du message`} className="h-auto max-h-32 w-full rounded object-contain" />
          ) : (
            <div data-spoiler-cover role="img" aria-label={`Image ${number} masquée — spoiler`}
              className="flex h-20 flex-col items-center justify-center gap-1 rounded bg-muted text-center text-xs text-muted-foreground">
              <EyeOff className="size-4" aria-hidden="true" />
              Image masquée — spoiler
            </div>
          )}
        </button>
      </div>
      {spoiler && (
        <Button type="button" variant="outline" size="sm" className="h-7 w-full text-xs" aria-controls={imageId} aria-expanded={revealed}
          onClick={() => setRevealed(!revealed)}>
          {revealed ? 'Masquer l’image' : 'Afficher l’image'}
        </Button>
      )}
      <figcaption className="flex items-center gap-2 text-xs">
        <Switch id={switchId} checked={spoiler} onCheckedChange={onSpoiler} aria-label={`Spoiler, ${label}`} />
        <label htmlFor={switchId}>Spoiler</label>
      </figcaption>
    </figure>
  );
}

/** A video of a selected message: LeakZero holds no file of it, the viewer only says what it is. */
function VideoItem({ alt, number, onOpen }: { alt: string | null; number: number; onOpen: (opener: HTMLElement) => void }) {
  return (
    <figure data-video className="w-32">
      <button type="button" data-open-viewer className={`${tile} flex h-20 flex-col items-center justify-center gap-1 bg-muted text-xs text-muted-foreground`}
        onClick={(event) => onOpen(event.currentTarget)} aria-label={`Ouvrir la vidéo ${number}${alt ? ` (${alt})` : ''} dans la visionneuse`}>
        <Film className="size-4" aria-hidden="true" />
        Vidéo
      </button>
    </figure>
  );
}

function MessageItem({ message, onError }: { message: SelectedMessage; onError: (message: string) => void }) {
  const sent = sentLabel(message);
  const media = mediaLabel(message);
  // Spoiler status of each media, shown at once and saved (the stored one wins when it changes).
  const [spoilers, setSpoilers] = useState(() => message.media.map((item) => item.spoiler));
  useEffect(() => setSpoilers(message.media.map((item) => item.spoiler)), [message]);
  const [viewing, setViewing] = useState<{ index: number; opener: HTMLElement } | null>(null);
  const items = viewerItems(message).map((item) => ({ ...item, spoiler: item.kind === 'image' && spoilers[item.index] }));

  const setSpoiler = (index: number, value: boolean) => {
    const set = (on: boolean) => setSpoilers((current) => current.map((item, position) => (position === index ? on : item)));
    set(value);
    sendNotesCommand({ type: 'notes:setSpoiler', conversationId: message.conversationId, key: message.key, media: index, spoiler: value })
      .catch((cause: unknown) => {
        set(!value);
        onError(`Statut spoiler non enregistré : ${cause instanceof Error ? cause.message : String(cause)}`);
      });
  };
  let images = 0;
  let videos = 0;
  const tiles = message.media.map((item, index) => {
    const open = (opener: HTMLElement) => setViewing({ index, opener });
    return item.kind === 'image'
      ? <ImageItem key={index} image={item} index={index} number={++images} spoiler={spoilers[index]} onSpoiler={(value) => setSpoiler(index, value)} onOpen={open} />
      : <VideoItem key={index} alt={item.alt} number={++videos} onOpen={open} />;
  });
  return (
    <li data-selected-message className="flex gap-3 rounded-md border px-3 py-2">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          {/* Only what Snapchat showed: a missing author or date is left out, never guessed. */}
          {message.author && <span data-author className="font-medium text-foreground">{message.author}</span>}
          {sent && <span data-sent>Envoyé : {sent}</span>}
          <span data-type>{MESSAGE_TYPE_LABELS[message.type]}</span>
          <span>Sélectionné le {formatDateTime(message.selectedAt)}</span>
        </p>
        {message.text && <p data-text className="whitespace-pre-wrap break-words">{message.text}</p>}
        {media && <p className="text-xs text-muted-foreground">{media}</p>}
        {message.links.length > 0 && <p className="break-all text-xs text-muted-foreground">{message.links.join(' ')}</p>}
      </div>
      {tiles.length > 0 && <div className="flex shrink-0 flex-col gap-2">{tiles}</div>}
      {viewing && (
        <MediaViewer items={items} start={Math.max(0, items.findIndex((item) => item.index === viewing.index))}
          opener={viewing.opener} onClose={() => setViewing(null)} />
      )}
    </li>
  );
}

/**
 * « Messages sélectionnés » of a note: the messages of its conversation selected on Snapchat Web, read
 * from IndexedDB through the service worker (`notes:selectedMessages`). Read again whenever `version`
 * changes (the service worker's `notes:selectionChanged` for this conversation). Never part of the note's
 * own text.
 */
export function SelectedMessages({ conversationId, version }: { conversationId: string; version: number }) {
  const [messages, setMessages] = useState<SelectedMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    sendNotesCommand<SelectedMessage[]>({ type: 'notes:selectedMessages', conversationId }).then(
      (result) => {
        if (!current) return;
        setMessages(result);
        setError(null);
      },
      (cause: unknown) => current && setError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => { current = false; };
  }, [conversationId, version]);

  return (
    <section aria-labelledby="selected-messages-title" className="flex max-h-[40%] shrink-0 flex-col border-t">
      <h2 id="selected-messages-title" className="px-4 pt-3 pb-2 font-semibold">
        Messages sélectionnés <span data-selected-count className="font-normal text-muted-foreground">({messages?.length ?? 0})</span>
      </h2>
      <div className="min-h-0 overflow-y-auto px-4 pb-3">
        {error && <p role="alert" className="text-xs text-destructive">Messages sélectionnés illisibles : {error}</p>}
        {actionError && <p role="alert" className="text-xs text-destructive">{actionError}</p>}
        {messages && messages.length === 0 && (
          <p className="text-xs text-muted-foreground">Aucun message sélectionné. Utilisez « Sélectionner des messages », puis cochez des messages sur Snapchat Web.</p>
        )}
        {messages && messages.length > 0 && (
          <ol className="space-y-2">{messages.map((message) => <MessageItem key={message.key} message={message} onError={setActionError} />)}</ol>
        )}
      </div>
    </section>
  );
}
