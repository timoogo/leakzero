import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Bold, Heading2, Heading3, Italic, Link2, List, ListOrdered, Underline } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { createAutosave, type SaveStatus } from '../autosave';
import { linkTarget, noteExtensions } from '../content';
import { sendNotesCommand } from '../messages';
import type { Note } from '../model';

/** Inactivity before a change is saved. */
export const SAVE_DELAY_MS = 300;

const STATUS_LABELS: Record<SaveStatus, string> = {
  saved: 'Sauvegardé',
  dirty: 'Modification en cours…',
  saving: 'Sauvegarde…',
  error: 'Erreur de sauvegarde',
};

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

export function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  return (
    <span data-save-status role="status" className={cn('flex items-center gap-2 text-xs', status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
      {STATUS_LABELS[status]}
      {status === 'error' && <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onRetry}>Réessayer</Button>}
    </span>
  );
}

interface Props {
  note: Note;
  /** Rendered in the header, next to the save state. */
  actions: ReactNode;
}

/**
 * Editor of one note (mounted per note: `key={note.id}`). Saves SAVE_DELAY_MS after the last change,
 * and at once when the note is left or the window closed, so a pending change is never lost.
 */
export function NoteEditor({ note, actions }: Props) {
  const [status, setStatus] = useState<SaveStatus>('saved');
  const autosave = useMemo(
    () => createAutosave({ delay: SAVE_DELAY_MS, onStatus: setStatus, save: (html) => sendNotesCommand({ type: 'notes:save', id: note.id, html }) }),
    [note.id],
  );
  const editor = useEditor({
    extensions: noteExtensions,
    content: note.html,
    editorProps: { attributes: { class: 'note-content', 'aria-label': `Notes de ${note.name}` } },
    onUpdate: ({ editor: current }) => autosave.change(current.isEmpty ? '' : current.getHTML()),
  });

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
        <h1 data-note-title className="min-w-0 flex-1 truncate text-lg font-semibold">{note.name}</h1>
        <SaveIndicator status={status} onRetry={() => void autosave.flush()} />
        <div className="flex items-center gap-1">{actions}</div>
      </header>
      {editor && <Toolbar editor={editor} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" onClick={() => editor?.commands.focus()}>
        <EditorContent editor={editor} className="mx-auto h-full max-w-3xl" />
      </div>
    </div>
  );
}
