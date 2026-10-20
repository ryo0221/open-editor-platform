import { memo, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { isDeepFrozen, newId } from '@editor-platform/artifact-core';
import { IconButton } from '@editor-platform/editor-ui';
import { DrawingView } from '@editor-platform/canvas-ui';
import { ArrowDown, ArrowUp, Copy, EyeOff, Layers, Plus, Trash2 } from 'lucide-react';
import {
  deleteSlide,
  duplicateSlide,
  reorderSlide,
  slideDrawing,
  slidePaintOrder,
  type Slide,
  type SlideLayout,
  type SlideObject,
  type SlideObjectType,
} from './model';
import { projectedReference, type SlideEditing } from './view-shared';
export interface SlideNavigatorProps {
  editing: SlideEditing;
  objects: SlideObject[];
  pages: string[];
  setPages: Dispatch<SetStateAction<string[]>>;
  setActiveId(id: string): void;
  navigate(index: number): boolean;
  flushInputs(): boolean;
  onAddSlide(layout: SlideLayout): void;
  tab: 'pages' | 'layers';
  setTab(tab: 'pages' | 'layers'): void;
  /** The slide being dragged; kept by the surface across navigator renders. */
  dragged: RefObject<string>;
  layerActions: {
    choose(ids: string[]): void;
    patch(id: string, patch: Partial<SlideObject>): void;
  };
}
/** Slide thumbnails with page actions, or the current slide's layer list. */
export function SlideNavigator(props: SlideNavigatorProps) {
  const { editing, layerActions, tab, setTab, dragged } = props;
  return (
    <>
      <div className="navigator-tabs">
        <button aria-pressed={tab === 'pages'} onClick={() => setTab('pages')}>
          Slides
        </button>
        <button aria-pressed={tab === 'layers'} onClick={() => setTab('layers')}>
          Layers
        </button>
      </div>
      {tab === 'pages' ? (
        <>
          <IconButton
            icon={Plus}
            label="Add slide"
            disabled={editing.readOnly}
            onClick={() => props.onAddSlide('blank')}
          />
          {editing.content.slides.map((s, i) => (
            <SlideThumbnail
              key={s.id}
              {...props}
              page={s}
              index={i}
              onDragStart={() => {
                dragged.current = s.id;
              }}
              onDrop={() =>
                editing.apply(
                  reorderSlide(
                    dragged.current,
                    i - editing.content.slides.findIndex((p) => p.id === dragged.current),
                  ),
                )
              }
            />
          ))}
        </>
      ) : (
        <LayerList
          objects={props.objects}
          selected={editing.ids}
          choose={layerActions.choose}
          onPatch={layerActions.patch}
        />
      )}
    </>
  );
}
function SlideThumbnail({
  editing,
  page: s,
  index: i,
  pages,
  setPages,
  navigate,
  onDragStart,
  onDrop,
  ...actions
}: SlideNavigatorProps & {
  page: Slide;
  index: number;
  onDragStart(): void;
  onDrop(): void;
}) {
  const { content, references } = editing;
  return (
    <div
      className="slide-thumb-row"
      draggable={!editing.readOnly}
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <button
        id={`thumb-${s.id}`}
        className="slide-thumb"
        aria-label={`Slide ${i + 1}: ${s.title}`}
        aria-pressed={s.id === editing.slide?.id}
        onClick={(e) => {
          if (e.shiftKey)
            setPages((p) => (p.includes(s.id) ? p.filter((id) => id !== s.id) : [...p, s.id]));
          else if (navigate(i)) {
            setPages([s.id]);
          }
        }}
      >
        <span>
          {i + 1}
          {s.hidden && <EyeOff size={12} />} {pages.includes(s.id) && '✓'}
        </span>
        <svg viewBox={`0 0 ${content.width} ${content.height}`} aria-hidden="true">
          <rect width={content.width} height={content.height} fill={s.background} />
          {slidePaintOrder(s).map((o) => (
            <DrawingView key={o.id} drawing={slideDrawing(projectedReference(o, references))} />
          ))}
        </svg>
        <small>{s.title}</small>
      </button>
      {s.id === editing.slide?.id && (
        <SlideActions editing={editing} page={s} index={i} {...actions} />
      )}
    </div>
  );
}
function SlideActions({
  editing,
  page: s,
  index: i,
  flushInputs,
  setActiveId,
}: Pick<SlideNavigatorProps, 'editing' | 'flushInputs' | 'setActiveId'> & {
  page: Slide;
  index: number;
}) {
  const { apply, choose, readOnly } = editing;
  return (
    <div className="thumb-actions">
      <IconButton
        icon={ArrowUp}
        label="Move slide up"
        disabled={i === 0 || readOnly}
        onClick={() => apply(reorderSlide(s.id, -1))}
      />
      <IconButton
        icon={ArrowDown}
        label="Move slide down"
        disabled={i === editing.content.slides.length - 1 || readOnly}
        onClick={() => apply(reorderSlide(s.id, 1))}
      />
      <IconButton
        icon={Copy}
        label="Duplicate slide"
        disabled={readOnly}
        onClick={() => {
          if (!flushInputs()) return;
          const copyId = newId('slide');
          if (apply(duplicateSlide(s.id, copyId))) {
            setActiveId(copyId);
            choose([]);
          }
        }}
      />
      <IconButton
        icon={Trash2}
        label="Delete slide"
        disabled={readOnly}
        onClick={() => {
          if (flushInputs() && apply(deleteSlide(s.id))) choose([]);
        }}
      />
    </div>
  );
}
const LayerList = memo(
  function LayerList({
    objects,
    selected,
    choose,
    onPatch,
  }: {
    objects: SlideObject[];
    selected: string[];
    choose: (ids: string[]) => void;
    onPatch: (id: string, patch: Partial<SlideObject>) => void;
  }) {
    const [query, setQuery] = useState('');
    const byId = new Map(objects.map((object) => [object.id, object]));
    const search = query.toLowerCase();
    return (
      <>
        <input
          aria-label="Search layers"
          placeholder="Search layers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul
          className="layers"
          onClick={(event) => {
            const button =
              event.target instanceof Element
                ? event.target.closest('button[data-layer-action]')
                : null;
            const id = button?.closest('[data-layer-id]')?.getAttribute('data-layer-id');
            const object = id ? byId.get(id) : undefined;
            if (!object) return;
            const action = button?.getAttribute('data-layer-action');
            if (action === 'select')
              choose(event.shiftKey ? [...new Set([...selected, object.id])] : [object.id]);
            else if (action === 'lock') onPatch(object.id, { locked: !object.locked });
            else if (action === 'visibility') onPatch(object.id, { hidden: !object.hidden });
          }}
        >
          {objects
            .filter((o) => (o.text + o.type).toLowerCase().includes(search))
            .map((o, i) => (
              <LayerRow
                key={o.id}
                id={o.id}
                type={o.type}
                text={o.text || o.type}
                index={i}
                grouped={!!o.groupId}
                locked={!!o.locked}
                hidden={!!o.hidden}
                selected={selected.includes(o.id)}
              />
            ))}
        </ul>
      </>
    );
  },
  (before, after) =>
    isDeepFrozen(before.objects) &&
    isDeepFrozen(after.objects) &&
    before.choose === after.choose &&
    before.onPatch === after.onPatch &&
    before.selected.length === after.selected.length &&
    before.selected.every((id, index) => id === after.selected[index]) &&
    before.objects.length === after.objects.length &&
    before.objects.every((object, index) => {
      const next = after.objects[index];
      return (
        object.id === next.id &&
        object.type === next.type &&
        object.text === next.text &&
        object.groupId === next.groupId &&
        object.locked === next.locked &&
        object.hidden === next.hidden
      );
    }),
);
// Primitive props keep unchanged rows stable even when a native command must
// replace the containing array. Delegated actions above read the current state.
const LayerRow = memo(function LayerRow({
  id,
  type,
  text,
  index,
  grouped,
  locked,
  hidden,
  selected,
}: {
  id: string;
  type: SlideObjectType;
  text: string;
  index: number;
  grouped: boolean;
  locked: boolean;
  hidden: boolean;
  selected: boolean;
}) {
  return (
    <li data-layer-id={id} style={{ paddingLeft: grouped ? 14 : 0 }}>
      <button
        aria-label={`Select ${type} object ${index + 1}`}
        aria-pressed={selected}
        data-layer-action="select"
      >
        <Layers size={14} />
        {text}
      </button>
      <button aria-label={`Toggle lock ${index + 1}`} data-layer-action="lock">
        {locked ? 'Unlock' : 'Lock'}
      </button>
      <button aria-label={`Toggle visibility ${index + 1}`} data-layer-action="visibility">
        {hidden ? 'Show' : 'Hide'}
      </button>
    </li>
  );
});
