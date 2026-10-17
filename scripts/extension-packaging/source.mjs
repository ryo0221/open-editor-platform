// Only tracked regular-file bytes from an explicit full commit pin enter a stage.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function pinnedSource(repo, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Full explicit source commit required');
  const git = (args) => execFileSync('git', args, { cwd: repo, maxBuffer: 32 * 1024 * 1024 });
  if (
    git(['rev-parse', `${commit}^{commit}`])
      .toString()
      .trim() !== commit
  )
    throw new Error('Commit pin mismatch');
  const entries = git(['ls-tree', '-r', '-z', commit]).toString().split('\0').filter(Boolean);
  const files = new Map(
    entries.map((entry) => {
      const [header, name] = entry.split('\t');
      const [mode, kind, blob] = header.split(' ');
      return [name, { mode, kind, blob }];
    }),
  );
  const read = (name) => {
    const entry = files.get(name);
    if (!entry || entry.kind !== 'blob' || !['100644', '100755'].includes(entry.mode))
      throw new Error('Not a tracked regular file: ' + name);
    return git(['cat-file', 'blob', entry.blob]);
  };
  return {
    read,
    async stage(prefix, destination) {
      const hashes = {};
      for (const name of [...files.keys()].sort()) {
        if (!name.startsWith(prefix + '/') || /\.(test|spec)\.tsx?$/.test(name)) continue;
        const bytes = read(name),
          target = path.join(destination, name.slice(prefix.length + 1));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
        hashes[name] = digest(bytes);
      }
      return hashes;
    },
  };
}
export function dependencyClosure(manifest, manifests) {
  const visiting = new Set(),
    result = new Set();
  const visit = (name) => {
    if (visiting.has(name)) throw new Error('Dependency cycle: ' + name);
    if (result.has(name)) return;
    const dependency = manifests.get(name);
    if (!dependency) throw new Error('Non-reviewed dependency: ' + name);
    visiting.add(name);
    for (const child of Object.keys(dependency.dependencies ?? {})) visit(child);
    visiting.delete(name);
    result.add(name);
  };
  for (const name of Object.keys(manifest.dependencies ?? {})) visit(name);
  return [...result];
}
export function checkPublicImport(specifier, manifest, manifests) {
  if (specifier.startsWith('.')) return;
  const dependency = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  const key = specifier === dependency ? '.' : './' + specifier.slice(dependency.length + 1);
  if (
    (dependency !== manifest.name && !Object.hasOwn(manifest.dependencies ?? {}, dependency)) ||
    !Object.hasOwn(manifests.get(dependency)?.exports ?? {}, key)
  )
    throw new Error('Private/undeclared import: ' + specifier);
}
export function auditTypeImports(text, file, manifest, manifests, sourceRoot) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const checkName = (specifier) => {
    if (specifier.startsWith('.')) {
      if (
        !path.resolve(path.dirname(file), specifier).startsWith(path.resolve(sourceRoot) + path.sep)
      )
        throw new Error('Private source escape: ' + specifier);
    } else checkPublicImport(specifier, manifest, manifests);
  };
  const check = (literal) => {
    if (literal && ts.isStringLiteralLike(literal)) checkName(literal.text);
  };
  for (const reference of source.typeReferenceDirectives) checkName(reference.fileName);
  for (const reference of source.referencedFiles) checkName(reference.fileName);
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) check(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      check(node.moduleReference.expression);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      check(node.argument.literal);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      check(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(source);
}
