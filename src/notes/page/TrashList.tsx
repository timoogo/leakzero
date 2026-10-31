import { RotateCcw, Trash2 } from 'lucide-react';
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
import { displayName, type Note } from '../model';

interface Props {
  notes: readonly Note[];
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
}

/** Deleted notes: kept until restored or deleted for good, by hand only. */
export function TrashList({ notes, onRestore, onPurge }: Props) {
  if (notes.length === 0) return <p className="px-2 py-4 text-center text-xs text-muted-foreground">La corbeille est vide.</p>;
  return (
    <ul className="space-y-1" aria-label="Corbeille">
      {notes.map((note) => (
        <li key={note.id} data-note={note.id} className="rounded-md border px-2 py-1.5">
          <p data-note-name className="truncate text-sm">{displayName(note)}</p>
          <p className="text-[11px] text-muted-foreground">Supprimée le {new Date(note.trashedAt!).toLocaleString('fr-FR')}</p>
          <div className="mt-1 flex gap-1">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onRestore(note.id)}><RotateCcw /> Restaurer</Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive"><Trash2 /> Supprimer définitivement</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Supprimer « {displayName(note)} » pour toujours ?</AlertDialogTitle>
                  <AlertDialogDescription>Ses notes seront effacées de cet ordinateur. Exportez-les avant si vous voulez les garder.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Annuler</AlertDialogCancel>
                  <AlertDialogAction onClick={() => onPurge(note.id)}>Supprimer pour toujours</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </li>
      ))}
    </ul>
  );
}
