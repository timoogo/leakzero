import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ModuleDefinition } from '../../modules/registry';
import type { SettingValue } from '../../modules/schema';
import type { ModuleUi } from '../../modules/ui';
import { ModuleSettings } from './ModuleSettings';

interface Props {
  module: ModuleDefinition;
  ui: ModuleUi;
  values: Record<string, SettingValue>;
  onChange: (settingId: string, value: SettingValue) => void;
  onBack: () => void;
}

export function AdvancedView({ module, ui, values, onChange, onBack }: Props) {
  const { Icon, AdvancedComponent } = ui;
  return (
    <section aria-labelledby="advanced-title" className="space-y-4 p-4">
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="Retour" onClick={onBack} autoFocus>
          <ArrowLeft />
        </Button>
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <h1 id="advanced-title" className="truncate text-base font-semibold">{module.title}</h1>
          <p className="text-xs text-muted-foreground">{module.advanced?.title ?? 'Paramètres avancés'}</p>
        </div>
      </header>
      {module.advanced?.settings && <ModuleSettings moduleId={module.id} settings={module.advanced.settings} values={values} onChange={onChange} />}
      {AdvancedComponent && <AdvancedComponent module={module} values={values} setValue={onChange} />}
    </section>
  );
}
