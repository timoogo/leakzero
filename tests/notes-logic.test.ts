import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosave, type SaveStatus } from '../src/notes/autosave';
import { follow, initialFollow, type FollowState } from '../src/notes/follow';
import { filterByName, listedNotes, moveNote, trashedNotes } from '../src/notes/list';
import type { Note } from '../src/notes/model';

function note(id: string, extra: Partial<Note> = {}): Note {
  return { id, conversationId: null, name: id, html: '', createdAt: 0, updatedAt: 0, lastSeenAt: 0, trashedAt: null, customName: null, ...extra };
}

describe('note list', () => {
  const notes = [
    note('a', { name: 'Élodie', lastSeenAt: 10 }),
    note('b', { name: 'Bob', lastSeenAt: 30 }),
    note('c', { name: 'Chloé', updatedAt: 20 }),
    note('t', { name: 'Trashed', lastSeenAt: 99, trashedAt: 5 }),
  ];

  it('sorts by recent activity (opened on Snapchat or edited), without the trash', () => {
    expect(listedNotes(notes, null).map((n) => n.id)).toEqual(['b', 'c', 'a']);
  });

  it('follows the manual order, new notes first, ignoring unknown and trashed ids', () => {
    expect(listedNotes(notes, ['a', 'gone', 't', 'b']).map((n) => n.id)).toEqual(['c', 'a', 'b']);
  });

  it('searches conversation names only, case and accent insensitive', () => {
    const withContent = [...notes, note('d', { name: 'Zoé', html: '<p>elodie</p>' })];
    expect(filterByName(listedNotes(withContent, null), ' ELO ').map((n) => n.id)).toEqual(['a']);
    expect(filterByName(listedNotes(withContent, null), '').map((n) => n.id)).toHaveLength(4);
  });

  it('moves a note to another position', () => {
    expect(moveNote(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveNote(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(moveNote(['a', 'b', 'c'], 'a', 9)).toEqual(['b', 'c', 'a']);
    expect(moveNote(['a', 'b'], 'x', 0)).toEqual(['a', 'b']);
  });

  it('lists the trash, most recently deleted first', () => {
    expect(trashedNotes([note('x', { trashedAt: 1 }), note('y', { trashedAt: 3 }), note('z')]).map((n) => n.id)).toEqual(['y', 'x']);
  });
});

describe('following the Snapchat conversation', () => {
  const run = (state: FollowState, ...events: Parameters<typeof follow>[1][]) => events.reduce(follow, state);

  it('selects the note of the active conversation by default', () => {
    expect(initialFollow('a')).toEqual({ selectedId: 'a', following: true, editing: false, pendingId: null });
    expect(run(initialFollow('a'), { type: 'active', noteId: 'b' }).selectedId).toBe('b');
  });

  it('does not switch notes while the editor has the focus, then applies the last change on blur', () => {
    const state = run(initialFollow('a'), { type: 'focus' }, { type: 'active', noteId: 'b' }, { type: 'active', noteId: 'c' });
    expect(state.selectedId).toBe('a');
    expect(run(state, { type: 'blur' })).toMatchObject({ selectedId: 'c', editing: false, pendingId: null });
  });

  it('suspends following when the user picks a note, until "Reprendre le suivi"', () => {
    const manual = run(initialFollow('a'), { type: 'select', noteId: 'x' }, { type: 'active', noteId: 'b' });
    expect(manual).toMatchObject({ selectedId: 'x', following: false });
    expect(run(manual, { type: 'focus' }, { type: 'active', noteId: 'c' }, { type: 'blur' }).selectedId).toBe('x');
    expect(run(manual, { type: 'resume', noteId: 'c' })).toMatchObject({ selectedId: 'c', following: true });
  });

  it('keeps the selection when the active conversation has no usable note (in the trash)', () => {
    expect(run(initialFollow('a'), { type: 'active', noteId: null }).selectedId).toBe('a');
    expect(run(initialFollow('a'), { type: 'select', noteId: 'x' }, { type: 'resume', noteId: null })).toMatchObject({ selectedId: 'x', following: true });
  });

  it('drops a pending change when the user picks a note while editing', () => {
    const state = run(initialFollow('a'), { type: 'focus' }, { type: 'active', noteId: 'b' }, { type: 'select', noteId: 'x' }, { type: 'blur' });
    expect(state.selectedId).toBe('x');
  });
});

describe('autosave', () => {
  let statuses: SaveStatus[];
  let save: ReturnType<typeof vi.fn<(html: string) => Promise<void>>>;
  beforeEach(() => {
    vi.useFakeTimers();
    statuses = [];
    save = vi.fn(async () => undefined);
  });
  afterEach(() => vi.useRealTimers());
  const autosave = () => createAutosave({ save, delay: 300, onStatus: (status) => statuses.push(status) });

  it('saves the last content 300 ms after the last change', async () => {
    const saver = autosave();
    saver.change('<p>a</p>');
    await vi.advanceTimersByTimeAsync(200);
    saver.change('<p>ab</p>');
    await vi.advanceTimersByTimeAsync(299);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledExactlyOnceWith('<p>ab</p>');
    expect(statuses).toEqual(['dirty', 'dirty', 'saving', 'saved']);
  });

  it('saves immediately on flush (note switch, window closing)', async () => {
    const saver = autosave();
    saver.change('<p>a</p>');
    await saver.flush();
    expect(save).toHaveBeenCalledExactlyOnceWith('<p>a</p>');
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('stays dirty when the content changes during a save, and saves it next', async () => {
    let finish!: () => void;
    save.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const saver = autosave();
    saver.change('<p>a</p>');
    await vi.advanceTimersByTimeAsync(300);
    saver.change('<p>ab</p>');
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('dirty');
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenLastCalledWith('<p>ab</p>');
    expect(statuses.at(-1)).toBe('saved');
  });

  it('reports a failure and keeps the content to retry', async () => {
    save.mockRejectedValueOnce(new Error('QUOTA'));
    const saver = autosave();
    saver.change('<p>a</p>');
    await vi.advanceTimersByTimeAsync(300);
    expect(statuses.at(-1)).toBe('error');
    expect(saver.pending()).toBe(true);
    await saver.flush();
    expect(save).toHaveBeenLastCalledWith('<p>a</p>');
    expect(statuses.at(-1)).toBe('saved');
  });
});
