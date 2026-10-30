import type { ComponentType } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { isDisabled, isVisible } from '../../modules/conditions';
import type { SettingDefinition, SettingType, SettingValue } from '../../modules/schema';

interface ControlProps<S extends SettingDefinition> {
  id: string;
  setting: S;
  value: SettingValue;
  disabled: boolean;
  onChange: (value: SettingValue) => void;
}

type Controls = { [T in SettingType]: ComponentType<ControlProps<Extract<SettingDefinition, { type: T }>>> };

// One control per setting type of schema.ts; adding a type means adding its schema and an entry here.
const CONTROLS: Controls = {
  switch: ({ id, value, disabled, onChange }) => (
    <Switch id={id} checked={value === true} disabled={disabled} onCheckedChange={onChange} />
  ),
  select: ({ id, setting, value, disabled, onChange }) => (
    <Select value={String(value)} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>
        {setting.options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  ),
  slider: ({ id, setting, value, disabled, onChange }) => (
    <div className="flex items-center gap-3">
      <Slider
        id={id}
        min={setting.min}
        max={setting.max}
        step={setting.step}
        value={[Number(value)]}
        disabled={disabled}
        aria-label={setting.label}
        onValueChange={([next]) => onChange(next)}
      />
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{value}{setting.unit}</span>
    </div>
  ),
  input: ({ id, setting, value, disabled, onChange }) => (
    <Input id={id} value={String(value)} placeholder={setting.placeholder} maxLength={setting.maxLength} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
  ),
  textarea: ({ id, setting, value, disabled, onChange }) => (
    <Textarea id={id} value={String(value)} placeholder={setting.placeholder} maxLength={setting.maxLength} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
  ),
};

interface Props {
  moduleId: string;
  settings: readonly SettingDefinition[];
  values: Record<string, SettingValue>;
  onChange: (settingId: string, value: SettingValue) => void;
}

/** Form generated from YAML declarations; dependencies grey out or hide settings, never change their value. */
export function ModuleSettings({ moduleId, settings, values, onChange }: Props) {
  return (
    <div className="space-y-4">
      {settings.filter((setting) => isVisible(setting, values)).map((setting) => {
        const id = `${moduleId}-${setting.id}`;
        const disabled = isDisabled(setting, values);
        const Control = CONTROLS[setting.type] as ComponentType<ControlProps<SettingDefinition>>;
        const control = <Control id={id} setting={setting} value={values[setting.id]} disabled={disabled} onChange={(value) => onChange(setting.id, value)} />;
        const text = (
          <div className="min-w-0 space-y-1">
            <Label htmlFor={id}>{setting.label}</Label>
            {setting.description && <p className="text-xs text-muted-foreground">{setting.description}</p>}
          </div>
        );
        return (
          <div
            key={setting.id}
            data-setting={setting.id}
            className={cn(
              setting.type === 'switch' ? 'flex items-center justify-between gap-4' : 'space-y-2',
              !setting.primary && (setting.disabledWhen || setting.requires) && 'border-l-2 pl-3',
              disabled && 'opacity-50',
            )}
          >
            {text}
            {control}
          </div>
        );
      })}
    </div>
  );
}
