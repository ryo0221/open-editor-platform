import { AnimationViewer2 } from './viewer';
import { useEffect, useRef, useState } from 'react';
import type { EditorInputs } from '@editor-platform/editor-core';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  animationCommand2,
  insertExactAnimation,
  adoptExactAnimation,
  type AnimationEmbed2,
  createAnimationLayer2,
  encodeAnimationBase64,
  hashAnimationBytes2,
  inspectAnimationAsset2,
  equivalentAnimationAsset2,
  propertyKind2,
  validateAnimationInputs2,
  type AnimationContent2,
  type AnimationCommand2,
  type AnimationInputValues2,
  type Asset2,
  type Layer2,
  type Property2,
  type PublicInput2,
} from '@editor-platform/animation-core/v2';
interface Props {
  sources?: readonly AnimationEmbed2[];
  inputs: EditorInputs;
  canEdit(): boolean;
  content: AnimationContent2;
  compositionId: string;
  layer?: Layer2;
  disabled: boolean;
  read(): AnimationContent2;
  apply(make: (current: AnimationContent2) => AnimationCommand2): boolean;
  select(id: string): void;
  report(message: string): void;
  previewInputs: AnimationInputValues2;
  preview(values: AnimationInputValues2): void;
}
export function AnimationSourceControls2(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [license, setLicense] = useState('Unspecified'),
    [attribution, setAttribution] = useState('Uploaded asset'),
    [busy, setBusy] = useState(false),
    [requestedProperty, setProperty] = useState<Property2>('opacity'),
    [raw, setRaw] = useState<Record<string, string>>({}),
    [sourceKey, setSourceKey] = useState('');
  const rawRef = useRef(raw),
    previewComposing = useRef(new Set<string>()),
    root = useRef<HTMLDetailsElement>(null);
  rawRef.current = raw;
  const previousInputs = useRef(new Map<string, PublicInput2>());
  for (const input of props.content.publicInputs) previousInputs.current.set(input.id, input);
  for (const id of previousInputs.current.keys())
    if (
      !props.content.publicInputs.some((input) => input.id === id) &&
      !Object.hasOwn(rawRef.current, id) &&
      !previewComposing.current.has(id)
    )
      previousInputs.current.delete(id);
  const renderedInputs = [
    ...props.content.publicInputs,
    ...[...previousInputs.current.values()].filter(
      (input) => !props.content.publicInputs.some((current) => current.id === input.id),
    ),
  ];
  function previewValues() {
    const p = latest.current,
      values = [...p.previewInputs];
    for (const [id, raw] of Object.entries(rawRef.current)) {
      const input = p.content.publicInputs.find((input) => input.id === id);
      if (!input)
        throw Error('A preview input was removed. Copy its value or reset preview inputs.');
      if (input.kind === 'number' && !raw.trim()) throw Error('Enter a preview number');
      const value = { inputId: id, value: input.kind === 'number' ? Number(raw) : raw },
        index = values.findIndex((value) => value.inputId === id);
      if (index >= 0) values[index] = value;
      else values.push(value);
    }
    validateAnimationInputs2(p.content, values);
    return values;
  }
  function previewProblem() {
    try {
      previewValues();
      return '';
    } catch (error) {
      return String(error);
    }
  }
  const busyRef = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const stop = props.inputs.register({
      label: 'Animation assets and preview inputs',
      read: () => ({
        dirty: !!previewProblem(),
        composing: busyRef.current || !!previewComposing.current.size,
      }),
      prepare: () => {
        if (busyRef.current) throw Error('Wait for asset preparation');
        const error = previewProblem();
        if (error) throw Error(error);
        return () => true;
      },
      focus: () => {
        if (root.current) root.current.open = true;
        root.current?.querySelector<HTMLInputElement>('[data-preview-input]')?.focus();
      },
    });
    return () => {
      alive.current = false;
      stop();
    };
  }, [props.inputs]);
  useEffect(() => {
    props.inputs.changed();
  }, [props.content.publicInputs, props.previewInputs, props.inputs]);
  async function upload(file: File, font: boolean) {
    if (props.disabled || busy) return;
    const before = structuredClone(props.read());
    setBusy(true);
    busyRef.current = true;
    props.inputs.changed();
    try {
      if (file.size > 2 * 1024 * 1024) throw Error('Asset exceeds 2 MiB');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const extension = file.name.split('.').at(-1)?.toLowerCase(),
        mime = font
          ? ({ otf: 'font/otf', ttf: 'font/ttf', woff2: 'font/woff2' } as const)[extension as 'otf']
          : (file.type as Asset2['mediaType']);
      if (!mime || (!font && !['image/png', 'image/jpeg'].includes(mime)))
        throw Error('Unsupported asset format');
      const uploaded: Asset2 = {
        id: crypto.randomUUID(),
        contentHash: hashAnimationBytes2(bytes),
        mediaType: mime,
        base64: encodeAnimationBase64(bytes),
        license,
        attribution,
      };
      const measured = inspectAnimationAsset2(uploaded),
        equivalent = before.assets.find((asset) => equivalentAnimationAsset2(asset, uploaded)),
        asset = equivalent ?? uploaded;
      if (
        !alive.current ||
        !latest.current.canEdit() ||
        canonicalJson(before) !== canonicalJson(latest.current.read())
      )
        throw Error('Animation changed while reading the asset; retry with the current source');
      const actions: Parameters<typeof animationCommand2>[1][number][] = equivalent
        ? []
        : [{ type: 'content.set', field: 'assets', value: [...before.assets, asset] }];
      let selected = props.layer?.id ?? '';
      if (font) {
        if (props.layer?.type === 'text' && props.layer.fontAssetId !== asset.id)
          actions.push({
            type: 'layer.patch',
            compositionId: props.compositionId,
            id: props.layer.id,
            patch: { fontAssetId: asset.id },
          });
      } else {
        const c = before.compositions.find((c) => c.id === props.compositionId)!;
        selected = crypto.randomUUID();
        const scale = Math.min(1, 300 / measured.width);
        const layer: Layer2 = {
          ...createAnimationLayer2('group', selected, c.duration),
          type: 'image',
          name: file.name,
          assetId: asset.id,
          width: measured.width * scale,
          height: measured.height * scale,
        };
        actions.push({ type: 'layer.insert', compositionId: c.id, layer });
      }
      if (!actions.length) {
        props.report('Asset already retained');
        return;
      }
      busyRef.current = false;
      props.inputs.changed();
      if (
        latest.current.apply((content) => {
          if (!alive.current || canonicalJson(before) !== canonicalJson(content))
            throw Error('Animation changed before asset import');
          return animationCommand2(
            content,
            actions,
            { canEdit: () => latest.current.canEdit() },
            'Import Animation asset',
          );
        })
      )
        props.select(selected);
    } catch (error) {
      if (alive.current) props.report(String(error));
    } finally {
      busyRef.current = false;
      props.inputs.changed();
      if (alive.current) setBusy(false);
    }
  }
  function addInput() {
    if (!props.layer) return;
    const l = props.layer;
    props.apply((content) => {
      const kind = propertyKind2(l, property),
        value =
          property in l.transform
            ? (l.transform as unknown as Record<string, number>)[property]
            : (l as unknown as Record<string, number | string>)[property];
      return animationCommand2(
        content,
        [
          {
            type: 'content.set',
            field: 'publicInputs',
            value: [
              ...content.publicInputs,
              {
                id: crypto.randomUUID(),
                name: `${l.name} ${property}`,
                kind,
                default: value,
                min: property === 'opacity' ? 0 : -1000000,
                max: property === 'opacity' ? 1 : 1000000,
                target: { compositionId: props.compositionId, layerId: l.id, property },
              },
            ],
          },
        ],
        { canEdit: () => latest.current.canEdit() },
        'Expose Animation input',
      );
    });
  }
  const properties: Property2[] = [
    'x',
    'y',
    'scaleX',
    'scaleY',
    'rotation',
    'opacity',
    ...(props.layer && 'fill' in props.layer ? ['fill' as const] : []),
    ...(props.layer?.type === 'text' ? ['text' as const] : []),
  ];
  const chosen = props.sources?.find((embed) => canonicalJson(embed.source) === sourceKey);
  const property = properties.includes(requestedProperty) ? requestedProperty : 'opacity';
  return (
    <details ref={root} className="a2-source-controls">
      <summary>Assets and public inputs</summary>
      {!!props.sources?.length && (
        <fieldset disabled={props.disabled}>
          <legend>Exact reusable composition</legend>
          <label>
            Saved source
            <select
              aria-label="Saved Animation source"
              value={sourceKey}
              onChange={(event) => setSourceKey(event.target.value)}
            >
              <option value="">Choose saved composition</option>
              {props.sources.map((embed) => (
                <option key={canonicalJson(embed.source)} value={canonicalJson(embed.source)}>
                  {embed.label} / {embed.source.versionId} / {embed.source.compositionId}
                </option>
              ))}
            </select>
          </label>
          {chosen && (
            <>
              <div style={{ height: 180 }}>
                <AnimationViewer2 animation={chosen} controls={false} />
              </div>
              <p>
                The saved source and its portable resources are retained. Later source edits require
                explicit adoption.
              </p>
              {props.layer?.type === 'composition' && props.layer.source.type === 'exact' && (
                <p>
                  Current version: {props.layer.source.ref.versionId}. A shorter source clamps the
                  out point; placement, speed and after-trim behavior are retained.
                </p>
              )}
              <button
                onClick={() => {
                  const id = crypto.randomUUID();
                  if (
                    props.apply((content) =>
                      insertExactAnimation(content, props.compositionId, chosen, id, {
                        canEdit: () => latest.current.canEdit(),
                      }),
                    )
                  )
                    props.select(id);
                }}
              >
                Insert reviewed source
              </button>
              {props.layer?.type === 'composition' && props.layer.source.type === 'exact' && (
                <button
                  onClick={() =>
                    props.apply((content) =>
                      adoptExactAnimation(content, props.compositionId, props.layer!.id, chosen, {
                        canEdit: () => latest.current.canEdit(),
                      }),
                    )
                  }
                >
                  Adopt reviewed source
                </button>
              )}
            </>
          )}
        </fieldset>
      )}
      <fieldset disabled={props.disabled || busy}>
        <legend>Portable assets</legend>
        <label>
          Asset attribution
          <input
            aria-label="Asset attribution"
            value={attribution}
            onChange={(e) => setAttribution(e.target.value)}
          />
        </label>
        <label>
          Asset license
          <textarea
            aria-label="Asset license"
            value={license}
            onChange={(e) => setLicense(e.target.value)}
          />
        </label>
        <label>
          Add image
          <input
            aria-label="Add Animation image"
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.currentTarget.value = '';
              if (file) void upload(file, false);
            }}
          />
        </label>
        <label>
          Add font
          <input
            aria-label="Add Animation font"
            type="file"
            accept=".otf,.ttf,.woff2"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.currentTarget.value = '';
              if (file) void upload(file, true);
            }}
          />
        </label>
        {props.layer?.type === 'text' && (
          <label>
            Text font
            <select
              aria-label="Text font"
              value={props.layer.fontAssetId ?? ''}
              onChange={(e) => {
                const id = e.target.value;
                props.apply((content) =>
                  animationCommand2(
                    content,
                    [
                      {
                        type: 'layer.patch',
                        compositionId: props.compositionId,
                        id: props.layer!.id,
                        patch: { fontAssetId: id || null },
                      },
                    ],
                    { canEdit: () => latest.current.canEdit() },
                    'Change text font',
                  ),
                );
              }}
            >
              <option value="">System sans-serif (ASCII)</option>
              {props.content.assets
                .filter((a) => a.mediaType.startsWith('font/'))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.attribution}
                  </option>
                ))}
            </select>
          </label>
        )}
      </fieldset>
      <fieldset disabled={props.disabled || !props.layer}>
        <legend>Expose selected property</legend>
        <select
          aria-label="Public input property"
          value={property}
          onChange={(e) => setProperty(e.target.value as Property2)}
        >
          {properties.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <button onClick={addInput}>Add public input</button>
      </fieldset>
      <p>Preview controls change this view. Use the adjacent button to save a new default.</p>
      <button
        onClick={() => {
          rawRef.current = {};
          setRaw({});
          previewComposing.current.clear();
          props.preview([]);
          props.inputs.changed();
        }}
      >
        Reset preview inputs
      </button>
      {renderedInputs.map((input) => {
        const value =
            (Object.hasOwn(raw, input.id) ? raw[input.id] : undefined) ??
            String(props.previewInputs.find((v) => v.inputId === input.id)?.value ?? input.default),
          converted = input.kind === 'number' ? Number(value) : value;
        const removed = !props.content.publicInputs.some((current) => current.id === input.id),
          invalid = !!previewProblem();
        return (
          <div key={input.id} className="a2-input">
            <label>
              {input.name}
              <input
                aria-label={`Preview ${input.name}`}
                data-preview-input={input.id}
                onCompositionStart={() => {
                  previewComposing.current.add(input.id);
                  props.inputs.changed();
                }}
                onCompositionEnd={() => {
                  previewComposing.current.delete(input.id);
                  props.inputs.changed();
                }}
                value={value}
                onChange={(e) => {
                  const next = e.target.value;
                  const nextRaw = { ...rawRef.current, [input.id]: next };
                  rawRef.current = nextRaw;
                  setRaw(nextRaw);
                  try {
                    props.preview(previewValues());
                  } catch (error) {
                    props.report(String(error));
                  } finally {
                    props.inputs.changed();
                  }
                }}
              />
            </label>
            {removed && (
              <small role="alert">
                This input was removed. Copy the retained value or reset preview inputs.
              </small>
            )}
            {invalid && <small>Invalid preview value.</small>}
            <button
              disabled={props.disabled || invalid}
              onClick={() =>
                props.apply((content) =>
                  animationCommand2(
                    content,
                    [
                      {
                        type: 'content.set',
                        field: 'publicInputs',
                        value: content.publicInputs.map((i) =>
                          i.id === input.id ? { ...i, default: converted } : i,
                        ),
                      },
                    ],
                    { canEdit: () => latest.current.canEdit() },
                    'Change Animation input default',
                  ),
                )
              }
            >
              Use preview as default
            </button>
            <button
              disabled={props.disabled}
              onClick={() =>
                props.apply((content) =>
                  animationCommand2(
                    content,
                    [
                      {
                        type: 'content.set',
                        field: 'publicInputs',
                        value: content.publicInputs.filter((i) => i.id !== input.id),
                      },
                    ],
                    { canEdit: () => latest.current.canEdit() },
                    'Remove Animation input',
                  ),
                )
              }
            >
              Remove {input.name} input
            </button>
          </div>
        );
      })}
    </details>
  );
}
