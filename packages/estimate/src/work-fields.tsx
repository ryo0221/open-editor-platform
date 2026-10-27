import { newId } from '@editor-platform/artifact-core';
import type { EstimateDocument, WorkRule, WorkPlan } from '@editor-platform/estimate-core';
export interface WorkDraft {
  workRules: WorkRule[];
  workPlan: WorkPlan;
}
export function WorkFields({
  value,
  document,
  change,
}: {
  value: WorkDraft;
  document: EstimateDocument;
  change(v: WorkDraft): void;
}) {
  const plan = value.workPlan;
  const setPlan = (patch: Partial<WorkPlan>) =>
    change({ ...value, workPlan: { ...plan, ...patch } });
  const rule = (id: string, patch: Partial<WorkRule>) =>
    change({
      ...value,
      workRules: value.workRules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  return (
    <>
      <h4>稼働暦と工程条件</h4>
      <p>祝日は推定しません。複数taskの人員重複やresource最適化は確認しません。</p>
      <label>
        計画開始日
        <input
          type="date"
          value={plan.projectStartDate}
          onChange={(e) => setPlan({ projectStartDate: e.target.value })}
        />
      </label>
      <fieldset>
        <legend>稼働曜日</legend>
        {['月', '火', '水', '木', '金', '土', '日'].map((day, i) => (
          <label key={day}>
            <input
              type="checkbox"
              checked={plan.calendar.weekdays.includes(i + 1)}
              onChange={(e) =>
                setPlan({
                  calendar: {
                    ...plan.calendar,
                    weekdays: e.target.checked
                      ? [...plan.calendar.weekdays, i + 1].sort()
                      : plan.calendar.weekdays.filter((d) => d !== i + 1),
                  },
                })
              }
            />
            {day}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>日付例外</legend>
        {plan.calendar.exceptions.map((x, i) => (
          <div key={i}>
            <label>
              例外日
              <input
                type="date"
                value={x.date}
                onChange={(e) =>
                  setPlan({
                    calendar: {
                      ...plan.calendar,
                      exceptions: plan.calendar.exceptions.map((v, n) =>
                        n === i ? { ...v, date: e.target.value } : v,
                      ),
                    },
                  })
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={x.working}
                onChange={(e) =>
                  setPlan({
                    calendar: {
                      ...plan.calendar,
                      exceptions: plan.calendar.exceptions.map((v, n) =>
                        n === i ? { ...v, working: e.target.checked } : v,
                      ),
                    },
                  })
                }
              />
              稼働日
            </label>
            <button
              onClick={() =>
                setPlan({
                  calendar: {
                    ...plan.calendar,
                    exceptions: plan.calendar.exceptions.filter((_, n) => n !== i),
                  },
                })
              }
            >
              例外を削除
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            setPlan({
              calendar: {
                ...plan.calendar,
                exceptions: [
                  ...plan.calendar.exceptions,
                  { date: plan.projectStartDate, working: false },
                ],
              },
            })
          }
        >
          日付例外を追加
        </button>
      </fieldset>
      {plan.tasks.map((task) => {
        const r = value.workRules.find((v) => v.id === task.ruleId)!;
        const patch = (p: Partial<typeof task>) =>
          setPlan({ tasks: plan.tasks.map((t) => (t.id === task.id ? { ...t, ...p } : t)) });
        return (
          <fieldset key={task.id}>
            <legend>
              {task.name} · {task.id}
            </legend>
            <label>
              工程名
              <input value={task.name} onChange={(e) => patch({ name: e.target.value })} />
            </label>
            <label>
              工程の費目
              <select value={task.lineId} onChange={(e) => patch({ lineId: e.target.value })}>
                {document.lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              着手可能日
              <input
                type="date"
                value={task.releaseDate ?? ''}
                onChange={(e) => {
                  const next = { ...task };
                  delete next.releaseDate;
                  patch({ ...next, ...(e.target.value ? { releaseDate: e.target.value } : {}) });
                  if (!e.target.value)
                    setPlan({ tasks: plan.tasks.map((t) => (t.id === task.id ? next : t)) });
                }}
              />
            </label>
            <label>
              準備工数（hour）
              <input
                value={r.setupHours}
                onChange={(e) => rule(r.id, { setupHours: e.target.value })}
              />
            </label>
            <label>
              単位あたり工数（hour）
              <input
                value={r.hoursPerUnit}
                onChange={(e) => rule(r.id, { hoursPerUnit: e.target.value })}
              />
            </label>
            <label>
              工数の数量単位
              <select value={r.perUnit} onChange={(e) => rule(r.id, { perUnit: e.target.value })}>
                {['count', 'mm', 'm', 'mm2', 'm2', 'mm3', 'm3', 'kg', 'hour', 'workday'].map(
                  (u) => (
                    <option key={u}>{u}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              人数
              <input
                type="number"
                min="1"
                max="100"
                value={r.crewCount}
                onChange={(e) => rule(r.id, { crewCount: Number(e.target.value) })}
              />
            </label>
            <label>
              一人あたり日稼働時間
              <input
                value={r.hoursPerDay}
                onChange={(e) => rule(r.id, { hoursPerDay: e.target.value })}
              />
            </label>
            <button
              onClick={() =>
                change({
                  workRules: value.workRules.filter((v) => v.id !== r.id),
                  workPlan: {
                    ...plan,
                    tasks: plan.tasks.filter((t) => t.id !== task.id),
                    dependencies: plan.dependencies.filter(
                      (d) => d.before !== task.id && d.after !== task.id,
                    ),
                  },
                })
              }
            >
              工程を削除
            </button>
          </fieldset>
        );
      })}
      <button
        disabled={!document.lines.length}
        onClick={() => {
          const line = document.lines[0],
            rate = document.rates.find((r) => r.id === line.rateId),
            id = newId('rule');
          change({
            workRules: [
              ...value.workRules,
              {
                id,
                name: line.name,
                setupHours: '0',
                hoursPerUnit: '1',
                perUnit: rate?.perUnit ?? 'count',
                crewCount: 1,
                hoursPerDay: '8',
              },
            ],
            workPlan: {
              ...plan,
              tasks: [
                ...plan.tasks,
                { id: newId('task'), name: line.name, lineId: line.id, ruleId: id },
              ],
            },
          });
        }}
      >
        工程を追加
      </button>
      <fieldset>
        <legend>完了から開始の依存（FS）</legend>
        {plan.dependencies.map((d, i) => (
          <div key={i}>
            {(['before', 'after'] as const).map((key) => (
              <label key={key}>
                {key === 'before' ? '先行工程' : '後続工程'}
                <select
                  value={d[key]}
                  onChange={(e) =>
                    setPlan({
                      dependencies: plan.dependencies.map((v, n) =>
                        n === i ? { ...v, [key]: e.target.value } : v,
                      ),
                    })
                  }
                >
                  {plan.tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label>
              待機する稼働日数
              <input
                type="number"
                min="0"
                value={d.lag}
                onChange={(e) =>
                  setPlan({
                    dependencies: plan.dependencies.map((v, n) =>
                      n === i ? { ...v, lag: Number(e.target.value) } : v,
                    ),
                  })
                }
              />
            </label>
            <button
              onClick={() => setPlan({ dependencies: plan.dependencies.filter((_, n) => n !== i) })}
            >
              依存を削除
            </button>
          </div>
        ))}
        <button
          disabled={plan.tasks.length < 2}
          onClick={() =>
            setPlan({
              dependencies: [
                ...plan.dependencies,
                { before: plan.tasks[0].id, after: plan.tasks[1].id, kind: 'FS', lag: 0 },
              ],
            })
          }
        >
          依存を追加
        </button>
      </fieldset>
    </>
  );
}
