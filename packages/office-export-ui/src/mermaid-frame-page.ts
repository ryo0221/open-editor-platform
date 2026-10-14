import { prepareOfficeFonts } from '@editor-platform/office-adapters';
import { installBrowserOfficeFonts } from '@editor-platform/office-adapters/browser';
import {
  missingFontGlyphs,
  exportAssetLimits,
  type ExportFontProfile,
} from '@editor-platform/export-core';

// This entry runs only in the trusted, CSP-restricted auxiliary page. Artifact HTML/JS
// is never inserted or executed; Mermaid is parsed in strict mode with SVG text labels.
let busy = false;
window.addEventListener('message', (event) => {
  if (
    event.source !== parent ||
    event.origin !== location.origin ||
    event.data?.type !== 'office-mermaid-render' ||
    busy
  )
    return;
  busy = true;
  const { key, source, manifest, files } = event.data;
  const send = (data: object) => parent.postMessage({ ...data, key }, event.origin);
  void (async () => {
    if (typeof source !== 'string' || source.length > 50000)
      throw Error('Mermaid image rendering supports at most 50,000 source characters');
    // Source/links remain available through the explicit source policy. Diagram image
    // rendering does not honor embedded resource/config instructions or fetch resources.
    if (
      /%%\s*\{|^\s*---|\b(?:img|image|icon)\s*:|\burl\s*\(|@import|\b(?:href|src)\s*=|<\s*(?:script|iframe|object|embed|img|image|foreignObject)\b/im.test(
        source,
      )
    )
      throw Error('Mermaid configuration and external resources require the source policy');
    const fonts = await prepareOfficeFonts(manifest, files);
    if (missingFontGlyphs(source, fonts.profile as ExportFontProfile).length)
      throw Error('The fixed diagram font lacks a required glyph');
    const dispose = await installBrowserOfficeFonts(fonts);
    try {
      await document.fonts.ready;
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
        suppressErrorRendering: true,
        fontFamily: fonts.profile.family,
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        themeVariables: { fontFamily: fonts.profile.family },
        maxTextSize: 50000,
        deterministicIds: true,
        deterministicIDSeed: 'office-diagram',
      });
      if (!(await mermaid.parse(source, { suppressErrors: true })))
        throw Error('Invalid Mermaid syntax');
      const { svg } = await mermaid.render('office-diagram', source);
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml'),
        root = parsed.documentElement;
      if (root.tagName !== 'svg' || parsed.querySelector('parsererror,foreignObject,script,image'))
        throw Error('This diagram cannot be represented as portable SVG text');
      for (const element of root.querySelectorAll('*'))
        for (const attr of [...element.attributes]) {
          if (/^on/i.test(attr.name)) throw Error('Diagram event handlers are not permitted');
          if (/href$/i.test(attr.name) && !attr.value.startsWith('#'))
            throw Error('Diagram links require the source policy');
        }
      const box = (root.getAttribute('viewBox') ?? '').split(/[ ,]+/).map(Number);
      if (box.length !== 4 || !box.every(Number.isFinite)) throw Error('Invalid diagram bounds');
      const width = Math.ceil(box[2]),
        height = Math.ceil(box[3]);
      if (width < 1 || height < 1 || width * height > exportAssetLimits.decodedPixels)
        throw Error('Diagram exceeds the image bounds');
      root.setAttribute('width', String(width));
      root.setAttribute('height', String(height));
      root.removeAttribute('style');
      send({
        type: 'office-mermaid-result',
        result: { svg: new XMLSerializer().serializeToString(root), width, height },
      });
    } finally {
      dispose();
    }
  })().catch((error: unknown) =>
    send({
      type: 'office-mermaid-error',
      message: error instanceof Error ? error.message : 'Mermaid rendering failed',
    }),
  );
});
