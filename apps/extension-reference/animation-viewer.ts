import { canonicalJson, commitVersion, createArtifact } from '@editor-platform/artifact-core';
import {
  EVALUATOR_V1,
  SCHEMA,
  migratePrototypeDraftToV1,
  type AnimationContentV1,
} from '@editor-platform/animation-core';
import {
  rectanglePrototypeFixture,
  rectangleViewerExtension,
  type RectangleViewerProvenance,
  type ViewerMount,
  type ViewerTestGates,
} from '@editor-platform/extension-sample/animation-viewer';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import {
  ManualClock,
  deferred,
  referenceBinding,
} from '@editor-platform/extension-runtime/reference';
import type { HandleD2 } from '@editor-platform/extension-contract/draft2';
const style = document.createElement('style');
style.textContent =
  'body{font:16px system-ui;max-width:800px;margin:24px auto;padding:16px;color:#173047;background:#f1f5f9}section{background:white;padding:16px;margin:16px 0;border-radius:10px}button{padding:10px;margin:4px;border:1px solid #697e92;border-radius:5px;background:white}button:disabled{opacity:.5}output{display:block;overflow-wrap:anywhere;margin:8px 0}input[type=range]{max-width:100%;vertical-align:middle}';
document.head.append(style);
const heading = document.createElement('h1');
heading.textContent = 'Read-only Animation Extension';
document.body.append(heading);
const intro = document.createElement('p');
intro.textContent =
  'An explicit migration creates a new draft. The viewer receives only artifact:read and lifecycle, and displays one fixed rectangle/group source. Original version bytes and hash stay retained.';
document.body.append(intro);
const controls = document.createElement('section');
controls.setAttribute('aria-label', 'Independent Host controls');
document.body.append(controls);
const status = document.createElement('output');
status.setAttribute('role', 'status');
status.setAttribute('aria-label', 'Viewer status');
status.textContent = 'Preparing retained prototype';
controls.append(status);
const provenanceOutput = document.createElement('output');
provenanceOutput.setAttribute('aria-label', 'Migration provenance');
controls.append(provenanceOutput);
const surface = document.createElement('main');
surface.setAttribute('aria-label', 'Extension container');
document.body.append(surface);
function button(label: string, action: () => void | Promise<void>) {
  const element = document.createElement('button');
  element.textContent = label;
  element.onclick = () => {
    void Promise.resolve()
      .then(action)
      .catch((error) => {
        status.textContent = String(error instanceof Error ? error.message : error);
      });
  };
  controls.append(element);
  return element;
}
const clock = new ManualClock(),
  registry = new ReferenceRegistry(clock);
type Phase = keyof ViewerTestGates;
const gateQueue = new Map<Phase, number[]>();
const gates = new Map<number, { entered: boolean; resolve(): void; promise: Promise<void> }>();
let gateId = 0;
let reentrantClose: Phase | undefined;
interface Opened {
  handle: HandleD2<AnimationContentV1, never>;
  mount?: ViewerMount;
  outcome: string;
  closed: boolean;
}
const openings: Opened[] = [];
let current: Opened | undefined;
let binding: ReturnType<typeof referenceBinding<AnimationContentV1>> | undefined;
let installed: ReturnType<typeof registry.install<AnimationContentV1, never>> | undefined;
let migrationPin: RectangleViewerProvenance | undefined;
let original: Awaited<ReturnType<typeof retainedPrototype>> | undefined;
let originalBytes = '';
let readAllowed = true;
function retainedPrototype() {
  return commitVersion(
    createArtifact('animation', 'Original prototype', rectanglePrototypeFixture()),
    null,
    'Retained original',
  );
}
const active = (record: Opened) =>
  current === record &&
  !record.closed &&
  record.handle.context.addons.lifecycle.state === 'granted' &&
  !record.handle.context.addons.lifecycle.api.signal.aborted;
function close() {
  if (current) {
    current.closed = true;
    current.handle.revoke('host-close');
  }
  status.textContent = 'Viewer closed';
}
function gate(phase: Phase) {
  if (reentrantClose === phase) {
    reentrantClose = undefined;
    close();
  }
  const id = gateQueue.get(phase)?.shift();
  if (id !== undefined) {
    const value = gates.get(id)!;
    value.entered = true;
    return value.promise;
  }
}
const hooks: ViewerTestGates = {
  beforePrepare: () => gate('beforePrepare'),
  beforeMount: () => gate('beforeMount'),
  afterMount: () => gate('afterMount'),
  afterDispose: () => gate('afterDispose'),
};
const migrateButton = button('Migrate retained prototype', async () => {
  if (!original || installed) throw new Error('Migration unavailable');
  migrateButton.disabled = true;
  const result = await migratePrototypeDraftToV1(
    original.draft,
    original.versions[0].contentHash,
    '2026-10-12T00:00:00.000Z',
  );
  migrationPin = {
    artifactId: original.id,
    compositionId: 'root',
    baseVersionId: result.draft.baseVersionId!,
    sourceContentHash: result.sourceContentHash,
    targetContentHash: result.targetContentHash,
    sourceSchema: SCHEMA,
    schemaVersion: 1,
    ticksPerSecond: 240000,
    evaluatorVersion: EVALUATOR_V1,
    playerVersion: 'animation-rectangle-player-1',
  };
  binding = referenceBinding(result.draft.content, original.id);
  binding.artifactKind = 'animation';
  binding.setGrants(readAllowed ? ['artifact:read'] : []);
  // Fixture-only reviewed-code pin. This sample does not verify distributable package bytes.
  const definition = rectangleViewerExtension('e'.repeat(64), migrationPin, {
    gates: hooks,
    observe: (mount) => {
      const record = current!;
      record.mount = mount;
      void mount.ready.then(
        () => {
          record.outcome = 'ready';
          if (active(record)) status.textContent = 'Read-only viewer ready';
        },
        (error) => {
          record.outcome = error instanceof Error ? error.message : String(error);
          if (active(record)) status.textContent = `Viewer stopped: ${record.outcome}`;
        },
      );
    },
  });
  installed = registry.install(definition, { trust: 'trusted', verifiedPin: definition.manifest });
  provenanceOutput.textContent = `schema 1 · 240000 ticks/sec · ${migrationPin.playerVersion}\nOriginal ${migrationPin.sourceContentHash}\nMigrated ${migrationPin.targetContentHash}\nBase ${migrationPin.baseVersionId}`;
  openButton.disabled = !readAllowed;
  status.textContent = 'Migration ready; open explicitly';
});
function open() {
  if (!installed || !binding || !readAllowed) throw new Error('Read-only opening unavailable');
  if (current && !current.closed) throw new Error('Close before reopening');
  if (openings.length >= 16) throw new Error('Sample scope limit; reload fixture');
  const result = installed.open({ ...binding, resources: undefined });
  if (result.state !== 'opened') throw new Error(result.code);
  const record: Opened = { handle: result.handle, outcome: 'pending', closed: false };
  current = record;
  openings.push(record);
  status.textContent = 'Preparing fixed source';
  result.handle.mount(surface);
  return openings.length - 1;
}
migrateButton.disabled = true;
const openButton = button('Open read-only viewer', () => {
  open();
});
openButton.disabled = true;
button('Close viewer', close);
function setRead(allowed: boolean) {
  readAllowed = allowed;
  if (!allowed && current) current.closed = true;
  binding?.setGrants(allowed ? ['artifact:read'] : []);
  openButton.disabled = !allowed || !installed;
  status.textContent = allowed ? 'Read restored; reopen explicitly' : 'Read revoked';
}
button('Revoke read', () => setRead(false));
button('Restore read', () => setRead(true));
const notice = document.createElement('p');
notice.textContent =
  'Independent local sample; no persistence, edit/save/resources grant, automatic migration/version following, Video codec or normal Host connection.';
document.body.append(notice);
const fixture = {
  open,
  close,
  setRead,
  hold(phase: Phase) {
    const task = deferred<void>();
    const id = ++gateId;
    gates.set(id, { ...task, entered: false });
    gateQueue.set(phase, [...(gateQueue.get(phase) ?? []), id]);
    return id;
  },
  entered(id: number) {
    return gates.get(id)?.entered ?? false;
  },
  release(id: number) {
    gates.get(id)?.resolve();
    gates.delete(id);
  },
  reenterClose(phase: Phase) {
    reentrantClose = phase;
  },
  async drain(index: number) {
    return openings[index].handle.drain({ deadlineMs: clock.now() });
  },
  inspect() {
    return {
      originalUnchanged: !!original && canonicalJson(original) === originalBytes,
      provenance: migrationPin && structuredClone(migrationPin),
      openings: openings.map((record) => ({
        generation: record.handle.scope.generation,
        outcome: record.outcome,
        closed: record.closed,
        slots: Object.fromEntries(
          Object.entries(record.handle.context.addons).map(([id, slot]) => [id, slot.state]),
        ),
      })),
    };
  },
};
declare global {
  interface Window {
    extensionAnimationViewer: typeof fixture;
  }
}
window.extensionAnimationViewer = fixture;
void retainedPrototype().then(
  (value) => {
    original = value;
    originalBytes = canonicalJson(value);
    migrateButton.disabled = false;
    status.textContent = 'Original prototype retained';
  },
  (error) => {
    status.textContent = String(error);
  },
);
