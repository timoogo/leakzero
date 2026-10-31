import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { normalizeSearch as normalize } from '@/lib/utils';
import type { ModuleDefinition } from '../../modules/registry';

/** The search field appears from this many modules. */
export const SEARCH_THRESHOLD = 5;

/** Modules whose title or description contains `query` (case and accent insensitive), order preserved. */
export function filterModules<M extends Pick<ModuleDefinition, 'title' | 'description'>>(modules: readonly M[], query: string): M[] {
  const needle = normalize(query.trim());
  if (!needle) return [...modules];
  return modules.filter((module) => normalize(`${module.title} ${module.description ?? ''}`).includes(needle));
}

export function ModuleSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input type="search" aria-label="Rechercher un module" placeholder="Rechercher un module" className="pl-8" value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
