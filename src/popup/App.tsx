import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CircleHelp, Shield, TriangleAlert, X } from 'lucide-react';
import { Accordion } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { modules as registeredModules, type ModuleDefinition } from '../modules/registry';
import type { SettingValue } from '../modules/schema';
import { bindModuleUi, componentFiles as registeredComponents, type ModuleComponent } from '../modules/ui';
import { settingKey, StorageKeys } from '../shared/keys';
import { initialValues, initializeState, isModuleActive, moduleValues, stringList } from '../shared/state';
import { AdvancedView } from './components/AdvancedView';
import { ModuleAccordion } from './components/ModuleAccordion';
import { filterModules, ModuleSearch, SEARCH_THRESHOLD } from './components/ModuleSearch';
import { WelcomeScreen } from './components/WelcomeScreen';
import { useStorage } from './useStorage';

type View = { name: 'main' } | { name: 'help' } | { name: 'advanced'; moduleId: string };

interface Props {
  /** Injectable for tests (fixtures); defaults to the modules discovered under src/modules/. */
  modules?: readonly ModuleDefinition[];
  componentFiles?: Record<string, ModuleComponent>;
}

export default function App({ modules = registeredModules, componentFiles = registeredComponents }: Props) {
  const ui = useMemo(() => bindModuleUi(modules, componentFiles), [modules, componentFiles]);
  // Idempotent: normally done by the service worker on install/update; also adds modules a dev reload brought.
  const { items, ready, error, write, dismissError } = useStorage(() => initializeState(modules, 'update'));
  const [view, setView] = useState<View>({ name: 'main' });
  const [query, setQuery] = useState('');
  const mainScroll = useRef(0);

  // The main view is unmounted while another view is shown: restore its scroll position on return.
  useLayoutEffect(() => {
    if (view.name === 'main' && document.scrollingElement) document.scrollingElement.scrollTop = mainScroll.current;
  }, [view]);

  if (!ready) return <main className="min-h-40 w-[340px]" aria-busy="true" />;

  function navigate(next: View) {
    if (view.name === 'main') mainScroll.current = document.scrollingElement?.scrollTop ?? 0;
    setView(next);
  }

  const onboarded = items[StorageKeys.onboarded] === true;
  const openSections = stringList(items[StorageKeys.openSections]);
  const newModules = stringList(items[StorageKeys.newModules]);
  const setValue = (module: ModuleDefinition) => (settingId: string, value: SettingValue) => write({ [settingKey(module.id, settingId)]: value });

  function onSectionsChange(next: string[]) {
    const opened = next.filter((id) => !openSections.includes(id));
    // A module stops being "Nouveau" the first time it is opened.
    const stillNew = newModules.filter((id) => !opened.includes(id));
    write({ [StorageKeys.openSections]: next, ...(stillNew.length !== newModules.length && { [StorageKeys.newModules]: stillNew }) });
  }

  const errorBanner = error && (
    <div role="alert" className="mx-4 mt-4 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs">
      <span className="flex-1">{error}</span>
      <button type="button" aria-label="Fermer le message" className="cursor-pointer text-muted-foreground" onClick={dismissError}><X className="size-3.5" /></button>
    </div>
  );

  if (!onboarded || view.name === 'help') {
    return (
      <main className="w-[340px]">
        {errorBanner}
        <WelcomeScreen
          modules={modules}
          ui={ui}
          firstUse={!onboarded}
          onDone={() => {
            write({ [StorageKeys.onboarded]: true });
            navigate({ name: 'main' });
          }}
        />
      </main>
    );
  }

  const advancedModule = view.name === 'advanced' ? modules.find((module) => module.id === view.moduleId) : undefined;
  if (advancedModule) {
    return (
      <main className="w-[340px]">
        {errorBanner}
        <AdvancedView
          module={advancedModule}
          ui={ui.get(advancedModule.id)!}
          values={moduleValues(items, advancedModule)}
          onChange={setValue(advancedModule)}
          onBack={() => navigate({ name: 'main' })}
        />
      </main>
    );
  }

  const anyActive = modules.some((module) => isModuleActive(items, module));
  const visible = modules.length >= SEARCH_THRESHOLD ? filterModules(modules, query) : modules;

  return (
    <main className="w-[340px]">
      <header className="flex items-center justify-between px-4 pt-4">
        <h1 className="flex items-center gap-2 text-lg font-semibold"><Shield className="size-5 text-primary" aria-hidden /> LeakZero</h1>
        <Button variant="ghost" size="icon" aria-label="Aide" title="Aide" onClick={() => navigate({ name: 'help' })}>
          <CircleHelp />
        </Button>
      </header>
      {errorBanner}
      <div className="space-y-3 p-4">
        {!anyActive && (
          <p role="status" className="flex items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden /> Aucune protection active
          </p>
        )}
        {modules.length >= SEARCH_THRESHOLD && <ModuleSearch value={query} onChange={setQuery} />}
        <div className="rounded-xl border bg-card px-4">
          <Accordion type="multiple" value={openSections} onValueChange={onSectionsChange}>
            {visible.map((module) => (
              <ModuleAccordion
                key={module.id}
                module={module}
                ui={ui.get(module.id)!}
                values={moduleValues(items, module)}
                active={isModuleActive(items, module)}
                isNew={newModules.includes(module.id)}
                onChange={setValue(module)}
                onOpenAdvanced={() => navigate({ name: 'advanced', moduleId: module.id })}
                onReset={() => write(initialValues(module))}
              />
            ))}
          </Accordion>
          {visible.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">Aucun module ne correspond à « {query} ».</p>}
        </div>
        <p className="text-xs text-muted-foreground">
          Protection au mieux : certains contenus (iframes isolées, canvas, Shadow DOM fermé, images CSS) ne peuvent pas être masqués.
          Vérifiez toujours votre aperçu avant de diffuser.
        </p>
      </div>
    </main>
  );
}
