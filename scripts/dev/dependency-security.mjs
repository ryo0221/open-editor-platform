import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const pins = () => {
  const manifest = json(resolve(root, 'package.json'));
  return {
    mermaid: manifest.dependencies.mermaid,
    katex: manifest.overrides.katex,
    dompurify: manifest.dependencies.dompurify,
    'pdfjs-dist': manifest.dependencies['pdfjs-dist'],
  };
};

/** A valid top-level pin must not conceal an older workspace or transitive copy. */
export function verifyDependencyLock(lock, expected = pins()) {
  for (const [path, record] of Object.entries(lock.packages)) {
    const name = path.match(/(?:^|\/)node_modules\/(mermaid|katex|dompurify|pdfjs-dist)$/)?.[1];
    if (name && record.version !== expected[name])
      throw Error(
        `Unsafe dependency lock: ${path} is ${record.version}; expected ${expected[name]}`,
      );
  }
  for (const path of ['', 'packages/document', 'packages/office-export-ui']) {
    if (lock.packages[path]?.dependencies?.mermaid !== expected.mermaid)
      throw Error(`Mermaid manifest/lock mismatch: ${path || 'root'}`);
  }
  for (const path of ['', 'packages/review-surfaces']) {
    if (lock.packages[path]?.dependencies?.['pdfjs-dist'] !== expected['pdfjs-dist'])
      throw Error(`PDF.js manifest/lock mismatch: ${path || 'root'}`);
  }
}

export function inspectDependencyModules(ids, expected = pins(), readPackage = json) {
  const packages = new Map();
  let coreMermaid = false;
  for (const raw of ids) {
    const id = raw.replaceAll('\\', '/');
    if (/\/node_modules\/image-size\//.test(id))
      throw Error('Unexpected reachable image-size parser');
    if (/\/node_modules\/pdfjs-dist\/(?:web\/|.*(?:pdf\.sandbox|pdf\.scripting))/.test(id))
      throw Error('Unexpected PDF viewer/scripting runtime');
    if (/\/node_modules\/mermaid\/dist\/mermaid(?:\.esm)?(?:\.min)?\.mjs/.test(id))
      throw Error('Use Mermaid core entry; prebundled dependencies cannot be verified');
    if (/\/node_modules\/mermaid\/dist\/mermaid\.core\.mjs/.test(id)) coreMermaid = true;
    const match = id.match(/^(.*\/node_modules\/(mermaid|katex|dompurify|pdfjs-dist))\//);
    if (!match || packages.has(match[1])) continue;
    const version = readPackage(match[1] + '/package.json').version;
    if (version !== expected[match[2]])
      throw Error(`Unsafe emitted dependency: ${match[2]} ${version}`);
    packages.set(match[1], { name: match[2], version });
  }
  return {
    coreMermaid,
    packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
    imageSizeReachable: false,
    pdfViewerScriptingReachable: false,
  };
}

/** Runs on both application and worker graphs; emitted evidence stays in dist. */
export function dependencySecurity(scope = 'app') {
  return {
    name: 'dependency-security',
    apply: 'build',
    buildStart() {
      verifyDependencyLock(json(resolve(root, 'package-lock.json')));
    },
    generateBundle() {
      const modules = [...this.getModuleIds()].sort();
      const report = inspectDependencyModules(modules);
      this.emitFile({
        type: 'asset',
        fileName:
          scope === 'worker'
            ? `assets/dependency-security-worker-${createHash('sha256').update(modules.join('\n')).digest('hex').slice(0, 12)}.json`
            : 'dependency-security.json',
        source: JSON.stringify(report, null, 2) + '\n',
      });
    },
  };
}
