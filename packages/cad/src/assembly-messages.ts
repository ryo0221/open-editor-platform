import type { CadGearMeshProblem } from '@editor-platform/cad-core';

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
  'make-part-unavailable':
    'このHostでは部品を作れません（新しいcadのArtifactを作れないか、部品の版を保持できません）。',
  'make-part-has-dependents':
    'このbodyを読む編集が文書に残るため、部品にできません。先にそれを消すか、読む先を選び直してください。',
  'make-part-imported':
    'STEPから読み込んだ形を含むbodyは、まだ部品にできません（読み込んだファイルはこのArtifactにだけ保持されています）。',
  'make-part-textures':
    'テクスチャ画像を貼ったbodyは、まだ部品にできません。テクスチャを外してから部品にしてください。',
  'make-part-component': '部品の配置が、作った部品を指していません。',
  'make-part-stale':
    '部品を作っている間に文書が変わりました。もう一度「部品にする」を押してください（作った部品のArtifactは残ります）。',
  'make-part-changed': '部品を作る前に文書が変わりました。もう一度「部品にする」を押してください。',
  'make-part-create-failed': '部品のArtifactを作れませんでした。',
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
    'jointの接続点には平らな面・円柱面・円錐面・円や円弧の辺・直線の辺・頂点・部品の原点だけを使えます。',
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
  'joint-multiple-parents':
    '1つの部品を置くjointは1つまでです（持ち替えの候補はMountsに並べます）。',
  'mount-joint': 'その部品の取り付け先の候補ではありません。',
  'mount-exists': 'その部品にはもう取り付け先の候補があります。',
  'limit-mounts': '取り付け先の持ち替えは1つの文書で64までです。',
  'limit-mount-joints': '1つの部品の取り付け先の候補は4つまでです。',
  'mount-joint-in-use':
    '外す候補のjointを、別のjointの連動か干渉の許容が使っています。先にそれを外してください。',
  'mount-component-unplaced': 'その部品はまだjointで置かれていません。',
  'joint-child-placed': 'jointの子の部品には、固定の配置を残せません。',
  'joint-values': 'jointの値がjointの型と合いません。',
  'joint-limit': 'jointの値が範囲の外です。',
  'joint-limits': 'jointの範囲が正しくありません。',
  'joint-limit-of': 'jointの範囲がjointの型の値を指していません。',
  'joint-couplings': 'jointの連動が正しくありません（1つの値に1つ、3つまで）。',
  'coupling-of': '連動する値がjointの型の値ではないか、2回指定されています。',
  'coupling-from': '連動のもとのjointまたは値がありません。',
  'coupling-kind': '角度は角度に、長さは長さにだけ連動できます。',
  'coupling-cycle': 'jointの連動が輪になっています。',
  'coupling-ratio': '連動の倍率は−1,000〜1,000にしてください。',
  'coupling-offset': '連動のずれが大きすぎます。',
  'coupling-range':
    '連動した角度が1回転を超えます（何回転も回すjointは「Turns continuously」にしてください）。',
  'joint-continuous': '何回転も回せるのは回転のjoint（revolute）だけです。',
  'gear-mesh-unsolved':
    '歯車のjointがまだ解けていません（部品を読めないか、jointが壊れています）。',
  'gear-mesh-gear': 'jointの子の部品の版に、その歯車（spurGear）がありません。',
  'gear-mesh-off-axis': '歯車の軸がjointの回転軸の上にありません。',
  'gear-mesh-axes': '2つの歯車の軸が平行ではありません。',
  'gear-mesh-module': '2つの歯車のモジュールが違います。',
  'gear-mesh-profile': '2つの歯車の歯形（インボリュート／サイクロイド）が違います。',
  'gear-mesh-pressure-angle': '2つの歯車の圧力角が違います。',
  'gear-mesh-distance': '歯車の中心距離がかみ合う距離と違います。',
  'gear-mesh-face': '2つの歯車の歯幅が軸の方向で重なっていません。',
  'gear-mesh-ratio':
    '歯車の歯数が変わり、保存した比と合いません。「Mesh again」で比と位相を直してください。',
  'gear-mesh-clearance':
    '歯車の歯先が、相手の歯元の円に届きます（歯先か歯元の係数を直してください）。',
  'gear-mesh-backlash':
    '2つの歯車の歯厚の和がピッチを超え、歯が通りません（歯厚を薄くしてください）。',
  'gear-mesh-inactive':
    'jointが効いていないmountの候補で、何も回しません（mountでその候補を選んでください）。',
  'gear-mesh-frame':
    '片方のjointの枠がもう片方のjointで動く部品に乗っていて、中心線が回ります（両方の軸を動かない部品に置いてください）。',
  'gear-mesh-mating':
    'サイクロイドの歯車が相手の歯数で作られていません（相手の歯数を合わせてください）。',
  'gear-mesh-placement':
    '歯車が向きを裏返すミラーの先にあり、位置が読めません（ミラーを合わせる（union）にするか、別の歯車を選んでください）。',
  'gear-mesh-phase':
    '部品の版の中で歯車の向きが変わり、歯と歯が向かい合っています。「Mesh again」で位相を直してください。',
  'gear-mesh-coupling': 'かみ合いの従動側のjointの角度が、駆動側に連動していません。',
  'gear-mesh-coupled': 'その歯車のjointの角度は、もう別の値に連動しています。',
  'gear-mesh-driven-twice': '1つのjointを2つのかみ合いで従わせることはできません。',
  'gear-mesh-joint': 'かみ合いには、2つの別々の回転のjoint（revolute）を選んでください。',
  'joint-continuous-limits':
    '何回転も回すjointには範囲を付けられません。先に範囲を外してください。',
  'configuration-stale':
    'この形態は今のjointと合いません（jointの追加・削除・連動の変更の後）。上書きすると今のjointで直ります。',
  'configuration-limit': 'この形態の値は、今のjointの範囲の外です。',
  'limit-configurations': '形態は32個までです。',
  'interference-not-ready':
    '干渉を調べるには、今の内容の計算が終わっている必要があります（jointを作っている間は調べません）。',
  'interference-limit':
    '三角形（合計2,000,000）または候補の組（10,000）が上限を超えるため、干渉を調べられません。',
  'interference-worker-failed': '干渉を調べる処理が止まりました。もう一度調べてください。',
  'interference-allowance-duplicate': 'この組には同じ許容がすでにあります。',
  'limit-interference-allowances': '干渉の許容は256個までです。',
  'interference-allowances': '干渉の許容の一覧が正しくありません。',
  'interference-allowance': '干渉の許容の形式が正しくありません。',
  'interference-allowance-path': '干渉の許容の部品の経路が正しくありません。',
  'interference-allowance-same': '干渉の許容は2つの違う部品の組にしてください。',
  'interference-allowance-region': '干渉の許容の範囲が正しくありません。',
  'interference-allowance-joint': '干渉の許容のjointが正しくありません。',
  'interference-allowance-radius': '干渉の許容の球の半径は0より大きくしてください。',
  configurations: '形態の一覧が正しくありません。',
  configuration: '形態の形式が正しくありません。',
  'configuration-name': '形態の名前を入れてください。',
  'configuration-values': '形態の値が正しくありません。',
  'configuration-joint': '形態の値がjointのIDを指していません。',
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
    '部品を配置した文書のSTLの書き出しにはまだ対応していません。STEP（AP242のassembly）・GLB・PNGは書き出せます。',
  'glb-part-unavailable':
    '計算できない・参照できない・表示用のmeshがない部品があるため、GLBに書き出せません。部品の木で状態を確かめてください。',
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
const mm = (n: number) => String(Math.round(n * 1000) / 1000);
/** WM2: a gear mesh's problem in plain words, with the distances for a centre distance. */
export function describeGearMeshProblem(p: CadGearMeshProblem): string {
  const side = p.side === 'driver' ? '駆動側の' : p.side === 'driven' ? '従動側の' : '';
  if (p.code === 'gear-mesh-distance' && p.distanceMm !== undefined)
    return `歯車の中心距離が ${mm(p.distanceMm)} mm です。この組は ${mm(p.expectedMm ?? 0)} mm（m(z1+z2)/2＋転位分）でかみ合います。`;
  return `${side}${messages[p.code] ?? p.code}`;
}
export function describeAssemblyCode(code: string): string | undefined {
  const base = code.startsWith('cad-invalid:') ? code.slice(12) : code;
  return messages[base.split(/[:@]/)[0]!];
}
