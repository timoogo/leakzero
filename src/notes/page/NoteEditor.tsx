import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Bold, Heading2, Heading3, Italic, Link2, List, ListOrdered, Pencil, Undo2, Underline } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { createAutosave, type SaveStatus } from '../autosave';
import { linkTarget, noteExtensions } from '../content';
import { sendNotesCommand } from '../messages';
import { displayName, MAX_NAME_LENGTH, type Note } from '../model';

/** Inactivity before a change is saved. */
export const SAVE_DELAY_MS = 300;

const STATUS_LABELS: Record<SaveStatus, string> = {
  saved: 'Sauvegardé',
  dirty: 'Modification en cours…',
  saving: 'Sauvegarde…',
  error: 'Erreur de sauvegarde',
};

/** The note's title, renamed in place; the name detected on Snapchat stays available underneath. */
function NoteTitle({ note }: { note: Note }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rename = (customName: string | null) => {
    setError(null);
    sendNotesCommand({ type: 'notes:rename', id: note.id, customName }).then(
      () => setDraft(null),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  if (draft !== null) {
    return (
      <form
        className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          // An empty title, or the detected name itself, means no custom title.
          const value = draft.trim();
          rename(value === '' || value === note.name ? null : value);
        }}
      >
        <Input
          name="customName"
          aria-label="Titre de la fiche"
          className="h-8 min-w-0 flex-1"
          maxLength={MAX_NAME_LENGTH}
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(null);
              setError(null);
            }
          }}
        />
        <Button type="submit" size="sm">Renommer</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft(null); setError(null); }}>Annuler</Button>
        {error && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
      </form>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div className="min-w-0">
        <h1 data-note-title className="truncate text-lg font-semibold">{displayName(note)}</h1>
        {note.customName !== null && (
          <p data-detected-name className="truncate text-xs text-muted-foreground">Nom Snapchat : {note.name}</p>
        )}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
      <Button variant="ghost" size="icon" aria-label="Renommer la fiche" title="Renommer la fiche" onClick={() => setDraft(displayName(note))}>
        <Pencil />
      </Button>
      {note.customName !== null && (
        <Button variant="ghost" size="icon" aria-label="Revenir au nom Snapchat" title="Revenir au nom Snapchat" onClick={() => rename(null)}>
          <Undo2 />
        </Button>
      )}
    </div>
  );
}

function ToolButton({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(active && 'bg-accent text-primary')}
      // Keeps the focus and the selection in the editor.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      h2: current.isActive('heading', { level: 2 }),
      h3: current.isActive('heading', { level: 3 }),
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      underline: current.isActive('underline'),
      bullet: current.isActive('bulletList'),
      ordered: current.isActive('orderedList'),
      link: current.isActive('link'),
      href: (current.getAttributes('link').href as string | undefined) ?? '',
    }),
  });
  const [linkInput, setLinkInput] = useState<string | null>(null);
  const [linkError, setLinkError] = useState(false);
  const chain = () => editor.chain().focus();

  function applyLink() {
    const href = linkTarget(linkInput ?? '');
    if (!href) return setLinkError(true);
    chain().extendMarkRange('link').setLink({ href }).run();
    setLinkInput(null);
  }

  return (
    <div className="border-b">
      <div role="toolbar" aria-label="Mise en forme" className="flex flex-wrap items-center gap-0.5 px-2 py-1">
        <ToolButton label="Titre" active={state.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}><Heading2 /></ToolButton>
        <ToolButton label="Sous-titre" active={state.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()}><Heading3 /></ToolButton>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <ToolButton label="Gras" active={state.bold} onClick={() => chain().toggleBold().run()}><Bold /></ToolButton>
        <ToolButton label="Italique" active={state.italic} onClick={() => chain().toggleItalic().run()}><Italic /></ToolButton>
        <ToolButton label="Souligné" active={state.underline} onClick={() => chain().toggleUnderline().run()}><Underline /></ToolButton>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <ToolButton label="Liste à puces" active={state.bullet} onClick={() => chain().toggleBulletList().run()}><List /></ToolButton>
        <ToolButton label="Liste numérotée" active={state.ordered} onClick={() => chain().toggleOrderedList().run()}><ListOrdered /></ToolButton>
        <ToolButton label="Lien" active={state.link || linkInput !== null} onClick={() => {
          setLinkError(false);
          setLinkInput(linkInput === null ? state.href : null);
        }}><Link2 /></ToolButton>
      </div>
      {linkInput !== null && (
        <form className="flex flex-wrap items-center gap-2 px-3 pb-2" onSubmit={(event) => { event.preventDefault(); applyLink(); }}>
          <Input
            autoFocus
            aria-label="Adresse du lien"
            placeholder="https://…"
            className="h-8 max-w-sm flex-1"
            value={linkInput}
            aria-invalid={linkError}
            onChange={(event) => { setLinkError(false); setLinkInput(event.target.value); }}
          />
          <Button type="submit" size="sm">Appliquer</Button>
          {state.link && (
            <Button type="button" variant="ghost" size="sm" onClick={() => { chain().extendMarkRange('link').unsetLink().run(); setLinkInput(null); }}>
              Retirer le lien
            </Button>
          )}
          {linkError && <span className="text-xs text-destructive">Adresse web (http, https) ou e-mail (mailto) uniquement.</span>}
        </form>
      )}
    </div>
  );
}

export function SaveIndicator({ status, error, onRetry }: { status: SaveStatus; error: string | null; onRetry: () => void }) {
  return (
    <span data-save-status role="status" className={cn('flex items-center gap-2 text-xs', status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
      {STATUS_LABELS[status]}
      {status === 'error' && error && <span className="max-w-xs">: {error}</span>}
      {status === 'error' && <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onRetry}>Réessayer</Button>}
    </span>
  );
}

interface Props {
  note: Note;
  /** Rendered in the header, next to the save state. `current` gives the note as shown, unsaved changes included. */
  actions: (current: () => Note) => ReactNode;
  /** The focus entered or left the editor (its toolbar and link field included). */
  onEditingChange: (editing: boolean) => void;
}

/**
 * Editor of one note (mounted per note: `key={note.id}`). Saves SAVE_DELAY_MS after the last change,
 * and at once when the note is left or the window closed, so a pending change is never lost.
 */
export function NoteEditor({ note, actions, onEditingChange }: Props) {
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [error, setError] = useState<string | null>(null);
  const autosave = useMemo(
    () => createAutosave({
      delay: SAVE_DELAY_MS,
      onStatus: setStatus,
      save: (html) => sendNotesCommand({ type: 'notes:save', id: note.id, html }).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }),
    }),
    [note.id],
  );
  const editor = useEditor({
    extensions: noteExtensions,
    content: note.html,
    editorProps: { attributes: { class: 'note-content', 'aria-label': `Notes de ${displayName(note)}` } },
    onUpdate: ({ editor: current }) => autosave.change(current.isEmpty ? '' : current.getHTML()),
  });

  // Unmounted with the focus inside (note deleted…): not editing anymore.
  useEffect(() => () => onEditingChange(false), [onEditingChange]);

  useEffect(() => {
    const onPageHide = () => void autosave.flush();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      void autosave.flush();
    };
  }, [autosave]);

  // The note changed elsewhere (import): shown unless the user is editing or a save is on its way.
  useEffect(() => {
    if (!editor || editor.isFocused || !autosave.idle()) return;
    if ((editor.isEmpty ? '' : editor.getHTML()) !== note.html) editor.commands.setContent(note.html, { emitUpdate: false });
  }, [editor, autosave, note.html]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
        <NoteTitle key={note.id} note={note} />
        <SaveIndicator status={status} error={error} onRetry={() => void autosave.flush()} />
        <div className="flex items-center gap-1">
          {actions(() => {
            void autosave.flush();
            return editor ? { ...note, html: editor.isEmpty ? '' : editor.getHTML() } : note;
          })}
        </div>
      </header>
      <div
        className="flex min-h-0 flex-1 flex-col"
        onFocus={() => onEditingChange(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onEditingChange(false);
        }}
      >
        {editor && <Toolbar editor={editor} />}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" onClick={() => editor?.commands.focus()}>
          <EditorContent editor={editor} className="mx-auto h-full max-w-3xl" />
        </div>
      </div>
    </div>
  );
}
