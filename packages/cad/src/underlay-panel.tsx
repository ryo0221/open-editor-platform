/**
 * #15: drawings laid under views (front, back, right, left, top, bottom), with their scale and
 * origin, kept as image assets of the document; and the deviation of the shown bodies'
 * silhouettes from each drawing's lines, per body in mm with a heat overlay. The numbers come
 * from `underlayDeviation`, which needs no GPU, so a headless run gives the same ones.
 */
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Section } from '@editor-platform/editor-ui';
import {
  cadUnderlayAxes,
  cadUnderlayBox,
  cadUnderlayLimits,
  cadUnderlayViews,
  type CadUnderlay,
  type CadUnderlayView,
} from '@editor-platform/cad-core';
import type { CadController, CadSnapshot } from './controller';
import {
  underlayDeviation,
  underlayHeatImage,
  type CadUnderlayDeviation,
  type CadUnderlayImage,
} from './underlay-deviation';
import type { CadViewport, CadViewportUnderlay } from './viewport';

const viewLabel: Record<CadUnderlayView, string> = {
  front: 'Front',
  back: 'Back',
  right: 'Right',
  left: 'Left',
  top: 'Top',
  bottom: 'Bottom',
};
const mm = (v: number) => (Number.isFinite(v) ? `${v.toFixed(2)} mm` : '—');

/** A decoded image: drawn on a canvas, with its RGBA for the deviation check. */
interface Decoded {
  canvas: HTMLCanvasElement;
  image: CadUnderlayImage;
}
async function decode(bytes: Uint8Array, mediaType: string): Promise<Decoded> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mediaType }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
  return { canvas, image: { width: canvas.width, height: canvas.height, data } };
}
function heatCanvas(d: CadUnderlayDeviation, toleranceMm: number) {
  const canvas = document.createElement('canvas');
  canvas.width = d.width;
  canvas.height = d.height;
  const rgba = underlayHeatImage(d, toleranceMm);
  canvas
    .getContext('2d')!
    .putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, d.width, d.height), 0, 0);
  return canvas;
}

export function UnderlaysSection({
  controller,
  snapshot,
  view,
  shown,
  editable,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
  view: RefObject<CadViewport | null>;
  /** Bodies drawn in the viewport now: the ones the check measures. */
  shown: ReadonlySet<string>;
  editable: boolean;
}) {
  const doc = snapshot.content;
  const list = useMemo(() => doc.underlays ?? [], [doc.underlays]);
  const [decoded, setDecoded] = useState<ReadonlyMap<string, Decoded>>(new Map());
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [addView, setAddView] = useState<CadUnderlayView>('front');
  const [addScale, setAddScale] = useState('1');
  const [note, setNote] = useState('');
  const [tolerance, setTolerance] = useState('1');
  const [results, setResults] = useState<
    ReadonlyMap<string, { contentHash: string; shown: string; result: CadUnderlayDeviation }>
  >(new Map());
  const [heatOn, setHeatOn] = useState(true);

  // Decode each underlay's image once (by asset), from the bytes the Host keeps.
  useEffect(() => {
    let live = true;
    for (const u of list) {
      const asset = doc.assets.find((a) => a.id === u.assetId);
      if (!asset || decoded.has(asset.sha256) || failed.has(asset.sha256)) continue;
      const bytes = controller.assetBytes(asset.sha256);
      if (!bytes) {
        setFailed((f) => new Set([...f, asset.sha256]));
        continue;
      }
      decode(bytes, asset.mediaType).then(
        (d) => live && setDecoded((m) => new Map([...m, [asset.sha256, d]])),
        () => live && setFailed((f) => new Set([...f, asset.sha256])),
      );
    }
    return () => {
      live = false;
    };
  }, [list, doc.assets, controller, decoded, failed]);
  const imageOf = (u: CadUnderlay) => {
    const asset = doc.assets.find((a) => a.id === u.assetId);
    return asset ? decoded.get(asset.sha256) : undefined;
  };
  const tol = Math.max(0.001, Number(tolerance) || 1);
  // A result holds for the content and the shown bodies it compared: hiding a body or changing
  // the named view makes it stale too (Codex on #35).
  const shownKey = [...shown].sort().join('\u0000');
  const current = (r: { contentHash: string; shown: string } | undefined) =>
    !!r && r.contentHash === snapshot.contentHash && r.shown === shownKey;
  const meshes =
    snapshot.meshes?.contentHash === snapshot.contentHash ? snapshot.meshes.meshes : undefined;

  // Draw them in the viewport (again when the model moves, so they stay behind it).
  useEffect(() => {
    const items: CadViewportUnderlay[] = list.flatMap((u) => {
      const d = imageOf(u);
      const r = results.get(u.id);
      const heat = heatOn && r && current(r) ? heatCanvas(r.result, tol) : undefined;
      if (!d && !heat) return [];
      return [
        {
          id: u.id,
          axes: cadUnderlayAxes(u.view),
          box: cadUnderlayBox(u),
          opacity: u.opacity,
          ...(d && !u.hidden ? { image: d.canvas } : {}),
          ...(heat ? { heat } : {}),
        },
      ];
    });
    view.current?.setUnderlays(items);
    // imageOf reads `decoded`
  }, [list, decoded, results, heatOn, tol, snapshot.contentHash, shownKey, meshes, view]);
  useEffect(() => () => view.current?.setUnderlays([]), [view]);

  const change = (id: string, patch: Partial<CadUnderlay>) => {
    const next = list.map((u) => {
      if (u.id !== id) return u;
      const merged = { ...u, ...patch };
      if (patch.hidden === undefined && 'hidden' in patch) delete merged.hidden;
      return merged;
    });
    void controller.setUnderlays(next);
  };
  const lookFrom = (u: CadUnderlay) => {
    const { u: right, v: up, toward } = cadUnderlayAxes(u.view);
    const [u0, v0, u1, v1] = cadUnderlayBox(u);
    const [cu, cv] = [(u0 + u1) / 2, (v0 + v1) / 2];
    const target = [0, 1, 2].map((i) => right[i]! * cu + up[i]! * cv) as [number, number, number];
    const reach = Math.max(u1 - u0, v1 - v0) * 2;
    view.current?.setView({
      camera: {
        position: target.map((t, i) => t + toward[i]! * reach) as [number, number, number],
        target,
        up,
      },
      projection: { type: 'orthographic', spanMm: (v1 - v0) * 1.1 },
    });
  };
  const check = (u: CadUnderlay) => {
    const d = imageOf(u);
    if (!d || !meshes) return;
    try {
      const result = underlayDeviation(u, d.image, meshes, shown);
      setResults(
        (m) =>
          new Map([...m, [u.id, { contentHash: snapshot.contentHash, shown: shownKey, result }]]),
      );
      setNote(
        result.bodies.length
          ? `Compared with ${u.name} (${result.bodies.length} bodies)`
          : `No shown body's outline lies within ${u.name}`,
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };
  const add = async (file: File) => {
    const scale = Number(addScale);
    if (!(scale >= cadUnderlayLimits.minMmPerPixel && scale <= cadUnderlayLimits.maxMmPerPixel))
      return setNote('Check the mm per pixel');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let d: Decoded;
    try {
      d = await decode(bytes, file.type);
    } catch {
      return setNote('The image could not be read (PNG or JPEG)');
    }
    const [w, h] = [d.image.width, d.image.height];
    if (w > cadUnderlayLimits.pixels || h > cadUnderlayLimits.pixels)
      return setNote(`The image is too large (at most ${cadUnderlayLimits.pixels} pixels a side)`);
    // Centred on the origin of the view at first; the origin fields move it.
    const ok = await controller.addUnderlay(
      { bytes, mediaType: file.type },
      {
        name: file.name.replace(/\.[^.]+$/, '') || viewLabel[addView],
        view: addView,
        pixels: [w, h],
        mmPerPixel: scale,
        originMm: [(-w * scale) / 2, (h * scale) / 2],
        opacity: 0.6,
      },
    );
    setNote(ok ? `${file.name} laid under the ${viewLabel[addView]} view` : '');
  };

  return (
    <Section title={`Underlays (${list.length})`} open={list.length > 0}>
      <div data-testid="cad-underlays">
        <ul aria-label="Underlays">
          {list.map((u) => {
            const r = results.get(u.id);
            const stale = r && !current(r);
            const asset = doc.assets.find((a) => a.id === u.assetId);
            const missing = asset && failed.has(asset.sha256);
            return (
              <li key={u.id} role="group" aria-label={`Underlay ${u.name}`}>
                <div className="cad-row">
                  <strong>{u.name}</strong> <span>{viewLabel[u.view]}</span>{' '}
                  <span>
                    {u.pixels[0]} × {u.pixels[1]} px
                  </span>
                  {missing && <span role="alert">The image data is missing</span>}
                </div>
                {editable && (
                  <div className="cad-row">
                    <label>
                      View
                      <select
                        aria-label="Underlay view"
                        value={u.view}
                        onChange={(e) => change(u.id, { view: e.target.value as CadUnderlayView })}
                      >
                        {cadUnderlayViews.map((v) => (
                          <option key={v} value={v}>
                            {viewLabel[v]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      mm per pixel
                      <input
                        aria-label="Underlay mm per pixel"
                        type="number"
                        step="any"
                        key={`s-${u.mmPerPixel}`}
                        defaultValue={u.mmPerPixel}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v !== u.mmPerPixel && v > 0) change(u.id, { mmPerPixel: v });
                        }}
                      />
                    </label>
                    {(['u', 'v'] as const).map((axis, i) => (
                      <label key={axis}>
                        Top-left {axis === 'u' ? 'right' : 'up'} (mm)
                        <input
                          aria-label={`Underlay origin ${axis}`}
                          type="number"
                          step="any"
                          key={`${axis}-${u.originMm[i]}`}
                          defaultValue={u.originMm[i]}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (!Number.isFinite(v) || v === u.originMm[i]) return;
                            const originMm: [number, number] = [...u.originMm];
                            originMm[i] = v;
                            change(u.id, { originMm });
                          }}
                        />
                      </label>
                    ))}
                    <label>
                      Opacity
                      <input
                        aria-label="Underlay opacity"
                        type="range"
                        min={cadUnderlayLimits.minOpacity}
                        max={1}
                        step={0.05}
                        key={`o-${u.opacity}`}
                        defaultValue={u.opacity}
                        onPointerUp={(e) =>
                          change(u.id, { opacity: Number((e.target as HTMLInputElement).value) })
                        }
                        onKeyUp={(e) =>
                          change(u.id, { opacity: Number((e.target as HTMLInputElement).value) })
                        }
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        aria-label="Hide underlay"
                        checked={!!u.hidden}
                        onChange={(e) =>
                          change(u.id, e.target.checked ? { hidden: true } : { hidden: undefined })
                        }
                      />
                      Hide
                    </label>
                  </div>
                )}
                <div className="cad-row">
                  <button type="button" onClick={() => lookFrom(u)}>
                    Look from {viewLabel[u.view]}
                  </button>
                  <button type="button" disabled={!imageOf(u) || !meshes} onClick={() => check(u)}>
                    Check deviation
                  </button>
                  {editable && (
                    <button
                      type="button"
                      onClick={() => void controller.setUnderlays(list.filter((x) => x !== u))}
                    >
                      Remove underlay
                    </button>
                  )}
                </div>
                {r && (
                  <table aria-label={`Deviation from ${u.name}`}>
                    <caption>
                      {stale
                        ? 'The model or the shown bodies changed: check again'
                        : `Cell ${mm(r.result.cellMm)}`}
                    </caption>
                    <thead>
                      <tr>
                        <th>Body</th>
                        <th>Mean</th>
                        <th>95 %</th>
                        <th>Max</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.result.bodies.map((b) => (
                        <tr key={b.bodyId}>
                          <td>{doc.bodies.find((x) => x.id === b.bodyId)?.name ?? b.bodyId}</td>
                          <td>{mm(b.meanMm)}</td>
                          <td>{mm(b.p95Mm)}</td>
                          <td>{mm(b.maxMm)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            );
          })}
        </ul>
        {results.size > 0 && (
          <div className="cad-row">
            <label>
              <input
                type="checkbox"
                aria-label="Show deviation heat"
                checked={heatOn}
                onChange={(e) => setHeatOn(e.target.checked)}
              />
              Show heat
            </label>
            <label>
              Within (mm)
              <input
                aria-label="Deviation tolerance"
                type="number"
                step="any"
                min={0.001}
                value={tolerance}
                onChange={(e) => setTolerance(e.target.value)}
              />
            </label>
          </div>
        )}
        {editable && list.length < cadUnderlayLimits.underlays && (
          <div className="cad-row" role="group" aria-label="Add underlay">
            <label>
              View
              <select
                aria-label="New underlay view"
                value={addView}
                onChange={(e) => setAddView(e.target.value as CadUnderlayView)}
              >
                {cadUnderlayViews.map((v) => (
                  <option key={v} value={v}>
                    {viewLabel[v]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              mm per pixel
              <input
                aria-label="New underlay mm per pixel"
                type="number"
                step="any"
                value={addScale}
                onChange={(e) => setAddScale(e.target.value)}
              />
            </label>
            <label>
              Drawing image
              <input
                aria-label="Underlay image"
                type="file"
                accept="image/png,image/jpeg"
                disabled={snapshot.busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void add(file);
                }}
              />
            </label>
          </div>
        )}
        {note && <p role="status">{note}</p>}
      </div>
    </Section>
  );
}
