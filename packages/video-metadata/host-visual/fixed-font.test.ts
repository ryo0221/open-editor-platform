import { expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { loadFixedFontAsset, readFixedFontAsset, assertFixedText } from './fixed-font';
const signal = () => new AbortController().signal;
it('retains exact existing font, glyph manifest and notice; rejects mutation and fallback glyphs', async () => {
  const root = 'apps/playground/public/office-fonts';
  let hostedNotice = readFileSync(path.join(root, 'COPYRIGHT.txt'));
  vi.stubGlobal('fetch', async (url: URL) => {
    const filename = path.basename(url.pathname);
    const data =
      filename === 'COPYRIGHT.txt' ? hostedNotice : readFileSync(path.join(root, filename));
    return new Response(new Uint8Array(data));
  });
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

    // The public a9e7083 snapshot supplied this original notice for saved Video assets.
    hostedNotice = readFileSync(
      new URL('./fixtures/noto-cjk-original-notice.txt', import.meta.url),
    );
    files['COPYRIGHT.txt'] = hostedNotice;
    const archived = zipSync(files, { level: 0, mtime: new Date(1980, 0, 1) });
    const reopened = await readFixedFontAsset(archived, plan, signal());
    expect(Buffer.from(reopened.notice)).toEqual(hostedNotice);
    await expect(
      loadFixedFontAsset('https://local.test/office-fonts/manifest.json', 'regular', signal()),
    ).rejects.toThrow('notice mismatch');
  } finally {
    vi.unstubAllGlobals();
  }
});
