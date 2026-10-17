import { useEffect, useRef, useState } from 'react';
import { EditorSession, type EditorCommand } from '@editor-platform/editor-core';
import {
  identityTransform,
  readAnimationV1,
  prepareRectangleAnimationV1,
  replaceTrack,
  putRectangleLayerV1,
  removeAnimationTrackV1,
  type AnimationContent,
  type AnimationContentV1,
  type Property,
  type Transform,
} from '@editor-platform/animation-core';
import {
  mountRectanglePlayerV1,
  type RectanglePlayerV1,
} from '@editor-platform/animation-player/v1';
import { newAnimation } from './sample';
import './style.css';
const properties: Property[] = ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity'];
const scope = { canEdit: () => true }; // Trusted local sample only; not a Host authority adapter.
const uid = () => crypto.randomUUID();
export function AnimationEditingSample() {
  const session = useRef(new EditorSession<AnimationContent>(newAnimation()));
  const [content, setContent] = useState<AnimationContentV1>(() =>
    readAnimationV1(session.current.content),
  );
  const [layerId, setLayerId] = useState('group'),
    [compositionId, setCompositionId] = useState('root');
  const [property, setProperty] = useState<Property>('x'),
    [keyId, setKeyId] = useState<string | null>(null);
  const [tick, setTick] = useState(0),
    [playing, setPlaying] = useState(false),
    [ready, setReady] = useState(false);
  const [message, setMessage] = useState('Local editing sample — native schema 1');
  const [base, setBase] = useState<Transform>(identityTransform()),
    [keyTick, setKeyTick] = useState('0'),
    [keyValue, setKeyValue] = useState('0');
  const [rate, setRate] = useState('1'),
    [importing, setImporting] = useState(false);
  const stage = useRef<HTMLDivElement>(null),
    player = useRef<RectanglePlayerV1 | undefined>(undefined),
    tickRef = useRef(0),
    rateRef = useRef('1');
  const comp = content.compositions.find((c) => c.id === compositionId) ?? content.compositions[0];
  const layer = comp.layers.find((l) => l.id === layerId),
    track = comp.tracks.find((t) => t.layerId === layerId && t.property === property);
  const selectedKey = track?.keys.find((k) => k.id === keyId);
  useEffect(() => {
    if (layer) setBase({ ...layer.transform });
  }, [layer]);
  useEffect(() => {
    if (selectedKey) {
      setKeyTick(String(selectedKey.tick));
      setKeyValue(String(selectedKey.value));
    }
  }, [selectedKey]);
  useEffect(() => {
    let active = true,
      frame = 0;
    setReady(false);
    setPlaying(false);
    player.current?.dispose();
    player.current = undefined;
    prepareRectangleAnimationV1(content)
      .then((source) => {
        if (!active) return;
        const p = mountRectanglePlayerV1(stage.current!, {
          source,
          compositionId: comp.id,
          label: 'Editable animation preview',
        });
        player.current = p;
        tickRef.current = Math.min(tickRef.current, comp.duration);
        p.seek(tickRef.current);
        p.setRate(Number(rateRef.current));
        setTick(tickRef.current);
        setReady(true);
        const sync = () => {
          if (!active) return;
          tickRef.current = p.tick;
          setTick(p.tick);
          setPlaying(p.playing);
          frame = requestAnimationFrame(sync);
        };
        frame = requestAnimationFrame(sync);
      })
      .catch((error) => {
        if (active) setMessage(String(error));
      });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      player.current?.dispose();
      player.current = undefined;
    };
  }, [content, comp.id, comp.duration]);
  const pause = () => {
    const current = player.current;
    if (current) {
      current.pause();
      // pause samples the absolute clock; the UI poll may still be one frame behind.
      tickRef.current = current.tick;
      setTick(current.tick);
    }
    setPlaying(false);
  };
  const seek = (t: number) => {
    pause();
    player.current?.seek(t);
    tickRef.current = t;
    setTick(t);
  };
  function refresh() {
    setContent(readAnimationV1(session.current.content));
  }
  function execute(command: EditorCommand<AnimationContent>, label: string) {
    pause();
    try {
      session.current.execute(command);
      refresh();
      setMessage(label);
    } catch (error) {
      setMessage(`Change rejected: ${String(error)}`);
    }
  }
  function addRect() {
    const id = uid();
    execute(
      putRectangleLayerV1(
        content,
        comp.id,
        {
          id,
          type: 'rect',
          parentId: comp.layers.find((l) => l.type === 'group')?.id ?? null,
          start: 0,
          end: comp.duration,
          width: 80,
          height: 80,
          fill: '#818cf8',
          transform: { ...identityTransform(), x: 80, y: 140 },
        },
        scope,
      ),
      'Rectangle created',
    );
    setLayerId(id);
    setKeyId(null);
  }
  function chooseKey(id: string) {
    const k = track?.keys.find((k) => k.id === id);
    if (!k) return;
    setKeyId(id);
    setKeyTick(String(k.tick));
    setKeyValue(String(k.value));
    seek(k.tick);
  }
  function saveKey(add: boolean) {
    if (!layer) return;
    try {
      const t = Number(keyTick),
        value = Number(keyValue);
      if (
        !keyTick.trim() ||
        !keyValue.trim() ||
        !Number.isSafeInteger(t) ||
        t < 0 ||
        t > comp.duration ||
        !Number.isFinite(value)
      )
        throw new Error('Enter an integer tick in range and a finite value');
      if (!add && !selectedKey) throw new Error('Select a key');
      const keys = track ? structuredClone(track.keys) : [];
      const id = add ? uid() : selectedKey!.id;
      if (keys.some((k) => k.tick === t && k.id !== id))
        throw new Error('A key already exists at that tick');
      if (add) keys.push({ id, tick: t, value, easing: { type: 'linear' } });
      else {
        const k = keys.find((k) => k.id === id)!;
        k.tick = t;
        k.value = value;
      }
      keys.sort((a, b) => a.tick - b.tick);
      const next = { id: track?.id ?? uid(), layerId: layer.id, property, keys };
      execute(replaceTrack(content, comp.id, next, scope), add ? 'Key added' : 'Key updated');
      setKeyId(id);
    } catch (error) {
      setMessage(`Change rejected: ${String(error)}`);
    }
  }
  function deleteKey() {
    if (!track || !selectedKey) return;
    const keys = track.keys.filter((k) => k.id !== selectedKey.id);
    execute(
      keys.length
        ? replaceTrack(content, comp.id, { ...track, keys }, scope)
        : removeAnimationTrackV1(content, comp.id, track.id, scope),
      'Key deleted',
    );
    setKeyId(null);
  }
  function save() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(session.current.content, null, 2) + '\n'], {
        type: 'application/json',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'animation.animation.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage('Native JSON downloaded');
  }
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function load(file: File) {
    const g = ++generation.current;
    pause();
    setImporting(true);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Sample import limit: 2 MiB');
      const parsed = readAnimationV1(JSON.parse(await file.text()));
      await prepareRectangleAnimationV1(parsed);
      if (g !== generation.current) return;
      session.current = new EditorSession<AnimationContent>(parsed);
      setCompositionId(parsed.rootCompositionId);
      setLayerId(
        parsed.compositions.find((c) => c.id === parsed.rootCompositionId)!.layers[0]?.id ?? '',
      );
      setKeyId(null);
      tickRef.current = 0;
      setTick(0);
      setContent(parsed);
      setMessage('Native JSON opened — Undo history reset');
    } catch (error) {
      if (g === generation.current)
        setMessage(`Open rejected; current content retained: ${String(error)}`);
    } finally {
      if (g === generation.current) setImporting(false);
    }
  }
  return (
    <main className="animation-editor">
      <header>
        <span>EDITOR PLATFORM · ANIMATION</span>
        <h1>Make a little motion.</h1>
        <p>Local editing prototype · rectangles & groups · native schema 1</p>
      </header>
      <fieldset disabled={importing}>
        <div className="ae-toolbar">
          <button onClick={addRect}>Add rectangle</button>
          <button
            disabled={!session.current.canUndo}
            onClick={() => {
              pause();
              session.current.undo();
              refresh();
              setKeyId(null);
              setMessage('Undone');
            }}
          >
            Undo
          </button>
          <button
            disabled={!session.current.canRedo}
            onClick={() => {
              pause();
              session.current.redo();
              refresh();
              setKeyId(null);
              setMessage('Redone');
            }}
          >
            Redo
          </button>
          <button onClick={save}>Save native JSON</button>
          <label className="ae-upload">
            Open native JSON
            <input
              aria-label="Open native JSON"
              type="file"
              accept=".json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void load(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <p className="ae-hint">
          Opening a file replaces this local session and resets Undo. Download your current work
          first.
        </p>
        <div className="ae-layout">
          <aside>
            <h2>Layers</h2>
            <label>
              Composition
              <select
                aria-label="Composition"
                value={comp.id}
                onChange={(e) => {
                  pause();
                  setCompositionId(e.target.value);
                  setLayerId(
                    content.compositions.find((c) => c.id === e.target.value)!.layers[0]?.id ?? '',
                  );
                  setKeyId(null);
                  tickRef.current = 0;
                }}
              >
                {content.compositions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id}
                  </option>
                ))}
              </select>
            </label>
            <nav aria-label="Layers">
              {comp.layers.map((l, i) => (
                <button
                  key={l.id}
                  aria-pressed={l.id === layerId}
                  onClick={() => {
                    setLayerId(l.id);
                    setKeyId(null);
                  }}
                >
                  {l.type === 'group' ? 'Group' : `Rectangle ${i}`}
                  <small>{l.id.slice(0, 8)}</small>
                </button>
              ))}
            </nav>
          </aside>
          <section>
            <div className="ae-stage" ref={stage} />
            <div className="ae-transport">
              <button
                disabled={!ready}
                onClick={() => {
                  if (playing) pause();
                  else {
                    if (player.current!.tick === comp.duration) player.current!.seek(0);
                    player.current!.play();
                  }
                }}
              >
                {playing ? 'Pause' : 'Play'}
              </button>
              <label>
                Speed
                <select
                  aria-label="Speed"
                  value={rate}
                  onChange={(e) => {
                    setRate(e.target.value);
                    rateRef.current = e.target.value;
                    player.current?.setRate(Number(e.target.value));
                  }}
                >
                  {['0.5', '1', '2'].map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
              <span>
                {(tick / 240000).toFixed(2)} s / {(comp.duration / 240000).toFixed(2)} s
              </span>
            </div>
            <input
              aria-label="Seek"
              type="range"
              min={0}
              max={comp.duration}
              step={1}
              value={tick}
              disabled={!ready}
              onChange={(e) => seek(Number(e.target.value))}
            />
          </section>
          <aside>
            <h2>Base transform</h2>
            <p className="ae-hint">
              Local values. An animated property is overridden by its track; edit its keys below.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (layer)
                  execute(
                    putRectangleLayerV1(content, comp.id, { ...layer, transform: base }, scope),
                    'Base transform applied',
                  );
              }}
            >
              <fieldset disabled={!layer}>
                <div className="ae-fields">
                  {properties.map((p) => (
                    <label key={p}>
                      {p}
                      <input
                        aria-label={`Base ${p}`}
                        type="number"
                        step="any"
                        required
                        value={Number.isFinite(base[p]) ? base[p] : ''}
                        onChange={(e) => setBase({ ...base, [p]: e.target.valueAsNumber })}
                      />
                    </label>
                  ))}
                </div>
                <button type="submit">Apply base transform</button>
              </fieldset>
            </form>
          </aside>
        </div>
        <section className="ae-timeline">
          <h2>
            Keyframes <small>240000 ticks / second</small>
          </h2>
          <label>
            Property
            <select
              aria-label="Property"
              value={property}
              onChange={(e) => {
                setProperty(e.target.value as Property);
                setKeyId(null);
              }}
            >
              {properties.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <div className="ae-keyline" aria-label="Keyframe timeline">
            {track?.keys.map((k) => (
              <button key={k.id} aria-pressed={keyId === k.id} onClick={() => chooseKey(k.id)}>
                {k.tick} ticks · {k.value}
              </button>
            )) ?? <p>No keys for this property.</p>}
          </div>
          <div className="ae-key-edit">
            <label>
              Key tick
              <input
                aria-label="Key tick"
                type="number"
                step="1"
                value={keyTick}
                onChange={(e) => setKeyTick(e.target.value)}
              />
            </label>
            <label>
              Key value
              <input
                aria-label="Key value"
                type="number"
                step="any"
                value={keyValue}
                onChange={(e) => setKeyValue(e.target.value)}
              />
            </label>
            <button
              onClick={() => {
                setKeyTick(String(Math.round(tick)));
                setKeyId(null);
              }}
            >
              Use playhead tick
            </button>
            <button disabled={!layer} onClick={() => saveKey(true)}>
              Add key
            </button>
            <button disabled={!selectedKey} onClick={() => saveKey(false)}>
              Update selected key
            </button>
            <button disabled={!selectedKey} onClick={deleteKey}>
              Delete selected key
            </button>
          </div>
          <p className="ae-hint">
            New keys use linear interpolation. Existing easing is preserved. Deleting the final key
            removes its track and restores the base value.
          </p>
        </section>
      </fieldset>
      <p role="status">{message}</p>
      <footer>
        No text, image, nested composition, mask or path editing. No shared editing or durable Host
        storage.
      </footer>
    </main>
  );
}
