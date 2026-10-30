import { icons } from 'lucide-react';

// YAML names icons in kebab-case, as on lucide.dev. Build-time only (vite.config.ts): the popup gets
// just the icons the declarations use, through the `virtual:leakzero-module-icons` module.

/** `phone` → `Phone`, `circle-help` → `CircleHelp`, as in lucide-react's export names. */
export function iconExportName(name: string): string {
  return name.replace(/(^|-)([a-z0-9])/g, (_match, _dash, char: string) => char.toUpperCase());
}

export function iconExists(name: string): boolean {
  return iconExportName(name) in icons;
}
