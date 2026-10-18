import { expect, it } from 'vitest';
import { inspectGeoPhoto } from './photo';
const png = (w: number, h: number) => {
  const b = new Uint8Array(24);
  b.set([137, 80, 78, 71, 13, 10, 26, 10]);
  b.set([73, 72, 68, 82], 12);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
it('refuses pixel/byte bombs, truncated headers and active formats before image decoding', () => {
  expect(inspectGeoPhoto(png(2, 3))).toEqual({ format: 'png', width: 2, height: 3 });
  for (const bytes of [
    png(0, 3),
    png(2049, 1),
    png(2048, 2048),
    new Uint8Array(100001),
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    png(2, 3).slice(0, 20),
  ])
    expect(() => inspectGeoPhoto(bytes)).toThrow();
});
it('reads bounded baseline/progressive JPEG dimensions and rejects truncated segments', () => {
  const b = new Uint8Array(24);
  b.set([255, 216, 255, 194, 0, 8, 8, 0, 3, 0, 2, 1]);
  expect(inspectGeoPhoto(b)).toEqual({ format: 'jpeg', width: 2, height: 3 });
  b[5] = 100;
  expect(() => inspectGeoPhoto(b)).toThrow('segment length');
});
