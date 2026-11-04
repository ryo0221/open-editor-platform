import { useEffect, useRef, useState } from 'react';
import { canonicalJson, contentHash, type Artifact } from '@editor-platform/artifact-core';
import { downloadBlob } from '@editor-platform/canvas-ui';
import { useEditorInput } from '@editor-platform/editor-ui';
import { validateFictionMap, type FictionMapContent } from './model';
import { renderFictionMapSvg, type FictionMapOutputView } from './render';
import { exportFictionMapPng } from './image-export';
export interface FictionMapOutputPanelProps {
  artifact: Artifact<FictionMapContent>;
  isCurrent(): boolean;
  onError(message: string): void;
  beforeOutput?(): void;
}
/** Saved immutable versions only; never substitute the current draft or private camera. */
export function FictionMapOutputPanel({
  artifact,
  isCurrent,
  onError,
  beforeOutput,
}: FictionMapOutputPanelProps) {
  const [versionId, setVersion] = useState(''),
    [view, setView] = useState<FictionMapOutputView>({ kind: 'document' }),
    [width, setWidth] = useState('1000'),
    [height, setHeight] = useState('700'),
    [transparent, setTransparent] = useState(false),
    [busy, setBusy] = useState(false),
    [epoch, setEpoch] = useState(0);
  const mounted = useRef(true),
    generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const latest = useRef({ artifact, isCurrent, epoch });
  latest.current = { artifact, isCurrent, epoch };
  const version = versionId
      ? artifact.versions.find((v) => v.versionId === versionId)
      : artifact.versions.at(-1),
    options = {
      width: Number(width),
      height: Number(height),
      view,
      background: transparent ? 'transparent' : '#ffffff',
    };
  useEditorInput({
    label: 'Fiction Map output',
    read: () => ({ dirty: busy, settles: true }),
    prepare() {
      throw Error('Wait for the current image output.');
    },
    focus() {},
  });
  let svg = '',
    message = '';
  try {
    if (version) svg = renderFictionMapSvg(version.content, options).svg;
    else message = 'Save a version before image output.';
  } catch (e) {
    message = String(e instanceof Error ? e.message : e);
  }
  function optionChange(change: () => void) {
    generation.current++;
    setEpoch(generation.current);
    change();
  }
  async function output(format: 'svg' | 'png') {
    if (!version || busy) return;
    try {
      beforeOutput?.();
      const source = version,
        identity = artifact.id,
        pinnedEpoch = generation.current,
        checkHost = isCurrent;
      const admitted = validateFictionMap(source.content);
      if (!admitted.ok) throw Error('Invalid saved Fiction Map');
      const fixed = admitted.value,
        canonical = canonicalJson(fixed);
      const guard = () =>
        mounted.current &&
        latest.current.artifact.id === identity &&
        generation.current === pinnedEpoch &&
        latest.current.artifact.versions.some(
          (v) =>
            v.versionId === source.versionId &&
            v.contentHash === source.contentHash &&
            canonicalJson(v.content) === canonical,
        ) &&
        checkHost();
      if (!guard()) throw Error('stale-output');
      setBusy(true);
      if ((await contentHash(fixed)) !== source.contentHash) throw Error('Saved map hash mismatch');
      if (!guard()) throw Error('stale-output');
      if (format === 'svg') {
        const rendered = renderFictionMapSvg(fixed, options);
        if (!guard()) throw Error('stale-output');
        downloadBlob(
          `${artifact.name}-${source.versionId}.svg`,
          new Blob([rendered.svg], { type: 'image/svg+xml' }),
        );
      } else {
        const bytes = await exportFictionMapPng(fixed, options, { isCurrent: guard });
        downloadBlob(
          `${artifact.name}-${source.versionId}.png`,
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
        );
      }
    } catch (e) {
      onError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="fm-output" aria-label="Saved map output">
      <h3>Saved map versions and images</h3>
      <p>
        Images use the selected immutable version and saved view. Camera and draft previews are
        excluded.
      </p>
      <label>
        Saved map version
        <select
          aria-label="Saved map version"
          value={version?.versionId ?? ''}
          onChange={(e) => optionChange(() => setVersion(e.target.value))}
        >
          {artifact.versions.map((v, i) => (
            <option key={v.versionId} value={v.versionId}>
              Version {i + 1} · {v.reason}
            </option>
          ))}
        </select>
      </label>
      <label>
        Saved map view
        <select
          aria-label="Saved map view"
          value={JSON.stringify(view)}
          onChange={(e) =>
            optionChange(() => setView(JSON.parse(e.target.value) as FictionMapOutputView))
          }
        >
          <option value={JSON.stringify({ kind: 'document' })}>
            Document bounds / default layers
          </option>
          {version?.content.namedViews.map((v) => (
            <option key={v.id} value={JSON.stringify({ kind: 'named', id: v.id })}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Output width
        <input
          aria-label="Map output width"
          inputMode="numeric"
          value={width}
          onChange={(e) => optionChange(() => setWidth(e.target.value))}
        />
      </label>
      <label>
        Output height
        <input
          aria-label="Map output height"
          inputMode="numeric"
          value={height}
          onChange={(e) => optionChange(() => setHeight(e.target.value))}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={transparent}
          onChange={(e) => optionChange(() => setTransparent(e.target.checked))}
        />
        Transparent map background
      </label>
      <button disabled={!svg || busy} onClick={() => void output('svg')}>
        Export map SVG
      </button>
      <button disabled={!svg || busy} onClick={() => void output('png')}>
        Export map PNG
      </button>
      {message && <p role="status">{message}</p>}
      {svg && (
        <img
          alt="Saved Fiction Map version"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          style={{ maxWidth: '100%', maxHeight: 300 }}
        />
      )}
    </section>
  );
}
