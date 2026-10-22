import { createRoot } from 'react-dom/client';
import { emptyCad, f02Plate, fixtureKernel, type CadDocument } from '@editor-platform/cad-core';
import { WorkerKernelPort } from '@editor-platform/cad-kernel-occt';
import KernelWorker from '@editor-platform/cad-kernel-occt/worker?worker';
import { EditorSession } from '@editor-platform/editor-core';
import '@editor-platform/editor-ui/styles.css';
import kernelBuild from 'virtual:cad-kernel-build';
import { CadController, CadSurface } from '../src';

// Standalone host: ?fixture=plate, ?readonly=1, ?kernel=missing, ?pair=1 (two Surfaces).
const params = new URLSearchParams(location.search);
const buildHash =
  params.get('kernel') === 'missing' || !kernelBuild
    ? 'sha256:' + '0'.repeat(64)
    : kernelBuild.buildHash;
const empty = emptyCad({ ...fixtureKernel, buildHash });
const initial: CadDocument =
  params.get('fixture') === 'plate'
    ? { ...f02Plate('center'), kernelProfile: empty.kernelProfile }
    : empty;
let n = 0;
function mount() {
  const port = new WorkerKernelPort({
    spawn: () => new KernelWorker() as never,
    build: {
      buildHash,
      moduleUrl: new URL(kernelBuild?.moduleUrl ?? '/cad-kernel/kernel.js', location.href).href,
      wasmUrl: kernelBuild?.wasmUrl ?? '/cad-kernel/kernel.wasm',
    },
    onMeshes: (hash, meshes) => controller.receiveMeshes(hash, meshes),
  });
  const controller: CadController = new CadController({
    session: new EditorSession(initial),
    kernel: port,
    canEdit: () => params.get('readonly') !== '1',
    permissionGeneration: () => 1,
    newId: (prefix) => `${prefix}-${++n}`,
  });
  return { controller, port };
}
const surfaces = params.get('pair') === '1' ? [mount(), mount()] : [mount()];
Object.assign(window, { cad: surfaces[0] });
createRoot(document.getElementById('root')!).render(
  surfaces.length === 1 ? (
    <CadSurface controller={surfaces[0].controller} />
  ) : (
    <div style={{ display: 'grid', gridTemplateRows: '1fr 1fr', height: '100%' }}>
      {surfaces.map(({ controller }, i) => (
        <div key={i} data-testid={`surface-${i}`} style={{ minHeight: 0, display: 'grid' }}>
          <CadSurface controller={controller} />
        </div>
      ))}
    </div>
  ),
);
