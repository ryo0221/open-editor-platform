/** Bounded UTF-8 adapters, not general-purpose format compatibility promises. */
export interface ParserLimits {
  rows: number;
  columns: number;
  depth: number;
  vertices: number;
}

export function* parseCsv(text: string, limits: ParserLimits): Generator<string[]> {
  let row: string[] = [],
    field = '',
    state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let active = false,
    records = 0;
  const cell = () => {
    if (row.length >= limits.columns) throw new Error('column-limit');
    row.push(field);
    field = '';
    state = 'start';
  };
  for (let i = 0; i < text.length; i++) {
    if (!active && row.length === 0 && state === 'start' && records > limits.rows)
      throw new Error('row-limit');
    if (state === 'start' && row.length >= limits.columns) throw new Error('column-limit');
    const c = text[i];
    active = true;
    if (state === 'quoted') {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else state = 'closed';
      } else field += c;
      continue;
    }
    if (c === ',') {
      cell();
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r') {
        if (text[i + 1] !== '\n') throw new Error('csv-lone-cr');
        i++;
      }
      cell();
      records++;
      yield row;
      row = [];
      active = false;
      continue;
    }
    if (state === 'closed') throw new Error('csv-after-quote');
    if (c === '"') {
      if (state !== 'start') throw new Error('csv-quote');
      state = 'quoted';
    } else {
      state = 'plain';
      field += c;
    }
  }
  if (state === 'quoted') throw new Error('csv-unclosed-quote');
  if (active || row.length) {
    cell();
    records++;
    yield row;
  }
  if (!records) throw new Error('csv-header');
}

/** Parses incrementally so depth/row/vertex overflow stops before the remaining values. */
export function parseGeoJson(text: string, limits: ParserLimits): unknown {
  let cursor = 0,
    vertices = 0;
  const space = () => {
    while (/[\t\n\r ]/.test(text[cursor] ?? 'x')) cursor++;
  };
  const fail = (): never => {
    throw new Error('geojson-syntax');
  };
  function string(): string {
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (text[cursor++] === '"') {
        try {
          return JSON.parse(text.slice(start, cursor)) as string;
        } catch {
          return fail();
        }
      }
    }
    return fail();
  }
  function value(depth: number, key = '', inCoordinates = false): unknown {
    if (depth > limits.depth) throw new Error('depth-limit');
    space();
    const c = text[cursor];
    if (c === '"') return string();
    if (c === '[') {
      cursor++;
      space();
      const coordinates = inCoordinates || key === 'coordinates';
      if (coordinates && text[cursor] !== '[' && text[cursor] !== ']') {
        vertices++;
        if (vertices > limits.vertices) throw new Error('vertex-limit');
      }
      const result: unknown[] = [];
      if (text[cursor] === ']') {
        cursor++;
        return result;
      }
      while (cursor < text.length) {
        if (key === 'features' && result.length >= limits.rows) throw new Error('row-limit');
        result.push(value(depth + 1, '', coordinates));
        space();
        if (text[cursor] === ']') {
          cursor++;
          return result;
        }
        if (text[cursor++] !== ',') return fail();
      }
      return fail();
    }
    if (c === '{') {
      cursor++;
      space();
      const result: Record<string, unknown> = {};
      if (text[cursor] === '}') {
        cursor++;
        return result;
      }
      let count = 0;
      while (cursor < text.length) {
        if (++count > limits.columns) throw new Error('column-limit');
        space();
        if (text[cursor] !== '"') return fail();
        const name = string();
        if (['__proto__', 'constructor', 'prototype', 'toJSON'].includes(name))
          throw new Error('reserved-json-key');
        if (Object.hasOwn(result, name)) throw new Error('duplicate-json-key');
        space();
        if (text[cursor++] !== ':') return fail();
        result[name] = value(depth + 1, name);
        space();
        if (text[cursor] === '}') {
          cursor++;
          return result;
        }
        if (text[cursor++] !== ',') return fail();
      }
      return fail();
    }
    for (const [word, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(word, cursor)) {
        cursor += word.length;
        return result;
      }
    }
    const start = cursor;
    while (cursor < text.length && !/[\t\r\n ,}\]]/.test(text[cursor])) cursor++;
    const token = text.slice(start, cursor);
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return fail();
    // Overflow remains a row diagnostic; it is never emitted into accepted native content.
    return Number(token);
  }
  const result = value(0);
  space();
  if (cursor !== text.length) return fail();
  return result;
}
