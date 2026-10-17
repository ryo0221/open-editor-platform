/** Independent public-API Host for PR #265 resolver lifetime/export race regressions. */
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { contentHash, clone } from '@editor-platform/artifact-core';
import {
  EditorInputs,
  EditorSession,
  command,
  type EditorCommand,
} from '@editor-platform/editor-core';
import { EditorInputsContext, EditorExportGuardContext } from '@editor-platform/editor-ui';
import {
  ReferenceResolver,
  ReferenceError,
  type ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import { ReferenceTools } from '@editor-platform/artifact-references/react';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { createData } from '@editor-platform/structured-data';
import {
  SlideSurface,
  createDeck,
  insertObject,
  makeSlideObject,
  patchObjects,
} from '@editor-platform/slide';
import {
  DesignSurface,
  createDesign,
  makeDesignElement,
  patchDesign,
} from '@editor-platform/design';
import {
  WhiteboardSurface,
  createWhiteboard,
  makeWhiteboardNode,
  patchNodes,
} from '@editor-platform/whiteboard';
import { DocumentSurface, createDocument, makeBlock } from '@editor-platform/document';
import '@editor-platform/editor-ui/styles.css';

type Kind = 'slide' | 'design' | 'whiteboard' | 'document';
const params = new URLSearchParams(location.search);
const kind = (params.get('kind') ?? 'slide') as Kind;
const sources = new Map<string, ReferenceSnapshot>();
const listeners = new Set<(id: string) => void>();
const subscriptions = [0, 0];
const reads: string[] = [];
const opened: string[] = [];
let listBlocked = false;
let listReleases: (() => void)[] = [];
let blocked = false,
  unavailable = false;
let releases: (() => void)[] = [];
let accessBlocked = false;
let accessOutcome: 'online' | 'forbidden' | 'offline' = 'online';
let accessReleases: (() => void)[] = [];
async function saved(id: string, value: number, revision: number): Promise<ReferenceSnapshot> {
  const content = createData();
  content.columns = [{ id: 'value', name: id, type: 'number' }];
  content.rows = [{ id: 'row', values: { value } }];
  if (params.get('limit') === 'bytes' && id === 'included')
    Object.assign(content, { retainedNotes: 'x'.repeat(1_050_000) });
  return {
    artifactId: id,
    domain: 'data',
    revision,
    versionId: `${id}-v${revision}`,
    content,
    contentHash: await contentHash(content),
    dependencies: [],
  };
}
function resolver(scope = 0) {
  return new ReferenceResolver(
    {
      list: async () => {
        if (listBlocked) await new Promise<void>((resolve) => listReleases.push(resolve));
        return [
          {
            label: `Scope ${scope} source`,
            source: {
              artifactId: 'included',
              domain: 'data',
              target: { kind: 'table', viewId: 'default' },
            },
          },
          ...(params.has('choices')
            ? [
                {
                  label: 'Second saved source',
                  source: {
                    artifactId: 'outside',
                    domain: 'data',
                    target: { kind: 'table', viewId: 'default' },
                  },
                },
              ]
            : []),
        ];
      },
      open(source) {
        opened.push(source.artifactId);
      },
      async checkAccess() {
        if (accessBlocked) await new Promise<void>((resolve) => accessReleases.push(resolve));
        if (scope || accessOutcome === 'forbidden')
          throw new ReferenceError('forbidden', 'replacement scope denied');
        if (accessOutcome === 'offline') throw new ReferenceError('offline', 'scope offline');
      },
      async read(source) {
        reads.push(source.artifactId);
        if (unavailable && source.artifactId === 'outside')
          throw new ReferenceError('missing-source', 'outside unavailable');
        if (blocked) await new Promise<void>((resolve) => releases.push(resolve));
        return sources.get(source.artifactId)!;
      },
      subscribe(listener) {
        subscriptions[scope]++;
        listeners.add(listener);
        return () => {
          subscriptions[scope]--;
          listeners.delete(listener);
        };
      },
    },
    nativeReferenceAdapters,
    'destination',
  );
}
async function start() {
  sources.set('included', await saved('included', 95, 1));
  sources.set('outside', await saved('outside', 700, 1));
  const first = resolver();
  const make = async (artifactId: string) => {
    const reference = await first.create(
      { artifactId, domain: 'data', target: { kind: 'table', viewId: 'default' } },
      params.has('fixed') ? 'fixed' : 'follow',
    );
    return {
      reference,
      src: first.project(reference.snapshot, reference.source.target).src,
      imageFit: 'fit' as const,
    };
  };
  const included = await make('included'),
    outside = await make('outside');
  if (params.has('cover')) included.reference = { ...included.reference, fit: 'cover' };
  const deck = createDeck();
  const image = insertObject(deck.slides[0].id, 'image', included).apply(deck).slides[0].objects[0];
  const inactive = params.has('inactive');
  deck.slides = [
    {
      ...deck.slides[0],
      id: 'page-a',
      title: 'First',
      objects: inactive
        ? []
        : [
            { ...image, id: 'inside' },
            { ...image, ...outside, id: 'hidden', hidden: true },
          ],
    },
    {
      ...deck.slides[0],
      id: 'page-b',
      title: 'Second',
      objects: [
        {
          ...image,
          ...(inactive ? included : outside),
          id: params.has('duplicate') ? 'inside' : 'other',
          bounds: { x: 500, y: 100, width: 300, height: 150 },
        },
      ],
    },
  ];
  const design = createDesign();
  design.elements = [
    {
      ...makeDesignElement('frame'),
      id: 'frame',
      name: 'Export frame',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    },
    {
      ...makeDesignElement('image'),
      ...included,
      id: 'inside',
      name: 'Inside',
      parentId: 'frame',
      bounds: { x: 50, y: 50, width: 400, height: 200 },
    },
    {
      ...makeDesignElement('image'),
      ...outside,
      id: 'other',
      name: 'Outside',
      bounds: { x: 900, y: 50, width: 400, height: 200 },
    },
    { ...makeDesignElement('image'), ...outside, id: 'hidden', hidden: true, parentId: 'frame' },
  ];
  const board = createWhiteboard();
  board.sections = [
    {
      id: 'section',
      title: 'Export section',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      background: '#ffffff',
    },
  ];
  board.nodes = [
    {
      ...makeWhiteboardNode('image'),
      ...included,
      id: 'inside',
      name: 'Inside',
      sectionId: 'section',
      bounds: { x: 50, y: 50, width: 400, height: 200 },
    },
    {
      ...makeWhiteboardNode('image'),
      ...outside,
      id: 'other',
      name: 'Outside',
      bounds: { x: 900, y: 50, width: 400, height: 200 },
    },
    {
      ...makeWhiteboardNode('image'),
      ...outside,
      id: 'hidden',
      sectionId: 'section',
      hidden: true,
    },
  ];
  const document = createDocument();
  // Placement scenarios need an editable frame; hidden descendants deliberately
  // block normal frame editing in the default export fixture.
  if (params.get('focus') === 'frame')
    design.elements = design.elements.filter((element) => element.id !== 'hidden');
  document.blocks = [
    { ...makeBlock('paragraph'), id: 'text', text: 'Editable text' },
    { ...makeBlock('image'), ...included, id: 'inside', caption: 'Original caption' },
  ];
  if (params.has('hidden-document')) {
    document.blocks.push({ ...makeBlock('image'), ...outside, id: 'hidden', hidden: true });
    if (params.has('hidden-only')) delete document.blocks[1].reference;
  }
  if (params.has('limit')) {
    const count = params.get('limit') === 'bytes' ? 3 : 64;
    const copies = <T extends { id: string }>(item: T) =>
      Array.from({ length: count }, (_, index) => ({
        ...clone(item),
        id: index ? `copy-${index}` : 'inside',
        hidden: index > 0,
      }));
    deck.slides = [{ ...deck.slides[0], objects: copies(deck.slides[0].objects[0]) }];
    design.elements = copies({ ...design.elements[1], parentId: undefined });
    board.nodes = copies({ ...board.nodes[0], sectionId: undefined });
    document.blocks = copies(document.blocks[1]);
  }
  const focus = { artifactId: 'destination', elementId: 'inside' };
  if (params.has('ancestor-hidden')) {
    const bounds = { x: 0, y: 0, width: 800, height: 600 };
    for (const page of deck.slides) {
      for (const object of page.objects)
        if (object.reference?.source.artifactId === 'outside') {
          object.groupId = 'hidden-nested';
          object.hidden = false;
        }
      page.objects.unshift(
        { ...makeSlideObject('group', 0), id: 'hidden-parent', hidden: true, bounds },
        { ...makeSlideObject('group', 0), id: 'hidden-nested', groupId: 'hidden-parent', bounds },
      );
    }
    for (const element of design.elements)
      if (element.reference?.source.artifactId === 'outside') {
        element.parentId = 'hidden-nested';
        element.hidden = false;
      }
    design.elements.unshift(
      {
        ...makeDesignElement('group'),
        id: 'hidden-parent',
        parentId: 'frame',
        hidden: true,
        bounds,
      },
      { ...makeDesignElement('group'), id: 'hidden-nested', parentId: 'hidden-parent', bounds },
    );
    for (const node of board.nodes)
      if (node.reference?.source.artifactId === 'outside') {
        node.groupId = 'hidden-nested';
        node.hidden = false;
      }
    board.nodes.unshift(
      {
        ...makeWhiteboardNode('group'),
        id: 'hidden-parent',
        sectionId: 'section',
        hidden: true,
        bounds,
      },
      { ...makeWhiteboardNode('group'), id: 'hidden-nested', groupId: 'hidden-parent', bounds },
    );
  }
  if (params.has('visible-plain'))
    for (const item of [
      ...deck.slides.flatMap((s) => s.objects),
      ...design.elements,
      ...board.nodes,
    ])
      if (item.id === 'inside') delete item.reference;
  if (params.has('grouped')) {
    const bounds = { x: 50, y: 50, width: 650, height: 450 };
    deck.slides[0].objects[0].groupId = 'nested';
    deck.slides[0].objects.unshift(
      { ...makeSlideObject('group', 0), id: 'group', bounds },
      { ...makeSlideObject('group', 0), id: 'nested', groupId: 'group', bounds },
      {
        ...makeSlideObject('shape', 0),
        id: 'plain',
        groupId: 'nested',
        text: 'Grouped plain',
        bounds: { x: 500, y: 350, width: 150, height: 100 },
      },
    );
    board.nodes[0].groupId = 'nested';
    board.nodes.unshift(
      { ...makeWhiteboardNode('group'), id: 'group', bounds },
      { ...makeWhiteboardNode('group'), id: 'nested', groupId: 'group', bounds },
      {
        ...makeWhiteboardNode('sticky'),
        id: 'plain',
        groupId: 'nested',
        text: 'Grouped plain',
        bounds: { x: 500, y: 350, width: 150, height: 100 },
      },
    );
  }
  if (params.has('plain'))
    for (const item of [
      ...deck.slides.flatMap((s) => s.objects),
      ...design.elements,
      ...board.nodes,
      ...document.blocks,
    ])
      delete item.reference;
  const sessions = {
    slide: new EditorSession(deck),
    design: new EditorSession(design),
    whiteboard: new EditorSession(board),
    document: new EditorSession(document),
  };
  function Host() {
    const [references, setReferences] = useState(params.has('disconnected') ? undefined : first);
    const [editRevision, render] = useState(0);
    const contents = useMemo(
      () => ({
        slide: sessions.slide.content,
        design: sessions.design.content,
        whiteboard: sessions.whiteboard.content,
        document: sessions.document.content,
      }),
      [editRevision],
    );
    const [inputs] = useState(() => new EditorInputs());
    const [selectedId, selectDocument] = useState('inside');
    function apply<T>(session: EditorSession<T>, command: EditorCommand<T>) {
      session.execute(command);
      render((n) => n + 1);
      return true;
    }
    window.referenceReview = {
      async publish() {
        sources.set('included', await saved('included', 80, 2));
        for (const listener of listeners) listener('included');
      },
      replace() {
        setReferences(resolver(1));
      },
      tamperClosure() {
        const item =
          kind === 'slide'
            ? sessions.slide.content.slides[0].objects.find((item) => item.id === 'inside')!
            : kind === 'design'
              ? sessions.design.content.elements.find((item) => item.id === 'inside')!
              : kind === 'whiteboard'
                ? sessions.whiteboard.content.nodes.find((item) => item.id === 'inside')!
                : sessions.document.content.blocks.find((item) => item.id === 'inside')!;
        const reference = clone(item.reference!);
        (reference.snapshot.content as ReturnType<typeof createData>).rows[0].values.value = 999;
        if (kind === 'slide')
          apply(sessions.slide, patchObjects('page-a', ['inside'], { reference }));
        else if (kind === 'design') apply(sessions.design, patchDesign(['inside'], { reference }));
        else if (kind === 'whiteboard')
          apply(sessions.whiteboard, patchNodes(['inside'], { reference }));
        else
          apply(
            sessions.document,
            command('test.replace-reference', 'Replace retained closure', (content) => ({
              ...content,
              blocks: content.blocks.map((block) =>
                block.id === 'inside' ? { ...block, reference } : block,
              ),
            })),
          );
      },
      moveFrame(x, y) {
        const frame = sessions.design.content.elements.find((element) => element.id === 'frame')!;
        flushSync(() =>
          apply(sessions.design, patchDesign(['frame'], { bounds: { ...frame.bounds, x, y } })),
        );
      },
      expireAccess() {
        accessBlocked = true;
        for (const listener of listeners) listener('included');
      },
      releaseAccess(outcome) {
        accessOutcome = outcome;
        accessBlocked = false;
        const pending = accessReleases;
        accessReleases = [];
        pending.forEach((release) => release());
        if (!pending.length) for (const listener of listeners) listener('included');
      },
      accessPending: () => accessReleases.length,
      blockList() {
        listBlocked = true;
      },
      releaseList() {
        listBlocked = false;
        const pending = listReleases;
        listReleases = [];
        pending.forEach((release) => release());
      },
      listPending: () => listReleases.length,
      opened: () => [...opened],
      undo() {
        sessions[kind].undo();
        render((n) => n + 1);
      },
      hideGroup(hidden) {
        if (kind === 'slide') apply(sessions.slide, patchObjects('page-a', ['group'], { hidden }));
        if (kind === 'whiteboard') apply(sessions.whiteboard, patchNodes(['group'], { hidden }));
      },
      subscriptions: () => [...subscriptions],
      source: () => clone(sessions[kind].content),
      canUndo: () => sessions[kind].canUndo,
      reads: () => [...reads],
      block() {
        reads.length = 0;
        blocked = true;
      },
      release() {
        blocked = false;
        const pending = releases;
        releases = [];
        pending.forEach((r) => r());
      },
      excludeOutside() {
        unavailable = true;
        reads.length = 0;
      },
      pending: () => inputs.getSnapshot(),
    };
    return (
      <EditorInputsContext.Provider value={inputs}>
        <EditorExportGuardContext.Provider value={() => flushSync(() => inputs.flush())}>
          <div style={{ height: '100vh' }}>
            {params.has('host-placement') && (
              <ReferenceTools
                label="Host placement"
                identity="frame"
                resolver={references}
                insert={(reference, src) => {
                  const frame = contents.design.elements.find((element) => element.id === 'frame')!;
                  const image = {
                    ...makeDesignElement('image'),
                    reference,
                    src,
                    parentId: frame.id,
                    bounds: {
                      x: frame.bounds.x + 24,
                      y: frame.bounds.y + 24,
                      width: 300,
                      height: 160,
                    },
                  };
                  apply(
                    sessions.design,
                    command('test.place', 'Place reference', (content) => ({
                      ...content,
                      elements: [...content.elements, image],
                    })),
                  );
                }}
              />
            )}
            {kind === 'slide' && (
              <SlideSurface
                readOnly={params.has('readonly')}
                focusAddress={focus}
                references={references}
                content={contents.slide}
                select={() => {}}
                execute={(c) => apply(sessions.slide, c)}
              />
            )}
            {kind === 'design' && (
              <DesignSurface
                readOnly={params.has('readonly')}
                focusReferenceId={params.get('focus') ?? 'inside'}
                references={references}
                content={contents.design}
                select={() => {}}
                execute={(c) => apply(sessions.design, c)}
              />
            )}
            {kind === 'whiteboard' && (
              <WhiteboardSurface
                readOnly={params.has('readonly')}
                focusReferenceId={params.get('focus') ?? 'inside'}
                references={references}
                content={contents.whiteboard}
                select={() => {}}
                execute={(c) => apply(sessions.whiteboard, c)}
              />
            )}
            {kind === 'document' && (
              <DocumentSurface
                readOnly={params.has('readonly')}
                focusAddress={focus}
                references={references}
                content={contents.document}
                selectedId={selectedId}
                select={selectDocument}
                execute={(c) => apply(sessions.document, c)}
              />
            )}
          </div>
        </EditorExportGuardContext.Provider>
      </EditorInputsContext.Provider>
    );
  }
  createRoot(window.document.getElementById('root')!).render(<Host />);
}
interface Controls {
  publish(): Promise<void>;
  replace(): void;
  subscriptions(): number[];
  source(): unknown;
  canUndo(): boolean;
  reads(): string[];
  block(): void;
  release(): void;
  excludeOutside(): void;
  pending(): { dirty: number; composing: number };
  blockList(): void;
  releaseList(): void;
  listPending(): number;
  opened(): string[];
  undo(): void;
  hideGroup(hidden: boolean): void;
  expireAccess(): void;
  releaseAccess(outcome: 'online' | 'forbidden' | 'offline'): void;
  accessPending(): number;
  tamperClosure(): void;
  moveFrame(x: number, y: number): void;
}
declare global {
  interface Window {
    referenceReview: Controls;
  }
}
void start();
