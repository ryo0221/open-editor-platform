import { describe, it, expect } from 'vitest';
import { drawingSvg, layoutTextRuns, normalizedRuns, textPrimitives, type Drawing } from './index';

describe('canvas rich text and common export layout', () => {
  it('renders inherited decorations per run so explicit false overrides can remove them', () => {
    const drawing: Drawing = {
      id: 'inherited',
      kind: 'text',
      text: 'Hello',
      fill: '#000000',
      bounds: { x: 0, y: 0, width: 300, height: 80 },
      typography: { underline: true, strike: true, overflow: 'expand' },
      runs: [
        { text: 'H' },
        { text: 'el', style: { underline: false, strike: false } },
        { text: 'lo' },
      ],
    };
    const text = textPrimitives(drawing).find((primitive) => primitive.tag === 'text')!;
    expect(text.attrs['text-decoration']).toBe('none');
    const svg = drawingSvg([drawing], drawing.bounds);
    expect(svg).toMatch(/text-decoration="underline line-through"[^>]*>H<\/tspan>/);
    expect(svg).toMatch(/text-decoration="none"[^>]*>el<\/tspan>/);
    expect(svg).toMatch(/text-decoration="underline line-through"[^>]*>lo<\/tspan>/);
  });
  it('omits unbound image slots while retaining configured asset references', () => {
    const image: Drawing = {
      id: 'slot',
      kind: 'image',
      text: '',
      bounds: { x: 0, y: 0, width: 40, height: 40 },
      fill: '#ffffff',
    };
    expect(drawingSvg([image], image.bounds)).not.toContain('<image');
    image.src = 'https://example.test/asset.png';
    expect(drawingSvg([image], image.bounds)).toContain('href="https://example.test/asset.png"');
    expect(image.id).toBe('slot');
  });
  it('keeps complete Japanese/emoji text and marked ranges when wrapping at different sizes', () => {
    const text = '計画🙂を段階的に確認する',
      runs = [
        { text: '計画🙂', style: { bold: true, fontSize: 32 } },
        { text: 'を段階的に', style: { color: '#cc3300', italic: true } },
        { text: '確認する' },
      ];
    const lines = layoutTextRuns(text, runs, 80, { fontSize: 18 });
    expect(
      lines
        .flatMap((l) => l.runs)
        .map((r) => r.text)
        .join(''),
    ).toBe(text);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0].ascent).toBe(32);
    const drawing: Drawing = {
      id: 'rich',
      kind: 'text',
      bounds: { x: 0, y: 0, width: 100, height: 300 },
      fill: '#000000',
      text,
      runs,
    };
    const svg = drawingSvg([drawing], drawing.bounds);
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('font-style="italic"');
    expect(svg).toContain('fill="#cc3300"');
    expect(svg).toContain('🙂');
  });
  it('discards stale formatting over changed plain text and isolates normalized runs', () => {
    const runs = [{ text: 'before', style: { bold: true } }];
    expect(normalizedRuns('after', runs)).toEqual([{ text: 'after' }]);
    const copy = normalizedRuns('before', runs);
    copy[0].style!.bold = false;
    expect(runs[0].style.bold).toBe(true);
  });
});
