import { useCallback, useEffect, useRef, useState } from 'react';
import type { StorageItems } from '../shared/state';

export interface StorageState {
  /** Mirror of chrome.storage.local, updated optimistically by `write` and by changes from other contexts. */
  items: StorageItems;
  ready: boolean;
  error: string | null;
  /** Saves immediately in a single chrome.storage.local.set (atomic); unchanged keys are not written. */
  write: (patch: StorageItems) => void;
  dismissError: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the popup in sync with chrome.storage.local. Content scripts react to the same writes through
 * chrome.storage.onChanged, so what the popup shows is what the tabs apply.
 *
 * While a write of a key is in flight, change events for that key are ignored (they may be stale echoes
 * of earlier keystrokes); once its last write settles, the key is re-read from storage, so a concurrent
 * write from another popup or a failed write never leaves the interface out of sync.
 */
export function useStorage(initialize: () => Promise<void>): StorageState {
  const [items, setItems] = useState<StorageItems>({});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const pending = useRef(new Map<string, number>());

  const reconcile = useCallback(async (keys: string[]) => {
    const fresh = await chrome.storage.local.get(keys);
    setItems((previous) => {
      const next = { ...previous };
      for (const key of keys) {
        if (pending.current.get(key)) continue;
        if (key in fresh) next[key] = fresh[key];
        else delete next[key];
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let active = true;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      const external = Object.entries(changes).filter(([key]) => !pending.current.get(key));
      if (external.length === 0) return;
      setItems((previous) => {
        const next = { ...previous };
        for (const [key, change] of external) {
          if (change.newValue === undefined) delete next[key];
          else next[key] = change.newValue;
        }
        return next;
      });
    };
    chrome.storage.onChanged.addListener(onChanged);
    initialize()
      .catch((cause: unknown) => setError(`Initialisation du stockage impossible : ${errorMessage(cause)}`))
      .then(() => chrome.storage.local.get(null))
      .then((all) => {
        if (!active) return;
        setItems(all);
        setReady(true);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(`Lecture des réglages impossible : ${errorMessage(cause)}`);
        setReady(true);
      });
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
    // `initialize` runs once per popup opening.
  }, []);

  const write = useCallback((patch: StorageItems) => {
    const changed = Object.fromEntries(
      Object.entries(patch).filter(([key, value]) => JSON.stringify(itemsRef.current[key]) !== JSON.stringify(value)),
    );
    const keys = Object.keys(changed);
    if (keys.length === 0) return;
    itemsRef.current = { ...itemsRef.current, ...changed };
    setItems((previous) => ({ ...previous, ...changed }));
    for (const key of keys) pending.current.set(key, (pending.current.get(key) ?? 0) + 1);
    chrome.storage.local
      .set(changed)
      .then(
        () => setError(null),
        (cause: unknown) => setError(`Échec de l’enregistrement : ${errorMessage(cause)}. Les réglages affichés ont été rétablis.`),
      )
      .finally(() => {
        for (const key of keys) pending.current.set(key, pending.current.get(key)! - 1);
        const settled = keys.filter((key) => !pending.current.get(key));
        if (settled.length > 0) {
          reconcile(settled).catch((cause: unknown) => setError(`Lecture des réglages impossible : ${errorMessage(cause)}`));
        }
      });
  }, [reconcile]);

  const dismissError = useCallback(() => setError(null), []);

  return { items, ready, error, write, dismissError };
}
