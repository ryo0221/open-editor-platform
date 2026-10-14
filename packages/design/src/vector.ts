import type { Bounds } from '@editor-platform/editor-core';

/** Portable path geometry and attribution. Hosts supply the original licensed paths. */
export interface DesignVector {
  viewBox: Bounds;
  paths: string[];
  provenance: { source: string; name: string; version: string; license: string };
}
export const designVectorLimits = { paths: 128, pathCharacters: 16384, totalCharacters: 65536 };
const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };
/** Accept SVG path commands/numbers only, with complete argument groups and finite coordinates. */
function validPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path.trim() || path.length > designVectorLimits.pathCharacters)
    return false;
  const tokens: string[] = [];
  const pattern = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  let end = 0;
  for (const match of path.matchAll(pattern)) {
    const gap = path.slice(end, match.index);
    if (
      !/^[ \t\r\n]*,?[ \t\r\n]*$/.test(gap) ||
      (gap.includes(',') &&
        (!tokens.length || /^[A-Za-z]$/.test(tokens.at(-1)!) || /^[A-Za-z]$/.test(match[0])))
    )
      return false;
    tokens.push(match[0]);
    end = match.index + match[0].length;
  }
  if (!/^[ \t\r\n]*$/.test(path.slice(end)) || !/^[Mm]$/.test(tokens[0] ?? '')) return false;
  for (let i = 0; i < tokens.length; ) {
    const command = tokens[i++].toUpperCase();
    if (command === 'Z') continue;
    const count = arity[command];
    if (!count) return false;
    let argumentsRead = 0;
    while (i < tokens.length && !/^[A-Za-z]$/.test(tokens[i])) {
      const index = argumentsRead % count;
      if (command === 'A' && (index === 3 || index === 4)) {
        // Flags are single grammar characters, even beside another flag or a coordinate.
        if (!['0', '1'].includes(tokens[i][0])) return false;
        const rest = tokens[i].slice(1);
        if (rest) tokens[i] = rest;
        else i++;
      } else {
        const number = Number(tokens[i]);
        if (!Number.isFinite(number) || Math.abs(number) > 1_000_000) return false;
        if (command === 'A' && index < 2 && number < 0) return false;
        i++;
      }
      argumentsRead++;
    }
    if (!argumentsRead || argumentsRead % count !== 0) return false;
  }
  return true;
}
/** XML 1.0 Char production, including paired supplementary Unicode characters. */
function validXmlText(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (
      !(
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      )
    )
      return false;
  }
  return true;
}
function validPaths(paths: unknown): paths is string[] {
  if (!Array.isArray(paths) || !paths.length || paths.length > designVectorLimits.paths)
    return false;
  let characters = 0;
  for (let i = 0; i < paths.length; i++) {
    if (!Object.hasOwn(paths, i) || !validPath(paths[i])) return false;
    characters += paths[i].length;
    if (characters > designVectorLimits.totalCharacters) return false;
  }
  return true;
}
function jsonRecord(value: unknown): value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
export function validDesignVector(value: unknown): value is DesignVector {
  if (
    !jsonRecord(value) ||
    !['viewBox', 'paths', 'provenance'].every((key) => Object.hasOwn(value, key))
  )
    return false;
  const v = value as DesignVector;
  return (
    jsonRecord(v.viewBox) &&
    ['x', 'y', 'width', 'height'].every((key) => Object.hasOwn(v.viewBox, key)) &&
    [v.viewBox.x, v.viewBox.y, v.viewBox.width, v.viewBox.height].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1_000_000,
    ) &&
    v.viewBox.width > 0 &&
    v.viewBox.height > 0 &&
    validPaths(v.paths) &&
    jsonRecord(v.provenance) &&
    ['source', 'name', 'version', 'license'].every((key) => {
      const text = v.provenance[key as keyof DesignVector['provenance']];
      return (
        Object.hasOwn(v.provenance, key) &&
        typeof text === 'string' &&
        !!text.trim() &&
        text.length <= 256 &&
        validXmlText(text)
      );
    })
  );
}
