import { fictionMapLimits as limits } from './limits';
import { fail, pointer } from './result';

/** Bounded lexical preflight, including decoded duplicate keys, before JSON.parse. */
export function readJson(
  input: string | Uint8Array,
  budget: { inputBytes: number; values: number; depth: number } = limits,
): unknown {
  let text: string;
  if (typeof input === 'string') {
    // A code unit consumes at least one UTF-8 byte. Bound allocation before encoding.
    if (input.length > budget.inputBytes)
      fail('input-byte-limit', '', { limit: budget.inputBytes, actual: input.length });
    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = input.charCodeAt(++i);
        if (!(d >= 0xdc00 && d <= 0xdfff)) fail('invalid-json', '');
      } else if (c >= 0xdc00 && c <= 0xdfff) fail('invalid-json', '');
    }
    const size = new TextEncoder().encode(input).length;
    if (size > budget.inputBytes)
      fail('input-byte-limit', '', { limit: budget.inputBytes, actual: size });
    text = input;
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > budget.inputBytes)
      fail('input-byte-limit', '', { limit: budget.inputBytes, actual: input.byteLength });
    if (input[0] === 239 && input[1] === 187 && input[2] === 191) fail('invalid-json', '');
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      fail('invalid-json', '');
    }
  } else fail('invalid-data', '');
  if (text.charCodeAt(0) === 0xfeff) fail('invalid-json', '');
  let i = 0,
    values = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[i] ?? '!')) i++;
  };
  const string = (path: string): string => {
    const start = i++;
    if (text[start] !== '"') fail('invalid-json', path);
    for (; i < text.length; i++) {
      if (text[i] === '\\') {
        i++;
        if (text[i] === 'u') i += 4;
        continue;
      }
      if (text[i] === '"') {
        const token = text.slice(start, ++i);
        try {
          return JSON.parse(token) as string;
        } catch {
          fail('invalid-json', path);
        }
      }
    }
    fail('invalid-json', path);
  };
  const value = (depth: number, path: string): void => {
    whitespace();
    if (++values > budget.values) fail('input-structure-limit', path);
    const c = text[i];
    if (c === '{' || c === '[') {
      if (depth > budget.depth) fail('input-structure-limit', path);
      const object = c === '{',
        end = object ? '}' : ']';
      i++;
      whitespace();
      const keys = new Set<string>();
      let index = 0;
      if (text[i] === end) {
        i++;
        return;
      }
      while (i < text.length) {
        let child = pointer(path, index++);
        if (object) {
          whitespace();
          const key = string(path);
          child = pointer(path, key);
          if (keys.has(key)) fail('invalid-json', child);
          keys.add(key);
          whitespace();
          if (text[i++] !== ':') fail('invalid-json', child);
        }
        value(depth + 1, child);
        whitespace();
        if (text[i] === end) {
          i++;
          return;
        }
        if (text[i++] !== ',') fail('invalid-json', path);
      }
      fail('invalid-json', path);
    } else if (c === '"') {
      string(path);
    } else {
      const m = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(i),
      );
      if (!m) fail('invalid-json', path);
      i += m[0].length;
    }
  };
  value(1, '');
  whitespace();
  if (i !== text.length) fail('invalid-json', '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail('invalid-json', '');
  }
}
