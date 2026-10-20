import { open } from 'node:fs/promises';
import { Unzip, UnzipInflate, unzipSync, strFromU8 } from 'fflate';
import ts from 'typescript';

export const reactArchiveLimits = Object.freeze({
  compressedBytes: 8 * 1024 * 1024,
  expandedBytes: 16 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  entries: 256,
});

// Bound the read as well as expansion, including a file that grows after stat().
export async function readReactArchive(path) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw Error('Expected a regular ZIP file');
    if (stat.size > reactArchiveLimits.compressedBytes)
      throw Error('Compressed ZIP limit exceeded');
    const bytes = new Uint8Array(reactArchiveLimits.compressedBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return extractReactArchive(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}

export function extractReactArchive(bytes) {
  const limits = reactArchiveLimits;
  if (bytes.length > limits.compressedBytes) throw Error('Compressed ZIP limit exceeded');
  const entries = new Map(),
    names = new Set();
  let declared = 0;
  // Inspect every central-directory entry without allocating any expanded output.
  unzipSync(bytes, {
    filter(entry) {
      if (entries.size >= limits.entries) throw Error('ZIP entry limit exceeded');
      const { name, originalSize, size, compression } = entry;
      if (
        !/^[\w./-]+$/.test(name) ||
        name.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
        names.has(name.toLowerCase())
      )
        throw Error('Invalid export path');
      names.add(name.toLowerCase());
      // The fixture exporter emits TypeScript, CSS, metadata and passive assets.
      // In particular JS/JSX cannot hide an Editor runtime behind a declaration.
      if (!/\.(?:tsx?|css|json|md|svg|png|jpe?g|gif|webp|woff2?)$/.test(name))
        throw Error('Unsupported export file type');
      if (![0, 8].includes(compression)) throw Error('Unsupported ZIP compression');
      declared += originalSize;
      if (originalSize > limits.fileBytes || declared > limits.expandedBytes || size > bytes.length)
        throw Error('Expanded ZIP limit exceeded');
      entries.set(name, entry);
      return false;
    },
  });
  const files = Object.create(null),
    started = new Set(),
    completed = new Set();
  let total = 0;
  const stream = new Unzip((file) => {
    const entry = entries.get(file.name);
    if (
      !entry ||
      started.has(file.name) ||
      file.compression !== entry.compression ||
      (file.originalSize !== undefined && file.originalSize !== entry.originalSize) ||
      (file.size !== undefined && file.size !== entry.size)
    )
      throw Error('ZIP entry mismatch');
    started.add(file.name);
    const chunks = [];
    let length = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      length += chunk.length;
      total += chunk.length;
      if (length > entry.originalSize || length > limits.fileBytes || total > limits.expandedBytes)
        throw Error('Actual ZIP expansion limit exceeded');
      chunks.push(chunk);
      if (final) {
        if (length !== entry.originalSize) throw Error('ZIP expanded size mismatch');
        const output = new Uint8Array(length);
        let offset = 0;
        for (const part of chunks) {
          output.set(part, offset);
          offset += part.length;
        }
        files[file.name] = output;
        completed.add(file.name);
      }
    };
    file.start();
  });
  stream.register(UnzipInflate);
  // Small input chunks bound temporary inflater output even if ZIP size fields lie.
  for (let at = 0; at < bytes.length; at += 256)
    stream.push(bytes.subarray(at, at + 256), at + 256 >= bytes.length);
  if (!entries.size || completed.size !== entries.size) throw Error('Incomplete ZIP archive');
  for (const [name, data] of Object.entries(files)) {
    if (!/\.(?:tsx?|css)$/.test(name)) continue;
    const source = strFromU8(data);
    if (source.includes('@editor-platform/')) throw Error('Editor runtime dependency');
    if (/\.tsx?$/.test(name)) {
      const scanner = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        ts.LanguageVariant.JSX,
        source,
      );
      for (
        let token = scanner.scan();
        token !== ts.SyntaxKind.EndOfFileToken;
        token = scanner.scan()
      )
        if (
          (token === ts.SyntaxKind.StringLiteral ||
            token === ts.SyntaxKind.NoSubstitutionTemplateLiteral) &&
          scanner.getTokenValue().includes('@editor-platform/')
        )
          throw Error('Editor runtime dependency');
    }
  }
  return files;
}
