export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

interface Options {
  save: (html: string) => Promise<void>;
  /** Inactivity before saving, in ms. */
  delay: number;
  onStatus: (status: SaveStatus) => void;
}

/**
 * Saves the content of one note `delay` ms after its last change. `flush` saves at once (switching
 * notes, closing the window); a failed save keeps the content, retried on the next change or flush.
 */
export function createAutosave({ save, delay, onStatus }: Options) {
  let latest = '';
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  let saving = false;

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    // Saves run one after the other, so an older content can never be written after a newer one.
    running = running.then(async () => {
      if (!dirty) return;
      const html = latest;
      dirty = false;
      saving = true;
      onStatus('saving');
      try {
        await save(html);
        onStatus(dirty ? 'dirty' : 'saved');
      } catch {
        dirty = true;
        onStatus('error');
      } finally {
        saving = false;
      }
    });
    return running;
  }

  return {
    change(html: string) {
      latest = html;
      dirty = true;
      onStatus('dirty');
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), delay);
    },
    flush,
    pending: () => dirty,
    /** Nothing to save and no save running: the stored content is the editor's. */
    idle: () => !dirty && !saving,
  };
}
