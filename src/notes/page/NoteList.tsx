import { useRef } from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Note } from '../model';

interface Props {
  notes: readonly Note[];
  selectedId: string | null;
  /** Note of the conversation open on Snapchat. */
  activeId: string | null;
  /** Reordering is off while searching: positions would not match the full list. */
  reorderable: boolean;
  onSelect: (id: string) => void;
  /** Moves `id` to `index` of the full list. */
  onMove: (id: string, index: number) => void;
}

/** Conversations, reorderable by drag and drop, or Alt+↑/↓ on a focused note. */
export function NoteList({ notes, selectedId, activeId, reorderable, onSelect, onMove }: Props) {
  const dragged = useRef<string | null>(null);
  return (
    <ul className="space-y-0.5" aria-label="Conversations">
      {notes.map((note, index) => (
        <li
          key={note.id}
          data-note={note.id}
          aria-current={note.id === selectedId}
          draggable={reorderable}
          onDragStart={(event) => {
            dragged.current = note.id;
            event.dataTransfer?.setData('text/plain', note.id);
          }}
          onDragOver={(event) => {
            if (reorderable && dragged.current) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragged.current && dragged.current !== note.id) onMove(dragged.current, index);
            dragged.current = null;
          }}
          onDragEnd={() => (dragged.current = null)}
          className={cn('group flex items-center rounded-md', note.id === selectedId ? 'bg-accent' : 'hover:bg-accent/50')}
        >
          {reorderable && <GripVertical className="ml-1 size-3.5 shrink-0 cursor-grab text-muted-foreground opacity-0 group-hover:opacity-100" aria-hidden />}
          <button
            type="button"
            data-select
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-sm"
            aria-keyshortcuts={reorderable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
            onClick={() => onSelect(note.id)}
            onKeyDown={(event) => {
              if (!reorderable || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
              event.preventDefault();
              onMove(note.id, index + (event.key === 'ArrowUp' ? -1 : 1));
            }}
          >
            <span data-note-name className={cn('min-w-0 flex-1 truncate', note.id === selectedId && 'font-medium')}>{note.name}</span>
            {note.id === activeId && (
              <span className="flex shrink-0 items-center gap-1 text-[10px] text-primary" title="Conversation ouverte sur Snapchat">
                <span className="size-1.5 rounded-full bg-primary" aria-hidden /> ouverte
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
