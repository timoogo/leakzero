import { useCallback, useEffect, useReducer, useState } from 'react';
import { ArrowDownWideNarrow, FileCode, FileText, LocateFixed, NotebookPen, Search, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useStorage } from '../../popup/useStorage';
import { noteDocument, noteFileName, noteText } from '../archive';
import { follow, initialFollow } from '../follow';
import { filterByName, listedNotes, moveNote, trashedNotes } from '../list';
import { sendNotesCommand } from '../messages';
import { activeConversation, readNotes, readOrder } from '../model';
import { trackWindowBounds } from '../window';
import { ArchiveActions } from './ArchiveActions';
import { downloadFile } from './download';
import { NoteEditor } from './NoteEditor';
import { NoteList } from './NoteList';
import { TrashList } from './TrashList';

const noInitialization = async () => undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Notes window. Reads the notes from chrome.storage.local (kept in sync by useStorage) and sends
 * every change to the service worker, which writes them (src/notes/store.ts).
 */
export default function NotesApp() {
  const { items, ready, error: storageError } = useStorage(noInitialization);
  const [state, dispatch] = useReducer(follow, null, () => initialFollow(null));
  const [view, setView] = useState<'notes' | 'trash'>('notes');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const notes = readNotes(items);
  const order = readOrder(items);
  const listed = listedNotes(notes, order);
  const trash = trashedNotes(notes);
  const active = activeConversation(items);
  const activeNote = active ? notes.find((note) => note.conversationId === active.conversationId) : undefined;
  const activeId = activeNote?.trashedAt === null ? activeNote.id : null;
  const selected = listed.find((note) => note.id === state.selectedId);

  useEffect(() => {
    if (ready) dispatch({ type: 'active', noteId: activeId });
  }, [ready, active?.detectedAt, activeId]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    chrome.windows.getCurrent().then(
      // Only the floating window: a tab must not save the size of the browser window it is in.
      (win) => { if (win.id !== undefined && win.type === 'popup') stop = trackWindowBounds(chrome, win.id); },
      () => undefined,
    );
    return () => stop?.();
  }, []);

  const onEditingChange = useCallback((editing: boolean) => dispatch({ type: editing ? 'focus' : 'blur' }), []);

  const run = (command: Parameters<typeof sendNotesCommand>[0]) => {
    setError(null);
    return sendNotesCommand(command).catch((cause: unknown) => setError(errorMessage(cause)));
  };

  if (!ready) return <main className="h-screen" aria-busy="true" />;

  const shown = filterByName(view === 'notes' ? listed : trash, query);
  const reorderable = view === 'notes' && query.trim() === '';
  const message = error ?? storageError;

  return (
    <main className="flex h-screen flex-col text-sm sm:flex-row">
      <aside className="flex max-h-[45vh] shrink-0 flex-col border-b sm:max-h-none sm:w-72 sm:border-r sm:border-b-0">
        <div className="space-y-2 p-3">
          <h2 className="flex items-center gap-2 font-semibold"><NotebookPen className="size-4 text-primary" aria-hidden /> LeakZero Notes</h2>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input type="search" aria-label="Rechercher une conversation" placeholder="Rechercher une conversation" className="h-8 pl-8"
              value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          {view === 'notes' && order && (
            <Button variant="ghost" size="sm" className="h-7 w-full justify-start px-2 text-xs text-muted-foreground"
              onClick={() => void run({ type: 'notes:setOrder', order: null })}>
              <ArrowDownWideNarrow /> Trier par activité récente
            </Button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {view === 'notes' ? (
            <NoteList
              notes={shown}
              selectedId={state.selectedId}
              activeId={activeId}
              reorderable={reorderable}
              onSelect={(id) => dispatch({ type: 'select', noteId: id })}
              onMove={(id, index) => void run({ type: 'notes:setOrder', order: moveNote(listed.map((note) => note.id), id, index) })}
            />
          ) : (
            <TrashList
              notes={shown}
              onRestore={(id) => void run({ type: 'notes:restore', id })}
              onPurge={(id) => void run({ type: 'notes:purge', id })}
            />
          )}
          {view === 'notes' && shown.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              {query ? `Aucune conversation ne correspond à « ${query} ».` : 'Aucune fiche pour l’instant.'}
            </p>
          )}
        </div>
        <div className="space-y-1 border-t p-2">
          <ArchiveActions notes={notes} onError={setError} onDone={setNotice} />
          <Button variant="ghost" size="sm" className="w-full justify-start px-2" onClick={() => setView(view === 'notes' ? 'trash' : 'notes')}>
            {view === 'notes' ? <><Trash2 /> Corbeille ({trash.length})</> : <>← Retour aux fiches</>}
          </Button>
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {message && (
          <div role="alert" className="m-3 mb-0 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs">
            <span className="flex-1">{message}</span>
            {error && <button type="button" aria-label="Fermer le message" className="cursor-pointer text-muted-foreground" onClick={() => setError(null)}><X className="size-3.5" /></button>}
          </div>
        )}
        {notice && (
          <div role="status" className="m-3 mb-0 flex items-start gap-2 rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
            <span className="flex-1">{notice}</span>
            <button type="button" aria-label="Fermer le message" className="cursor-pointer" onClick={() => setNotice(null)}><X className="size-3.5" /></button>
          </div>
        )}
        {view === 'notes' && active && activeNote && activeNote.trashedAt !== null && (
          <div role="status" className="m-3 mb-0 flex flex-wrap items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            <span className="flex-1">La fiche de « {activeNote.name} » est dans la corbeille.</span>
            <Button variant="outline" size="sm" className="h-7" onClick={() => void run({ type: 'notes:restore', id: activeNote.id })}>Restaurer la fiche</Button>
          </div>
        )}
        {!state.following && (
          <div className="m-3 mb-0 flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            <span className="flex-1">Suivi de Snapchat suspendu : la fiche ne change plus avec la conversation ouverte.</span>
            <Button variant="outline" size="sm" className="h-7" onClick={() => dispatch({ type: 'resume', noteId: activeId })}>
              <LocateFixed /> Reprendre le suivi
            </Button>
          </div>
        )}
        {selected ? (
          <NoteEditor
            key={selected.id}
            note={selected}
            onEditingChange={onEditingChange}
            actions={(current) => (
              <>
                <Button variant="ghost" size="icon" aria-label="Exporter en HTML" title="Exporter en HTML"
                  onClick={() => downloadFile(noteFileName(selected, 'html'), new Blob([noteDocument(current())], { type: 'text/html' }))}>
                  <FileCode />
                </Button>
                <Button variant="ghost" size="icon" aria-label="Exporter en TXT" title="Exporter en TXT"
                  onClick={() => downloadFile(noteFileName(selected, 'txt'), new Blob([noteText(current())], { type: 'text/plain' }))}>
                  <FileText />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void run({ type: 'notes:trash', id: selected.id })}>
                  <Trash2 /> Supprimer
                </Button>
              </>
            )}
          />
        ) : (
          <p className="m-auto max-w-xs p-6 text-center text-muted-foreground">
            {active ? 'Choisissez une fiche dans la liste.' : 'Aucune conversation Snapchat détectée pour l’instant. Ouvrez une conversation sur Snapchat Web ou choisissez une fiche.'}
          </p>
        )}
      </section>
    </main>
  );
}
