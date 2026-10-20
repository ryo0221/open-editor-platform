import console from 'node:console';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// Build-time aliases (vite.react-ui.config.ts), not installable packages.
const aliases = new Set(['@reference/product-image', '@reference/dependency-style']);
const importPattern =
  /^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|(?:^|[\s(=,])import\(\s*['"]([^'"]+)['"]\s*\)/gm;
const packageName = (specifier) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(?:m?[jt]sx?)$/.test(entry.name) && !/\.(?:test|spec)\.|\.d\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

/** Bare imports in each workspace's non-test src that its package.json does not declare. */
export function undeclaredImports(root) {
  const found = [];
  for (const group of ['apps', 'packages'])
    for (const name of readdirSync(join(root, group))) {
      const dir = join(root, group, name),
        manifest = join(dir, 'package.json');
      if (!existsSync(manifest) || !existsSync(join(dir, 'src'))) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      const declared = new Set(
        [pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies, pkg.devDependencies]
          .filter(Boolean)
          .flatMap(Object.keys),
      );
      const seen = new Set();
      for (const file of sourceFiles(join(dir, 'src')))
        for (const match of readFileSync(file, 'utf8').matchAll(importPattern)) {
          // Vite query suffixes (?url, ?raw) still load from the named package.
          const specifier = (match[1] ?? match[2] ?? match[3]).replace(/\?.*$/, '');
          if (/^(?:\.|\/|node:|virtual:)/.test(specifier)) continue;
          const dependency = packageName(specifier);
          if (
            dependency === pkg.name ||
            declared.has(dependency) ||
            aliases.has(dependency) ||
            builtinModules.includes(dependency) ||
            seen.has(dependency)
          )
            continue;
          seen.add(dependency);
          found.push({ workspace: pkg.name, dependency, file: relative(root, file) });
        }
    }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = undeclaredImports(process.cwd());
  for (const { workspace, dependency, file } of found)
    console.error(`${workspace} imports undeclared ${dependency} (${file})`);
  if (found.length) process.exit(1);
  console.log('All workspace imports are declared.');
}
