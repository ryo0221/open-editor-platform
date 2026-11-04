import type { TimelineTimeConstraint } from './projection';
const reason = {
  time: '時点を確定できません',
  precision: '時刻の精度が足りません',
  clock: '時計の換算がありません',
  reference: '基準の保存版を確認できません',
  unsupported: 'この制約の上限は未対応です',
  overflow: '計算範囲を超えます',
};
export function TimeConstraints({ checks }: { checks: TimelineTimeConstraint[] }) {
  return (
    <section aria-label="明示された時間制約" className="tl-time-constraints">
      <h4>明示された時間制約</h4>
      {checks.length ? (
        <ul>
          {checks.map((c) => (
            <li key={c.id} data-time-constraint={c.id} data-result={c.result.state}>
              <strong>
                {c.result.state === 'satisfied'
                  ? '成立'
                  : c.result.state === 'violated'
                    ? '違反'
                    : '判定不能'}
              </strong>
              ：{c.kind === 'after' ? '前後関係' : '明示された最低移動日数'} · {c.minimum}日以上 ·
              基準{' '}
              {c.base.state === 'internal'
                ? c.base.item
                : c.base.state === 'unreadable'
                  ? '読めない参照'
                  : `${c.base.artifact} · ${c.base.version} · ${c.base.item}`}
              （{c.anchor === 'end' ? '終端' : '始端'}）
              {c.result.state === 'undetermined' && <> · {reason[c.result.reason]}</>}
            </li>
          ))}
        </ul>
      ) : (
        <p>表示できる制約はありません。移動可能性や全体の整合性を判定したものではありません。</p>
      )}
      <p>
        書かれた二つの時点と、同じ台帳内の厳密な前後関係の循環を確認します。出来事の時点を自動修正しません。全制約の同時成立・例外・知識は未評価です。
      </p>
    </section>
  );
}
