// Which note the Notes page shows. It follows the conversation open on Snapchat, except:
// - while the editor has the focus, a change is kept pending and applied when it loses it;
// - once the user picks a note, following stops until "Reprendre le suivi".

export interface FollowState {
  selectedId: string | null;
  following: boolean;
  editing: boolean;
  /** Note of the last conversation detected while editing. */
  pendingId: string | null;
}

export type FollowEvent =
  /** The active conversation changed; `noteId` is null when it has no note outside the trash. */
  | { type: 'active'; noteId: string | null }
  | { type: 'select'; noteId: string }
  | { type: 'resume'; noteId: string | null }
  | { type: 'focus' }
  | { type: 'blur' };

export function initialFollow(selectedId: string | null): FollowState {
  return { selectedId, following: true, editing: false, pendingId: null };
}

export function follow(state: FollowState, event: FollowEvent): FollowState {
  switch (event.type) {
    case 'active':
      if (!state.following || event.noteId === null) return state;
      return state.editing ? { ...state, pendingId: event.noteId } : { ...state, selectedId: event.noteId };
    case 'select':
      return { ...state, selectedId: event.noteId, following: false, pendingId: null };
    case 'resume':
      return { ...state, selectedId: event.noteId ?? state.selectedId, following: true, pendingId: null };
    case 'focus':
      return { ...state, editing: true };
    case 'blur':
      return { ...state, editing: false, pendingId: null, selectedId: state.following && state.pendingId ? state.pendingId : state.selectedId };
  }
}
