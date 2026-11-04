import { useEffect, useMemo, useRef, useState } from 'react';
import { Field, type Notice } from './edit';
import {
  TimelineAnalysisHost,
  type TimelineAnalysisCapabilities,
  type TimelineAnalysisResult,
  type TimelineSubstitutionProposal,
  type TimelineHypothesisResult,
} from './analysis-host';
import { captureTimelineCandidate } from './analysis-context';
import type { TimelineWorkbench } from './workbench';
import type { TimelineSemantics, TimelineDiagnostic } from './analysis-semantics';
import { TimelineExceptionView } from './analysis-exception-view';
const labels = {
  satisfied: '成立',
  contradiction: '矛盾',
  insufficient: '情報不足',
  undetermined: '判定不能',
  unsupported: '未対応',
};
export function TimelineAnalysisView({
  workbench: w,
  capabilities,
  notify,
  select,
  selectOccurrence,
}: {
  workbench: TimelineWorkbench;
  capabilities: TimelineAnalysisCapabilities;
  notify(n: Notice): void;
  select(scene: string): void;
  selectOccurrence(occurrence: string): void;
}) {
  const { t3a, t3b, readingPremise, shared } = capabilities;
  const host = useMemo(
    () => new TimelineAnalysisHost(w, { t3a, t3b, readingPremise, shared }),
    [w, t3a, t3b, readingPremise, shared],
  );
  const [owner, setOwner] = useState(''),
    [analysis, setAnalysis] = useState<TimelineAnalysisResult>(),
    [proposal, setProposal] = useState<TimelineSubstitutionProposal>(),
    [result, setResult] = useState<TimelineHypothesisResult>(),
    [targets, setTargets] = useState<string[]>([]),
    [rows, setRows] = useState<number[]>([]),
    [busy, setBusy] = useState(false),
    [exception, setException] = useState<TimelineDiagnostic>();
  const generation = useRef(0);
  useEffect(() => {
    setBusy(false);
    setAnalysis(undefined);
    setProposal(undefined);
    setResult(undefined);
    return () => {
      generation.current++;
    };
  }, [host]);
  const clear = () => {
    generation.current++;
    if (proposal) host.cancelProposal(proposal);
    setProposal(undefined);
    setResult(undefined);
    setRows([]);
    setBusy(false);
  };
  const run = async (work: () => Promise<void>) => {
    const g = ++generation.current;
    setBusy(true);
    try {
      await work();
    } catch {
      if (g === generation.current)
        notify({
          ok: false,
          text: '診断の入力・範囲・権限を確認してください。結果は適用していません。',
        });
    } finally {
      if (g === generation.current) setBusy(false);
    }
  };
  const diagnose = (draft: boolean) => {
    clear();
    setAnalysis(undefined);
    void run(async () => {
      const g = generation.current;
      const candidate = draft
        ? await captureTimelineCandidate(w, owner, 'draft:' + owner)
        : undefined;
      const a = await host.analyze(
        candidate ? { candidates: [candidate], roots: { [owner]: candidate.id } } : {},
      );
      if (g === generation.current) {
        setAnalysis(a);
        setTargets([]);
      }
    });
  };
  const current = analysis?.current() ? analysis : undefined,
    plan = proposal?.current() ? proposal : undefined,
    shown = result?.current() ? result : undefined;
  const choices = [
    ...new Set(
      current?.recheck.sites.flatMap((s) => {
        const o = w.owner(s.owner),
          row = o?.editor.artifact.versions
            .find((v) => v.versionId === o.editor.artifact.draft.baseVersionId)
            ?.content.rows.find((r) => r.id === s.row);
        return row?.values['tl1.row'] === 'cite' ? [s.owner + '#' + row.values['tl1.subject']] : [];
      }) ?? [],
    ),
  ];
  return (
    <details className="tl-repin" data-timeline-analysis>
      <summary>診断と試算</summary>
      <p>
        保存版・下書き案・確認した差替表を別々に読みます。試算で保存版・採用・原稿・Undoを変更しません。単作初見が前提です。世界の日付だけで人物の経験順を補いません。
      </p>
      <p>シリーズ横断の読書前提、任意の時間旅行、地図からの移動日数、sharedは未対応です。</p>
      {(analysis || exception) && (
        <TimelineExceptionView
          workbench={w}
          diagnostic={exception}
          diagnostics={current?.adopted.diagnostics ?? []}
          current={analysis?.current ?? (() => false)}
          notify={notify}
          done={() => setException(undefined)}
        />
      )}
      {!capabilities.t3a ? (
        <p role="note">このHostはT3a診断に対応していません。</p>
      ) : (
        <>
          <button type="button" disabled={busy || !!exception} onClick={() => diagnose(false)}>
            保存版を診断
          </button>
          <Field label="診断する下書きの資料">
            {(id) => (
              <select
                id={id}
                value={owner}
                disabled={busy || !!exception}
                onChange={(e) => {
                  clear();
                  setAnalysis(undefined);
                  setOwner(e.currentTarget.value);
                  setTargets([]);
                }}
              >
                <option value="">選んでください</option>
                {w.ownersOf('ledger').map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <button
            type="button"
            disabled={busy || !!exception || !owner}
            onClick={() => diagnose(true)}
          >
            この下書き案を診断
          </button>
          {busy && <p role="status">診断の入力を確認しています。</p>}
          {((analysis && !current) || (proposal && !plan) || (result && !shown)) && (
            <p role="status">前提が変わったため旧結果を表示しません。再診断してください。</p>
          )}
          {current && (
            <>
              <p data-analysis-scope={current.recheck.scope}>
                {current.recheck.scope === 'partial'
                  ? '限定範囲です。読めない資料がある場合は詳細な判定を返しません。'
                  : '許可された入力の範囲です。作品全体の整合性を保証するものではありません。'}
              </p>
              <Results
                label="現採用の診断"
                value={current.adopted}
                record={exception ? undefined : setException}
              />
              <Results label="下書き案だけの診断" value={current.candidate} />
              <section aria-label="未評価の再確認候補">
                <h3>未評価の再確認候補</h3>
                <p>修正必須や更新済みを意味しません。参照版と使用する情報の差分から列挙します。</p>
                {current.recheck.sites.length ? (
                  <ul>
                    {current.recheck.sites.map((s) => (
                      <li
                        key={s.site}
                        data-recheck-site={s.site}
                        data-recheck-classification={s.classification}
                      >
                        {s.site}：
                        {s.classification === 'direct'
                          ? '直接'
                          : s.classification === 'conditional'
                            ? '上流を再固定する場合'
                            : '判定不能'}
                        （未評価）
                        <details>
                          <summary>根拠と宛先</summary>
                          <p>{s.via.join('、')}</p>
                          {s.destinations.map((d) => (
                            <p key={d.occurrence}>
                              {d.occurrence} · {d.links.join('、') || '原稿未接続'}
                              <button
                                type="button"
                                onClick={() =>
                                  selectOccurrence(
                                    d.occurrence.slice(d.occurrence.indexOf('#') + 1),
                                  )
                                }
                              >
                                提示位置と原稿を確認
                              </button>
                            </p>
                          ))}
                        </details>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>表示できる再確認候補はありません。</p>
                )}
              </section>
              <fieldset disabled={busy || !!exception || !!plan}>
                <legend>情報利用を試算する場面</legend>
                {choices.map((scene) => (
                  <label key={scene} className="tl-analysis-choice">
                    <input
                      type="checkbox"
                      checked={targets.includes(scene)}
                      onChange={(e) => {
                        clear();
                        setTargets(
                          e.currentTarget.checked
                            ? [...targets, scene]
                            : targets.filter((t) => t !== scene),
                        );
                      }}
                    />
                    {scene}
                    <button type="button" onClick={() => select(scene)}>
                      場面を確認
                    </button>
                  </label>
                ))}
              </fieldset>
              {!capabilities.t3b && (
                <p role="note">このHostはT3bの案生成・作者確認・仮定診断に対応していません。</p>
              )}
              <button
                type="button"
                disabled={busy || !targets.length || !capabilities.t3b || !!plan}
                onClick={() =>
                  void run(async () => {
                    const g = generation.current;
                    const p = await host.proposeSubstitutions(current, {
                      kind: 'information-use',
                      targets: [...targets],
                    });
                    if (g === generation.current) {
                      setProposal(p);
                      setRows(p.rows.map((_, i) => i));
                      setResult(undefined);
                    }
                  })
                }
              >
                差替表の案を作る
              </button>
            </>
          )}
          {plan && (
            <section aria-label="確認する差替表">
              <h3>確認する差替表（未評価）</h3>
              <p>
                選んだ行だけを試算します。外した行の参照は固定された旧版のままです。生成だけでは診断しません。
              </p>
              {plan.rows.map((r, i) => (
                <label
                  key={r.source + r.selector.row + r.selector.ref}
                  className="tl-analysis-choice"
                >
                  <input
                    type="checkbox"
                    checked={rows.includes(i)}
                    disabled={busy || !!exception}
                    onChange={(e) => {
                      setRows(e.currentTarget.checked ? [...rows, i] : rows.filter((n) => n !== i));
                      setResult(undefined);
                    }}
                  />
                  <span>
                    {r.owner} · {r.selector.row}/{r.selector.ref}
                    <br />
                    {r.expectOld.artifact}@{r.expectOld.version}#{r.expectOld.item} →{' '}
                    {r.to.candidate}#{r.to.item}
                  </span>
                </label>
              ))}
              <button
                type="button"
                disabled={busy || !!exception}
                onClick={() =>
                  void run(async () => {
                    const g = generation.current,
                      confirmed = await host.confirmSubstitutions(
                        plan,
                        rows.map((i) => plan.rows[i]),
                      );
                    const r = await host.evaluateHypothesis(confirmed);
                    if (g === generation.current) setResult(r);
                  })
                }
              >
                この表で試算
              </button>
              <button type="button" onClick={clear}>
                差替案を取り消す
              </button>
            </section>
          )}
          {shown && <Results label="確認した差替表の仮定診断" value={shown.hypothesis} />}
        </>
      )}
    </details>
  );
}
function Results({
  label,
  value,
  record,
}: {
  label: string;
  value: TimelineSemantics;
  record?(d: TimelineDiagnostic): void;
}) {
  return (
    <section aria-label={label} data-diagnostic-result>
      <h3>{label}</h3>
      <p>
        snapshot {value.snapshotId.slice(0, 12)} ·{' '}
        {value.scope === 'partial' ? '限定範囲' : '入力範囲内'}
        。明示された最低移動日数がない移動可能性は情報不足です。
      </p>
      {value.diagnostics.length ? (
        <ul>
          {value.diagnostics.map((d, i) => (
            <li
              key={d.site + ':' + i}
              data-diagnostic-site={d.site}
              data-diagnostic-state={d.state}
            >
              <strong>{labels[d.state]}</strong>：{d.site}
              <p>{d.reason}</p>
              {record && d.state !== 'satisfied' && (
                <button type="button" onClick={() => record(d)}>
                  この診断に例外を記録
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>表示できる診断はありません。</p>
      )}
      <details>
        <summary>時点・場面の読取文脈</summary>
        {value.times.map((t) => (
          <p key={t.site}>
            {t.site}（{t.context}）：
            {t.calculated.state === 'resolved'
              ? `${t.calculated.time.kind} ${t.calculated.time.start ?? '未指定'}`
              : '算出不能'}
          </p>
        ))}
        {value.scenes.map((s) => (
          <p key={s.site}>
            {s.site}：{labels[s.state]} ·{' '}
            {s.evaluated ? '候補参照で試算' : '固定された保存版を参照'}
          </p>
        ))}
      </details>
      <details>
        <summary>事実・発言・認識と読者への開示</summary>
        <p>構成の提示位置までに引用された明示情報です。原稿に反映済みとは意味しません。</p>
        {value.statements.map((s) => (
          <p key={s.site}>
            {s.site}：
            {s.category === 'fact' ? '事実' : s.category === 'claim' ? '発言' : '人物の認識'} ·{' '}
            {s.info} · {s.mode}
          </p>
        ))}
        {value.disclosure.map((d) => (
          <p key={d.occurrence + d.info}>
            {d.occurrence}：{d.info} ·{' '}
            {d.mode === 'confirmed'
              ? '確定的な開示'
              : d.mode === 'misleading'
                ? '誤誘導の主張'
                : '部分的な開示'}
          </p>
        ))}
      </details>
    </section>
  );
}
