import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import { parse } from 'yaml';
import manifest from './manifest.config';
import { validateModuleDeclaration } from './src/modules/schema';
import { iconExists, iconExportName } from './src/modules/icons';

const MODULES_DIR = fileURLToPath(new URL('./src/modules', import.meta.url));
const ICONS_MODULE = 'virtual:leakzero-module-icons';

/**
 * Converts `*.yaml` imports to JSON modules at build time (no YAML parser ships in the extension) and
 * validates every `module.yaml`, so an invalid declaration fails `pnpm build`/`pnpm dev` with its path.
 */
function moduleYaml(): Plugin {
  return {
    name: 'leakzero-module-yaml',
    // Imports only the Lucide icons the declarations name, instead of the whole icon set.
    resolveId: (id) => (id === ICONS_MODULE ? `\0${ICONS_MODULE}` : null),
    load(id) {
      if (id !== `\0${ICONS_MODULE}`) return null;
      const names = new Set<string>();
      for (const entry of readdirSync(MODULES_DIR, { withFileTypes: true })) {
        const file = join(MODULES_DIR, entry.name, 'module.yaml');
        if (!entry.isDirectory() || !existsSync(file)) continue;
        this.addWatchFile(file);
        const icon = (parse(readFileSync(file, 'utf8')) as { icon?: unknown } | null)?.icon;
        if (typeof icon === 'string' && iconExists(icon)) names.add(icon);
      }
      const icons = [...names].map((name) => [name, iconExportName(name)] as const);
      return [
        `import { ${icons.map(([, exported]) => exported).join(', ')} } from 'lucide-react';`,
        `export default { ${icons.map(([name, exported]) => `${JSON.stringify(name)}: ${exported}`).join(', ')} };`,
      ].join('\n');
    },
    transform(code, id) {
      const file = id.split('?')[0];
      if (!file.endsWith('.yaml')) return null;
      const data: unknown = parse(code);
      if (basename(file) === 'module.yaml') {
        const componentsDir = join(dirname(file), 'components');
        const components = existsSync(componentsDir)
          ? readdirSync(componentsDir).filter((name) => name.endsWith('.tsx')).map((name) => name.slice(0, -4))
          : [];
        validateModuleDeclaration(data, file, { directory: basename(dirname(file)), components, iconExists });
      }
      return { code: `export default ${JSON.stringify(data)};`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [moduleYaml(), react(), tailwindcss(), crx({ manifest, contentScripts: { standaloneFiles: ['src/content/index.ts'] } })],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { environment: 'node', setupFiles: ['tests/setup.ts'] },
});
