/** Explicit constant clock conversion, owned by the Story's world settings. */
import { useState } from 'react';
import { insertRows, type TimelineRowInput } from './commands';
import { setClockOffset } from './clock-command';
import { EditForm, Field, type Notice } from './edit';
import type { TimelineWorkbench } from './workbench';
export function ClockEdit({
  workbench: w,
  notify,
}: {
  workbench: TimelineWorkbench;
  notify(n: Notice): void;
}) {
  const owner = w.owner(w.links.story.worldSettings);
  const [form, setForm] = useState<{
    id: string;
    expected?: TimelineRowInput;
    remove?: boolean;
    clock?: boolean;
  }>();
  const [name, setName] = useState('');
  if (!owner || !w.editable(owner.id)) return null;
  const offsets = w.rows(owner.id).filter((r) => r.values['tl1.row'] === 'clock-offset');
  return (
    <section className="tl-edit" aria-label="時計の換算">
      <h3>時計の換算</h3>
      <p>世界設定の固定の日数差を編集します。時刻の速さ・幅・自動経路探索は扱いません。</p>
      <button
        type="button"
        disabled={!!form}
        onClick={() => {
          setName('');
          setForm({ id: w.nextId(owner.id, 'CL'), clock: true });
        }}
      >
        時計を追加
      </button>
      <button
        type="button"
        disabled={!!form}
        onClick={() => setForm({ id: w.nextRelationId(owner.id, 'clock-offset') })}
      >
        換算を追加
      </button>
      {offsets.map((r) => (
        <div key={r.id} data-clock-offset={r.id}>
          <span>
            {String(r.values['tl1.clock'])} → {String(r.values['tl1.clock2'])}：
            {String(r.values['tl1.offset.min'])}日
          </span>
          {[false, true].map((remove) => (
            <button
              key={String(remove)}
              type="button"
              disabled={!!form}
              onClick={() => setForm({ id: r.id, expected: structuredClone(r), remove })}
            >
              {r.id} の換算を{remove ? '解除' : '変更'}
            </button>
          ))}
        </div>
      ))}
      {form?.clock && (
        <EditForm
          owner={owner}
          title="時計を追加"
          dirty
          build={() =>
            insertRows('world', [
              { id: form.id, values: { 'tl1.row': 'clock', 'tl1.label': name } },
            ])
          }
          cancel={() => setForm(undefined)}
          success={() => notify({ ok: true, text: '時計を追加しました。' })}
        >
          <Field label="時計の名前">
            {(id) => (
              <input id={id} value={name} onChange={(e) => setName(e.currentTarget.value)} />
            )}
          </Field>
        </EditForm>
      )}
      {form && !form.clock && (
        <ClockForm
          key={form.id + String(form.remove)}
          w={w}
          {...form}
          notify={notify}
          done={() => setForm(undefined)}
        />
      )}
    </section>
  );
}
function ClockForm({
  w,
  id,
  expected,
  remove,
  notify,
  done,
}: {
  w: TimelineWorkbench;
  id: string;
  expected?: TimelineRowInput;
  remove?: boolean;
  notify(n: Notice): void;
  done(): void;
}) {
  const owner = w.owner(w.links.story.worldSettings)!;
  const [from, setFrom] = useState(String(expected?.values['tl1.clock'] ?? ''));
  const [to, setTo] = useState(String(expected?.values['tl1.clock2'] ?? ''));
  const [offset, setOffset] = useState(String(expected?.values['tl1.offset.min'] ?? ''));
  const clocks = w.rows(owner.id).filter((r) => r.values['tl1.row'] === 'clock');
  return (
    <EditForm
      owner={owner}
      title={remove ? '時計の換算を解除' : '時計の換算を編集'}
      dirty
      validate={(signal) =>
        w.prepareStoryEdit(
          owner.id,
          id,
          () => {
            if (!remove && !offset.trim()) throw Error('日数差を入力してください。');
            return setClockOffset(id, from, to, remove ? undefined : Number(offset), expected);
          },
          signal,
        )
      }
      cancel={done}
      success={() => notify({ ok: true, text: '世界設定の時計の換算を確定しました。' })}
    >
      {remove ? (
        <p>換算を解除します。各出来事の時点は書き換えません。</p>
      ) : (
        <>
          {(
            [
              ['換算元の時計', from, setFrom],
              ['換算先の時計', to, setTo],
            ] as const
          ).map(([label, value, set]) => (
            <Field key={label} label={label}>
              {(fid) => (
                <select id={fid} value={value} onChange={(e) => set(e.currentTarget.value)}>
                  <option value="">選んでください</option>
                  {clocks.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id} {String(c.values['tl1.label'])}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ))}
          <Field label="換算先から元を引いた日数差">
            {(fid) => (
              <input id={fid} value={offset} onChange={(e) => setOffset(e.currentTarget.value)} />
            )}
          </Field>
        </>
      )}
    </EditForm>
  );
}
