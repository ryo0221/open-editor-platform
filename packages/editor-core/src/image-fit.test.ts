import { expect, it } from 'vitest';
import { drawingSvg, type Drawing } from './drawing';

for (const fit of ['fit', 'fill'] as const) {
  it(`applies ${fit} inside embedded SVG viewports without changing native source bytes`, () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80" viewBox="0 0 400 80" preserveAspectRatio="none"><text>日本語</text></svg>';
    const src = 'data:image/svg+xml;base64,' + Buffer.from(source).toString('base64');
    const image: Drawing = {
      id: 'image',
      kind: 'image',
      bounds: { x: 0, y: 0, width: 200, height: 200 },
      fill: 'none',
      text: '',
      src,
      imageFit: fit,
    };
    const result = drawingSvg([image], image.bounds);
    const encoded = result.match(/href="data:image\/svg\+xml;base64,([^"]+)"/)![1];
    const rendered = Buffer.from(encoded, 'base64').toString('utf8');
    expect(rendered).toContain(
      `preserveAspectRatio="xMidYMid ${fit === 'fit' ? 'meet' : 'slice'}"`,
    );
    expect(rendered.match(/preserveAspectRatio=/g)).toHaveLength(1);
    expect(rendered).toContain('日本語');
    expect(image.src).toBe(src);
    expect(Buffer.from(image.src!.split(',')[1], 'base64').toString('utf8')).toBe(source);
    expect(drawingSvg([{ ...image, src: 'data:image/png;base64,abc' }], image.bounds)).toContain(
      'href="data:image/png;base64,abc"',
    );
  });
}
