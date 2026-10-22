import type { CadDocument, CadSession } from '@editor-platform/cad-core';
import {
  WorkerKernelPort,
  type CadKernelBuild,
  type WorkerLike,
} from '@editor-platform/cad-kernel-occt';
import { EditorInputs } from '@editor-platform/editor-core';
import { CadController } from './controller';

/** A build no Worker can verify: documents stay readable and report the kernel as unavailable. */
const unavailable: CadKernelBuild = {
  buildHash: `sha256:${'0'.repeat(64)}`,
  moduleUrl: '',
  wasmUrl: '',
};
export interface CadBindingOptions {
  session: CadSession;
  /** Host-verified kernel build, or null when this Host offers none. Relative URLs are resolved. */
  build: CadKernelBuild | null;
  spawnWorker(): WorkerLike;
  canEdit(): boolean;
  permissionGeneration(): number;
  onApplied?(content: CadDocument): void;
}
export interface CadBinding {
  controller: CadController;
  /** Message for a Host input guard while an edit is still evaluating, otherwise undefined. */
  pendingInput(): string | undefined;
  /**
   * Field buffers for a Host without its own registry: provide it as `EditorInputsContext`
   * around the Surface. It also holds the evaluating edit.
   */
  inputs: EditorInputs;
  /** Save/export/detach boundary: commits valid field drafts, then throws while any input is invalid, composing or still evaluating. */
  flushInputs(): void;
  /** Terminates the kernel Worker; the session and its content stay with the Host. */
  dispose(): void;
}

/** One kernel Worker and one controller for one Host session. */
export function createCadBinding(options: CadBindingOptions): CadBinding {
  const build = options.build
    ? {
        ...options.build,
        // Both are fetched inside the Worker, where relative URLs would resolve against its script.
        moduleUrl: new URL(options.build.moduleUrl, location.href).href,
        wasmUrl: new URL(options.build.wasmUrl, location.href).href,
      }
    : unavailable;
  const port = new WorkerKernelPort({
    spawn: options.spawnWorker,
    build,
    onMeshes: (hash, meshes) => controller.receiveMeshes(hash, meshes),
  });
  const controller: CadController = new CadController({
    session: options.session,
    kernel: port,
    canEdit: options.canEdit,
    permissionGeneration: options.permissionGeneration,
    onApplied: options.onApplied,
  });
  const pendingInput = () =>
    controller.getSnapshot().busy
      ? '形状を計算中です。計算が終わってから、もう一度操作してください。'
      : undefined;
  const inputs = new EditorInputs();
  const release = inputs.register({
    label: '3D CAD',
    read: () => ({ dirty: !!pendingInput() }),
    prepare: () => {
      throw new Error(pendingInput());
    },
    focus: () => {},
  });
  return {
    controller,
    pendingInput,
    inputs,
    flushInputs: () => {
      inputs.flush();
      // A committed field starts an evaluation: refuse until its result is applied.
      const pending = pendingInput();
      if (pending) throw new Error(pending);
    },
    dispose: () => {
      release();
      port.dispose();
    },
  };
}
