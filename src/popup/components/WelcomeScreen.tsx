import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ModuleDefinition } from '../../modules/registry';
import type { ModuleUi } from '../../modules/ui';

interface Props {
  modules: readonly ModuleDefinition[];
  ui: Map<string, ModuleUi>;
  /** First use: "Commencer"; reopened from the help icon: "Fermer". */
  firstUse: boolean;
  onDone: () => void;
}

export function WelcomeScreen({ modules, ui, firstUse, onDone }: Props) {
  return (
    <section aria-labelledby="welcome-title" className="space-y-5 p-4">
      <div className="space-y-2 text-center">
        <ShieldCheck className="mx-auto size-10 text-primary" aria-hidden />
        <h1 id="welcome-title" className="text-lg font-semibold">Bienvenue sur LeakZero</h1>
        <p className="text-sm text-muted-foreground">Protégez vos informations sensibles pendant vos lives.</p>
      </div>
      <ul className="space-y-3">
        {modules.map((module) => {
          const Icon = ui.get(module.id)!.Icon;
          return (
            <li key={module.id} className="flex gap-3 rounded-lg border bg-card p-3">
              <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium">{module.title}</p>
                {module.description && <p className="text-xs text-muted-foreground">{module.description}</p>}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        Chaque protection s’active séparément. La détection n’est pas garantie instantanée : vérifiez toujours votre aperçu avant de diffuser.
      </p>
      <Button className="w-full" onClick={onDone}>{firstUse ? 'Commencer' : 'Fermer'}</Button>
    </section>
  );
}
