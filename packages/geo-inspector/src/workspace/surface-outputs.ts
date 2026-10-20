import type { GeoAsset } from '@editor-platform/geo-core';
import { createGeoPng, type GeoPngBundle } from './png';
import type { GeoSurfaceContext } from './surface-context';
import { parseGeoNumber } from './surface-dom';
import { guardedDownloadLink } from './surface-map';

const panel = (ctx: GeoSurfaceContext, legend: string) => {
  const set = ctx.kit.node('fieldset');
  set.append(ctx.kit.node('legend', legend));
  ctx.el.root.append(set);
  return set;
};

async function inspectPhotos(ctx: GeoSurfaceContext, a: GeoAsset) {
  for (const p of a.photos) {
    const bytes = ctx.host.photo(p.sourceId);
    const image = ctx.kit.node('img');
    const source = ctx.open().snapshot.content.sources.find((s) => s.id === p.sourceId);
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], {
        type: source?.format === 'png' ? 'image/png' : 'image/jpeg',
      }),
    );
    ctx.urls.add(url);
    image.src = url;
    image.alt = p.name;
    image.width = 160;
    ctx.el.downloads.append(image);
    await image.decode();
  }
}

export function buildGeoAssetPanel(ctx: GeoSurfaceContext) {
  const { kit, host, state } = ctx;
  const assetPanel = panel(ctx, 'Selected asset inspection');
  const assetId = kit.input(assetPanel, 'Asset ID'),
    inspectionDate = kit.input(assetPanel, 'Inspection date'),
    accuracy = kit.input(assetPanel, 'Location accuracy (meters)'),
    notes = kit.textArea(assetPanel, 'Asset notes'),
    photoFile = kit.input(assetPanel, 'Local inspection photo', '', 'file');
  photoFile.accept = 'image/png,image/jpeg';
  const asset = (): GeoAsset => {
    const selected = state.selected;
    if (!selected) throw Error('Select an asset feature');
    const old = ctx
      .workspace()
      .assets.find((a) => a.layerId === selected.layerId && a.featureId === selected.featureId);
    return {
      ...selected,
      assetId: assetId.value,
      inspectedAt: inspectionDate.value,
      accuracyMeters: accuracy.value.trim() ? parseGeoNumber(accuracy.value) : null,
      notes: notes.value,
      photos: old?.photos ?? [],
    };
  };
  ctx.button(assetPanel, 'Save asset inspection', () => {
    const a = asset(),
      w = ctx.workspace();
    w.assets = [
      ...w.assets.filter((x) => x.layerId !== a.layerId || x.featureId !== a.featureId),
      a,
    ];
    return ctx.mutate([{ type: 'setWorkspace', workspace: w }]);
  });
  ctx.button(assetPanel, 'Attach selected local photo', async () => {
    ctx.requireClean();
    const target = asset(),
      stamp = host.stamp();
    const file = photoFile.files?.[0];
    if (!file || file.size > 100000) throw Error('Choose a local PNG/JPEG up to 100,000 bytes');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (host.stamp() !== stamp) throw Error('Photo input changed');
    return host.attachPhoto(target, bytes, file.name);
  });
  ctx.button(assetPanel, 'Inspect retained photos', async () => inspectPhotos(ctx, asset()));
  return { assetId, inspectionDate, accuracy, notes };
}

function appendPngDownloads(ctx: GeoSurfaceContext, bundle: GeoPngBundle, stamp: string) {
  for (const [blob, name, label] of [
    [
      new Blob([new Uint8Array(bundle.bytes)], { type: 'image/png' }),
      'map.png',
      'Download fixed PNG',
    ],
    [
      new Blob([JSON.stringify(bundle.receipt, null, 2)], { type: 'application/json' }),
      'map.receipt.json',
      'Download PNG receipt',
    ],
  ] as const) {
    const url = URL.createObjectURL(blob),
      a = guardedDownloadLink(
        ctx,
        label,
        url,
        name,
        () => ctx.host.stamp() === stamp && ctx.urls.has(url),
      );
    ctx.el.downloads.append(a, ctx.kit.node('br'));
  }
}

async function generatePng(
  ctx: GeoSurfaceContext,
  pngView: HTMLSelectElement,
  pngWidth: HTMLInputElement,
  pngHeight: HTMLInputElement,
) {
  const { host, state } = ctx;
  ctx.requireClean();
  ctx.retire();
  const generation = state.outputGeneration,
    viewId = pngView.value;
  const pixels: [number, number] = [
    parseGeoNumber(pngWidth.value),
    parseGeoNumber(pngHeight.value),
  ];
  const check = () => {
    if (generation !== state.outputGeneration || host.stamp() !== stamp)
      throw Error('PNG scope changed');
  };
  const stamp = host.stamp(),
    capture = await host.capture();
  check();
  const bundle = await createGeoPng(ctx.doc, capture, viewId, pixels, host.budgets, check);
  check();
  state.png = { bundle, stamp };
  appendPngDownloads(ctx, bundle, stamp);
  ctx.el.status.textContent = 'PNG and provenance receipt ready.';
}

async function placePngOnSlide(ctx: GeoSurfaceContext) {
  const { host, state } = ctx;
  const issued = state.png;
  if (!issued || host.stamp() !== issued.stamp)
    throw Error('Generate an authorized fixed PNG first');
  const artifact = await host.placeOnSlide(issued.bundle);
  if (state.png !== issued || host.stamp() !== issued.stamp)
    throw Error('Slide transfer scope changed');
  const url = URL.createObjectURL(new Blob([artifact.text], { type: 'application/json' })),
    link = guardedDownloadLink(
      ctx,
      'Download Slide with fixed map image',
      url,
      artifact.name,
      () => ctx.urls.has(url) && host.stamp() === issued.stamp,
    );
  ctx.el.downloads.append(
    link,
    ctx.kit.node(
      'p',
      'Open the downloaded native file in Slide. The fixed PNG and its provenance receipt are retained in the slide image and notes.',
    ),
  );
}

export function buildGeoImageExportPanel(ctx: GeoSurfaceContext) {
  const { kit } = ctx;
  const imageExport = panel(ctx, 'Fixed PNG and Slide image');
  const pngView = kit.select(imageExport, 'PNG saved view', []),
    pngWidth = kit.input(imageExport, 'PNG width', '960'),
    pngHeight = kit.input(imageExport, 'PNG height', '600');
  imageExport.append(
    kit.node(
      'p',
      'PNG uses the explicitly selected saved native version and named view. Source bytes, hidden attributes, inspection notes and photos are omitted. Export native to preserve all data. Download the receipt alongside the image.',
    ),
  );
  ctx.button(imageExport, 'Generate fixed PNG', () =>
    generatePng(ctx, pngView, pngWidth, pngHeight),
  );
  ctx.button(imageExport, 'Place PNG on Slide', () => placePngOnSlide(ctx));
  imageExport.append(ctx.el.downloads);
  return { pngView };
}
