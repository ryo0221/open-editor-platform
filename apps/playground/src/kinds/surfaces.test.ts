import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';

vi.mock('virtual:cad-kernel-build', () => ({
  default: { id: 'surfaces-test-kernel', buildHash: `sha256:${'1'.repeat(64)}` },
  kernels: [],
}));
vi.mock('virtual:playground-manga-tools', () => ({ MangaArtTools: undefined }));

const { kindHooks } = await import('./surfaces');
const { kindRegistry } = await import('../model');
const kinds = kindRegistry.all().map((entry) => entry.kind);
const where = (pick: (hooks: ReturnType<typeof kindHooks>) => unknown) =>
  kinds.filter((kind) => pick(kindHooks(kind)));

// The per-kind branches App.tsx had before KR5b, as the kinds each hook now names.
it('keeps the Playground behaviour each kind had in App.tsx', () => {
  expect(where((h) => !h.comments).sort()).toEqual(
    [
      'animation',
      'structured-graph',
      'analysis',
      'estimate',
      'geo',
      'cad',
      'bim',
      'character',
      'simulation',
      'construction',
      'pcb',
      'schematic',
      'ladder',
      'cosim',
      'drawing',
      'factory',
    ].sort(),
  );
  expect(where((h) => h.holdsEditsWhileSaving)).toEqual(['animation']);
  expect(where((h) => h.pendingInputs).sort()).toEqual(
    ['animation', 'schematic', 'ladder', 'cosim', 'factory'].sort(),
  );
  expect(where((h) => h.pendingInputs?.disablesHistory)).toEqual(['animation']);
  expect(where((h) => h.history).sort()).toEqual(
    ['fiction-map', 'schedule', 'character', 'cad', 'react-ui'].sort(),
  );
  expect(where((h) => h.restore).sort()).toEqual(['cad', 'character', 'structured-graph'].sort());
  expect(where((h) => h.beforeVersion).sort()).toEqual(
    ['fiction-map', 'geo', 'cad', 'character', 'bim'].sort(),
  );
  expect(where((h) => h.strictCapture)).toEqual(['geo']);
  expect(where((h) => h.flushBeforeReadOnly).sort()).toEqual(['animation', 'schedule']);
  expect(where((h) => h.adoptsOpenedContent)).toEqual(['structured-graph']);
  expect(where((h) => h.feedsAnimationCatalog)).toEqual(['animation']);
  expect(where((h) => h.readsAnimationCatalog)).toEqual(['animation']);
  expect(where((h) => h.exports.documentText)).toEqual(['document']);
  expect(where((h) => h.exports.csv)).toEqual(['data']);
  expect(where((h) => h.exports.download)).toEqual(['file']);
  expect(where((h) => !h.sharedSessions).sort()).toEqual(
    [
      'structured-graph',
      'analysis',
      'estimate',
      'geo',
      'schedule',
      'cad',
      'bim',
      'character',
      'simulation',
      'construction',
      'pcb',
      'schematic',
      'ladder',
      'cosim',
      'drawing',
      'factory',
    ].sort(),
  );
  expect(where((h) => h.annotationSurface).sort()).toEqual(['file', 'review']);
  expect(where((h) => h.commentsButton === 'hidden')).toEqual(['animation']);
  expect(where((h) => h.commentsButton === 'disabled').sort()).toEqual(
    [
      'structured-graph',
      'cad',
      'bim',
      'character',
      'simulation',
      'construction',
      'pcb',
      'schematic',
      'ladder',
      'cosim',
      'drawing',
      'factory',
    ].sort(),
  );
  expect(kindHooks('unknown-kind').comments).toBe(true);
});

it('native reuse is off for Fiction Map and Animation, on for every other starter', async () => {
  const { makeArtifact } = await import('../model');
  // Simulation and Construction need a saved source to be created; their content is never reused.
  for (const kind of kinds.filter((k) => k !== 'simulation' && k !== 'construction')) {
    const content = makeArtifact(kind as Parameters<typeof makeArtifact>[0], 1).draft.content;
    expect(kindHooks(kind).nativeReuse(content), kind).toBe(
      kind !== 'fiction-map' && kind !== 'animation',
    );
  }
});

// The per-kind branches app/records.ts and app/import-artifact.ts had before KR5b-2.
it('keeps the record handling each kind had in records and import', async () => {
  const { recordHooks } = await import('./records');
  const pick = (p: (h: ReturnType<typeof recordHooks>) => unknown) =>
    kinds.filter((kind) => p(recordHooks(kind))).sort();
  const engineering = [
    'cad',
    'bim',
    'character',
    'simulation',
    'construction',
    'pcb',
    'schematic',
    'ladder',
    'cosim',
    'drawing',
    'factory',
  ];
  expect(pick((h) => h.storedVersionHashes)).toEqual(
    ['design', 'estimate', 'analysis', 'structured-graph', 'animation', ...engineering].sort(),
  );
  expect(pick((h) => h.verifyStored)).toEqual(
    ['fiction-map', 'geo', 'simulation', 'construction', 'factory', 'drawing'].sort(),
  );
  expect(pick((h) => h.invalidReason)).toEqual(['structured-graph']);
  expect(pick((h) => h.parseNative)).toEqual(['fiction-map']);
  expect(pick((h) => h.importKeepsId)).toEqual(['geo']);
  expect(pick((h) => h.importExtras)).toEqual(
    ['geo', 'cad', 'character', 'bim', 'construction', 'factory', 'drawing', 'simulation'].sort(),
  );
  expect(pick((h) => h.relink)).toEqual(['cosim']);
  const { makeArtifact } = await import('../model');
  const checked = kinds.filter((k) => k !== 'simulation' && k !== 'construction');
  expect(
    checked.filter((kind) =>
      recordHooks(kind).reusableAdapter(
        makeArtifact(kind as Parameters<typeof makeArtifact>[0], 1).draft.content,
      ),
    ),
  ).toEqual(['document', 'data', 'review', 'file', 'whiteboard', 'design', 'slide']);
  expect(recordHooks('unknown-kind').storedVersionHashes).toBe(false);
});
