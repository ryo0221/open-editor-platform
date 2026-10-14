import {
  operation,
  uid,
  type Identity,
  type Snapshot,
  type Proposal,
} from '@editor-platform/collaboration-core';
import {
  prepareEditorCommand,
  slideEditorCodec,
  designEditorCodec,
  whiteboardEditorCodec,
  dataEditorCodec,
  documentEditorCodec,
  reactUiEditorCodec,
} from '@editor-platform/collaboration-adapters';
import { updateObject, type SlideContent } from '@editor-platform/slide/model';
import { updateElement, type DesignContent } from '@editor-platform/design/model';
import { updateNode, type WhiteboardContent } from '@editor-platform/whiteboard/model';
import { setCell, type StructuredData } from '@editor-platform/structured-data/model';
import { contentToNode, documentSchema } from '@editor-platform/document/engine';
import type { DocumentContent } from '@editor-platform/document/model';
import { Transform } from 'prosemirror-transform';
import { reactUiCommand, type ReactUiDocument } from '@editor-platform/react-ui-core';

/** Reference Host/Runtime only: no provider, prompt or agent behavior in Editor packages. */
export function practicalProposal(snapshot: Snapshot<unknown>, identity: Identity): Proposal {
  const color = (current: string) => (current === '#a78bfa' ? '#fbbf24' : '#a78bfa');
  let op, summary: string;
  switch (snapshot.domain) {
    case 'react-ui': {
      const state = snapshot as Snapshot<ReactUiDocument>;
      const target = state.content.nodes.find((node) => node.component.componentId === 'Button');
      if (!target) throw new Error('Insert a registered Button before requesting this proposal');
      op = prepareEditorCommand(
        reactUiEditorCodec,
        state,
        identity,
        reactUiCommand(
          [
            {
              type: 'set-prop',
              nodeId: target.id,
              prop: 'label',
              value: target.props.label === 'Reviewed action' ? 'Continue' : 'Reviewed action',
            },
          ],
          'Review React action label',
        ),
      );
      summary = 'Review the registered React button label';
      break;
    }
    case 'slide': {
      const state = snapshot as Snapshot<SlideContent>,
        page = state.content.slides[0];
      const target = page.objects.find((o) => o.type === 'shape') ?? page.objects[0];
      if (!target) throw new Error('Insert an element before requesting this proposal');
      op = prepareEditorCommand(
        slideEditorCodec,
        state,
        identity,
        updateObject(page.id, target.id, { fill: color(target.fill) }),
      );
      summary = 'Change the selected shape color';
      break;
    }
    case 'design': {
      const state = snapshot as Snapshot<DesignContent>;
      const target =
        state.content.elements.find((e) => e.type === 'frame') ?? state.content.elements[0];
      if (!target) throw new Error('Insert an element before requesting this proposal');
      op = prepareEditorCommand(
        designEditorCodec,
        state,
        identity,
        updateElement(target.id, { fill: color(target.fill) }),
      );
      summary = '画面の背景色を共同確認用に変更';
      break;
    }
    case 'whiteboard': {
      const state = snapshot as Snapshot<WhiteboardContent>;
      const target = state.content.nodes.find((e) => e.kind === 'sticky') ?? state.content.nodes[0];
      if (!target) throw new Error('Insert a note before requesting this proposal');
      op = prepareEditorCommand(
        whiteboardEditorCodec,
        state,
        identity,
        updateNode(target.id, { color: color(target.color) }),
      );
      summary = '確認する付箋を色で区別';
      break;
    }
    case 'data': {
      const state = snapshot as Snapshot<StructuredData>;
      const field = state.content.columns.find((c) => c.type === 'text' && !c.readOnly);
      const row = state.content.rows[0];
      if (!field || !row) throw new Error('Add a record with an editable text field first');
      op = prepareEditorCommand(
        dataEditorCodec,
        state,
        identity,
        setCell(row.id, field.id, String(row.values[field.id] ?? '') + '／確認済み'),
      );
      summary = '先頭の課題名に確認結果を追記';
      break;
    }
    case 'document': {
      const state = snapshot as Snapshot<DocumentContent>,
        doc = contentToNode(state.content);
      const tr = new Transform(doc).insert(
        doc.content.size,
        documentSchema.nodes.paragraph.create(
          { id: uid() },
          documentSchema.text('検証結果：受付時間と完了率を継続して測定します。'),
        ),
      );
      op = operation(documentEditorCodec, state, identity, [
        {
          type: 'document.steps',
          target: 'text',
          payload: { version: state.engineVersion, steps: tr.steps.map((s) => s.toJSON()) },
        },
      ]);
      summary = '企画書の末尾に検証結果を追記';
      break;
    }
    default:
      throw new Error(
        'This surface supports shared annotations; content proposals are unavailable.',
      );
  }
  if (!op) throw new Error('The proposed change is already present');
  return {
    schema: 1,
    id: uid(),
    artifactId: snapshot.artifactId,
    sourceActorId: identity.actorId,
    baseRevision: snapshot.revision,
    summary,
    actions: op.actions,
    reads: op.conditions,
    writes: op.conditions,
    external: [],
  };
}
