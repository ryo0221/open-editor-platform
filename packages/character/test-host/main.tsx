import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  blockyFigure,
  characterContentHash,
  characterEditorCommand,
  composeMat4,
  emptyCharacter,
  freshCharacterId,
  GltfImportError,
  importGltf,
  type CharacterDocument,
} from '@editor-platform/character-core';
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import '@editor-platform/editor-ui/styles.css';
import {
  CharacterSurface,
  frameBounds,
  type CharacterImportReport,
  type CharacterPropChoice,
  type CharacterPropMesh,
  type CharacterPropView,
} from '../src';
import '../src/style.css';

// Standalone host: ?props=1 (a fake two-link arm version can be added as a prop: a fixed base
// and a link turned about z by joint `j-turn`; ?props=failed shows it as not evaluated),
// ?empty=1 (no parts), ?edit=1 (the Host keeps new mesh assets in memory, so parts can be added and edited; with
// ?edit=slow it takes a moment, ?edit=refuse refuses them, ?edit=revoke withdraws edit permission while keeping one),
// ?readonly=1, ?admit=refuse (the Host refuses every edit), ?broken=1 (an asset whose bytes do not match), ?hidden=1 (every
// part starts hidden). The Host keeps
// the asset bytes in memory for the page's life and replaces the session on each import.
const params = new URLSearchParams(location.search);
const readOnly = params.get('readonly') === '1';
interface Shown {
  session: EditorSession<CharacterDocument>;
  assets: Map<string, Uint8Array>;
  report?: CharacterImportReport;
  /** Counts imports; the Surface is not remounted, it follows the new session itself. */
  key: number;
}
function initial(): Shown {
  const f = blockyFigure();
  const assets = new Map(f.assets);
  if (params.get('broken') === '1') {
    const [id, bytes] = [...assets][0];
    const copy = bytes.slice();
    copy[copy.length - 1] ^= 1;
    assets.set(id, copy);
  }
  if (params.get('hidden') === '1') for (const part of f.doc.parts) part.visible = false;
  // ?empty=1: a character with nothing in it yet (to model from a cube).
  if (params.get('empty') === '1')
    return { session: new EditorSession(emptyCharacter()), assets: new Map(), key: 0 };
  // ?props=late: the arm is already placed far to the side, and its view arrives after a moment.
  if (params.get('props') === 'late')
    f.doc.props.push({
      id: 'prop-arm',
      name: 'Robot arm',
      source: {
        kind: 'cad',
        artifactId: 'cad-arm',
        versionId: 'v-arm-1',
        contentHash: 'c'.repeat(64),
      },
      placement: { translation: [4000, 0, 0], rotation: [0, 0, 0, 1] },
      visible: true,
    });
  return { session: new EditorSession(f.doc), assets, key: 0 };
}

/** An axis-aligned box from `lo` to `hi` (mm), 24 corners with face normals. */
function box(lo: number[], hi: number[], color: string): CharacterPropMesh {
  const positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [0, 1]) {
      const n = [0, 0, 0];
      n[axis] = side ? 1 : -1;
      const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
      const base = positions.length / 3;
      for (const [a, b] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]) {
        const p = [0, 0, 0];
        p[axis] = side ? hi[axis]! : lo[axis]!;
        p[u] = a ? hi[u]! : lo[u]!;
        p[v] = b ? hi[v]! : lo[v]!;
        positions.push(...p);
        normals.push(...n);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    color,
    opacity: 1,
  };
}
const armBase = box([-150, -150, 0], [150, 150, 200], '#d0661f');
const armLink = box([0, -60, 200], [900, 60, 320], '#e3a21a');
// MR7: a tool held at the link's tip or set on the base (a mount with two candidates).
const armTool = box([-40, -40, 0], [40, 40, 80], '#4a7bd0');
const toolAt = (joint: string, a: number): [number, number, number] =>
  joint === 'j-tool-base' ? [0, 0, 200] : [900 * Math.cos(a), 900 * Math.sin(a), 320];
const armChoice: CharacterPropChoice = {
  artifactId: 'cad-arm',
  versionId: 'v-arm-1',
  contentHash: 'c'.repeat(64),
  label: 'Robot arm — v1',
};
// MR4: a second version of the arm whose turn is limited to ±90°.
const armChoice2: CharacterPropChoice = {
  ...armChoice,
  versionId: 'v-arm-2',
  contentHash: 'd'.repeat(64),
  label: 'Robot arm — v2',
};
const armJoints = (limit: number) => ({
  joints: [
    {
      id: 'j-turn',
      name: 'Turn',
      values: [{ key: 'angle' as const, saved: 0, min: -limit, max: limit }],
    },
  ],
  followers: [],
  // MR7: v2 has no mount for the tool.
  ...(limit === Math.PI
    ? { mounts: [{ id: 'm-tool', joints: ['j-tool-tip', 'j-tool-base'] }] }
    : {}),
});
const armView: CharacterPropView =
  params.get('props') === 'failed'
    ? { status: 'failed', message: 'part-build-mismatch' }
    : {
        status: 'ready',
        joints: [
          {
            id: 'j-turn',
            name: 'Turn',
            values: [{ key: 'angle', saved: 0, min: -Math.PI, max: Math.PI }],
          },
        ],
        // MR4: the version's forms; one no longer fits its joints.
        forms: [
          { id: 'f-folded', name: 'Folded', values: { 'j-turn': { angle: 0 } } },
          { id: 'f-open', name: 'Open', values: { 'j-turn': { angle: Math.PI / 2 } } },
          { id: 'f-old', name: 'Old', values: {}, problem: 'configuration-stale' },
          // MR7: the tool in hand, then set on the base with the link turned away.
          {
            id: 'f-hold',
            name: 'Holding',
            values: { 'j-turn': { angle: 0 } },
            mounts: { 'm-tool': 'j-tool-tip' },
          },
          {
            id: 'f-stow',
            name: 'Stowed',
            values: { 'j-turn': { angle: Math.PI / 2 } },
            mounts: { 'm-tool': 'j-tool-base' },
          },
        ],
        mounts: [
          {
            id: 'm-tool',
            name: 'Tool',
            joints: [
              { id: 'j-tool-tip', name: 'Tip' },
              { id: 'j-tool-base', name: 'Base' },
            ],
            active: 'j-tool-tip',
          },
        ],
        // MR5: the link hits the base past 100° (a stand-in for the Host's mesh check).
        checkInterferenceAlong: async (samples) => {
          const hits = samples
            .filter((s) => (s.values.get('j-turn')?.angle ?? 0) > (100 * Math.PI) / 180)
            .map((s) => ({
              tick: s.tick,
              overlaps: [
                {
                  a: 'Base',
                  b: 'Link',
                  aId: 'base',
                  bId: 'link',
                  kind: 'intersect' as const,
                  depthMm: 2,
                },
              ],
            }));
          // MR7: a switch moves the tool unless the link is at 0° (where tip and base agree, a
          // stand-in for the Host's gap).
          const jumps = [];
          let before = 'j-tool-tip';
          for (const s of samples) {
            const now = s.mounts?.get('m-tool') ?? 'j-tool-tip';
            const a = s.values.get('j-turn')?.angle ?? 0;
            if (now !== before && Math.abs(a) > 1e-6) {
              const [p, q] = [toolAt(before, a), toolAt(now, a)];
              const mm = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
              jumps.push({ tick: s.tick, mount: 'm-tool', from: before, to: now, mm, rad: 0 });
            }
            before = now;
          }
          return { status: 'ok', samples: samples.length, hits, unchecked: [], jumps };
        },
        draw: (values, mounts) => {
          const a = values.get('j-turn')?.angle ?? 0;
          const tool = toolAt(mounts?.get('m-tool') ?? 'j-tool-tip', a);
          return [
            {
              mesh: armBase,
              matrix: composeMat4({
                translation: [0, 0, 0],
                rotation: [0, 0, 0, 1],
                scale: [1, 1, 1],
              }),
            },
            {
              mesh: armLink,
              matrix: composeMat4({
                translation: [0, 0, 0],
                rotation: [0, 0, Math.sin(a / 2), Math.cos(a / 2)],
                scale: [1, 1, 1],
              }),
            },
            {
              mesh: armTool,
              matrix: composeMat4({ translation: tool, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }),
            },
          ];
        },
      };

// WM4: a fake watch movement: a balance, a pallet fork and an escape wheel (a continuous joint,
// no limits), with a seconds hand that follows the escape wheel (1/12, as a 20-tooth wheel at
// 28,800 beats per hour turns 12 times a minute) and keeps within ±180°.
const watchChoice: CharacterPropChoice = {
  artifactId: 'cad-watch',
  versionId: 'v-watch-1',
  contentHash: 'e'.repeat(64),
  label: 'Watch movement — v1',
};
const watchJoints = [
  {
    id: 'j-balance',
    name: 'Balance',
    values: [{ key: 'angle' as const, saved: 0, min: -2 * Math.PI, max: 2 * Math.PI }],
  },
  {
    id: 'j-fork',
    name: 'Fork',
    values: [{ key: 'angle' as const, saved: 0, min: -0.5, max: 0.5 }],
  },
  { id: 'j-escape', name: 'Escape wheel', values: [{ key: 'angle' as const, saved: 0 }] },
];
const turnedAbout = (centre: [number, number, number], a: number) =>
  composeMat4({
    translation: [
      centre[0] - centre[0] * Math.cos(a) + centre[1] * Math.sin(a),
      centre[1] - centre[0] * Math.sin(a) - centre[1] * Math.cos(a),
      0,
    ],
    rotation: [0, 0, Math.sin(a / 2), Math.cos(a / 2)],
    scale: [1, 1, 1],
  });
const watchMeshes = {
  balance: box([-50, -4, 0], [50, 4, 4], '#c8a040'),
  fork: box([60, -2, 0], [100, 2, 3], '#b03030'),
  escape: box([110, -15, 0], [140, 15, 3], '#4060c0'),
  hand: box([-2, 0, 10], [2, 60, 11], '#202020'),
};
const watchView: CharacterPropView = {
  status: 'ready',
  joints: watchJoints,
  // The seconds hand (`j-hand`, following the escape wheel at −1/12) keeps within ±180°.
  // MR4: a form with the escape wheel turned 2,200°, where the hand would be past its limits.
  forms: [
    { id: 'f-rest', name: 'At rest', values: { 'j-escape': { angle: 0 } } },
    { id: 'f-far', name: 'Turned far', values: { 'j-escape': { angle: (2200 * Math.PI) / 180 } } },
  ],
  limitViolation: (values) =>
    Math.abs((values.get('j-escape')?.angle ?? 0) / 12) > Math.PI
      ? { joint: 'j-hand', key: 'angle' }
      : undefined,
  draw: (values) => {
    const a = (j: string) => values.get(j)?.angle ?? 0;
    return [
      { mesh: watchMeshes.balance, matrix: turnedAbout([0, 0, 0], a('j-balance')) },
      { mesh: watchMeshes.fork, matrix: turnedAbout([80, 0, 0], a('j-fork')) },
      { mesh: watchMeshes.escape, matrix: turnedAbout([125, 0, 0], a('j-escape')) },
      { mesh: watchMeshes.hand, matrix: turnedAbout([0, 0, 0], -a('j-escape') / 12) },
    ];
  },
};

function App() {
  const [shown, setShown] = useState(initial);
  const [late, setLate] = useState(params.get('props') === 'late');
  useEffect(() => {
    if (!late) return;
    const t = setTimeout(() => setLate(false), 400);
    return () => clearTimeout(t);
  }, [late]);
  const [importError, setImportError] = useState<string>();
  // ?edit=revoke: the Host withdraws edit permission while it keeps a mesh asset.
  const [revoked, setRevoked] = useState(false);
  Object.assign(window, {
    characterSession: shown.session,
    // For the browser tests: a new session over the same assets, its skeleton moved by `x` mm.
    // With `inAction`, the rest pose stays and only the new first action (under new action ids)
    // holds the root bones `x` mm away.
    replaceCharacter: (x: number, inAction = false) =>
      setShown((s) => {
        const doc = structuredClone(s.session.content);
        if (inAction) {
          for (const a of doc.actions) a.id = `${a.id}-moved`;
          const first = doc.actions[0];
          for (const k of doc.skeletons)
            for (const b of k.bones.filter((b) => !b.parentId)) {
              const at: [number, number, number] = [...b.rest.translation];
              at[0] += x;
              const id = `${first.id}/${b.id}/translation`;
              first.tracks.push({
                id,
                target: { kind: 'bone', id: b.id, property: 'translation' },
                keys: [0, first.duration].map((tick, n) => ({
                  id: `${id}#${n}`,
                  tick,
                  value: at,
                  easing: { type: 'linear' },
                })),
              });
            }
        } else {
          for (const k of doc.skeletons)
            for (const b of k.bones) if (!b.parentId) b.rest.translation[0] += x;
          for (const part of doc.parts) part.transform.translation[0] += x;
        }
        return { ...s, session: new EditorSession(doc), key: s.key + 1 };
      }),
  });
  return (
    <CharacterSurface
      session={shown.session}
      assets={shown.assets}
      readOnly={readOnly}
      canEdit={() => !revoked}
      {...(params.get('admit') === 'refuse'
        ? {
            admit: () => {
              throw new Error('native-file-full');
            },
          }
        : {})}
      importError={importError}
      {...(params.get('props')
        ? {
            props: new Map(
              shown.session.content.props.map((p) => [
                p.id,
                late
                  ? ({ status: 'pending' } as const)
                  : p.source.artifactId === watchChoice.artifactId
                    ? watchView
                    : armView,
              ]),
            ),
            propChoices: [armChoice, armChoice2, watchChoice],
            onPreparePropVersion: async (_id: string, c: CharacterPropChoice) =>
              c.artifactId === watchChoice.artifactId
                ? { joints: watchJoints, followers: [] }
                : armJoints(c.contentHash === armChoice2.contentHash ? Math.PI / 2 : Math.PI),
            onAddProp: (c: CharacterPropChoice) => {
              const doc = shown.session.content;
              shown.session.execute(
                characterEditorCommand(
                  {
                    type: 'addProp',
                    prop: {
                      id: freshCharacterId(
                        doc,
                        c.artifactId === watchChoice.artifactId ? 'prop-watch' : 'prop-arm',
                      ),
                      name: c.label.replace(/ — .*$/, ''),
                      source: {
                        kind: 'cad',
                        artifactId: c.artifactId,
                        versionId: c.versionId,
                        contentHash: c.contentHash,
                      },
                      placement: { translation: [800, 0, 0], rotation: [0, 0, 0, 1] },
                      visible: true,
                    },
                  },
                  { expectedHash: characterContentHash(doc), canEdit: () => !readOnly },
                ),
              );
              setShown((s) => ({ ...s }));
            },
          }
        : {})}
      {...(params.get('edit')
        ? {
            onMeshAsset: async (
              { ref, bytes }: { ref: { id: string }; bytes: Uint8Array },
              more: readonly { ref: { id: string }; bytes: Uint8Array }[] = [],
            ) => {
              if (params.get('edit') === 'slow') await new Promise((r) => setTimeout(r, 300));
              if (params.get('edit') === 'refuse') throw new Error('asset-store-full');
              if (params.get('edit') === 'revoke') {
                setRevoked(true);
                await new Promise((r) => setTimeout(r, 100));
              }
              setShown((s) => {
                const assets = new Map(s.assets).set(ref.id, bytes);
                for (const m of more) assets.set(m.ref.id, m.bytes);
                return { ...s, assets };
              });
            },
          }
        : {})}
      {...(shown.report ? { report: shown.report } : {})}
      onExport={(file) =>
        // For the browser tests: the exported bytes, as the Host would save them.
        Object.assign(window, {
          characterExport: { name: file.name, bytes: [...file.bytes], losses: file.losses },
        })
      }
      onExportMedia={async (file) =>
        // C8: the exported file's bytes, for the browser tests.
        Object.assign(window, {
          characterMedia: {
            name: file.name,
            type: file.type,
            bytes: [...new Uint8Array(await file.data.arrayBuffer())],
          },
        })
      }
      onImport={async (file) => {
        try {
          const r = importGltf(new Uint8Array(await file.arrayBuffer()));
          // A file without a scene name is named after the file, as a Host would.
          if (r.doc.name === 'Imported')
            r.doc.name = file.name.replace(/\.[^.]+$/, '') || 'Imported';
          setImportError(undefined);
          setShown((s) => ({
            session: new EditorSession(r.doc),
            assets: r.assets,
            report: { fileName: file.name, losses: r.losses, ...(r.vrm ? { vrm: r.vrm } : {}) },
            key: s.key + 1,
          }));
        } catch (e) {
          // The shown character stays; nothing of the refused file is kept.
          if (!(e instanceof GltfImportError)) throw e;
          setImportError(`Import refused: ${e.problem} (${e.detail})`);
        }
      }}
      onFrame={(frame, playback, props, view) =>
        // For the browser tests: what is drawn, in millimetres, and where a point is on screen.
        Object.assign(window, {
          characterProject: view.project,
          characterFrame: {
            tick: playback.tick,
            playing: playback.playing,
            bounds: frameBounds(frame),
            parts: Object.fromEntries(
              frame.map((p) => [p.partId, { visible: p.visible, positions: [...p.positions] }]),
            ),
            props: Object.fromEntries(
              props.map((p) => [
                p.propId,
                { visible: p.visible, matrices: p.instances.map((i) => [...i.matrix]) },
              ]),
            ),
          },
        })
      }
    />
  );
}
// For the browser tests: the Host's input boundary, flushed as a Host flushes before a save.
const inputs = new EditorInputs();
Object.assign(window, { characterInputs: inputs });
createRoot(document.getElementById('root')!).render(
  <EditorInputsContext.Provider value={inputs}>
    <App />
  </EditorInputsContext.Provider>,
);
