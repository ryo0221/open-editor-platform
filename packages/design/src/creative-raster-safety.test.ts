import { expect, it } from 'vitest';
import { createArtifact, MemoryStorage } from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import { ArtifactEditor } from '@editor-platform/editor-host';
import {
  createDesign,
  insertElement,
  isDesignWithPaths,
  patchDesign,
  type DesignContent,
} from '@editor-platform/design/model';
import { insertDesignPage, setDesignPagination } from '@editor-platform/design/pagination';
import {
  createCreativeDesignHostAdapter,
  prepareCreativeDesignProposal,
  designCreativeProposalDiff,
} from '@editor-platform/design/creative-proposal-diff';
const src = 'data:image/png;base64,AA==',
  replacement = 'data:image/png;base64,AQ==';
function fixture() {
  let d = insertDesignPage({ x: 0, y: 0, width: 600, height: 800 }, 'page').apply(createDesign());
  d = insertElement('image', { id: 'asset', src, parentId: 'page' }).apply(d);
  return setDesignPagination({
    ...d.pagination!,
    images: [{ elementId: 'asset', source: 'Original author', license: 'Original license' }],
  }).apply(d);
}
function host(content: DesignContent) {
  return new ArtifactEditor(
    createArtifact('design', 'Raster safety', content),
    createCreativeDesignHostAdapter({
      kind: 'design',
      validate: isDesignWithPaths,
      capabilities: {
        undo: true,
        nativeJson: true,
        formats: [],
        preview: 'none',
        shared: false,
        proposals: true,
      },
    }),
    new MemoryStorage(),
  );
}
it('refuses a raw src change that would retain stale manga source/license', () => {
  const editor = host(fixture()),
    before = editor.snapshot;
  const raw = command<DesignContent>('raw', 'Replace image', (d) => ({
    ...d,
    elements: d.elements.map((e) => (e.id === 'asset' ? { ...e, src: replacement } : e)),
  }));
  expect(designCreativeProposalDiff.diff(editor.content, raw.apply(editor.content))).toMatchObject({
    changes: [{ property: 'src' }],
    fallback: [],
  });
  const proposal = prepareCreativeDesignProposal(
    { id: 'raw', summary: 'Replace', baseLocalRevision: editor.revision, commands: [raw] },
    { required: [{ elementId: 'asset' }] },
  );
  expect(() => editor.propose(proposal)).toThrow(/attribution/);
  expect(editor.snapshot).toEqual(before);
  expect(editor.proposals).toEqual([]);
  expect(
    patchDesign(['asset'], { src: replacement }).apply(editor.content).pagination!.images,
  ).toEqual([]);
});
it('retains manga attribution when a raw edit preserves the image source', () => {
  const editor = host(fixture()),
    before = editor.content;
  const raw = command<DesignContent>('raw', 'Fit image', (d) => ({
    ...d,
    elements: d.elements.map((e) => (e.id === 'asset' ? { ...e, imageFit: 'fit' as const } : e)),
  }));
  const proposal = prepareCreativeDesignProposal(
    { id: 'fit', summary: 'Fit', baseLocalRevision: editor.revision, commands: [raw] },
    { required: [{ elementId: 'asset' }] },
  );
  editor.propose(proposal);
  editor.acceptProposal(proposal.id);
  expect(editor.content.pagination!.images).toEqual(before.pagination!.images);
  editor.undo();
  expect(editor.content).toEqual(before);
});
it('allows raw src replacement when no page attribution can become stale', () => {
  const initial = fixture();
  initial.pagination!.images = [];
  const editor = host(initial);
  const raw = command<DesignContent>('raw', 'Replace image', (d) => ({
    ...d,
    elements: d.elements.map((e) => (e.id === 'asset' ? { ...e, src: replacement } : e)),
  }));
  const proposal = prepareCreativeDesignProposal(
    { id: 'raw', summary: 'Replace', baseLocalRevision: editor.revision, commands: [raw] },
    { required: [{ elementId: 'asset' }] },
  );
  editor.propose(proposal);
  editor.acceptProposal(proposal.id);
  expect(editor.content.elements.find((e) => e.id === 'asset')!.src).toBe(replacement);
});
