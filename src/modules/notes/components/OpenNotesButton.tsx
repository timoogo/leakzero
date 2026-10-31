import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openNotesWindow } from '../../../notes/window';
import type { ModuleComponentProps } from '../../ui';

/** Opens the floating Notes window, or brings it to the front (src/notes/window.ts). */
export default function OpenNotesButton({ values }: ModuleComponentProps) {
  const [error, setError] = useState<string | null>(null);
  if (values.enabled !== true) return null;
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => {
          setError(null);
          openNotesWindow().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
        }}
      >
        <ExternalLink /> Ouvrir Notes
      </Button>
      {error && <p role="alert" className="text-xs text-destructive">Impossible d’ouvrir Notes : {error}</p>}
    </div>
  );
}
