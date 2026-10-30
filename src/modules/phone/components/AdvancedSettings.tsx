import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import type { ModuleComponentProps } from '../../ui';

// Sample shown in the popup only; it is not a real number.
const SAMPLE = '06 00 00 00 00';

/** Live preview of how a phone number is rendered with the current settings, and what is masked. */
export default function AdvancedSettings({ values, setValue }: ModuleComponentProps) {
  const enabled = values.enabled === true;
  const reinforced = values.reinforced === true;
  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Aperçu</h3>
        <p data-testid="phone-preview" className="rounded-md border bg-background px-3 py-2 text-sm">
          Appelle-moi au{' '}
          {!enabled ? (
            <span>{SAMPLE}</span>
          ) : reinforced ? (
            <span className="rounded-sm bg-black px-1.5 py-0.5 text-xs font-medium text-white">🛡 Numéro masqué</span>
          ) : (
            <span className="blur-[2px]">**********</span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {!enabled ? 'Protection désactivée : le numéro reste visible.' : reinforced ? 'Flou et rectangle noir opaque.' : 'Astérisques floutés.'}
        </p>
      </section>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="phone-advanced-reinforced">Mode renforcé</Label>
        <Switch
          id="phone-advanced-reinforced"
          checked={reinforced}
          disabled={!enabled}
          onCheckedChange={(checked) => setValue('reinforced', checked)}
        />
      </div>
      <section className="space-y-1 text-xs text-muted-foreground">
        <h3 className="text-sm font-medium text-foreground">Ce qui est masqué</h3>
        <p>Téléphones (internationaux, mobiles français, numéros nationaux de votre langue) : <code>**********</code>.</p>
        <p>Toute autre suite de 3 chiffres ou plus : <code>•••</code>.</p>
        <p>Restent visibles : dates, heures, années, âges, prix et montants.</p>
        <p>Champs de saisie et zones éditables ne sont jamais modifiés.</p>
      </section>
    </div>
  );
}
