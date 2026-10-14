import names from 'color-name';

/** Portable conversion of the existing native CSS color subset; no DOM parsing. */
export function exportColor(value: string): { hex: string; alpha: number } | undefined {
  if (typeof value !== 'string') return;
  const v = value.trim().toLowerCase();
  if (v === 'none' || v === 'transparent') return { hex: '000000', alpha: 0 };
  let rgba: number[] | undefined;
  if (/^#[a-f0-9]{3,4}$/i.test(v)) rgba = [...v.slice(1)].map((c) => parseInt(c + c, 16));
  else if (/^#[a-f0-9]{6}([a-f0-9]{2})?$/i.test(v))
    rgba = v
      .slice(1)
      .match(/../g)!
      .map((c) => parseInt(c, 16));
  else if (Object.hasOwn(names, v)) rgba = [...names[v]];
  else {
    const match = /^rgba?\(([^)]+)\)$/.exec(v);
    if (!match) return;
    const parts = match[1].split(',').map((s) => s.trim());
    if (
      parts.length < 3 ||
      parts.length > 4 ||
      parts.some((s) => !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(s))
    )
      return;
    rgba = parts.map((s, i) => {
      const n = parseFloat(s);
      return i === 3
        ? Math.max(0, Math.min(1, s.endsWith('%') ? n / 100 : n)) * 255
        : Math.max(0, Math.min(255, s.endsWith('%') ? n * 2.55 : n));
    });
  }
  return {
    hex: rgba
      .slice(0, 3)
      .map((n) => Math.round(n).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase(),
    alpha: (rgba[3] ?? 255) / 255,
  };
}
