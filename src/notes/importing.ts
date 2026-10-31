import { noteKey } from './keys';
import { MAX_NAME_LENGTH, type Note } from './model';

/** What to do with an imported note that conflicts with an existing one. */
export type ImportResolution = 'keep' | 'replace' | 'both';

export interface ImportItem {
  note: Note;
  /** Existing note with the same id or, failing that, following the same conversation. */
  conflict: Note | null;
}

export function planImport(imported: readonly Note[], existing: readonly Note[]): ImportItem[] {
  return imported.map((note) => ({
    note,
    conflict: existing.find((other) => other.id === note.id)
      ?? (note.conversationId === null ? undefined : existing.find((other) => other.conversationId === note.conversationId))
      ?? null,
  }));
}

const copyName = (name: string) => `${name.slice(0, MAX_NAME_LENGTH - 17)} (copie importée)`;

/**
 * The writes of an import. A conflict is kept unless `resolutions` says otherwise: nothing is
 * overwritten silently. "replace" keeps the existing note's id and conversation; "both" adds a copy with
 * a new id, tied to its conversation only if no other note follows it, so a conversation never has two
 * notes.
 */
export function applyImport(
  imported: readonly Note[],
  existing: readonly Note[],
  resolutions: Readonly<Record<string, ImportResolution>>,
  newId: () => string,
) {
  const patch: Record<string, Note> = {};
  const followed = new Set(existing.flatMap((note) => (note.conversationId ? [note.conversationId] : [])));
  const summary = { added: 0, replaced: 0, skipped: 0 };
  for (const { note, conflict } of planImport(imported, existing)) {
    if (!conflict) {
      patch[noteKey(note.id)] = note;
      if (note.conversationId) followed.add(note.conversationId);
      summary.added++;
      continue;
    }
    switch (resolutions[note.id] ?? 'keep') {
      case 'keep':
        summary.skipped++;
        break;
      case 'replace':
        patch[noteKey(conflict.id)] = { ...note, id: conflict.id, conversationId: conflict.conversationId };
        summary.replaced++;
        break;
      case 'both': {
        const id = newId();
        const conversationId = note.conversationId && !followed.has(note.conversationId) ? note.conversationId : null;
        if (conversationId) followed.add(conversationId);
        patch[noteKey(id)] = { ...note, id, conversationId, name: copyName(note.name) };
        summary.added++;
        break;
      }
    }
  }
  return { patch, summary };
}

export type ImportSummary = ReturnType<typeof applyImport>['summary'];
