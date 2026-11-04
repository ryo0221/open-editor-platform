import { fileURLToPath, URL } from 'node:url';

const id = 'virtual:playground-manga-tools';
// A consuming-Host preset, not a Design schema or always-shipped dependency.
export function playgroundMangaSample(
  sampleModule = fileURLToPath(
    new URL('../../apps/playground/src/app/samples/manga/layered-art-tools.tsx', import.meta.url),
  ),
) {
  let enabled = false;
  return {
    name: 'playground-manga-sample',
    configResolved(config) {
      enabled = config.env.VITE_MANGA_EXPERIMENT === '1';
    },
    resolveId(source) {
      return source === id ? '\0' + id : undefined;
    },
    load(resolved) {
      if (resolved !== '\0' + id) return;
      // The disabled module has no import edge. This also excludes the sample and
      // CSS when Rollup tree-shaking is disabled in the ordinary build.
      return enabled
        ? `export { LayeredArtTools as MangaArtTools } from ${JSON.stringify(sampleModule)};\n`
        : 'export const MangaArtTools = undefined;\n';
    },
  };
}
