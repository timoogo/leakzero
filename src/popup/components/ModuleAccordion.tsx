import { ChevronRight, SlidersHorizontal } from 'lucide-react';
import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ModuleDefinition } from '../../modules/registry';
import type { SettingValue } from '../../modules/schema';
import type { ModuleUi } from '../../modules/ui';
import { ModuleSettings } from './ModuleSettings';
import { ResetModuleButton } from './ResetModuleButton';

interface Props {
  module: ModuleDefinition;
  ui: ModuleUi;
  values: Record<string, SettingValue>;
  active: boolean;
  isNew: boolean;
  onChange: (settingId: string, value: SettingValue) => void;
  onOpenAdvanced: () => void;
  onReset: () => void;
}

/** One module: informative header (state, "Nouveau"), every control inside. */
export function ModuleAccordion({ module, ui, values, active, isNew, onChange, onOpenAdvanced, onReset }: Props) {
  const { Icon, Component } = ui;
  return (
    <AccordionItem value={module.id} data-module={module.id}>
      <AccordionTrigger>
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate">{module.title}</span>
              {isNew && <Badge>Nouveau</Badge>}
            </span>
            {module.description && <span className="line-clamp-2 block text-xs font-normal text-muted-foreground">{module.description}</span>}
          </span>
          <span
            data-testid="module-status"
            className={cn('flex shrink-0 items-center gap-1.5 text-xs font-normal', active ? 'text-primary' : 'text-muted-foreground')}
          >
            <span className={cn('size-1.5 rounded-full', active ? 'bg-primary' : 'bg-muted-foreground/60')} aria-hidden />
            {active ? 'Actif' : 'Inactif'}
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent className="space-y-4">
        <ModuleSettings moduleId={module.id} settings={module.settings} values={values} onChange={onChange} />
        {Component && <Component module={module} values={values} setValue={onChange} />}
        <div className="-mx-2 space-y-1 border-t pt-2">
          {module.advanced && (
            <Button variant="ghost" size="sm" className="w-full justify-between px-2" onClick={onOpenAdvanced}>
              <span className="flex items-center gap-2"><SlidersHorizontal /> Paramètres avancés</span>
              <ChevronRight className="text-muted-foreground" />
            </Button>
          )}
          <ResetModuleButton title={module.title} onConfirm={onReset} />
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}
