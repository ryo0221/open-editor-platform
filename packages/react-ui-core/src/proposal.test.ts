import { expect, it } from 'vitest';
import { createReferenceDocument } from '../../../apps/react-ui-reference/src/catalog';
import { reuseHash } from '@editor-platform/reuse-core';
import {
  prepareReactScreenProposal,
  readReactRegistrationCandidates,
  createReactScreenProposal,
  serializeReactScreenProposal,
  parseReactScreenProposal,
  validateReactScreenProposal,
  reactScreenProposalWidths,
  validateReactComponent,
} from './index';

it('reads discovery candidates without adopting invalid, duplicate, or executable metadata', () => {
  const document = createReferenceDocument();
  const valid = document.components[0];
  const result = readReactRegistrationCandidates({
    sourceRevision: 'host-commit-123',
    candidates: [
      valid,
      valid,
      { ...valid, import: { source: 'https://example.com/run.js', export: 'default' } },
    ],
  });
  expect(result.candidates).toEqual([
    {
      kind: 'react-registration-candidate',
      sourceRevision: 'host-commit-123',
      review: 'unreviewed',
      proposed: valid,
    },
  ]);
  expect(() => validateReactComponent(result.candidates[0])).toThrow();
  expect(result.diagnostics.map((d) => d.path)).toEqual([
    '$.source.candidates[1]',
    '$.source.candidates[2]',
  ]);
  let read = false;
  expect(() =>
    readReactRegistrationCandidates({
      get sourceRevision() {
        read = true;
        return 'x';
      },
      candidates: [],
    }),
  ).toThrow();
  expect(read).toBe(false);
});
it('binds a proposal to exact fixture/environment and all three captures, retaining opaque Host references', async () => {
  const document = createReferenceDocument('form');
  const shots = reactScreenProposalWidths.map((width) => ({
    width,
    height: 700,
    path: `screens/${width}.png`,
    hash: 'a'.repeat(64),
    fixtureHash: reuseHash(document.fixture),
    environmentHash: document.environment.ref.hash,
  }));
  const request = {
    document,
    externalReferences: [{ namespace: 'host', screenId: 'opaque:screen/12', stateId: 'draft' }],
    signal: new AbortController().signal,
    capture: {
      async capture() {
        return { screenshots: shots, diagnostics: [] };
      },
    },
  };
  const proposal = await prepareReactScreenProposal(request);
  expect(proposal.composition).toEqual(document);
  expect(proposal.externalReferences).toEqual(request.externalReferences);
  shots[0].fixtureHash = 'b'.repeat(64);
  await expect(prepareReactScreenProposal(request)).rejects.toThrow(/fixture\/environment/);
  expect(proposal.screenshots[0].fixtureHash).toBe(reuseHash(document.fixture));
  shots[0].fixtureHash = reuseHash(document.fixture);
  shots[0].path = '../outside.png';
  await expect(prepareReactScreenProposal(request)).rejects.toThrow(/relative PNG/);
  shots[0].path = 'screens/390.png';
  shots[1].width = 390;
  await expect(prepareReactScreenProposal(request)).rejects.toThrow(/width/);
  const controller = new AbortController();
  controller.abort();
  await expect(
    prepareReactScreenProposal({ ...request, signal: controller.signal }),
  ).rejects.toThrow(/aborted/);
});

it('exports and validates ID-bound composition JSON before screenshots/TSX, with immutable fixed widths', () => {
  const document = createReferenceDocument('form');
  const references = [{ namespace: 'host', screenId: 'screen:27', stateId: 'draft' }];
  const proposal = createReactScreenProposal(document, references);
  references[0].screenId = 'changed';
  expect(proposal.externalReferences[0].screenId).toBe('screen:27');
  expect(proposal.screenshotWidths).toEqual([390, 1024, 1400]);
  expect(proposal.screenshots).toEqual([]);
  expect(parseReactScreenProposal(serializeReactScreenProposal(proposal))).toEqual(proposal);
  expect(() => validateReactScreenProposal({ ...proposal, screenshotWidths: [390, 1400] })).toThrow(
    /fixed/,
  );
  expect(() =>
    validateReactScreenProposal({
      ...proposal,
      externalReferences: [{ namespace: 'host', screenId: 27 }],
    }),
  ).toThrow(/opaque/);
  expect(() => validateReactScreenProposal({ ...proposal, unexpected: true })).toThrow(/field/);
  expect(() => validateReactScreenProposal({ ...proposal, schemaVersion: 2 })).toThrow(/version/);
  expect(() => createReactScreenProposal(document, [])).toThrow(/screen reference/);
});
