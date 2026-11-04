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
const armChoice: CharacterPropChoice = {
  artifactId: 'cad-arm',
  versionId: 'v-arm-1',
  contentHash: 'c'.repeat(64),
  label: 'Robot arm — v1',
};
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
        draw: (values) => {
          const a = values.get('j-turn')?.angle ?? 0;
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
                late ? ({ status: 'pending' } as const) : armView,
              ]),
            ),
            propChoices: [armChoice],
            onAddProp: (c: CharacterPropChoice) => {
              const doc = shown.session.content;
              shown.session.execute(
                characterEditorCommand(
                  {
                    type: 'addProp',
                    prop: {
                      id: freshCharacterId(doc, 'prop-arm'),
                      name: 'Robot arm',
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
            onMeshAsset: async ({ ref, bytes }: { ref: { id: string }; bytes: Uint8Array }) => {
              if (params.get('edit') === 'slow') await new Promise((r) => setTimeout(r, 300));
              if (params.get('edit') === 'refuse') throw new Error('asset-store-full');
              if (params.get('edit') === 'revoke') {
                setRevoked(true);
                await new Promise((r) => setTimeout(r, 100));
              }
              setShown((s) => ({ ...s, assets: new Map(s.assets).set(ref.id, bytes) }));
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
