# 設計に連動する見積・積算・工程の設計

**設計 v0.1 / 2026-10-25、実装更新 2026-10-26。E0〜E5の実装・検証中。**
具体的なAPI、通常導線と検証済み範囲は実装記録を参照。全条件の受け入れは未完了。
`kind: estimate`、純粋な`@editor-platform/estimate-core`とReactの`@editor-platform/estimate`を提案する。
対象は数量の根拠、単価・費目、案比較と工程案。domain担当は積算modelと計算、adapter担当はCAD/BIM/Data接続、
Host担当は保存・権限・複数成果物への公開を受け持つ。
[共通設計](../calculation/design.md)と[検証計画](verification-plan.md)を合わせてレビューする。

## 目的と初期の完成像

設計者・見積担当者がCADの部品数量やBIMの数量から費用を計算し、設計変更に伴う差額を確認して採用できる。
後続で作業量から工程案を作り、通常Dataで管理する工程とScheduleに接続する。
原価/見積の試算を扱い、発注、請求、会計処理、契約承認、法令準拠の積算基準を提供するとは宣言しない。

正常操作は、(1)部品を数量と単価へ対応付けて見積を保存、(2)設計の新版を読み差額と未対応行を確認して採用、
(3)作業条件から工程案を作り、Dataへ公開してScheduleに表示、の3つ。
失敗例は、単価欠落を0円扱いする入力、親assemblyと子部品の二重計上、古いBIM評価値による数量更新。

Dataのprojectionだけでは数量根拠、単価の版、単位換算、丸め、重複計上、更新時の対応と差額を保持できない。
Estimateはその独立した意味を持つ。CAD/BIMの形状・部品表は元domainの正本、単価表はDataの正本を維持し、
Estimateの表を編集して形状や元の単価を変更しない。工程の編集正本も後述の通常Dataに置く。

## 現在の実装との接点

| 現在のコード                          | 使えるもの                                                | 積算にそのまま使えない点                                                                               |
| ------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `cad-core/src/bom.ts`の`bomRows`      | flat/hierarchical、入れ子・pattern・bom excludeの数量規則 | `item`は表示順。`CadBomRow`は永続row ID・root body ID・全occurrence lineageを持たない                  |
| `cad-core`のassembly/source closure   | 保存した部品の版、component ID、body ID、pattern          | 同じ名前・品番だけで新版の同一性を判断できない。flatでown bodiesを持つassemblyと子が両方出る場合がある |
| `bim-core/src/derive.ts`の`deriveBim` | 要素別のshape/quantity/diagnostic                         | 数量はmm/mm2/mm3。`source: kernel`の値はanalyticだけで完結しない                                       |
| `bim/src/evaluate.ts`の`BimEvaluator` | element別status、`kernelQuantities`、形状のmeasure        | 全体の`status: ok`でも各elementがerrorの場合がある。kernel成功だけで全必要数量の充足を推定しない       |
| Data Timeline / Schedule lanes        | 工程rowの保存・表示と予定への関連                         | 稼働日計算や工程の依存solver、外部カレンダー同期はここに追加済みではない                               |

`docs/status.md`やCAD入口には古い提案段階の文章が残るため、この表は実行sourceを根拠とする。
図面・IFCの未マージPRは本設計の依存にしない。積算は既存のnative数量から始める。

## 能力matrix

| 能力                               | 宣言範囲・段階                                        | 状態 / 拒否方法                                        | 条件         |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ | ------------ |
| Local編集・Viewer                  | E1：手入力数量、単価、費目、見積比較                  | 実装予定                                               | N01–N14      |
| CAD数量                            | E2：保存済みassembly/body、countのみ                  | 実装・検証中。重量・面積・加工時間の自動推定は非対応   | C09          |
| BIM数量                            | E3：要素別の明示metric、analytic/kernelの検証済み数量 | 実装・検証中。unsupported/未計算を診断し集計を止める   | C09          |
| 文字・選択                         | E1：名称/理由のplain text、line/source ID選択         | 実装・検証中。永続annotationは非対応                   | C01、N08     |
| Proposal / headless                | E1：数値・単位・数量根拠・価格・差額のpreview         | 実装・検証中。UIと同じvalidator、1採用1Undo            | C03          |
| Shared / template / linked reuse   | 初期local-only、通常作成のみ                          | 非対応。全入口で理由付き拒否、catalogに登録しない      | C04–C06はN/A |
| Native / CSV / Dataコピー          | E1：計算根拠付きnativeと静的出力                      | 実装・検証中。CSVを根拠の完全保存とは呼ばない          | N10、C07/C09 |
| 結果参照                           | E4：保存した見積表・比較chart                         | 実装・検証中。既存の4 destinationとcaptureへ接続       | C07          |
| 工程案→Data→Schedule               | E5：稼働暦、FS依存、単位期間、明示公開                | 実装・検証中。resource最適化・予定への自動反映は非対応 | C03/C07      |
| React/TSX、Office参照出力、IFC出力 | 本domainでは扱わない                                  | 非対応としてformat選択・APIを拒否                      | C08はN/A     |
| 狭い画面・offline                  | 条件入力・差分確認、保持入力での計算                  | 実装・検証中。未保持/失効時は診断。実機は別検証        | N11/C09/C10  |

## Native model

以下は概念schema。`SourcePin`、decimal、単位・丸めは共通設計を用いる。

```text
EstimateDocument(schemaVersion=1)
  title, currency{code,minorDigits}, roundingPolicy
  sources[{id, pin, snapshotKey, extractionSpec}]
  quantities[{id, sourceId?, identity, metric, unit, value,
              quality, extractionBasis, coverage, override?}]
  rates[{id, sourceDataPin?, rowId?, priceFieldId?,
         unitPrice, perUnit, currency, asOfDate?, evidenceText?}]
  lines[{id, name, category, quantityBindings, rateId,
         wasteRatio, adjustments, workRuleId?, inclusion}]
  adjustments[{id, kind: fixed|percent, amountOrRate, basisLineIds, reason}]
  workRules[{id, setupHours, hoursPerUnit, crewCount, hoursPerDay}]
  workPlan{calendar, projectStartDate, tasks, dependencies}?
  scenarios[{id, name, permittedOverrides}]
  calculations[{id, basis, basisHash, lineResults, totals, workResults?, resultHash}]
  retainedSources[{key, pin, nativeContent, dependencies}]
```

quantity、rate、line、rule、task、scenarioのIDは表示順と独立。複製では新IDを発行し内部参照をremapする。
quantityの由来とvalueはadapter由来の不変snapshot。手直しは`override {value, reason}`に分離して元値を保持する。
手入力quantityは`quality: manual`で、出典・理由を必須とし、幾何計測済みとは表示しない。
読み取った外部値を使うか、手入力値を採用するかは明示操作であり、元sourceの失効を自動overrideで回避しない。

calculationのbasisには数量、採用override、ratesの値と版、line mapping、規則、engine版、単位・丸めを保持する。
シナリオは許可された単価・数量override・ロス率・作業条件だけを変更する。CAD形状の変更はCADで新しい版にする。
パネル、選択、計算進捗、現在比較しているcalculationはprivate。成功結果の採用・削除は通常command。
空見積は有効。参照されるrate/quantityの削除はmapping修正と一緒に行わなければ拒否する。

## CADの数量identityと重複計上

CAD coreに新しい公開quantity projectionを追加する案とする。既存BOM表示をコピーして別の数量規則を作らない。
`bomRows`と新projectionが同じtraversal/count関数を利用できるよう小さく整理し、既存CSVと数量を回帰する。
提案名は`cadQuantityRows`。既存APIではない。

- occurrenceのidentityはroot Artifact ID、component IDのpath、pattern IDとcopy ordinal、leaf body IDのtuple。
  versionはsource pinへ分離し、同じIDが残る新版を対応付ける。patternの設定変更は位置/数量差を必ず表示する。
- flatの購入部品はpart Artifact IDで対応候補をまとめても、同一assembly内に異なるversionがある場合は別行にする。
  version移行が一対一と検証できない場合は`ambiguous`。名前・品番・contentHashのみで自動対応しない。
- rootのbodyはbody IDを使い、`CadBomRow.item`やbody nameをidentityにしない。
- quantity rowは被覆するoccurrence/bodyの集合（上限内のcanonical集合）と数量、source pinsを持つ。
  instance倍率をもう一度掛けない。階層表示の親子行を単純sumしない。
- 各assemblyは`buy`（親を購入し子を含めない）か`make`（自身のbody材料と子を数え、組立工賃は別費目）を明示する。
  同じcost category内で親の購入費とその子の購入費がcoverage重複したら拒否する。
- `bom: exclude`は元の意図を保ち、除外された件数と対象を表示する。access不可・欠落は除外とは区別し、計算を止める。

同じ部品に材料費・加工費・組立費が付くことは許可する。重複検査はcost categoryとcoverageで行う。
一つのquantityを同じcategoryで分割する場合は配賦比率を明示し、合計1以下を要求する。
余りは未配賦として表示し、完全見積を確定するには配賦完了か理由付き除外が必要。
E2ではcountのみを対応し、volume×密度や形状からの加工費推定を暗黙で加えない。

## BIMの数量取得

selectorはelement ID + metric ID + scope（whole element / 宣言したlayer等）を使う。
初期scopeはwhole element。metricはcount、length、grossArea、netArea、grossVolume、netVolumeのうち
各要素が実際に提供するものだけを能力表に宣言する。未知の`values` keyや未実装の面積を推定しない。

1. 対象native版をvalidateし、`deriveBim`のdiagnosticを確認する。
2. `analytic`は該当metricを取得。`kernel`は同じcontentHash・geometry設定・engine版の評価結果を要求する。
3. `BimEvaluator`の全体statusだけでなく、対象elementのstatusと必要metricが全てあることを確認する。
   grossが無い時にnetを代用しない。`source: none`も0と解釈しない。
4. mm→mは1/1000、mm2→m2は1/1,000,000、mm3→m3は1/1,000,000,000を使う。
   浮動小数の幾何計測値はその数値精度を保持し、decimal化によって物理的な正確さが増すとは表示しない。
5. 屋根による切断、開口、joinの変更はgeometry basisを変え、古い計測を`stale`にする。
   net/grossと開口控除の採用を各lineで表示し、既に控除した数量から二度控除しない。

BIMに配置されたCAD部品は建築element IDを一次identityにする。同じ配置をBIMと参照CAD両方から
数えないよう、root sourceとoccurrence mappingを明示する。根拠がない異なるsource間の同一性は推測せず、
ユーザーが対象を分けるかduplicateとして解決する。BRep・原本assetを必要とする場合は保持closureに含め、欠落時は拒否する。

## 単価・費用計算

rateは手入力か保存Dataのrow/fieldを明示的に対応付ける。source Dataの変更通知だけでは単価を変えない。
不足単価、通貨違い、単位違い、負の通常数量、NaN/Infinityは`blocked`。単価0は明示入力と理由があるときだけ有効。
通常lineの負額は禁止し、値引きは理由付きadjustmentで表す。FXは初期非対応。

```text
billableQuantity = adoptedQuantity × allocationRatio × (1 + wasteRatio)
unroundedLineCost = billableQuantity(converted to rate.perUnit) × unitPrice
lineCost = quantize(unroundedLineCost, currency.minorDigits, roundingPolicy)
baseSubtotal = sum(lineCost of included lines)
adjustment = fixed amount OR quantize(sum(named base line costs) × rate, minorDigits, mode)
total = baseSubtotal + sum(adjustments)
```

quantity表示の丸めと請求数量の丸めは別。数量を切上げて購入する場合はlineの明示quantize規則として計算する。
ロス率は0〜1、配賦比率は0〜1、単価は非負。percent adjustmentは-1〜1、fixedはsigned decimal。
adjustmentのbasisは通常lineだけで、他adjustmentを参照する循環・複利計算を許さない。
税相当額が必要なら利用者が率と対象lineを明示する。法域や税率、適格請求書要件を自動判定しない。
複数の丸め順序は初期に増やさず、line丸め→集計に固定する。異なる通貨の合計を一つにしない。
adjustmentの適用後にtotalが負になる場合は初期範囲では拒否する。返金・credit処理は別能力とする。

一つでも未解決の必須quantity/rate/mappingがあれば完全な`total`は出さない。表示可能な部分額は
「集計済み小計」と未解決件数を併記し、見積合計や比較の最安案に使わない。
全source行はinclude/exclude/pendingのどれかを持つ。除外は理由を保存し、欠落と区別する。

## 変更と差額の採用

新版の取得はquantityを差し替えるproposalを準備する。`unchanged/changed/added/removed/ambiguous/blocked`を
quantity/lineごとに返す。手入力単価、名称、備考、配賦、作業規則は対応が確認できたlineで保持する。
削除されたquantityに紐づくlineは自動削除せず、削除案/手入力へ切替/対応変更を示す。
新quantityは未対応行になる。名前の類似で既存単価を勝手に割り当てない。

同時に数量と単価が変わった場合、先に数量を変更した中間計算を作り、
`quantityDelta = cost(newQ, oldRate) - cost(oldQ, oldRate)`、
`rateDelta = cost(newQ, newRate) - cost(newQ, oldRate)`とする。丸め後の計算を差し引くため差額の和が一致する。
追加/削除/ロス/配賦/adjustment等は別の変更として示し、説明できない残差を黙って数量差に含めない。

採用はsource pins、mapping、数量、検証済みcalculationをEstimateの1transactionで更新する。
Cancelと失敗はcontent/history不変。過去の確定版は不変で、旧見積の表示が最新設計へ追従しない。
既存sourceの更新、入力buffer、Undo、権限変更後に届いたcandidateは共通設計のrevision/basis検査で拒否する。

## 工程案と編集正本（E5）

Estimateは「この数量・作業条件なら何日かかるか」という計算根拠と工程案を持つ。
Dataが管理する実際の工程row、担当者、進捗、コメントをEstimate内に複製しない。
`workPlan.tasks`は計算用のtask ID、line ID、rule ID、releaseDate、dependencyだけを持ち、実績を持たない。

```text
effortHours = setupHours + billableQuantity × hoursPerUnit
durationWorkdays = ceil(effortHours / (crewCount × hoursPerDay))
start = first working date >= projectStart / release / predecessor finishes
finishExclusive = calendar date immediately after the last occupied working date
```

crewCountは1〜100、hoursPerDayは(0,24]、effortHoursは非負。effort0はmilestoneとして別表示する。
calendarは週の稼働曜日と日付例外を文書内に保持し、全taskで1つ。祝日や地域暦は推定せず入力する。
計算はISO暦日で行い、UTC瞬間に変換しない。初期依存はfinish-to-startだけ、lagは非負の整数稼働日。
cycle、休日しかないcalendar、範囲外の日付、未解決lineを拒否する。自動resource leveling・人員の二重割当防止は非対応で、
同じcrewを複数taskで使う場合の実行可能性は保証しない。画面にその前提を表示する。

公開時はHostへData用の宣言的な行patchを返す。対応する費目・task IDと、開始日/終了日/工数/根拠を示す。
既存Data Timelineと`time-axis`は両端を含む日付区間を使う。adapterは開始日と「最終稼働日」を日付列へ書き、
計算のfinishExclusiveをそのままend列へ書かない。期間中の休日を含む棒は暦上の期間であり、稼働日数/工数を別列に出す。
milestoneは同日開始/終了とkind列を持つrowにし、通常Timelineでは1日のmarkerとして表示する。
duration0という意味はkind/工数列で明示し、1日の労務費を加算しない。日付境界とmilestoneを往復fixtureで確認する。

Hostはtarget Artifact、source task ID↔row ID、更新対象column ID、前回公開値をpublication receiptとして保持する。
更新は「前回公開値 / 現在Data / 新しい工程案」の3者比較。管理対象fieldを人が変えていたらconflictにし、
備考・担当・進捗など管理対象外のfieldは保持する。削除案も人の編集があれば自動削除しない。
同request IDで同内容はidempotent、異内容はconflict。新規作成はatomic `putIfAbsent`を必須にする。

Estimate採用→Data更新→Schedule参照追加は各々の保存境界を持つ。Hostの再試行台帳で完了/未完了を表示し、
途中失敗を全成功にしない。既存Dataはtarget revisionを検査して一つの通常transactionで更新する。
DataをUndoしてもEstimateやScheduleの過去履歴を巻き戻さない。再提案時にreceiptと現行値を再照合する。
Scheduleは保存したData Timelineをlaneで参照するだけ。外部カレンダー・会議・参加者への反映は行わない。

## Surface・操作・Host

上部に版と「完全/未対応n件/過去の条件」を表示。数量表、単価・費目表、差額比較、工程案を切り替える。
source要素とlineを相互選択し、quantityの元値・override・単位換算・丸め前後を確認できる。
各行の編集は通常command。複数lineの単価mapping、source更新採用、計算結果採用はそれぞれ1transaction。
readOnlyはbuttonだけでなくshortcut、paste、headless、proposal、async完了のtrusted境界で強制する。
IME bufferとUndoの境界はAnalysisと同じ。390pxでは比較を縦に並べ、表の横scrollとfield drawerを用意する。
精密な3D操作を必須にせず、一覧からsource elementへ移動できる。永続3D annotationは今回追加しない。

公開入口案は`estimate-core`（model/計算/操作/差分）、`estimate`（Surface/CSS）、
`estimate/sources`（CAD/BIM/Data adapter）、`estimate/outputs`（Data patch/参照adapter）。
数量adapterのCAD/BIM依存はcoreの外に置き、手入力見積HostへOCCTを読み込ませない。public exportsだけを使う。
Hostは保存・permission・source読取・kernel評価結果取得・navigation・公開receiptを提供する。
工程公開や外部計算のためにEditorへユーザー/組織/承認/queue/接続tokenのmodelを足さない。

通常Hostのkind/content/validator/native/format/Surface routingと独立`estimate-host.html`を追加する。
接続先は`apps/playground/src/model.ts`、`App.tsx`、`app/import-artifact.ts`、
`apps/artifact-host/src/model.ts`。全packageのclosed unionへ無条件に追加せず、対応能力だけを宣言する。
保存失敗のdirty保持、遅延保存の非上書き、native全version検査、retryは既存Hostを使う。

## 上限・入出力

初期はsources 8、quantities 2,000、rates/lines各1,000、scenarios 10、保存calculations 5、tasks 1,000、
FS edges 3,000、calendar日付例外1,000、計画期間10年以内。occurrence coverageは全体10,000件以内。
domain contentは閉包と過去結果込み2 MiB、native envelopeは既存16 MiB。どれかの超過で拒否し、無断縮約しない。
大きなCAD原本・assetを閉包として保持できない場合は初期対象外。必要な入力を限定した保存版を選び直す。

native JSONは数量・単価・根拠・計算・工程条件を保持する。CSVは静的line/合計と単位・版を出し、
formula風文字列を無害化する。価格や数量根拠を含む出力のアクセス確認は共通設計に従う。
参照表示は保存・検証済みの見積結果に限定し、draftや未計算の現行条件を確定見積として描画しない。
過去版の固定出力は当時の数量・価格・丸めで再現する。

## 実装順と設計判断

| 段階 | 主な変更                                            | 完了の意味                                            |
| ---- | --------------------------------------------------- | ----------------------------------------------------- |
| E0   | `estimate-core`、共通decimal/単位、fixture          | 費目・配賦・丸め・不完全状態と更新差分を検証          |
| E1   | Surface、独立/通常Host、保存、native/CSV/Dataコピー | 手入力数量と単価の見積を完走。ES01–ES10               |
| E2   | CAD数量projectionとsource adapter、更新preview      | CAD部品数量→見積→設計更新→差額採用。ES11–ES15         |
| E3   | BIM adapter、kernel quantityとのbasis接続           | 対象metricの数量根拠を確認して積算。ES16–ES19         |
| E4   | ReferenceAdapterと比較の通常導線                    | 保存した見積表・chartを説明資料へ。ES20–ES21          |
| E5   | work rule/calendar/FS、Data更新adapter、Schedule    | 工程案の公開・人の変更とのconflict・再試行。ES22–ES27 |

推奨は単一通貨、line丸め、CAD countから開始、BIMはmetricを限定、工程の実績はData所有。
既存BOM identityを拡張する実装PRでは、既存CSVの変化とsource selectorの公開APIを改めてレビューする。
公開receiptを永続化できないHostでは再同期を宣言せず、新規の静的Data作成までに制限する。
将来の多通貨、税計算、resource最適化、共有編集は別能力として受け入れる。汎用ERPや工程workflow engineを作らない。
CAD解析・最適化の後続計画は変更せず、今回の積算をそのsolver完了に依存させない。
