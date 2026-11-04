/** Story structure forms use the same input registry and per-owner native Undo as time edits. */
import { useRef, useState, type ReactNode } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { EditForm, Field, type Notice } from './edit';
import type { TimelineProjection, TimelineRefView } from './projection';
import type { TimelineRowInput } from './commands';
import {
  createWorldline,
  setExperience,
  setInheritance,
  setTransfer,
  setWorldline,
  storyGroup,
} from './story-commands';
import type { TimelineWorkbench, TimelineWorkbenchOwner } from './workbench';
type Props = { workbench: TimelineWorkbench; notify(n: Notice): void };
type Ref = { artifact: string; version: string; hash: string; item: string };
const rowRef = (row: TimelineRowInput | undefined, prefix = 'tl1.ref'): Ref | undefined =>
  row?.values[prefix + '.artifact']
    ? (Object.fromEntries(
        ['artifact', 'version', 'hash', 'item'].map((k) => [
          k,
          String(row.values[prefix + '.' + k]),
        ]),
      ) as Ref)
    : undefined;
const cells = (value: string, prefix = 'tl1.ref') => {
  if (!value) throw Error('保存版の出来事を選んでください。');
  const ref = JSON.parse(value) as Ref;
  return Object.fromEntries(Object.entries(ref).map(([k, v]) => [prefix + '.' + k, v]));
};
function eventChoices(w: TimelineWorkbench, current?: Ref) {
  const options: { value: string; label: string }[] = [];
  for (const o of w.ownersOf('ledger')) {
    const a = o.editor.artifact;
    const versions = a.versions.filter(
      (v) =>
        v.versionId === a.draft.baseVersionId ||
        (current?.artifact === o.id &&
          current.version === v.versionId &&
          current.hash === v.contentHash),
    );
    for (const v of versions)
      for (const row of v.content.rows.filter((r) => r.values['tl1.row'] === 'event')) {
        const ref = { artifact: o.id, version: v.versionId, hash: v.contentHash, item: row.id };
        options.push({
          value: canonicalJson(ref),
          label: `${o.name} · ${row.id} · ${String(row.values['tl1.label'])}（保存版 ${v.versionId}）`,
        });
      }
  }
  return options;
}
function EventField({
  label,
  value,
  set,
  w,
  current,
}: {
  label: string;
  value: string;
  set(value: string): void;
  w: TimelineWorkbench;
  current?: Ref;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <select id={id} value={value} onChange={(e) => set(e.currentTarget.value)}>
          <option value="">読める保存版を選んでください</option>
          {eventChoices(w, current).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
function StoryForm({
  w,
  owner,
  id,
  title,
  build,
  done,
  notify,
  children,
}: {
  w: TimelineWorkbench;
  owner: TimelineWorkbenchOwner;
  id: string;
  title: string;
  build(): EditorCommand<StructuredData> | Promise<EditorCommand<StructuredData>>;
  done(): void;
  notify(n: Notice): void;
  children?: ReactNode;
}) {
  return (
    <EditForm
      owner={owner}
      title={title}
      dirty
      validate={(signal) => w.prepareStoryEdit(owner.id, id, build, signal)}
      cancel={done}
      success={() => notify({ ok: true, text: `${title}を確定しました。` })}
    >
      {children}
    </EditForm>
  );
}
function WorldlineForm({
  workbench: w,
  notify,
  id,
  done,
  initial,
}: Props & { id: string; done(): void; initial?: TimelineRowInput }) {
  const owner = w.owner(w.links.story.worldSettings)!;
  const [seen] = useState(() => initial && structuredClone(initial));
  const [label, setLabel] = useState('');
  const [clock, setClock] = useState('');
  const [parent, setParent] = useState(String(seen?.values['tl1.world.parent'] ?? ''));
  const [point, setPoint] = useState(String(seen?.values['tl1.time.start'] ?? ''));
  return (
    <StoryForm
      w={w}
      owner={owner}
      id={id}
      title={seen ? `${id} の分岐` : '世界線を追加'}
      done={done}
      notify={notify}
      build={() =>
        seen
          ? setWorldline(id, parent || undefined, point.trim() ? Number(point) : undefined, seen)
          : createWorldline(
              id,
              label,
              clock,
              parent || undefined,
              point.trim() ? Number(point) : undefined,
            )
      }
    >
      {!seen && (
        <>
          <Field label="世界線の名前">
            {(fid) => (
              <input id={fid} value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
            )}
          </Field>
          <Field label="時計">
            {(fid) => (
              <select id={fid} value={clock} onChange={(e) => setClock(e.currentTarget.value)}>
                <option value="">選んでください</option>
                {w
                  .rows(owner.id)
                  .filter((r) => r.values['tl1.row'] === 'clock')
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {String(r.values['tl1.label'])}
                    </option>
                  ))}
              </select>
            )}
          </Field>
        </>
      )}
      <Field label="親世界">
        {(fid) => (
          <select id={fid} value={parent} onChange={(e) => setParent(e.currentTarget.value)}>
            <option value="">なし</option>
            {w
              .rows(owner.id)
              .filter((r) => r.values['tl1.row'] === 'worldline' && r.id !== id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {String(r.values['tl1.label'])}
                </option>
              ))}
          </select>
        )}
      </Field>
      <Field label="分岐の表示時点（日境界）">
        {(fid) => (
          <input
            id={fid}
            inputMode="numeric"
            value={point}
            onChange={(e) => setPoint(e.currentTarget.value)}
          />
        )}
      </Field>
      <p>継承する出来事は別に指定します。分岐時点から自動選択しません。</p>
    </StoryForm>
  );
}
function InheritanceForm({
  workbench: w,
  notify,
  world,
  id,
  initial,
  done,
}: Props & { world: string; id: string; initial?: TimelineRowInput[]; done(): void }) {
  const owner = w.owner(w.links.story.worldSettings)!;
  const [seen] = useState(() => structuredClone(initial ?? []));
  const [event, setEvent] = useState('');
  return (
    <StoryForm
      w={w}
      owner={owner}
      id={id}
      title={seen.length ? '継承を解除' : '継承を追加'}
      done={done}
      notify={notify}
      build={async () => {
        const verified = seen.length
          ? undefined
          : await w.verify([
              { id, values: { 'tl1.row': 'inherits', 'tl1.subject': world, ...cells(event) } },
            ]);
        return setInheritance(id, verified, seen);
      }}
    >
      {seen.length ? (
        <p>元の出来事や保存版は削除しません。</p>
      ) : (
        <>
          <EventField label="継承する出来事" value={event} set={setEvent} w={w} />
          <p>親の系列にある台帳の保存版を指定してください。</p>
        </>
      )}
    </StoryForm>
  );
}
export function WorldEdit({ workbench: w, notify, id }: Props & { id: string }) {
  const owner = w.owner(w.links.story.worldSettings);
  const [form, setForm] = useState<{
    kind: 'branch' | 'inherit';
    id: string;
    seen?: TimelineRowInput[];
  }>();
  if (!owner || !w.editable(owner.id)) return null;
  const row = w.rows(owner.id).find((r) => r.id === id)!;
  const inherits = w
    .rows(owner.id)
    .filter(
      (r) =>
        r.values['tl1.row'] === 'inherits' &&
        r.values['tl1.subject'] === id &&
        w.readable(String(r.values['tl1.ref.artifact'])),
    );
  return (
    <section className="tl-edit" aria-label="世界線の編集">
      <button
        type="button"
        disabled={!!form}
        onClick={() =>
          setForm({ kind: 'branch', id, seen: [structuredClone(row) as TimelineRowInput] })
        }
      >
        分岐を変更
      </button>
      <button
        type="button"
        disabled={!!form}
        onClick={() =>
          setForm({ kind: 'inherit', id: w.nextRelationId(owner.id, id + '.inherits') })
        }
      >
        継承を追加
      </button>
      {inherits.map((r) => (
        <button
          type="button"
          disabled={!!form}
          key={r.id}
          onClick={() =>
            setForm({
              kind: 'inherit',
              id: r.id,
              seen: structuredClone(storyGroup(owner.editor.content, r.id)),
            })
          }
        >
          {String(r.values['tl1.ref.item'])} の継承を解除
        </button>
      ))}
      {form?.kind === 'branch' && (
        <WorldlineForm
          key={form.id}
          workbench={w}
          notify={notify}
          id={id}
          initial={form.seen?.[0]}
          done={() => setForm(undefined)}
        />
      )}
      {form?.kind === 'inherit' && (
        <InheritanceForm
          key={form.id}
          workbench={w}
          notify={notify}
          id={form.id}
          world={id}
          initial={form.seen}
          done={() => setForm(undefined)}
        />
      )}
    </section>
  );
}
function RelationForm({
  workbench: w,
  notify,
  kind,
  id,
  initial,
  remove,
  done,
}: Props & {
  kind: 'transfer' | 'experience';
  id: string;
  initial: TimelineRowInput[];
  remove?: boolean;
  done(): void;
}) {
  const owner = w.owner(
    kind === 'transfer' ? w.links.story.worldSettings : w.links.story.composition,
  )!;
  const [seen] = useState(() => structuredClone(initial));
  const root = seen.find((r) => r.id === id);
  const [from, setFrom] = useState(() => (rowRef(root) ? canonicalJson(rowRef(root)) : ''));
  const [to, setTo] = useState(() =>
    rowRef(root, 'tl1.ref2') ? canonicalJson(rowRef(root, 'tl1.ref2')) : '',
  );
  const [label, setLabel] = useState(String(root?.values['tl1.label'] ?? ''));
  const [ch, setCh] = useState(String(root?.values['tl1.ind.ch'] ?? ''));
  const [origin, setOrigin] = useState(String(root?.values['tl1.ind.origin'] ?? ''));
  const [info, setInfo] = useState(
    seen
      .filter((r) => r.values['tl1.row'] === 'transfer-info')
      .map((r) => r.values['tl1.info'])
      .join(','),
  );
  const infoIds = useRef(
    new Map(
      seen
        .filter((r) => r.values['tl1.row'] === 'transfer-info')
        .map((r) => [String(r.values['tl1.info']), r.id]),
    ),
  );
  const title = `${id} の${kind === 'transfer' ? '移送' : '経験順'}${remove ? 'を解除' : 'を編集'}`;
  return (
    <StoryForm
      w={w}
      owner={owner}
      id={id}
      title={title}
      done={done}
      notify={notify}
      build={async () => {
        if (remove) return (kind === 'transfer' ? setTransfer : setExperience)(id, undefined, seen);
        const rows: TimelineRowInput[] = [
          {
            id,
            values: {
              'tl1.row': kind,
              'tl1.label': label || id,
              'tl1.ind.ch': ch,
              'tl1.ind.origin': origin,
              ...cells(from),
              ...cells(to, 'tl1.ref2'),
            },
          },
        ];
        if (kind === 'transfer')
          for (const value of new Set(
            info
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )) {
            if (!infoIds.current.has(value))
              infoIds.current.set(value, w.nextRelationId(owner.id, id + '.info'));
            rows.push({
              id: infoIds.current.get(value)!,
              values: { 'tl1.row': 'transfer-info', 'tl1.subject': id, 'tl1.info': value },
            });
          }
        const verified = await w.verify(rows);
        return (kind === 'transfer' ? setTransfer : setExperience)(id, verified, seen);
      }}
    >
      {remove ? (
        <p>この関係だけを解除し、端点の出来事は変更しません。</p>
      ) : (
        <>
          <Field label="関係の名前">
            {(fid) => (
              <input id={fid} value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
            )}
          </Field>
          <Field label="人物のID">
            {(fid) => <input id={fid} value={ch} onChange={(e) => setCh(e.currentTarget.value)} />}
          </Field>
          <Field label="出身世界">
            {(fid) => (
              <select id={fid} value={origin} onChange={(e) => setOrigin(e.currentTarget.value)}>
                <option value="">選んでください</option>
                {w
                  .rows(w.links.story.worldSettings)
                  .filter((r) => r.values['tl1.row'] === 'worldline')
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {String(r.values['tl1.label'])}
                    </option>
                  ))}
              </select>
            )}
          </Field>
          <EventField
            label={kind === 'transfer' ? '出発の出来事' : '先に経験する出来事'}
            value={from}
            set={setFrom}
            w={w}
            current={rowRef(root)}
          />
          <EventField
            label={kind === 'transfer' ? '到着の出来事' : '次に経験する出来事'}
            value={to}
            set={setTo}
            w={w}
            current={rowRef(root, 'tl1.ref2')}
          />
          {kind === 'transfer' ? (
            <Field label="運ぶ情報のID（カンマ区切り）">
              {(fid) => (
                <input id={fid} value={info} onChange={(e) => setInfo(e.currentTarget.value)} />
              )}
            </Field>
          ) : (
            <p>世界時刻や提示順とは独立した、このStory内の本人の経験順です。</p>
          )}
        </>
      )}
    </StoryForm>
  );
}
const refText = (r?: TimelineRefView) =>
  r?.state === 'unreadable'
    ? '読めない参照'
    : r
      ? `${r.artifact} · ${r.version} · ${r.item}`
      : '参照なし';
export function StoryRelations({
  projection: p,
  edit,
}: {
  projection: TimelineProjection;
  edit?: Props;
}) {
  const w = edit?.workbench;
  const [form, setForm] = useState<{
    kind: 'worldline' | 'transfer' | 'experience';
    id: string;
    seen: TimelineRowInput[];
    remove?: boolean;
  }>();
  const ownerFor = (kind: 'transfer' | 'experience') =>
    kind === 'transfer' ? w?.links.story.worldSettings : w?.links.story.composition;
  const open = (kind: 'transfer' | 'experience', id?: string, remove = false) => {
    if (!w) return;
    const owner = w.owner(ownerFor(kind)!)!;
    setForm({
      kind,
      id: id ?? w.nextId(owner.id, kind === 'transfer' ? 'TR' : 'XP'),
      seen: id ? structuredClone(storyGroup(owner.editor.content, id)) : [],
      remove,
    });
  };
  return (
    <section className="tl-story-relations" aria-label="Storyの関係">
      <h3>人物の経験順</h3>
      <ul>
        {p.experiences.map((e) => (
          <li key={e.id} data-experience={e.id}>
            {e.label} · {e.individual}：{refText(e.from)} → {refText(e.to)}
          </li>
        ))}
      </ul>
      {edit && w && (
        <>
          {w.editable(w.links.story.worldSettings) && (
            <button
              type="button"
              disabled={!!form}
              onClick={() =>
                setForm({
                  kind: 'worldline',
                  id: w.nextId(w.links.story.worldSettings, 'WL'),
                  seen: [],
                })
              }
            >
              世界線を追加
            </button>
          )}
          {(['transfer', 'experience'] as const).map(
            (kind) =>
              w.editable(ownerFor(kind)!) && (
                <div key={kind}>
                  <button type="button" disabled={!!form} onClick={() => open(kind)}>
                    {kind === 'transfer' ? '移送を追加' : '経験順を追加'}
                  </button>
                  {(kind === 'transfer' ? p.transfers : p.experiences)
                    .filter((r) => r.from?.state !== 'unreadable' && r.to?.state !== 'unreadable')
                    .map((r) => (
                      <span key={r.id}>
                        <button type="button" disabled={!!form} onClick={() => open(kind, r.id)}>
                          {r.id} を編集
                        </button>
                        <button
                          type="button"
                          disabled={!!form}
                          onClick={() => open(kind, r.id, true)}
                        >
                          {r.id} を解除
                        </button>
                      </span>
                    ))}
                </div>
              ),
          )}
          {form?.kind === 'worldline' ? (
            <WorldlineForm key={form.id} {...edit} id={form.id} done={() => setForm(undefined)} />
          ) : (
            form && (
              <RelationForm
                key={form.id + String(form.remove)}
                {...edit}
                kind={form.kind}
                id={form.id}
                initial={form.seen}
                remove={form.remove}
                done={() => setForm(undefined)}
              />
            )
          )}
        </>
      )}
    </section>
  );
}
