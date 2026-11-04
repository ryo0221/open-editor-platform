/**
 * The texture part of a look (#662), shared by CAD's Appearance and the building's materials:
 * the set it carries, its real size, turn and normal-map convention, and reading a new set from
 * the files the user downloaded (a zip as a free texture site gives it, or the images). Each
 * file's map is read from its name and can be changed before the set is put on. Domain-free:
 * the caller stores the images and makes the edit.
 */
import { useRef, useState } from 'react';
import { CommitInput, Dialog } from '@editor-platform/editor-ui';
import {
  geometryTextureLimits,
  geometryTextureRoles,
  type GeometryNormalConvention,
  type GeometryTextureRole,
} from '@editor-platform/geometry-core';
import type { GeometryTextureSet } from '@editor-platform/geometry-core';
import { readTextureFiles, type ViewTextureFile, type ViewTextureRead } from './texture-files';
import './texture-panel.css';

/** The files chosen for a new set, with their maps, and the set's other values. */
export type ViewTextureAdd = (
  files: { role: GeometryTextureRole; bytes: Uint8Array; mediaType: string }[],
  set: Omit<GeometryTextureSet, 'maps'>,
) => void | Promise<unknown>;

const roleNames: Record<GeometryTextureRole, string> = {
  color: 'Colour',
  normal: 'Normal',
  roughness: 'Roughness',
  metalness: 'Metalness',
  occlusion: 'Ambient occlusion',
};
const ignoredNames: Record<string, string> = {
  'not-image': 'not a PNG or JPEG image',
  displacement: 'height map (not drawn)',
  opacity: 'opacity map (not drawn)',
  other: 'map not drawn',
  preview: 'preview image',
  duplicate: 'another file has this map',
};
const problemNames: Record<NonNullable<ViewTextureFile['problem']>, string> = {
  'too-large': `over ${geometryTextureLimits.imageBytes / 1024 / 1024} MiB`,
  'too-many-pixels': `over ${geometryTextureLimits.imagePixels} px`,
  unreadable: 'cannot be read',
};
const { minSizeMm, maxSizeMm } = geometryTextureLimits;
const sizeOk = (v: number) => Number.isFinite(v) && v >= minSizeMm && v <= maxSizeMm;

export function TextureEditor({
  set: t,
  readOnly,
  canAdd,
  onChange,
  onAdd,
  testId = 'view-texture',
}: {
  set: GeometryTextureSet | undefined;
  readOnly: boolean;
  /** The Host keeps images: a set can be added or replaced. */
  canAdd: boolean;
  /** A changed set (size, turn, convention), or undefined to take it off. */
  onChange(set: GeometryTextureSet | undefined): void;
  onAdd: ViewTextureAdd;
  testId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [read, setRead] = useState<ViewTextureRead>();
  const [problem, setProblem] = useState<string>();
  const set = onChange;
  const maps = t
    ? (Object.keys(t.maps) as GeometryTextureRole[]).map((r) => roleNames[r]).join(', ')
    : '';
  if (readOnly)
    return t ? (
      <dl className="view-texture-info" data-testid={testId}>
        <dt>Texture</dt>
        <dd>{t.name}</dd>
        <dt>Maps</dt>
        <dd>{maps}</dd>
        <dt>Size</dt>
        <dd>
          {t.sizeMm[0]} × {t.sizeMm[1]} mm
        </dd>
        {t.source && (
          <>
            <dt>Source</dt>
            <dd className="view-texture-url">{t.source}</dd>
          </>
        )}
        {t.license && (
          <>
            <dt>Licence</dt>
            <dd>{t.license}</dd>
          </>
        )}
      </dl>
    ) : null;
  const choose = async (files: FileList | null) => {
    if (!files?.length) return;
    setProblem(undefined);
    try {
      const chosen = await Promise.all(
        [...files].map(async (f) => ({
          name: f.name,
          bytes: new Uint8Array(await f.arrayBuffer()),
        })),
      );
      setRead(await readTextureFiles(chosen));
    } catch {
      setProblem('The files could not be read (a zip over 64 MB or a damaged zip).');
    }
  };
  return (
    <div className="view-texture" data-testid={testId}>
      {t ? (
        <>
          <p>
            Texture <strong>{t.name}</strong> ({maps})
          </p>
          <div className="view-texture-row">
            <CommitInput
              label="Width (mm)"
              type="number"
              min={minSizeMm}
              max={maxSizeMm}
              value={t.sizeMm[0]}
              onCommit={(v) => {
                if (!sizeOk(Number(v))) return false;
                set({ ...t, sizeMm: [Number(v), t.sizeMm[1]] });
              }}
            />
            <CommitInput
              label="Height (mm)"
              type="number"
              min={minSizeMm}
              max={maxSizeMm}
              value={t.sizeMm[1]}
              onCommit={(v) => {
                if (!sizeOk(Number(v))) return false;
                set({ ...t, sizeMm: [t.sizeMm[0], Number(v)] });
              }}
            />
          </div>
          <CommitInput
            label="Rotation (°)"
            type="number"
            min={-360}
            max={360}
            value={t.rotationDeg}
            onCommit={(v) => {
              const n = Number(v);
              if (!Number.isFinite(n) || Math.abs(n) > 360) return false;
              set({ ...t, rotationDeg: n });
            }}
          />
          {t.maps.normal && (
            <label className="ep-field">
              Normal map
              <select
                value={t.normal}
                onChange={(e) => set({ ...t, normal: e.target.value as GeometryNormalConvention })}
              >
                <option value="gl">OpenGL (y up)</option>
                <option value="dx">DirectX (y down)</option>
              </select>
            </label>
          )}
          {(t.source || t.license) && (
            <p className="view-texture-muted">
              {t.license && <>Licence {t.license}. </>}
              {t.source && <span className="view-texture-url">{t.source}</span>}
            </p>
          )}
          <div className="view-texture-row">
            {canAdd && (
              <button type="button" onClick={() => input.current?.click()}>
                Replace texture…
              </button>
            )}
            <button type="button" onClick={() => set(undefined)}>
              Remove texture
            </button>
          </div>
        </>
      ) : (
        canAdd && (
          <button type="button" onClick={() => input.current?.click()}>
            Add texture…
          </button>
        )
      )}
      {problem && <p role="alert">{problem}</p>}
      <input
        ref={input}
        type="file"
        multiple
        accept=".zip,.png,.jpg,.jpeg,application/zip,image/png,image/jpeg"
        hidden
        aria-label="Texture files"
        onChange={(e) => {
          const files = e.target.files;
          void choose(files).finally(() => (e.target.value = ''));
        }}
      />
      {read && <TextureImportDialog read={read} onAdd={onAdd} onClose={() => setRead(undefined)} />}
    </div>
  );
}

/** The read files with their maps, and the set's size and source, before it is put on. */
function TextureImportDialog({
  read,
  onAdd,
  onClose,
}: {
  read: ViewTextureRead;
  onAdd: ViewTextureAdd;
  onClose: () => void;
}) {
  const [roles, setRoles] = useState<string[]>(() => read.files.map((f) => f.role ?? ''));
  const usable = read.files.map((f) => !f.problem && !!f.mediaType);
  const normalFile = read.files.find((f, i) => roles[i] === 'normal');
  const [normal, setNormal] = useState<GeometryNormalConvention>(normalFile?.normal ?? 'gl');
  const [name, setName] = useState(read.name);
  const [width, setWidth] = useState('1000');
  const [height, setHeight] = useState('1000');
  const [source, setSource] = useState('');
  const [license, setLicense] = useState('CC0');
  const chosen = read.files.flatMap((f, i) =>
    roles[i] && usable[i] ? [{ file: f, role: roles[i] as GeometryTextureRole }] : [],
  );
  const twice = geometryTextureRoles.filter((r) => chosen.filter((c) => c.role === r).length > 1);
  const size = [Number(width), Number(height)] as [number, number];
  const sourceOk = !source.trim() || /^https?:\/\/\S+$/.test(source.trim());
  const ok =
    chosen.length > 0 &&
    !twice.length &&
    size.every(sizeOk) &&
    sourceOk &&
    !!name.trim() &&
    [...license].length <= 64;
  const apply = async () => {
    onClose();
    await onAdd(
      chosen.map((c) => ({ role: c.role, bytes: c.file.bytes, mediaType: c.file.mediaType! })),
      {
        name: [...name.trim()].slice(0, 256).join(''),
        sizeMm: size,
        rotationDeg: 0,
        normal,
        ...(source.trim() ? { source: source.trim() } : {}),
        ...(license.trim() ? { license: license.trim() } : {}),
      },
    );
  };
  return (
    <Dialog title="Add texture" onClose={onClose}>
      <div className="view-texture-dialog" data-testid="view-texture-import">
        <table className="view-texture-files">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Map</th>
            </tr>
          </thead>
          <tbody>
            {read.files.map((f, i) => (
              <tr key={f.name}>
                <td>
                  {f.name}
                  {f.width ? (
                    <span className="view-texture-muted">
                      {' '}
                      {f.width} × {f.height} px
                    </span>
                  ) : null}
                </td>
                <td>
                  {usable[i] ? (
                    <select
                      aria-label={`Map of ${f.name}`}
                      value={roles[i]}
                      onChange={(e) =>
                        setRoles(roles.map((r, k) => (k === i ? e.target.value : r)))
                      }
                    >
                      <option value="">
                        Not used
                        {!roles[i] && f.ignored ? ` (${ignoredNames[f.ignored] ?? f.ignored})` : ''}
                      </option>
                      {geometryTextureRoles.map((r) => (
                        <option key={r} value={r}>
                          {roleNames[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="view-texture-muted">
                      Not used (
                      {f.problem
                        ? problemNames[f.problem]
                        : (ignoredNames[f.ignored ?? ''] ?? f.ignored)}
                      )
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {twice.length > 0 && (
          <p role="alert">
            Choose one file for each map: {twice.map((r) => roleNames[r]).join(', ')} is chosen
            twice.
          </p>
        )}
        <label className="ep-field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="view-texture-muted">
          The real size one image covers, as the texture site gives it (e.g. 2000 × 2000 mm).
        </p>
        <div className="view-texture-row">
          <label className="ep-field">
            Width (mm)
            <input
              type="number"
              min={minSizeMm}
              max={maxSizeMm}
              value={width}
              onChange={(e) => setWidth(e.target.value)}
            />
          </label>
          <label className="ep-field">
            Height (mm)
            <input
              type="number"
              min={minSizeMm}
              max={maxSizeMm}
              value={height}
              onChange={(e) => setHeight(e.target.value)}
            />
          </label>
        </div>
        {roles.includes('normal') && (
          <label className="ep-field">
            Normal map
            <select
              value={normal}
              onChange={(e) => setNormal(e.target.value as GeometryNormalConvention)}
            >
              <option value="gl">OpenGL (y up)</option>
              <option value="dx">DirectX (y down)</option>
            </select>
          </label>
        )}
        <label className="ep-field">
          Source URL
          <input
            type="url"
            value={source}
            placeholder="https://"
            aria-invalid={!sourceOk || undefined}
            onChange={(e) => setSource(e.target.value)}
          />
        </label>
        <label className="ep-field">
          Licence
          <input value={license} maxLength={64} onChange={(e) => setLicense(e.target.value)} />
        </label>
        <p className="view-texture-muted">
          The images are kept with the document, so it shows the same wherever it is opened.
        </p>
        <div className="view-texture-row">
          <button type="button" disabled={!ok} onClick={() => void apply()}>
            Add texture
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
