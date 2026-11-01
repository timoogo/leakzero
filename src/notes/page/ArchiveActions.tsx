import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { exportArchive, parseArchive } from '../archive';
import { readSelectedMessages } from '../selected';
import { planImport, type ImportItem, type ImportResolution, type ImportSummary } from '../importing';
import { sendNotesCommand } from '../messages';
import { displayName, type Note } from '../model';
import { downloadFile } from './download';

const CHOICES: { value: ImportResolution; label: string }[] = [
  { value: 'keep', label: 'Conserver l’existante' },
  { value: 'replace', label: 'Remplacer' },
  { value: 'both', label: 'Conserver les deux' },
];

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`;

function ChoiceGroup({ label, value, onChange }: { label: string; value: ImportResolution; onChange: (value: ImportResolution) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border p-0.5">
      {CHOICES.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={value === choice.value}
          aria-label={choice.label}
          className={cn('cursor-pointer rounded px-2 py-1 text-xs', value === choice.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent')}
          onClick={() => onChange(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

interface Props {
  notes: readonly Note[];
  onError: (message: string | null) => void;
  onDone: (message: string) => void;
}

/** "Exporter tout (ZIP)" and "Importer une archive", with the conflicts to resolve before importing. */
export function ArchiveActions({ notes, onError, onDone }: Props) {
  const [includeTrash, setIncludeTrash] = useState(false);
  const [plan, setPlan] = useState<ImportItem[] | null>(null);
  const [global, setGlobal] = useState<ImportResolution>('keep');
  const [overrides, setOverrides] = useState<Record<string, ImportResolution>>({});
  const input = useRef<HTMLInputElement>(null);
  const trashed = notes.filter((note) => note.trashedAt !== null).length;
  const conflicts = plan?.filter((item) => item.conflict) ?? [];

  async function exportAll() {
    const exported = notes.filter((note) => includeTrash || note.trashedAt === null);
    let messages;
    try {
      // Each note gets the messages selected in its own conversation.
      messages = await readSelectedMessages(exported.map((note) => note.conversationId));
    } catch (cause) {
      return onError(`Export annulé : messages sélectionnés illisibles (${cause instanceof Error ? cause.message : String(cause)}).`);
    }
    const zip = exportArchive(exported, { includeTrash, messages });
    downloadFile(`leakzero-notes-${new Date().toISOString().slice(0, 10)}.zip`, new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
  }

  async function read(file: File) {
    onError(null);
    try {
      const imported = parseArchive(new Uint8Array(await file.arrayBuffer()));
      setGlobal('keep');
      setOverrides({});
      setPlan(planImport(imported, notes));
    } catch (error) {
      onError(`Import impossible : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function confirmImport() {
    if (!plan) return;
    const resolutions = Object.fromEntries(conflicts.map((item) => [item.note.id, overrides[item.note.id] ?? global]));
    setPlan(null);
    try {
      const summary = await sendNotesCommand<ImportSummary>({ type: 'notes:import', notes: plan.map((item) => item.note), resolutions });
      onDone(`Import terminé : ${plural(summary.added, 'ajoutée')}, ${plural(summary.replaced, 'remplacée')}, ${plural(summary.skipped, 'conservée')} sans changement.`);
    } catch (error) {
      onError(`Import impossible : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" className="w-full justify-start px-2"><Download /> Exporter tout (ZIP)</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Exporter toutes les fiches</AlertDialogTitle>
            <AlertDialogDescription>Archive ZIP : chaque fiche en HTML et en TXT, et un manifeste de leurs identifiants. Elle peut être réimportée.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="export-trash">Inclure la corbeille ({trashed})</Label>
            <Switch id="export-trash" aria-label="Inclure la corbeille" checked={includeTrash} onCheckedChange={setIncludeTrash} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={() => void exportAll()}>Exporter</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Button variant="ghost" size="sm" className="w-full justify-start px-2" onClick={() => input.current?.click()}><Upload /> Importer une archive</Button>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void read(file);
        }}
      />

      <AlertDialog open={plan !== null} onOpenChange={(open) => !open && setPlan(null)}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Importer des fiches</AlertDialogTitle>
            <AlertDialogDescription>
              {plural(plan?.length ?? 0, 'fiche')} à importer{conflicts.length > 0 && `, dont ${conflicts.length} en conflit avec une fiche existante (même fiche ou même conversation)`}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {conflicts.length > 0 && (
            <div className="space-y-3 text-sm">
              <div className="space-y-1">
                <p className="font-medium">Pour toutes les fiches en conflit</p>
                <ChoiceGroup label="Pour toutes les fiches en conflit" value={global} onChange={setGlobal} />
              </div>
              <ul className="space-y-2 border-t pt-2">
                {conflicts.map(({ note, conflict }) => (
                  <li key={note.id} className="space-y-1">
                    <p className="truncate">
                      {displayName(note)}
                      <span className="text-xs text-muted-foreground"> — existante : {displayName(conflict!)}{conflict!.trashedAt !== null && ' (corbeille)'}</span>
                    </p>
                    <ChoiceGroup label={displayName(note)} value={overrides[note.id] ?? global} onChange={(value) => setOverrides({ ...overrides, [note.id]: value })} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmImport()}>Importer</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
