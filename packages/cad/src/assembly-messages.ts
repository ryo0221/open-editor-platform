/** Messages for the R2b assembly codes (docs/cad/r2b-assembly.md). */
const messages: Record<string, string> = {
  'part-source-missing': '部品の版がこの文書に保持されていないため、箱で表示しています。',
  'part-source-mismatch': '保持している部品の版の内容が記録と一致しないため、使っていません。',
  'part-access-revoked': 'この部品を読む権限がないため、箱で表示しています。',
  'part-build-mismatch':
    '部品の版のkernel buildがassemblyと違います。部品を開いてassemblyと同じbuildへ移行し、版を保存してから使ってください。',
  'part-source-unavailable':
    'このHostでは部品を挿入できません（部品の版を一覧・読み込みできません）。',
  'part-invalid': '部品の版の内容が正しくないため、挿入できません。',
  'part-empty': 'この版には形状（active body）も配置した部品もないため、挿入できません。',
  'part-stage-failed': '部品の版を保存できませんでした。',
  'part-insert-busy': '部品を挿入しています。終わってから、もう一度操作してください。',
  'limit-assembly-depth': '部品の入れ子が深すぎます（8段まで）。',
  'limit-instances': '入れ子を展開した部品の数が上限（10,000）を超えます。',
  'limit-closure-versions': '保持する部品の版が上限（512）を超えます。',
  'limit-parts': '部品の定義は512個までです。',
  'limit-components': '配置した部品（component）は1,024個までです。',
  'assembly-pose-mismatch':
    '保存された部品の配置が、配置の値またはjointと一致しません。「配置を解き直す」で採用するまで、編集と書き出しを止めています。',
  'assembly-poses-match': '保存された配置はjointと一致しています。解き直す必要はありません。',
  'assembly-pose-unstable': 'jointの配置が定まりませんでした。',
  'component-unplaced': '部品の配置がありません（jointの子でない部品には配置が要ります）。',
  'component-mirror-joint':
    'jointで置いた部品は鏡映して複製できません。固定の配置を持つ部品を選んでください。',
  'connector-missing':
    'jointの接続点の面・辺・頂点が見つかりません。接続点を選び直すか、jointを削除してください。',
  'connector-ambiguous':
    'jointの接続点の面・辺・頂点が分かれて1つに決まりません。接続点を選び直すか、jointを削除してください。',
  'connector-unsupported-geometry':
    'jointの接続点には平らな面・円柱面・円錐面・円や円弧の辺・頂点・部品の原点だけを使えます。',
  'joint-part-unavailable':
    'jointの部品を参照できないため、そのjointの子を動かす編集（joint・値・offsetの変更、親の接続点を動かす編集）はできません（子は保存された配置のままです）。',
  'part-pose-mismatch':
    'この部分assemblyの版の保存された配置がjointと一致しないため、使っていません。部分assemblyを開いて配置を解き直し、版を保存してください。',
  'part-joint-broken':
    'この部分assemblyの版のjointの接続点が解決できないため、使っていません。部分assemblyを開いて直し、版を保存してください。',
  'connector-path': 'jointの接続点の部品の経路が正しくありません。',
  'connector-ref': 'jointの接続点の参照が正しくありません。',
  'joint-type': 'jointの型が正しくありません。',
  'joint-child': 'jointの子の部品がありません。',
  'joint-cycle': 'jointが輪になっています。jointは木の形にしてください。',
  'joint-multiple-parents': '1つの部品の親のjointは1つまでです。',
  'joint-child-placed': 'jointの子の部品には、固定の配置を残せません。',
  'joint-values': 'jointの値がjointの型と合いません。',
  'joint-limit': 'jointの値が範囲の外です。',
  'joint-limits': 'jointの範囲が正しくありません。',
  'joint-limit-of': 'jointの範囲がjointの型の値を指していません。',
  'limit-joints': 'jointは1,024個までです。',
  'limit-joint-depth': 'jointの木が深すぎます（128段まで）。',
  'solved-poses-children': '解いた配置がjointの子と合いません。',
  'component-pattern': '部品のpatternの形式が正しくありません。',
  'component-pattern-seed': '部品のpatternの元の部品（seed）がありません。',
  'component-pattern-seed-changed': '部品のpatternの元の部品（seed）は変えられません。',
  'component-id-reserved':
    '「copy:」で始まる名前はpatternの写しのためにあり、部品のIDにできません。',
  'limit-pattern-copies': 'patternの写しは文書全体で4,096個までです（元の部品・bodyを含む）。',
  'connector-copy-missing':
    'jointの親がpatternの写しで、その写しが無くなります。先にjointを消すか、別の部品へ付け替えてください。',
  'part-unreferenced': '使われていない部品の定義があります。',
  'part-source-duplicate': '同じ部品の版の定義が2つあります。',
  'joint-child-own':
    'jointの子は動かす部品の面・辺・頂点か原点です。この文書のbodyは子にできません（親にはできます）。',
  'joint-child-copy':
    'patternの写しはjointの子にできません（写しは元の部品とpatternに従います）。元の部品を子にするか、写しを親にしてください。',
  'joint-child-is-parent': '親と同じ部品を子にはできません。別の部品の接続点を選んでください。',
  'joint-connector-body': 'この形は今のactive bodyのものではないため、接続点にできません。',
  'joint-drag-bound':
    'このjointの値はparameterまたは式で決まります。dragではなくparameterで変更してください。',
  'joint-drag-edge-on':
    'この向きからはjointを動かせません（動く面や軸を真横・真正面から見ています）。視点を変えてください。',
  'joint-drag-unsolved': 'このjointは解けていないため、dragで動かせません。',
  'joint-drag-fixed': '固定のjointには動かす値がありません。',
  'joint-drag-busy': '形状を計算しています。終わってから動かしてください。',
  'joint-drag-changed':
    '動かしている間に内容が変わりました（Undoなど）。値は変えていません。もう一度動かしてください。',
  'joint-creating':
    'jointを作っている途中です。Apply jointかCancelで終えてから、もう一度操作してください。',
  'assembly-export-unsupported':
    '部品を配置した文書のSTL・GLBの書き出しにはまだ対応していません。STEP（AP242のassembly）とPNGは書き出せます。',
  'step-parts-pending': '部品を計算中です。全ての部品が済んでから、もう一度書き出してください。',
  'step-part-unavailable':
    '計算できない・参照できない・参考表示の部品があるため、STEPに書き出せません。部品の木で状態を確かめてください。',
  'step-part-missing': '保持していない部品の版があるため、STEPに書き出せません。',
  'step-product-limit': '部品の種類が512を超えるため、STEPに書き出せません。',
  'step-assembly-not-empty':
    'assemblyのSTEPは空の文書にだけ取り込めます。新しい3D partを作ってから取り込んでください。',
  'step-instance-limit':
    'STEPの部品の配置（入れ子を平らにした数）が1,024を超えるため、取り込めません。',
  'step-instance-transform': 'STEPの部品の配置に拡大・縮小か鏡映があるため、取り込めません。',
  'step-depth-limit': 'STEPのassemblyの入れ子が8段を超えるため、取り込めません。',
  'step-assembly-empty': 'STEPのassemblyに、solidか面（shell）を持つ部品がありません。',
};
/** A message for an assembly code (also inside `cad-invalid:<code>@path`), or undefined. */
export function describeAssemblyCode(code: string): string | undefined {
  const base = code.startsWith('cad-invalid:') ? code.slice(12) : code;
  return messages[base.split(/[:@]/)[0]!];
}
