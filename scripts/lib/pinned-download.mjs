import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

export async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyPinnedFile(path, pin) {
  const info = await stat(path);
  if (info.size !== pin.bytes || (await fileDigest(path)) !== pin.sha256)
    throw Error(
      `SHA-256/size mismatch: ${path}. Keep the expected checksum; remove the invalid downloaded file and retry.`,
    );
}

/** Never expose partial or unverified bytes at the destination. */
export async function downloadPinned(pin, path, fetcher) {
  try {
    await verifyPinnedFile(path, pin);
    return 'cached';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = await mkdtemp(join(dirname(path), '.download-'));
  try {
    const partial = join(temporary, 'content');
    // Node 20 fetch does not honor the standard proxy variables. curl preserves
    // the cloud's HTTPS proxy/authentication and CA configuration without reading credentials.
    const useProxy =
      !fetcher &&
      ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some(
        (key) => process.env[key],
      );
    if (useProxy) {
      await promisify(execFile)('curl', [
        '--disable',
        '--fail',
        '--location',
        '--silent',
        '--show-error',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--retry',
        '2',
        '--max-time',
        '180',
        '--max-filesize',
        String(pin.bytes),
        '--output',
        partial,
        pin.url,
      ]);
    } else {
      const response = await (fetcher ?? globalThis.fetch)(pin.url, {
        signal: globalThis.AbortSignal.timeout(180_000),
      });
      if (!response.ok || !response.body)
        throw Error(`Download failed (${response.status}): ${pin.url}`);
      const handle = await open(partial, 'wx');
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > pin.bytes) throw Error(`Download exceeds the pinned size: ${pin.url}`);
          await handle.writeFile(chunk);
        }
      } finally {
        await handle.close();
      }
    }
    await verifyPinnedFile(partial, pin);
    try {
      await link(partial, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await verifyPinnedFile(path, pin);
    }
    return 'downloaded';
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
