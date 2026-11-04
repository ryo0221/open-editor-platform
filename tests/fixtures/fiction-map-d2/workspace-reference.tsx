import { useState, type ReactNode } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorSession, type EditorCommand } from '@editor-platform/editor-core';
import { DocumentSurface, createDocument, makeBlock, isDocument } from '@editor-platform/document';
import {
  DesignSurface,
  createDesign,
  makeDesignElement,
  isDesignWithPaths,
} from '@editor-platform/design';
import { insertDesignPage } from '@editor-platform/design/pagination';
import {
  type EmbeddedReference,
  type ReferenceResolver,
} from '@editor-platform/artifact-references';
const mapFocus = { id: 'map-image' };
type Props = { reference: EmbeddedReference; resolver: ReferenceResolver };
function useConsumer<T>(factory: () => T) {
  const [session] = useState(() => new EditorSession(factory()));
  const [, render] = useState(0);
  return {
    session,
    execute: (c: EditorCommand<T>) => {
      session.execute(c);
      render((n) => n + 1);
    },
  };
}
function Container({
  session,
  children,
}: {
  session: Pick<
    EditorSession<unknown>,
    'content' | 'revision' | 'canUndo' | 'canRedo' | 'peekHistory'
  >;
  children: ReactNode;
}) {
  return (
    <section aria-label="Workspace reference consumer">
      <pre data-testid="consumer-native">{canonicalJson(session.content)}</pre>
      <output data-testid="consumer-history">
        {JSON.stringify({
          revision: session.revision,
          undo: session.canUndo,
          redo: session.canRedo,
          undoCandidate: session.peekHistory('undo'),
          redoCandidate: session.peekHistory('redo'),
        })}
      </output>
      <div style={{ height: 760, minWidth: 0 }}>{children}</div>
    </section>
  );
}
function Novel({ reference, resolver }: Props) {
  const { session, execute } = useConsumer(() => {
    const d = createDocument();
    d.blocks.push({
      ...makeBlock('image'),
      id: 'map-image',
      reference,
      src: resolver.project(reference.snapshot, reference.source.target).src,
      alt: 'Pinned map',
      width: 600,
    });
    if (!isDocument(d)) throw Error('Invalid Document reference fixture');
    return d;
  });
  const [selected, select] = useState<string | undefined>('map-image');
  return (
    <Container session={session}>
      <DocumentSurface
        content={session.content}
        workspace="novel"
        novel={{
          reading: {
            content: session.content,
            label: 'Fixture-only readonly content; source map version is fixed',
          },
        }}
        references={resolver}
        selectedId={selected}
        select={select}
        execute={execute}
      />
    </Container>
  );
}
function Manga({ reference, resolver }: Props) {
  const { session, execute } = useConsumer(() => {
    const d = insertDesignPage({ x: 0, y: 0, width: 800, height: 1100 }, 'map-page').apply(
      createDesign(),
    );
    d.elements.push({
      ...makeDesignElement('image'),
      id: 'map-image',
      parentId: 'map-page',
      bounds: { x: 30, y: 120, width: 700, height: 490 },
      reference,
      src: resolver.project(reference.snapshot, reference.source.target).src,
      alt: 'Pinned map',
    });
    if (!isDesignWithPaths(d)) throw Error('Invalid Design reference fixture');
    return d;
  });
  return (
    <Container session={session}>
      <DesignSurface
        content={session.content}
        workspace="manga"
        references={resolver}
        focusRequest={mapFocus}
        select={() => {}}
        execute={execute}
      />
    </Container>
  );
}
/** Fixture-only consumers each own one Session, separate from the source map. */
export function WorkspaceReference({
  workspace,
  ...props
}: Props & { workspace: 'novel' | 'manga' }) {
  return workspace === 'novel' ? <Novel {...props} /> : <Manga {...props} />;
}
