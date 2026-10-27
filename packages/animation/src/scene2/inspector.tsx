import { useEffect, useRef, useState } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import type { EditorInputs } from '@editor-platform/editor-core';
import {
  animationLayerSystemFont2,
  animationCommand2,
  animationLayerLocked2,
  frameStep2,
  propertyKind2,
  resolveComposition2,
  type AnimationContent2,
  type AnimationCommand2,
  type VectorPath2,
} from '@editor-platform/animation-core/v2';
import { ControlledEasing } from '../controlled-easing';
interface Props {
  content: AnimationContent2;
  compositionId: string;
  layerId: string;
  trackId?: string;
  keyId?: string;
  read(): AnimationContent2;
  inputs: EditorInputs;
  readOnly: boolean;
  execute(command: AnimationCommand2): boolean | void;
  report(message: string): void;
  editText(): void;
}
type Draft = { base: AnimationContent2; fields: Record<string, string>; composing: Set<string> };
function numeric(raw: string, label: string) {
  if (!raw.trim() || !Number.isFinite(Number(raw))) throw Error(`${label}: enter a finite number`);
  return Number(raw);
}
export function AnimationInspector2(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const draft = useRef<Draft | null>(null),
    root = useRef<HTMLDivElement>(null),
    [, refresh] = useState(0),
    [problem, setProblem] = useState('');
  const c = props.content.compositions.find((c) => c.id === props.compositionId),
    current = c?.layers.find((l) => l.id === props.layerId);
  const previous = draft.current?.base.compositions.find((c) => c.id === props.compositionId),
    layer = current ?? previous?.layers.find((l) => l.id === props.layerId);
  const track =
      c?.tracks.find((t) => t.id === props.trackId) ??
      previous?.tracks.find((t) => t.id === props.trackId),
    key =
      track?.keys.find((k) => k.id === props.keyId) ??
      previous?.tracks.find((t) => t.id === props.trackId)?.keys.find((k) => k.id === props.keyId);
  const disabled = props.readOnly || !current || !!(c && animationLayerLocked2(c, props.layerId));
  const notify = () => {
    refresh((n) => n + 1);
    props.inputs.changed();
  };
  function begin() {
    if (latest.current.readOnly) throw Error('Read only');
    draft.current ??= {
      base: structuredClone(latest.current.read()),
      fields: {},
      composing: new Set(),
    };
    return draft.current;
  }
  function change(name: string, value: string) {
    if (disabled) return;
    try {
      begin().fields[name] = value;
      setProblem('');
      notify();
    } catch (error) {
      setProblem(String(error));
    }
  }
  function composing(name: string, on: boolean) {
    if (on && disabled) return;
    if (on) begin().composing.add(name);
    else draft.current?.composing.delete(name);
    notify();
  }
  function prepare() {
    const d = draft.current,
      p = latest.current;
    if (!d) return undefined;
    if (p.readOnly || d.composing.size) throw Error('Finish composition before applying');
    const content = p.read();
    if (canonicalJson(content) !== canonicalJson(d.base))
      throw Error('Animation changed. Cancel or copy these inputs before editing the new version.');
    const comp = content.compositions.find((c) => c.id === p.compositionId),
      l = comp?.layers.find((l) => l.id === p.layerId);
    if (!comp || !l) throw Error('Selected layer was removed; inputs are retained');
    const patch: Record<string, unknown> = {},
      transform: Record<string, number> = {},
      fields = d.fields;
    const keyTrack = comp.tracks.find((t) => t.id === p.trackId),
      nextTrack = keyTrack ? structuredClone(keyTrack) : undefined,
      nextKey = nextTrack?.keys.find((k) => k.id === p.keyId);
    const nested = l.type === 'composition' ? structuredClone(l.time) : undefined;
    const sourceStep =
      l.type === 'composition' ? frameStep2(resolveComposition2(content, l).composition) : 1;
    const pathEdits = new Map<string, VectorPath2>();
    for (const [name, raw] of Object.entries(fields)) {
      if (name.startsWith('time.') && nested) {
        const field = name.slice(5);
        if (field === 'after') nested.after = raw as typeof nested.after;
        else if (field.startsWith('rate.'))
          nested.rate[field.slice(5) as 'numerator' | 'denominator'] = numeric(raw, name);
        else nested[field as 'sourceIn' | 'sourceOut'] = numeric(raw, name) * sourceStep;
        patch.time = nested;
      } else if (name.startsWith('transform.')) transform[name.slice(10)] = numeric(raw, name);
      else if (name.startsWith('path.') || name.startsWith('motion.path.')) {
        const motion = name.startsWith('motion.'),
          parts = name.split('.'),
          index = Number(parts.at(-2)),
          coordinate = Number(parts.at(-1)),
          address = motion ? 'motion' : 'path';
        let path = pathEdits.get(address);
        if (!path) {
          const source = motion ? l.motion?.path : l.type === 'path' ? l.path : undefined;
          if (!source) throw Error('Path was removed');
          path = structuredClone(source);
          pathEdits.set(address, path);
        }
        (path[index] as (number | string)[])[coordinate] = numeric(raw, name);
      } else if (name === 'key.tick') {
        if (!nextKey) throw Error('Selected key was removed');
        nextKey.tick = numeric(raw, 'Key frame') * frameStep2(comp);
      } else if (name === 'key.value') {
        if (!nextKey || !nextTrack) throw Error('Selected key was removed');
        nextKey.value =
          propertyKind2(l, nextTrack.property) === 'number' ? numeric(raw, 'Key value') : raw;
      } else if (name === 'key.easing') {
        if (!nextKey) throw Error('Selected key was removed');
        const easing = JSON.parse(raw) as { type: 'hold' | 'linear' | 'bezier'; points: string[] };
        nextKey.easing =
          easing.type === 'bezier'
            ? {
                type: 'bezier',
                x1: numeric(easing.points[0], 'x1'),
                y1: numeric(easing.points[1], 'y1'),
                x2: numeric(easing.points[2], 'x2'),
                y2: numeric(easing.points[3], 'y2'),
              }
            : { type: easing.type };
      } else if (['name', 'fill', 'stroke'].includes(name)) patch[name] = raw;
      else if (name === 'start' || name === 'end')
        patch[name] = numeric(raw, name) * frameStep2(comp);
      else patch[name] = numeric(raw, name);
    }
    if (Object.keys(transform).length) patch.transform = transform;
    for (const [address, path] of pathEdits) {
      if (address === 'path') patch.path = path;
      else patch.motion = { ...l.motion, path };
    }
    const actions: Parameters<typeof animationCommand2>[1][number][] = [];
    if (Object.keys(patch).length)
      actions.push({ type: 'layer.patch', compositionId: comp.id, id: l.id, patch });
    if (nextTrack && Object.keys(fields).some((name) => name.startsWith('key.'))) {
      nextTrack.keys.sort((a, b) => a.tick - b.tick);
      actions.push({ type: 'track.put', compositionId: comp.id, track: nextTrack });
    }
    return actions.length
      ? animationCommand2(
          content,
          actions,
          { canEdit: () => !!root.current?.isConnected && !latest.current.readOnly },
          'Apply Animation inputs',
        )
      : undefined;
  }
  useEffect(
    () =>
      props.inputs.register({
        label: 'Animation properties',
        read: () => ({
          dirty: !!draft.current && Object.keys(draft.current.fields).length > 0,
          composing: !!draft.current?.composing.size,
        }),
        prepare: () => {
          const command = prepare();
          return () => {
            if (command && latest.current.execute(command) === false) return false;
            draft.current = null;
            setProblem('');
            refresh((n) => n + 1);
            latest.current.inputs.changed();
            return true;
          };
        },
        focus: () => {
          try {
            prepare();
          } catch (error) {
            setProblem(String(error));
          }
          root.current?.querySelector<HTMLInputElement>('[data-draft="true"]')?.focus();
        },
      }),
    [props.inputs, props.compositionId, props.layerId, props.trackId, props.keyId],
  );
  if (!layer) return <p role="status">Select a layer to edit its properties.</p>;
  const raw = (name: string, value: string | number) =>
    draft.current?.fields[name] ?? String(value);
  const field = (name: string, value: string | number, label = name) => {
    const tracked = c?.tracks.some(
      (track) => track.layerId === layer.id && track.property === name.replace('transform.', ''),
    );
    const bound = props.content.publicInputs.some(
      (i) =>
        i.target.compositionId === props.compositionId &&
        i.target.layerId === layer.id &&
        i.target.property === name.replace('transform.', ''),
    );
    return (
      <label key={name}>
        {label}
        <input
          aria-label={label}
          value={raw(name, value)}
          aria-invalid={
            (!!problem && draft.current?.fields[name] !== undefined) ||
            !!draft.current?.composing.has(name)
          }
          disabled={disabled || bound || tracked}
          data-draft={draft.current?.fields[name] !== undefined}
          onChange={(e) => change(name, e.target.value)}
          onCompositionStart={() => composing(name, true)}
          onCompositionEnd={() => composing(name, false)}
        />
        {bound && <small>Controlled by a public input.</small>}
        {tracked && <small>Edit the selected key for this animated property.</small>}
      </label>
    );
  };
  const pathFields = (path: VectorPath2, prefix: string) => (
    <fieldset>
      <legend>{prefix === 'path' ? 'Vector points' : 'Motion path points'}</legend>
      {path.map((command, i) => (
        <div className="a2-path-row" key={i}>
          <span>{command[0]}</span>
          {command
            .slice(1)
            .map((value, j) =>
              field(
                `${prefix}.${i}.${j + 1}`,
                value,
                `${prefix} point ${i + 1} coordinate ${j + 1}`,
              ),
            )}
        </div>
      ))}
    </fieldset>
  );
  const projection = current ? props.content : (draft.current?.base ?? props.content);
  const easing = key?.easing,
    buffered = draft.current?.fields['key.easing'];
  return (
    <div ref={root} className="a2-inspector" aria-label="Animation properties">
      {!current && <p role="alert">Selected layer is unavailable. Your inputs remain here.</p>}
      {problem && <p role="alert">{problem}</p>}
      {field('name', layer.name, 'Layer name')}
      <div className="a2-fields">
        {Object.entries(layer.transform).map(([name, value]) =>
          field('transform.' + name, value, 'Base ' + name),
        )}
      </div>
      <div className="a2-fields">
        {field('start', layer.start / frameStep2(c ?? previous!), 'Start frame')}
        {field('end', layer.end / frameStep2(c ?? previous!), 'End frame')}
      </div>
      {(layer.type === 'rect' || layer.type === 'image' || layer.type === 'text') && (
        <div className="a2-fields">
          {field('width', layer.width, 'Width')}
          {field('height', layer.height, 'Height')}
        </div>
      )}
      {'fill' in layer && field('fill', layer.fill, 'Fill')}
      {'stroke' in layer && (
        <>
          {field('stroke', layer.stroke, 'Stroke')}
          {field('strokeWidth', layer.strokeWidth, 'Stroke width')}
        </>
      )}
      {layer.type === 'text' && (
        <>
          <div className="a2-fields">
            {field('fontSize', layer.fontSize, 'Font size')}
            {field('lineHeight', layer.lineHeight, 'Line height')}
          </div>
          <button disabled={disabled} onClick={props.editText}>
            Edit text on canvas
          </button>
          {animationLayerSystemFont2(projection, props.compositionId, layer.id) && (
            <p role="note" className="a2-note">
              System font preview: pin a font asset to fix how this text looks.
            </p>
          )}
        </>
      )}
      {layer.type === 'path' && pathFields(layer.path, 'path')}
      {layer.motion && pathFields(layer.motion.path, 'motion.path')}
      {layer.type === 'composition' && (
        <fieldset>
          <legend>Nested timing</legend>
          {field(
            'time.sourceIn',
            layer.time.sourceIn / frameStep2(resolveComposition2(projection, layer).composition),
            'Source in frame',
          )}
          {field(
            'time.sourceOut',
            layer.time.sourceOut / frameStep2(resolveComposition2(projection, layer).composition),
            'Source out frame',
          )}
          {field('time.rate.numerator', layer.time.rate.numerator, 'Speed numerator')}
          {field('time.rate.denominator', layer.time.rate.denominator, 'Speed denominator')}
          <label>
            After trim
            <select
              aria-label="After trim"
              disabled={disabled}
              value={draft.current?.fields['time.after'] ?? layer.time.after}
              onChange={(event) => change('time.after', event.target.value)}
            >
              {['hold', 'loop', 'hide'].map((after) => (
                <option key={after}>{after}</option>
              ))}
            </select>
          </label>
        </fieldset>
      )}
      {key && track && (
        <fieldset disabled={disabled}>
          <legend>Selected key</legend>
          {field('key.tick', key.tick / frameStep2(c ?? previous!), 'Key frame')}
          {field('key.value', key.value, 'Key value')}
          {track.property !== 'text' && (
            <ControlledEasing
              value={
                buffered
                  ? JSON.parse(buffered)
                  : {
                      type: easing!.type,
                      points:
                        easing!.type === 'bezier'
                          ? [easing!.x1, easing!.y1, easing!.x2, easing!.y2].map(String)
                          : ['0.42', '0', '0.58', '1'],
                    }
              }
              change={(value) => change('key.easing', JSON.stringify(value))}
              composing={composing}
              errorId="animation2-easing-error"
            />
          )}
        </fieldset>
      )}
      <div className="a2-actions">
        <button
          disabled={disabled || !draft.current}
          onClick={() => {
            try {
              props.inputs.flush();
            } catch (error) {
              setProblem(String(error));
            }
          }}
        >
          Apply inputs
        </button>
        <button
          disabled={!draft.current}
          onClick={() => {
            draft.current = null;
            setProblem('');
            notify();
          }}
        >
          Cancel inputs
        </button>
      </div>
    </div>
  );
}
