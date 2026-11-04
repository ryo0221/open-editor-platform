import { useId, useMemo, type ReactNode, type SVGProps } from 'react';
import type { WhiteboardInteractionMode } from '@editor-platform/whiteboard';
import {
  createFictionMapProjection,
  hitFictionMapProjection,
  renderFictionMapSvg,
  type FictionMapProjection,
} from '@editor-platform/fiction-map/render';
import type { BoardReading, BoardEvent } from './reading';
import type { FilteredStoryBoard } from './filter';
import type { TimelineTime } from '../timeline/projection';

export type BoardSelection = { kind: 'event' | 'place' | 'individual'; key: string };
export interface BoardPanelActions {
  select(value: BoardSelection): void;
  point(value: number): void;
  source(event: BoardEvent): void;
}
interface Props {
  reading: BoardReading;
  view: FilteredStoryBoard;
  width: number;
  height: number;
  mode: WhiteboardInteractionMode;
  selection?: BoardSelection;
  actions: BoardPanelActions;
}
export const boardTimeLabel = (time: TimelineTime | undefined) =>
  !time
    ? '時計換算なし・時点未定'
    : time.kind === 'point'
      ? `${time.start}日目`
      : time.kind === 'day'
        ? `${time.start}日目・日内未区分`
        : time.kind === 'interval'
          ? `${time.start}〜${time.end}日目（終了を含まない）`
          : time.kind === 'range'
            ? `${time.start ?? '…'}〜${time.end ?? '…'}日目の候補`
            : '時点未定';

function action(
  label: string,
  mode: WhiteboardInteractionMode,
  run: () => void,
): SVGProps<SVGGElement> {
  return {
    role: 'button',
    'aria-label': label,
    tabIndex: mode === 'content' ? 0 : -1,
    onClick:
      mode === 'content'
        ? (e) => {
            e.stopPropagation();
            run();
          }
        : undefined,
    onKeyDown:
      mode === 'content'
        ? (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              run();
            } else if (e.key === ' ') e.preventDefault();
          }
        : undefined,
    // Let NativeStage own held-Space pan. A pan focuses the Stage, so its keyup
    // never activates this control; a keyboard-only Space activates on release.
    onKeyUp:
      mode === 'content'
        ? (e) => {
            if (e.key === ' ') {
              e.preventDefault();
              run();
            }
          }
        : undefined,
  };
}
function Frame({
  width,
  height,
  title,
  children,
}: {
  width: number;
  height: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <g className="sb-svg-panel">
      <rect
        x={1}
        y={1}
        width={Math.max(1, width - 2)}
        height={Math.max(1, height - 2)}
        rx={12}
        fill="#fffdf8"
        stroke="#c6bbab"
      />
      <text x={18} y={31} fontSize={19} fontWeight={650} fill="#403b34">
        {title}
      </text>
      <path d={`M 12 46 H ${width - 12}`} stroke="#ddd4c5" />
      {children}
    </g>
  );
}
const short = (label: string, limit = 18) =>
  [...label].length > limit ? [...label].slice(0, limit).join('') + '…' : label;
const selectedEvent = (props: Props, event: BoardEvent) =>
  props.selection?.kind === 'event'
    ? props.selection.key === event.key
    : props.selection?.kind === 'individual'
      ? event.individuals.includes(props.selection.key)
      : props.selection?.kind === 'place'
        ? props.view.presences.some(
            (p) => p.event === event.key && p.place === props.selection!.key,
          )
        : false;

export function BoardTimelinePanel(props: Props) {
  const { reading, view, width, height, mode, selection, actions } = props;
  const values = [...reading.events.map((e) => e.time), ...reading.presences.map((p) => p.time)]
    .flatMap((time) => [time?.start, time?.end])
    .filter((n): n is number => n !== undefined);
  const query = view.filter.time;
  const focus =
    query.kind === 'point' ? [query.value] : query.kind === 'range' ? [query.start, query.end] : [];
  const min = Math.min(0, ...values, ...focus),
    max = Math.max(min + 6, ...values, ...focus);
  const left = Math.min(150, width * 0.29),
    right = Math.max(left + 1, width - 22);
  const x = (day: number) =>
    left + ((Math.max(min, Math.min(max, day)) - min) * (right - left)) / (max - min);
  const rowHeight = Math.min(31, (height - 110) / Math.max(1, view.individuals.length));
  const ticks = [
    ...new Set(Array.from({ length: 7 }, (_, i) => Math.round(min + (i * (max - min)) / 6))),
  ];
  return (
    <Frame width={width} height={height} title="人物別タイムライン">
      <text x={18} y={66} fontSize={11} fill="#777063">
        作中時系列・相対整数日
      </text>
      {ticks.map((day) => (
        <g key={day} {...action(`${day}日目を見る`, mode, () => actions.point(day))}>
          <rect x={x(day) - 18} y={52} width={36} height={28} fill="transparent" />
          <text x={x(day)} y={72} textAnchor="middle" fontSize={12} fill="#716651">
            {day}
          </text>
          <path d={`M ${x(day)} 83 V ${height - 22}`} stroke="#e7e2d8" strokeDasharray="3 5" />
        </g>
      ))}
      {view.individuals.length === 0 && (
        <text x={20} y={124} fontSize={15}>
          表示条件に一致する個体はありません。
        </text>
      )}
      {view.individuals.map((person, i) => {
        const y = 101 + i * rowHeight;
        const world =
          reading.timeline.worlds.find((w) => w.id === person.origin)?.label ?? person.origin;
        return (
          <g key={person.key} data-board-lane={person.key}>
            <g
              {...action(`${person.label}・${world}を選択`, mode, () =>
                actions.select({ kind: 'individual', key: person.key }),
              )}
            >
              <rect
                x={12}
                y={y - 14}
                width={left - 20}
                height={rowHeight - 3}
                rx={5}
                fill={
                  selection?.kind === 'individual' && selection.key === person.key
                    ? '#d6eee7'
                    : 'transparent'
                }
              />
              <text x={20} y={y + 2} fontSize={13} fill="#40524c">
                <title>{`${person.label}・${world}`}</title>
                {short(person.label, 8)}{' '}
                <tspan fontSize={9} fill="#7b817d">
                  {world}
                </tspan>
              </text>
            </g>
            <path d={`M ${left} ${y} H ${right}`} stroke="#dce5df" />
            {view.presences
              .filter((p) => p.individual === person.key && p.time?.start !== undefined)
              .map((p) => {
                const from = x(p.time!.start!),
                  to = x(p.time!.end ?? p.time!.start!);
                const place = reading.places.find((l) => l.key === p.place);
                return (
                  <g key={p.key}>
                    <title>{`${place?.label ?? '未接続'}・${boardTimeLabel(p.time)}・${p.certainty === 'confirmed' ? '確定の記録' : '候補'}`}</title>
                    <rect
                      x={from}
                      y={y - 6}
                      width={Math.max(3, to - from)}
                      height={12}
                      rx={5}
                      fill={
                        p.certainty === 'confirmed' && p.time!.kind === 'interval'
                          ? '#b2d6c6'
                          : '#f7e4b9'
                      }
                      stroke="#96b4a7"
                      strokeDasharray={
                        p.certainty === 'uncertain' || p.time!.kind === 'range' ? '3 3' : undefined
                      }
                    />
                  </g>
                );
              })}
            {view.events
              .filter(
                (e) =>
                  e.individuals.includes(person.key) &&
                  e.time &&
                  !['unset', 'derived'].includes(e.time.kind),
              )
              .map((e) => (
                <g
                  key={e.key}
                  {...action(
                    `${e.label}${['day', 'range'].includes(e.time!.kind) ? '（時点候補）' : ''}を選択`,
                    mode,
                    () => actions.select({ kind: 'event', key: e.key }),
                  )}
                  data-board-event={e.key}
                >
                  <title>{`${e.label}・${boardTimeLabel(e.time)}`}</title>
                  {e.time!.kind === 'point' ? (
                    <circle
                      cx={x(e.time!.start!)}
                      cy={y}
                      r={selectedEvent(props, e) ? 8 : 5}
                      fill={selectedEvent(props, e) ? '#147e74' : '#698e80'}
                      stroke="#fffdf8"
                      strokeWidth={2}
                    />
                  ) : (
                    <rect
                      x={x(e.time!.start ?? min)}
                      y={y - 5}
                      width={Math.max(
                        3,
                        x(e.time!.kind === 'day' ? e.time!.start! + 1 : (e.time!.end ?? max)) -
                          x(e.time!.start ?? min),
                      )}
                      height={10}
                      rx={3}
                      fill={selectedEvent(props, e) ? '#d2eae0' : '#f6e6bf'}
                      stroke={selectedEvent(props, e) ? '#147e74' : '#bd9d5e'}
                      strokeDasharray={e.time!.kind === 'interval' ? undefined : '3 2'}
                    />
                  )}
                </g>
              ))}
          </g>
        );
      })}
      {view.filter.time.kind === 'point' && (
        <g pointerEvents="none">
          <path
            d={`M ${x(view.filter.time.value)} 82 V ${height - 18}`}
            stroke="#d5a048"
            strokeWidth={2}
          />
          <text
            x={x(view.filter.time.value) - 5}
            y={height - 5}
            textAnchor="end"
            fontSize={11}
            fill="#986e26"
          >
            {view.filter.time.value}日目
          </text>
        </g>
      )}
    </Frame>
  );
}

export function BoardMapPanel(props: Props) {
  const { reading, view, width, height, mode, actions, selection } = props;
  const clipId = 'sb-map-' + useId().replaceAll(':', '');
  const w = Math.max(1, Math.min(4096, Math.round(width - 24))),
    h = Math.max(1, Math.min(4096, Math.round(height - 85)));
  const image = useMemo(() => {
    try {
      const options = {
        width: w,
        height: h,
        view: reading.opened.settings.map.view,
        featureIds: reading.opened.settings.map.featureIds,
        background: '#f4f1e4',
      };
      const projection = createFictionMapProjection(reading.map, options);
      return {
        projection,
        href:
          'data:image/svg+xml;charset=utf-8,' +
          encodeURIComponent(renderFictionMapSvg(reading.map, options).svg),
      };
    } catch {
      return undefined;
    }
  }, [reading.map, reading.opened.settings.map, w, h]);
  const clusters = new Map<string, Set<string>>();
  for (const p of view.positions.flatMap((position) => position.records)) {
    if (
      p.certainty !== 'confirmed' ||
      !['interval', 'point'].includes(p.time?.kind ?? '') ||
      !p.place
    )
      continue;
    for (const feature of reading.places.find((l) => l.key === p.place)?.features ?? []) {
      const people = clusters.get(feature) ?? new Set<string>();
      people.add(p.individual);
      clusters.set(feature, people);
    }
  }
  return (
    <Frame width={width} height={height} title="地図・在場の記録">
      {!image ? (
        <text x={20} y={100} fontSize={14}>
          この寸法・地図を表示できません。
        </text>
      ) : (
        <svg
          x={12}
          y={53}
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          onClick={
            mode === 'content'
              ? (event) => {
                  const matrix = event.currentTarget.getScreenCTM();
                  if (!matrix) return;
                  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
                    matrix.inverse(),
                  );
                  const hits = hitFictionMapProjection(image.projection, point);
                  const place = reading.places.find((p) =>
                    p.features.some((id) => hits.includes(id)),
                  );
                  if (place) actions.select({ kind: 'place', key: place.key });
                }
              : undefined
          }
        >
          <image width={w} height={h} href={image.href} data-board-map-background />
          <defs>
            <clipPath id={clipId}>
              <rect {...image.projection.clip} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`}>
            {image.projection.features.map((feature) => {
              const people = [...(clusters.get(feature.id) ?? [])];
              const place = reading.places.find((p) => p.features.includes(feature.id));
              const highlighted =
                !!place &&
                ((selection?.kind === 'place' && selection.key === place.key) ||
                  (selection?.kind === 'individual' && people.includes(selection.key)) ||
                  (selection?.kind === 'event' &&
                    view.positions.some((position) =>
                      position.records.some(
                        (p) =>
                          p.event === selection.key &&
                          p.place === place.key &&
                          p.certainty === 'confirmed' &&
                          ['interval', 'point'].includes(p.time?.kind ?? ''),
                      ),
                    )));
              const geometry = feature.geometry;
              if (geometry.type !== 'point') {
                if (!people.length && !highlighted) return null;
                const coordinates =
                  geometry.type === 'polyline' ? geometry.coordinates : geometry.outer;
                const points = coordinates
                  .map(image.projection.project)
                  .map((p) => `${p.x},${p.y}`)
                  .join(' ');
                return (
                  <g
                    key={feature.id}
                    {...action(`${feature.name}・領域の在場記録を選択`, mode, () => {
                      if (place) actions.select({ kind: 'place', key: place.key });
                    })}
                  >
                    <polyline
                      points={points}
                      fill={geometry.type === 'polygon' ? '#31a68e22' : 'none'}
                      stroke={highlighted ? '#057d6f' : '#629c83'}
                      strokeWidth={highlighted ? 5 : 3}
                    />
                  </g>
                );
              }
              const pixel = image.projection.visiblePoint(geometry.coordinates);
              if (!pixel || (!people.length && !highlighted)) return null;
              const labels = people.map(
                (key) => reading.individuals.find((i) => i.key === key)!.label,
              );
              return (
                <g
                  key={feature.id}
                  data-board-map-marker={people.length ? feature.id : undefined}
                  {...action(
                    people.length
                      ? `${feature.name}：${labels.join('、')}`
                      : `${feature.name}を選択`,
                    mode,
                    () => {
                      if (place) actions.select({ kind: 'place', key: place.key });
                    },
                  )}
                >
                  <circle
                    cx={pixel.x}
                    cy={pixel.y}
                    r={highlighted ? 15 : 12}
                    fill={!people.length ? 'none' : highlighted ? '#097e70' : '#3c9a82'}
                    stroke={people.length ? 'white' : '#187e70'}
                    strokeWidth={3}
                  />
                  {people.length > 0 && (
                    <text
                      x={pixel.x}
                      y={pixel.y + 4}
                      textAnchor="middle"
                      fontSize={12}
                      fontWeight={700}
                      fill="white"
                    >
                      {people.length}
                    </text>
                  )}
                  <text
                    x={pixel.x + 17}
                    y={pixel.y + 20}
                    fontSize={11}
                    fill="#245d50"
                    stroke="#fffdf8"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {short(labels.join('・'), 16)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      )}
      <text x={18} y={height - 12} fontSize={10} fill="#716b60">
        確定の在場のみ表示・補間なし・地図は固定版
      </text>
    </Frame>
  );
}

export function BoardEventCard({ event, ...props }: Props & { event?: BoardEvent }) {
  const { width, height, mode, reading, actions } = props;
  if (!event)
    return (
      <Frame width={width} height={height} title="出来事カード">
        <text x={18} y={88} fontSize={13}>
          現在の表示条件の対象外です。
        </text>
      </Frame>
    );
  const people = event.individuals
    .filter((key) => props.view.individuals.some((i) => i.key === key))
    .map((key) => reading.individuals.find((i) => i.key === key)?.label ?? '');
  const places = [
    ...new Set(
      props.view.presences
        .filter((p) => p.event === event.key)
        .map(
          (p) =>
            (p.certainty === 'uncertain' || !['interval', 'point'].includes(p.time?.kind ?? '')
              ? '候補：'
              : '') +
            (reading.places.find((place) => place.key === p.place)?.label ?? '場所へ未接続'),
        ),
    ),
  ];
  return (
    <Frame width={width} height={height} title="出来事">
      <g
        {...action(`${event.label}を選択`, mode, () =>
          actions.select({ kind: 'event', key: event.key }),
        )}
      >
        <rect
          x={8}
          y={52}
          width={width - 16}
          height={height - 104}
          rx={8}
          fill={selectedEvent(props, event) ? '#e4f3eb' : '#fffdf8'}
          stroke={selectedEvent(props, event) ? '#289180' : 'none'}
          strokeWidth={2}
        />
        <text x={18} y={81} fontSize={17} fontWeight={650} fill="#34493d">
          <title>{event.label}</title>
          {short(event.label, 14)}
        </text>
        <text x={18} y={111} fontSize={12} fill="#736c5e">
          {short(boardTimeLabel(event.time), 24)}
        </text>
        <text x={18} y={139} fontSize={12} fill="#4d6659">
          {short(people.join('・'), 20)}
        </text>
        <text x={18} y={163} fontSize={12} fill="#4d6659">
          {short(places.join('・') || '在場先は未記録', 20)}
        </text>
      </g>
      <g {...action(`${event.label}の元資料を開く`, mode, () => actions.source(event))}>
        <rect x={14} y={height - 43} width={width - 28} height={29} rx={6} fill="#d9ede2" />
        <text x={width / 2} y={height - 23} textAnchor="middle" fontSize={13} fill="#246c5c">
          元資料を開く ↗
        </text>
      </g>
    </Frame>
  );
}

export function boardPositionLabel(
  reading: BoardReading,
  position: FilteredStoryBoard['positions'][number],
) {
  if (position.state === 'choose-time') return '位置を見る時点を選んでください';
  if (!position.records.length)
    return position.reason === 'clock' ? '時計を換算できません' : '所在不明・在場の記録なし';
  return position.records
    .map((record) => {
      const place = reading.places.find((p) => p.key === record.place);
      const candidate =
        record.certainty === 'uncertain' ||
        !['interval', 'point'].includes(record.time?.kind ?? '');
      if (!place) return (candidate ? '候補：' : '') + '地図の場所へ未接続';
      let projection = positionProjections.get(reading);
      if (!projection) {
        projection = createFictionMapProjection(reading.map, {
          width: 600,
          height: 400,
          view: reading.opened.settings.map.view,
          featureIds: reading.opened.settings.map.featureIds,
        });
        positionProjections.set(reading, projection);
      }
      const visible = projection.features
        .filter((f) => place.features.includes(f.id))
        .some((feature) => {
          const geometry = feature.geometry;
          if (geometry.type === 'point') return !!projection!.visiblePoint(geometry.coordinates);
          const points = geometry.type === 'polyline' ? geometry.coordinates : geometry.outer;
          const xs = points.map((p) => p[0]),
            ys = points.map((p) => p[1]),
            extent = projection!.extent;
          return (
            Math.max(...xs) >= extent.minX &&
            Math.min(...xs) <= extent.maxX &&
            Math.max(...ys) >= extent.minY &&
            Math.min(...ys) <= extent.maxY
          );
        });
      return (candidate ? '候補：' : '') + place.label + (visible ? '' : '（表示範囲外・非表示）');
    })
    .join(' / ');
}
const positionProjections = new WeakMap<BoardReading, FictionMapProjection>();
