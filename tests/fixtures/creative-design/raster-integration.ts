/** Run only on a checkout containing both #615 and #616. See verification record. */
import assert from 'node:assert/strict';
import {
  createArtifact,
  MemoryStorage,
  serializeArtifact,
  type Artifact,
} from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import { ArtifactEditor, loadHostArtifact } from '@editor-platform/editor-host';
import * as native from '@editor-platform/design/model';
import {
  createCreativeDesignHostAdapter,
  creativeDesignAddressKey,
  creativeDesignEditCommand,
  designCreativeProposalDiff,
  prepareCreativeDesignProposal,
} from '@editor-platform/design/creative-proposal-diff';
import type { DesignContent, DesignElement } from '@editor-platform/design/model';
assert.ok('deriveDesignRasterProvenance' in native, 'This integration requires both #615 and #616');
const src = 'data:image/png;base64,AA==',
  replacement = 'data:image/png;base64,AQ==';
const oldProvenance = { src, source: 'Custom instance artist', license: 'CC0' };
const replacementProvenance = { src: replacement, source: 'New shared artist', license: 'CC0' };
type Attributed = { provenance?: unknown };
const metadata = (value: unknown) => (value as Attributed).provenance;
const shared = { componentId: 'body', elementId: 'coat' };
function fixture(): DesignContent {
  return {
    ...native.createDesign(),
    components: [
      {
        id: 'body',
        name: 'Body',
        width: 220,
        height: 160,
        template: { type: 'frame', text: '', fill: '' },
        elements: ['coat', 'hat'].map((id) =>
          Object.assign(native.makeDesignElement('image'), {
            id,
            src,
            provenance: { ...oldProvenance, source: 'Shared original' },
          }),
        ),
      },
    ],
    elements: ['A', 'B'].map((id) => ({
      ...native.makeDesignElement('instance'),
      id,
      componentId: 'body',
      ...(id === 'A'
        ? {
            overrides: {
              coat: Object.assign({} as Partial<DesignElement>, { provenance: oldProvenance }),
              hat: Object.assign({} as Partial<DesignElement>, { provenance: oldProvenance }),
            },
          }
        : {}),
    })),
  };
}
const adapter = createCreativeDesignHostAdapter({
  kind: 'design',
  validate: native.isDesignWithPaths,
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none' as const,
    shared: false as const,
    proposals: true,
  },
});
let cases = 0;
for (const viaHelper of [false, true])
  for (const withAttribution of [false, true]) {
    const before = fixture();
    before.elements[0].locked = true; // A shared edit retains native propagation semantics.
    const storage = new MemoryStorage<Artifact<DesignContent>>();
    const editor = new ArtifactEditor(
      createArtifact('design', 'Integration', before),
      adapter,
      storage,
    );
    const patch = withAttribution
      ? { src: replacement, provenance: replacementProvenance }
      : { src: replacement };
    const edit = viaHelper
      ? creativeDesignEditCommand(shared, patch)
      : native.updateComponentPart('body', 'coat', patch);
    const proposal = prepareCreativeDesignProposal(
      {
        id: 'shared',
        summary: 'Replace shared coat',
        commands: [edit],
        baseLocalRevision: editor.revision,
      },
      { required: [shared] },
    );
    const preview = editor.propose(proposal);
    assert.deepEqual(editor.content, before);
    assert.equal(
      designCreativeProposalDiff.diff(before, preview.preview.content).fallback.length,
      0,
    );
    const accepted = editor.acceptProposal(proposal.id);
    assert.deepEqual(
      accepted.changedElementIds?.sort(),
      [
        creativeDesignAddressKey(shared),
        creativeDesignAddressKey({ ...shared, instanceId: 'A' }),
      ].sort(),
    );
    const after = editor.content;
    assert.equal(Object.hasOwn(after.elements[0].overrides!.coat, 'provenance'), false);
    assert.deepEqual(after.elements[0].overrides!.hat, before.elements[0].overrides!.hat);
    const effective: DesignElement = native
      .designInstanceElements(after, after.elements[0])
      .find((e) => e.id === 'coat')!;
    assert.equal(effective.src, replacement);
    assert.deepEqual(metadata(effective), withAttribution ? replacementProvenance : undefined);
    await editor.save({ commitVersion: true });
    const reloaded = await loadHostArtifact(
      serializeArtifact((await storage.get(editor.id))!),
      adapter,
    );
    const restored = reloaded.draft.content;
    assert.deepEqual(
      metadata(
        native.designInstanceElements(restored, restored.elements[0]).find((e) => e.id === 'coat'),
      ),
      metadata(effective),
    );
    editor.undo();
    assert.deepEqual(editor.content, before);
    editor.redo();
    assert.deepEqual(editor.content, after);
    cases++;
  }
for (const mutation of ['unrelated-removal', 'explicit-attribution', 'extra-fill'] as const) {
  const before = fixture(),
    editor = new ArtifactEditor(
      createArtifact('design', 'Rejection', before),
      adapter,
      new MemoryStorage(),
    );
  const raw = command<DesignContent>('raw', 'Tampered replacement', (d) => {
    const next = native.updateComponentPart('body', 'coat', { src: replacement }).apply(d);
    if (mutation === 'unrelated-removal')
      delete (next.elements[0].overrides!.hat as Attributed).provenance;
    if (mutation === 'explicit-attribution')
      Object.assign(next.elements[0].overrides!.coat, {
        provenance: { ...replacementProvenance, source: 'Unrequested instance artist' },
      });
    if (mutation === 'extra-fill') next.elements[0].overrides!.coat.fill = 'red';
    return next;
  });
  const proposal = prepareCreativeDesignProposal(
    { id: mutation, summary: 'Tampered', commands: [raw], baseLocalRevision: editor.revision },
    { required: [shared] },
  );
  assert.throws(() => editor.propose(proposal), /outside/);
  assert.deepEqual(editor.content, before);
  assert.equal(editor.canUndo, false);
  cases++;
}
console.log(`Creative raster integration: ${cases} cases PASS`);
