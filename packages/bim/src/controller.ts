import {
  BimOperationError,
  bimContentHash,
  bimEditorCommand,
  BimValidationError,
  deriveBim,
  type BimDerived,
  type BimDocument,
  type BimElement,
  type BimOperation,
  type BimAssetRef,
  type BimView,
} from '@editor-platform/bim-core';
import type { GeometryTextureRole, GeometryTextureSet } from '@editor-platform/geometry-core';
import type { EditorSession } from '@editor-platform/editor-core';
import type { BimIfcExport } from '@editor-platform/bim-ifc';
import { BimDrawings } from './drawing';
import { bimNewId } from './drafting';
import { BimEvaluator, type BimEvaluation, type BimKernel } from './evaluate';
import { exportBimIfc } from './ifc';
import type { BimPartReference, BimPartShape, BimPartSource, BimPartStatus } from './parts';

/**
 * The bim Surface's state without React (docs/cad/r2c-architecture.md, Surface; R2c-3c). Edits
 * are pure operations: each is one session command, applied at once and saved, then evaluated
 * in the background. An element that fails to build is named in the evaluation and never stops
 * the edit or the save (a building is not one solid).
 */
/** What the controller needs of a session: a Host can pass its own (artifact Host). */
export type BimSession = Pick<EditorSession<BimDocument>, 'content' | 'execute'>;

export interface BimControllerOptions {
  session: BimSession;
  kernel: BimKernel;
  /** Trusted, current edit authority; re-read by every command. */
  canEdit(): boolean;
  /** After an edit is applied: the Host saves the draft. */
  onApplied?(content: BimDocument): void;
  /** Normalized BRep of placed parts, by content hash. */
  assets?(): Map<string, Uint8Array>;
  /** The Host's CAD versions: part types read their shapes from it (R2c-U2). */
  parts?: BimPartSource;
  /** The Host's store of texture images (#662); without it materials take no textures. */
  textures?: BimAssetStore;
}

/**
 * Where a Host keeps a building's texture images (#662): by content hash, outside the content.
 * `stage` resolves once the bytes are stored; the content names them afterwards, in its own edit.
 */
export interface BimAssetStore {
  get(sha256: string): Uint8Array | undefined;
  stage(assets: { ref: BimAssetRef; bytes: Uint8Array }[]): Promise<void>;
}

/** Why the last edit was refused: a diagnostic or operation code and the entities it names. */
export interface BimNotice {
  code: string;
  ids: string[];
  path?: string;
  /** A refused delete: the entities it would have deleted, on the content it was refused on. */
  delete?: { ids: string[]; hash: string };
  /** The Host's own words, when it refused (a texture that could not be stored). */
  message?: string;
}

/**
 * TW3: the kernel's measured quantities, only when the adopted evaluation is of the current
 * content; while a newer one runs, an edited element's measurement is not known yet.
 */
export const bimCurrentKernelQuantities = (
  s: Pick<BimState, 'hash' | 'evaluatedHash' | 'evaluation'>,
) => (s.evaluatedHash === s.hash ? s.evaluation?.kernelQuantities : undefined);

export interface BimState {
  content: BimDocument;
  hash: string;
  derived: BimDerived;
  /** The latest evaluation adopted; it may be for an earlier hash while `evaluating`. */
  evaluation?: Extract<BimEvaluation, { status: 'ok' }>;
  evaluatedHash?: string;
  evaluating: boolean;
  selection: string[];
  /** The level the plan and the element list show. */
  level?: string;
  notice?: BimNotice;
  readOnly: boolean;
  /** Each part type's shape, by its version's content hash. */
  parts: ReadonlyMap<string, BimPartStatus>;
}

export class BimController {
  private current: BimState;
  private readonly listeners = new Set<() => void>();
  private readonly evaluator: BimEvaluator;
  private disposed = false;
  /** Part shapes read from the Host, by content hash; kept for the session. */
  private readonly shapes = new Map<string, Uint8Array>();
  private drawings: BimDrawings | undefined;

  constructor(private readonly options: BimControllerOptions) {
    this.evaluator = new BimEvaluator(options.kernel);
    const content = options.session.content;
    this.current = {
      ...this.derive(content),
      evaluating: false,
      selection: [],
      level: content.levels[0]?.id,
      readOnly: !options.canEdit(),
      parts: new Map(),
    };
    this.loadParts();
    void this.evaluate();
  }

  get state(): BimState {
    return this.current;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * Applies one operation as one session command. Returns the refusal's code, which is also
   * the state's `notice`; nothing changes then.
   */
  apply(op: BimOperation): string | undefined {
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied', ids: [] });
    let next: BimDocument;
    try {
      next = this.options.session.execute(
        bimEditorCommand(op, {
          expectedHash: this.current.hash,
          canEdit: () => this.options.canEdit(),
        }),
      );
    } catch (error) {
      return this.refuse({
        ...noticeOf(error),
        ...(op.type === 'delete' ? { delete: { ids: [...op.ids], hash: this.current.hash } } : {}),
      });
    }
    this.adopt(next, { notice: undefined });
    this.options.onApplied?.(next);
    return undefined;
  }
  /** Replaces one element, keeping its kind (attributes, type, placement values). */
  updateElement(element: BimElement) {
    return this.apply({ type: 'update', collection: 'elements', entity: element });
  }

  /** Host Undo, Redo or restore changed the session: show and evaluate its content. */
  sync() {
    const content = this.options.session.content;
    if (bimContentHash(content) === this.current.hash) return;
    this.adopt(content, {});
  }
  /** The Host's edit authority changed. */
  accessChanged() {
    this.set({ readOnly: !this.options.canEdit() });
  }

  select(ids: string[]) {
    const known = new Set(this.current.content.elements.map((e) => e.id));
    const selection = ids.filter((id) => known.has(id));
    // A refusal is about what was selected: another selection drops it.
    const same = selection.join('\u0000') === this.current.selection.join('\u0000');
    this.set({ selection, ...(same ? {} : { notice: undefined }) });
  }
  setLevel(level: string) {
    if (this.current.content.levels.some((l) => l.id === level)) this.set({ level });
  }
  dismissNotice() {
    this.set({ notice: undefined });
  }
  /** Shows why a drawing could not become an operation (nothing changes). */
  report(notice: BimNotice) {
    this.refuse(notice);
  }

  /** Whether the Host offers CAD versions to place. */
  get partsOffered() {
    return !!this.options.parts;
  }
  /** The CAD versions the Host offers. */
  listParts() {
    return this.options.parts?.list() ?? Promise.resolve([]);
  }
  /**
   * Makes a part type from an exact CAD version: its shape is read first (its bounds are the
   * type's hint), the version is kept with the building, then the type is inserted as one edit.
   * Returns the refusal's code, which is also the `notice`.
   */
  async addPartType(source: BimPartReference, name: string): Promise<string | undefined> {
    const parts = this.options.parts;
    if (!parts) return this.refuse({ code: 'part-source-unavailable', ids: [] });
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied', ids: [] });
    try {
      const shape = await parts.shape(source);
      await parts.retain(source);
      this.shapes.set(source.contentHash, shape.brep);
      this.setPart(source.contentHash, {
        status: 'available',
        ...partAvailable(shape),
      });
      const [min, max] = shape.bounds;
      const doc = this.current.content;
      return this.apply({
        type: 'insert',
        entities: {
          types: [
            { id: bimNewId(doc, 'pt'), kind: 'part', name, source, hintBounds: { min, max } },
          ],
        },
      });
    } catch (error) {
      return this.refuse({ code: error instanceof Error ? error.message : String(error), ids: [] });
    }
  }

  /** Whether the Host stores texture images, so a material can take one (#662). */
  get canTexture() {
    return !!this.options.textures;
  }
  /** A stored texture image's bytes, by hash. */
  assetBytes(sha256: string) {
    return this.options.textures?.get(sha256);
  }
  /**
   * Puts a downloaded texture on a material (#662): the images are stored with the Host first,
   * then the material names them in one edit, which also adds their refs. As in glTF the values
   * multiply the maps, so a colour map makes the colour white and a roughness or metalness map
   * makes that value 1. Returns the refusal's code, which is also the `notice`.
   */
  async adoptTextures(
    materialId: string,
    files: readonly { role: GeometryTextureRole; bytes: Uint8Array; mediaType: string }[],
    textures: Omit<GeometryTextureSet, 'maps'>,
  ): Promise<string | undefined> {
    const store = this.options.textures;
    if (!store) return this.refuse({ code: 'texture-unavailable', ids: [] });
    if (!this.options.canEdit()) return this.refuse({ code: 'permission-denied', ids: [] });
    if (!files.length) return this.refuse({ code: 'texture-empty', ids: [] });
    const doc = this.current.content;
    if (!doc.materials.some((m) => m.id === materialId))
      return this.refuse({ code: 'target-missing', ids: [materialId] });
    // Each image by its hash; IDs are given after staging, against the content as it is then.
    const staged: { ref: BimAssetRef; bytes: Uint8Array }[] = [];
    const roles: [GeometryTextureRole, BimAssetRef][] = [];
    for (const file of files) {
      const kind =
        file.mediaType === 'image/png'
          ? 'texture-png'
          : file.mediaType === 'image/jpeg'
            ? 'texture-jpeg'
            : undefined;
      if (!kind) return this.refuse({ code: 'texture-media-type', ids: [] });
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', file.bytes as BufferSource),
      );
      const sha256 = `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
      let ref = staged.find((a) => a.ref.kind === kind && a.ref.sha256 === sha256)?.ref;
      if (!ref) {
        // A provisional ID for the Host; the edit gives the final one.
        const id = bimNewId(doc, 'asset', new Set(staged.map((x) => x.ref.id)));
        ref = {
          id,
          kind,
          sha256,
          byteLength: file.bytes.byteLength,
          mediaType: kind === 'texture-png' ? 'image/png' : 'image/jpeg',
        };
        staged.push({ ref, bytes: file.bytes });
      }
      roles.push([file.role, ref]);
    }
    try {
      await store.stage(staged);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.refuse({ code: 'texture-stage-failed', ids: [], message });
    }
    // Read the content again: an edit (or another texture) may have landed while the images
    // were stored. An image it already holds keeps its ref; a new one gets an ID free in the
    // whole document's namespace (Codex).
    const now = this.current.content;
    const material = now.materials.find((m) => m.id === materialId);
    if (!material) return this.refuse({ code: 'target-missing', ids: [materialId] });
    const taken = new Set<string>();
    const added: BimAssetRef[] = [];
    const final = new Map<BimAssetRef, BimAssetRef>();
    for (const { ref } of staged) {
      const held = now.assets?.find((a) => a.kind === ref.kind && a.sha256 === ref.sha256);
      if (held) final.set(ref, held);
      else {
        const id = bimNewId(now, 'asset', taken);
        taken.add(id);
        const next = { ...ref, id };
        added.push(next);
        final.set(ref, next);
      }
    }
    const maps: GeometryTextureSet['maps'] = {};
    for (const [role, ref] of roles) maps[role] = final.get(ref)!.id;
    const a = material.appearance ?? { color: '#ffffff', opacity: 1, roughness: 1, metalness: 0 };
    const { preset: _preset, ...look } = a;
    return this.apply({
      type: 'update',
      collection: 'materials',
      entity: {
        ...material,
        appearance: {
          ...look,
          ...(maps.color ? { color: '#ffffff' } : {}),
          ...(maps.roughness ? { roughness: 1 } : {}),
          ...(maps.metalness ? { metalness: 1 } : {}),
          textures: { ...textures, maps },
        },
      },
      assets: added,
    });
  }

  /**
   * A view's drawing of the current content (R2c-5), with the part shapes read so far. Reading
   * needs no edit authority, and a drawing never changes the document.
   */
  draw(view: BimView) {
    this.drawings ??= new BimDrawings(this.options.kernel);
    return this.drawings.draw(this.current.content, view, this.assets(), this.current.parts);
  }

  /**
   * The current content as an IFC file (R2c-6): what only the kernel knows (clipped volumes,
   * part meshes) is measured in its own job, so the screen's display never changes the file.
   * Reading needs no edit authority. A refusal is the `notice`, naming the elements.
   */
  async exportIfc(file: {
    artifactId: string;
    timeStamp: string;
    fileName?: string;
  }): Promise<BimIfcExport | undefined> {
    const parts = this.current.parts;
    const result = await exportBimIfc(this.current.content, this.options.kernel, {
      ...file,
      assets: this.assets(),
      part: (hash) => parts.get(hash),
    });
    if (result.status === 'ok') return result.file;
    this.refuse({ code: result.code, ids: result.ids });
    return undefined;
  }

  /** Stops listening; a running evaluation is not adopted. */
  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }

  private derive(content: BimDocument) {
    return { content, hash: bimContentHash(content), derived: deriveBim(content) };
  }
  private adopt(content: BimDocument, extra: Partial<BimState>) {
    const known = new Set(content.elements.map((e) => e.id));
    const level = content.levels.some((l) => l.id === this.current.level)
      ? this.current.level
      : content.levels[0]?.id;
    this.set({
      ...this.derive(content),
      ...extra,
      selection: this.current.selection.filter((id) => known.has(id)),
      level,
    });
    this.loadParts();
    void this.evaluate();
  }
  /** Reads the shape of each part type not read yet; each arrival evaluates again. */
  private loadParts() {
    for (const t of this.current.content.types) {
      if (t.kind !== 'part') continue;
      const hash = t.source.contentHash;
      if (this.current.parts.has(hash)) continue;
      const parts = this.options.parts;
      if (!parts) {
        this.setPart(hash, { status: 'unavailable', code: 'part-source-unavailable' });
        continue;
      }
      this.setPart(hash, { status: 'loading' });
      parts.shape(t.source).then(
        (shape) => {
          this.shapes.set(hash, shape.brep);
          this.setPart(hash, { status: 'available', ...partAvailable(shape) });
          void this.evaluate();
        },
        (error) =>
          this.setPart(hash, {
            status: 'unavailable',
            code: error instanceof Error ? error.message : String(error),
          }),
      );
    }
  }
  private setPart(hash: string, status: BimPartStatus) {
    this.set({ parts: new Map(this.current.parts).set(hash, status) });
  }
  private refuse(notice: BimNotice) {
    this.set({ notice });
    return notice.code;
  }
  private async evaluate() {
    const { content, hash } = this.current;
    this.set({ evaluating: true });
    const result = await this.evaluator.evaluate(content, { assets: this.assets() });
    // A later edit started another evaluation, which adopts its own result.
    if (this.disposed || result.status !== 'ok' || hash !== this.current.hash) return;
    this.set({ evaluation: result, evaluatedHash: hash, evaluating: false });
  }
  private assets() {
    return new Map([...(this.options.assets?.() ?? []), ...this.shapes]);
  }
  private set(patch: Partial<BimState>) {
    if (this.disposed) return;
    this.current = { ...this.current, ...patch };
    for (const l of this.listeners) l();
  }
}

/**
 * What a drawing of the current state is drawn from: the content and the part shapes read so
 * far. A shape that arrives after a drawing was made changes it, so the drawing is made again.
 */
export function bimDrawingKey(state: Pick<BimState, 'hash' | 'parts'>) {
  const shapes = [...state.parts]
    .filter(([, p]) => p.status === 'available')
    .map(([hash]) => hash)
    .sort();
  return [state.hash, ...shapes].join('\u0000');
}

function noticeOf(error: unknown): BimNotice {
  if (error instanceof BimOperationError) return { code: error.code, ids: error.dependents };
  if (error instanceof BimValidationError) {
    const d = error.diagnostics[0];
    return { code: d?.code ?? 'bim-invalid', ids: d?.id ? [d.id] : [], path: d?.path };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: message || 'edit-failed', ids: [] };
}

/** What a read shape tells the view and drawings, without its bytes. */
function partAvailable(shape: BimPartShape) {
  const { kinds, bounds, looks, faces } = shape;
  const sized = looks && faces && looks.length === kinds.length && faces.length === kinds.length;
  return { kinds, bounds, ...(sized ? { looks, faces } : {}) };
}
