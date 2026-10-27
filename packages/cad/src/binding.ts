import {
  CadAssemblyPort,
  type CadAdmission,
  type CadDocument,
  type CadSession,
} from '@editor-platform/cad-core';
import {
  CatalogKernelPort,
  type CadCatalogBuild,
  type CadKernelCatalog,
  type WorkerLike,
} from '@editor-platform/cad-kernel-occt';
import { EditorInputs } from '@editor-platform/editor-core';
import { CadAssembly, type CadPartSourceHost, type CadPartStore } from './assembly';
import { CadController, type CadAssetStore } from './controller';

/** A build no Worker can verify: documents stay readable and report the kernel as unavailable. */
const unavailable: CadCatalogBuild = {
  id: 'unavailable',
  buildHash: `sha256:${'0'.repeat(64)}`,
  moduleUrl: '',
  wasmUrl: '',
};
export interface CadBindingOptions {
  session: CadSession;
  /** Host-verified current kernel build, or null when this Host offers none. Relative URLs are resolved. */
  build: CadCatalogBuild | null;
  /**
   * Host-managed older builds, revocations and approved read-only substitutions (kernel
   * update, docs/cad/model.md). Never taken from a document.
   */
  kernels?: Omit<CadKernelCatalog, 'current'>;
  spawnWorker(): WorkerLike;
  canEdit(): boolean;
  permissionGeneration(): number;
  onApplied?(content: CadDocument): void;
  /**
   * D2 asset bytes kept by the Host. STEP import is offered only with it, and imported bodies
   * evaluate from it; a Host that cannot keep assets with the content leaves it out.
   */
  assets?: CadAssetStore;
  /** Stored-size admission of each edit (CAD23), for a Host with a native file limit. */
  admission?: CadAdmission;
  /**
   * R2b: the Host's retained part versions. Without it, an assembly shows its parts as boxes
   * (`part-source-missing`) and no part can be inserted.
   */
  parts?: CadPartStore;
  /** R2b: the Host's part-source capability (list, read and access of saved versions). */
  partSource?: CadPartSourceHost;
}
export interface CadBinding {
  controller: CadController;
  /** Part meshes and assembly edits; pass it to the Surface beside the controller. */
  assembly: CadAssembly;
  /** Message for a Host input guard while an edit is still evaluating, otherwise undefined. */
  pendingInput(): string | undefined;
  /**
   * Field buffers for a Host without its own registry: provide it as `EditorInputsContext`
   * around the Surface. It also holds the evaluating edit.
   */
  inputs: EditorInputs;
  /**
   * Save/export/detach boundary: commits valid field drafts, then throws while any input is
   * invalid, composing or still evaluating. With `keepEditor` (a save that leaves the editor
   * open), an edit that was already evaluating does not refuse: the save captures the committed
   * content and the edit applies afterwards (ST-28 #6, CAD21). An edit this flush commits, and
   * STEP assets still being stored, refuse either way.
   */
  flushInputs(options?: { keepEditor?: boolean }): void;
  /** Terminates the kernel Worker; the session and its content stay with the Host. */
  dispose(): void;
}

/**
 * The CAD input boundary state: an evaluating edit is pending work that settles by itself (it
 * never mixes into the content before it applies); storing STEP assets is not, and neither is an
 * edit waiting for its references to be chosen again (Confirm or Cancel ends it).
 */
export function cadInputState(controller: CadController, assembly?: CadAssembly) {
  const { busy, rebind, sketch } = controller.getSnapshot();
  // A pending reference choice or an open sketch waits for the editor, never settles by itself.
  const choosing = !!rebind?.withEdit || !!sketch;
  // An insert reads, stores and evaluates a part before its edit: nothing may leave meanwhile.
  const inserting = !!assembly?.getSnapshot().inserting;
  return {
    dirty: busy || choosing || inserting,
    settles: busy && !choosing && !inserting && !controller.stagingAssets,
  };
}

/** One kernel Worker and one controller for one Host session. */
export function createCadBinding(options: CadBindingOptions): CadBinding {
  // Both URLs are fetched inside the Worker, where relative URLs would resolve against its script.
  const absolute = (build: CadCatalogBuild): CadCatalogBuild => ({
    ...build,
    moduleUrl: new URL(build.moduleUrl, location.href).href,
    wasmUrl: new URL(build.wasmUrl, location.href).href,
  });
  const current = options.build ? absolute(options.build) : unavailable;
  const port = new CatalogKernelPort(
    {
      ...options.kernels,
      current,
      retained: options.kernels?.retained?.map(absolute),
    },
    {
      spawn: options.spawnWorker,
      // A part job's meshes belong to the parts every instance shares, not to the editor.
      onMeshes: (hash, meshes) =>
        assemblyPort.partJobs.has(hash)
          ? assembly.receive(hash, meshes)
          : controller.receiveMeshes(hash, meshes),
      ...(options.assets ? { assets: (sha256: string) => options.assets!.get(sha256) } : {}),
      // How far a long evaluation got (CM-4); a part's is shown by the parts' own count.
      onProgress: ({ candidateHash }, done, total) => {
        if (!assemblyPort.partJobs.has(candidateHash)) controller.receiveProgress(done, total);
      },
    },
  );
  // One build for the assembly and all its parts (R2b-U6), each version evaluated once.
  const assemblyPort = new CadAssemblyPort({
    kernel: port,
    parts: (hash) => options.parts?.get(hash),
    // Parts no joint reads evaluate after the result: the assembly can be edited and saved
    // while they do (R2b-4).
    background: true,
    // Each part also has a coarse display mesh, drawn when it is small on screen (R2b-4, LOD).
    coarse: true,
    ...(options.partSource ? { access: (id: string) => options.partSource!.checkAccess(id) } : {}),
  });
  const controller: CadController = new CadController({
    session: options.session,
    kernel: assemblyPort,
    canEdit: options.canEdit,
    permissionGeneration: options.permissionGeneration,
    onApplied: options.onApplied,
    exportMeshes: (request, deflectionMm) => port.exportMeshes(request, deflectionMm),
    exportStep: (request) => port.exportStep(request),
    analyzeContinuity: (request, edge) => port.analyzeContinuity(request, edge),
    analyzeCurvature: (request) => port.analyzeCurvature(request),
    analyzeComb: (request, edge) => port.analyzeComb(request, edge),
    importStep: (profile, requestId, bytes) => port.importStep(profile, requestId, bytes),
    ...(options.assets ? { assets: options.assets } : {}),
    ...(options.admission ? { admission: options.admission } : {}),
    ...(options.build ? { currentKernel: { id: current.id, buildHash: current.buildHash } } : {}),
  });
  const pendingInput = () =>
    assembly.getSnapshot().inserting
      ? '部品を挿入しています。終わってから、もう一度操作してください。'
      : controller.getSnapshot().rebind?.withEdit
        ? '参照の選び直しを確定するか取り消してから、もう一度操作してください。'
        : controller.getSnapshot().sketch
          ? 'スケッチを終えるか取り消してから、もう一度操作してください。'
          : controller.getSnapshot().busy
            ? '形状を計算中です。計算が終わってから、もう一度操作してください。'
            : undefined;
  const assembly = new CadAssembly({
    controller,
    port: assemblyPort,
    exportBrep: (request) => port.exportBrep(request),
    exportAssemblyStep: (profile, requestId, plan, breps) =>
      port.exportAssemblyStep(profile, requestId, plan, breps),
    importStepAssembly: (profile, requestId, bytes) =>
      port.importStepAssembly(profile, requestId, bytes),
    ...(options.parts ? { store: options.parts } : {}),
    ...(options.partSource ? { source: options.partSource } : {}),
  });
  const inputs = new EditorInputs();
  const release = inputs.register({
    label: '3D CAD',
    read: () => cadInputState(controller, assembly),
    prepare: () => {
      throw new Error(pendingInput());
    },
    focus: () => {},
  });
  return {
    controller,
    assembly,
    pendingInput,
    inputs,
    flushInputs: (options = {}) => {
      const started = controller.startedEdits;
      inputs.flush(options);
      // A field this flush committed starts an evaluation: it is the latest input, so wait for it.
      const pending = pendingInput();
      if (
        pending &&
        (!options.keepEditor || controller.stagingAssets || controller.startedEdits !== started)
      )
        throw new Error(pending);
    },
    dispose: () => {
      release();
      assembly.dispose();
      assemblyPort.dispose();
      port.dispose();
    },
  };
}
