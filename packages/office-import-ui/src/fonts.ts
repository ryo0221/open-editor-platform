import { prepareOfficeFonts, type OfficeFontManifest } from '@editor-platform/office-adapters';
import { installBrowserOfficeFonts } from '@editor-platform/office-adapters/browser';
export async function installImportFonts(manifestUrl: string, signal: AbortSignal) {
  const response = await fetch(manifestUrl, { credentials: 'omit', signal });
  if (!response.ok) throw Error('Fixed preview fonts could not be loaded');
  const manifest = (await response.json()) as OfficeFontManifest;
  if (
    manifest.id !== 'noto-cjk-jp-2.004' ||
    !Array.isArray(manifest.faces) ||
    manifest.faces.length !== 2
  )
    throw Error('Unexpected import font profile');
  const files = await Promise.all(
    manifest.faces.map(async (face) => {
      const response = await fetch(new URL(face.file, manifestUrl), {
        credentials: 'omit',
        signal,
      });
      if (!response.ok || !response.body) throw Error('Fixed preview font could not be loaded');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.length;
          if (length > 24 * 1024 * 1024) throw Error('Font file exceeds the profile limit');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      const out = new Uint8Array(length);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    }),
  );
  return installBrowserOfficeFonts(await prepareOfficeFonts(manifest, files), signal);
}
