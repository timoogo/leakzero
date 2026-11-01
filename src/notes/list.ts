import { normalizeSearch } from '@/lib/utils';
import { displayName, lastActivity, type Note } from './model';

const byActivity = (a: Note, b: Note) => lastActivity(b) - lastActivity(a) || displayName(a).localeCompare(displayName(b));

/**
 * The notes outside the trash, as the list shows them: by recent activity, or in the manual `order`
 * once the user has reordered them. Notes created since (not in `order`) come first.
 */
export function listedNotes(notes: readonly Note[], order: readonly string[] | null): Note[] {
  const active = notes.filter((note) => note.trashedAt === null);
  if (!order) return active.sort(byActivity);
  const rank = new Map(order.map((id, index) => [id, index]));
  const unranked = active.filter((note) => !rank.has(note.id)).sort(byActivity);
  const ranked = active.filter((note) => rank.has(note.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...unranked, ...ranked];
}

export function trashedNotes(notes: readonly Note[]): Note[] {
  return notes.filter((note) => note.trashedAt !== null).sort((a, b) => b.trashedAt! - a.trashedAt!);
}

/** Notes whose custom title or conversation name contains `query`; the content is never searched. */
export function filterByName(notes: readonly Note[], query: string): Note[] {
  const needle = normalizeSearch(query.trim());
  return needle ? notes.filter((note) => [note.customName, note.name].some((name) => name !== null && normalizeSearch(name).includes(needle))) : [...notes];
}

/** `ids` with `id` moved to position `to`. */
export function moveNote(ids: readonly string[], id: string, to: number): string[] {
  if (!ids.includes(id)) return [...ids];
  const rest = ids.filter((other) => other !== id);
  rest.splice(Math.min(Math.max(to, 0), rest.length), 0, id);
  return rest;
}
