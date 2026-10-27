import { expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { loadFixedFontAsset, readFixedFontAsset, assertFixedText } from './fixed-font';
const signal = () => new AbortController().signal;
it('retains exact existing font, glyph manifest and notice; rejects mutation and fallback glyphs', async () => {
  vi.stubGlobal(
    'fetch',
    async (url: URL) =>
      new Response(
        new Uint8Array(
          readFileSync(
            path.join('apps/playground/public/office-fonts', path.basename(url.pathname)),
          ),
        ),
      ),
  );
  try {
    const { bytes, plan } = await loadFixedFontAsset(
      'https://local.test/office-fonts/manifest.json',
      'regular',
      signal(),
    );
    const decoded = await readFixedFontAsset(bytes, plan, signal());
    expect(
      Buffer.from(decoded.font).equals(
        readFileSync('apps/playground/public/office-fonts/NotoSansCJKjp-Regular.otf'),
      ),
    ).toBe(true);
    expect(
      Buffer.from(decoded.notice).equals(
        readFileSync('apps/playground/public/office-fonts/COPYRIGHT.txt'),
      ),
    ).toBe(true);
    expect(() => assertFixedText('日本語タイトル\n明示改行', decoded.manifest)).not.toThrow();
    expect(() => assertFixedText('未知\u{10ffff}', decoded.manifest)).toThrow('missing glyph');
    const files = unzipSync(bytes);
    files['COPYRIGHT.txt'][0] ^= 1;
    await expect(
      readFixedFontAsset(zipSync(files, { level: 0, mtime: new Date(1980, 0, 1) }), plan, signal()),
    ).rejects.toThrow('notice mismatch');
    await expect(
      readFixedFontAsset(bytes, { ...plan, weight: 'bold' }, signal()),
    ).rejects.toThrow();
  } finally {
    vi.unstubAllGlobals();
  }
});
