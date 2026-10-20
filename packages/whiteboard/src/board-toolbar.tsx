import type { RefObject } from 'react';
import {
  ReferenceTools,
  type ReferenceSurfaceProps,
} from '@editor-platform/artifact-references/react';
import { StickyNote, Frame, Pen, ArrowUpRight, Download, Layers } from 'lucide-react';
import type { EditorCommand, ShapeKind } from '@editor-platform/editor-core';
import { IconButton, Menu, CommitInput } from '@editor-platform/editor-ui';
import { InsertTools, ArrangeMenu, EditMenu, type CanvasView } from '@editor-platform/canvas-ui';
import {
  alignNodes,
  connectNodes,
  type WhiteboardContent,
  type WhiteboardNode,
  type WhiteboardNodeKind,
} from './model';
import { nodeSection } from './sections';

export interface BoardToolbarProps {
  content: WhiteboardContent;
  ids: string[];
  chosen: WhiteboardNode[];
  references: ReferenceSurfaceProps['references'];
  readOnly: boolean;
  sectionTool: boolean;
  setSectionTool: (on: boolean) => void;
  pen: boolean;
  setPen: (on: boolean) => void;
  reference: string;
  setReference: (reference: string) => void;
  view: CanvasView;
  setView: (view: CanvasView) => void;
  viewport: RefObject<HTMLDivElement | null>;
  apply: (cmd: EditorCommand<WhiteboardContent>) => boolean;
  add: (kind: WhiteboardNodeKind, patch?: Partial<WhiteboardNode>) => void;
  image: (file: File) => void;
  action: (a: string, value?: number) => void;
  fit: (ids?: string[]) => void;
  output: (format: 'svg' | 'png', scope: string) => void;
  setError: (message: string) => void;
}

export function BoardToolbar(props: BoardToolbarProps) {
  const { content, ids, chosen, readOnly, apply, add, action, reference } = props;
  const align = (mode: Parameters<typeof alignNodes>[1]) => {
    const parent = content.sections?.find(
      (s) => s.id === (chosen[0] ? nodeSection(content, chosen[0]) : undefined),
    );
    if (reference === 'page' && !parent) {
      props.setError('Select nodes within a Section for region-relative alignment');
      return;
    }
    apply(alignNodes(ids, mode, reference === 'page' ? parent?.bounds : undefined));
  };
  return (
    <>
      <ReferenceTools
        identity={ids.join(',')}
        resolver={props.references}
        readOnly={readOnly}
        insert={(reference, src, label) =>
          add('image', {
            reference,
            src,
            alt: label,
            imageFit: 'fit',
            bounds: { x: 80, y: 140, width: 700, height: 320 },
          })
        }
      />
      <InsertTools
        readOnly={readOnly}
        onShape={(shape: ShapeKind) => add('shape', { shape, text: '' })}
        onText={() => add('text')}
        onImage={(file) => props.image(file)}
      />
      <IconButton
        icon={StickyNote}
        label="Add sticky"
        disabled={readOnly}
        onClick={() => add('sticky')}
      />
      <IconButton
        icon={Frame}
        label="Draw Section"
        aria-pressed={props.sectionTool}
        disabled={readOnly}
        onClick={() => {
          props.setSectionTool(!props.sectionTool);
          props.setPen(false);
        }}
      />
      <IconButton
        icon={Pen}
        label="Freehand pen"
        aria-pressed={props.pen}
        disabled={readOnly}
        onClick={() => props.setPen(!props.pen)}
      />
      <IconButton
        icon={ArrowUpRight}
        label="Connect selected"
        disabled={ids.length !== 2 || readOnly}
        reason="Select two nodes"
        onClick={() => apply(connectNodes(ids[0], ids[1]))}
      />
      <ArrangeMenu
        count={ids.length}
        readOnly={readOnly}
        onAction={action}
        reference={reference}
        onReference={props.setReference}
        onAlign={align}
      />
      <EditMenu onAction={action} readOnly={readOnly} />
      <Menu label="Board actions" icon={Layers}>
        <button disabled={!chosen.length || readOnly} onClick={() => action('frame')}>
          Section around selected objects
        </button>
        <button onClick={() => props.fit()}>Fit all content</button>
        {(['x', 'y'] as const).map((axis) => (
          <CameraCenterInput key={axis} {...props} axis={axis} />
        ))}
        <button disabled={!ids.length} onClick={() => props.fit(ids)}>
          Fit selection
        </button>
      </Menu>
      <Menu label="Export whiteboard" icon={Download}>
        {(['svg', 'png'] as const).map((format) =>
          ['all', 'selection', 'section'].map((scope) => (
            <button key={format + scope} onClick={() => props.output(format, scope)}>
              Export {scope} {format.toUpperCase()}
            </button>
          )),
        )}
      </Menu>
    </>
  );
}

function CameraCenterInput({
  axis,
  view,
  setView,
  viewport,
}: BoardToolbarProps & { axis: 'x' | 'y' }) {
  const size = () =>
    axis === 'x' ? (viewport.current?.clientWidth ?? 900) : (viewport.current?.clientHeight ?? 600);
  return (
    <CommitInput
      label={`Camera center ${axis}`}
      type="number"
      value={Math.round((size() / 2 - view.pan[axis]) / view.zoom)}
      onCommit={(value) => {
        setView({
          ...view,
          fit: false,
          pan: { ...view.pan, [axis]: size() / 2 - Number(value) * view.zoom },
        });
      }}
    />
  );
}
