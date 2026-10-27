# 設計積算・工程の実装・検証計画

**計画 v0.1。実施結果は実装記録のES別一覧を参照。** [設計](design.md)と[共通設計](../calculation/design.md)に
対応する機能受け入れを定義する。製造品質・法令準拠・工期実現性・本番サービスの保証ではない。

## 固定fixture

| Fixture | 入力                                                           | 独立に決める期待値                                                  |
| ------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| EF1     | root panel 1個×1,200円、subassembly 2個それぞれbolt 3個×25円   | bolt6個、合計1,350円。subassemblyのbuy/makeでcoverageが変わる       |
| EF2     | EF1のbolt数量を9個へ、単価を30円へ                             | 旧1,350円→数量だけ1,425円→数量と単価1,470円。数量差75円・単価差45円 |
| EF3     | 小数2桁通貨、数量3、単価0.335、half-up                         | 1.005をline丸めして1.01。単価丸め後の1.02と混同しない               |
| EF4     | 壁3m×2m×0.1m、開口1m×0.5m、単価20,000円/m3                     | gross 600,000,000mm3、net 550,000,000mm3、netで11,000円             |
| EF5     | 屋根でclipされる壁、kernel error/古いcontentHash、gross欠落    | 必要metricの完了までtotal blocked。analyticやnetで代用しない        |
| EF6     | 同名body、同品番別Artifact、複数part版、pattern・excluded part | 表示順に依存しないidentity。曖昧な版対応は明示解決                  |
| EF7     | 工程A=2稼働日、B=1稼働日、FS、金曜2026-10-30開始、土日休み     | Aは10/30と11/2、finishExclusive=11/3。Bは11/3、finishExclusive=11/4 |
| EF8     | EF7に11/3休業例外、Dataの担当/備考/開始日を個別編集            | Bは11/4〜11/5 exclusive。担当/備考は保持、開始日の競合だけ拒否      |
| EF9     | fake storage/authority/quantity Worker/target Data             | 遅延・重複・失敗・失効・Undoと再公開を再現                          |

税・材料・実勢単価を実データとして用いない。数値は仕様を検査する架空値であり、価格や標準歩掛の推奨ではない。
CAD/BIMのfixtureは既存fixtureを必要最小限で拡張し、数量期待値はBOM実装の再利用だけで作らない。

## 受け入れscenario

| ID   | 操作・故障                                               | 確認する結果                                                                                 | 段階  |
| ---- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----- |
| ES01 | 手入力数量・rate・lineを作成→計算→Undo/Redo              | exact値、単位、安定ID、1操作1履歴、元入力のfreeze不変                                        | E1    |
| ES02 | EF3、異なる単位、負数、0価格、overflow、未知通貨設定     | 1.01、変換係数、理由付き0、誤単位/暗黙丸めを拒否                                             | E0/E1 |
| ES03 | 単価欠落、未配賦、重複、quantity除外                     | 完全totalを出さず小計/未対応件数を表示。理由付き除外を区別                                   | E1    |
| ES04 | adjustment fixed/percent、配賦、ロス率、cycle            | 対象lineの明示、ratio境界、循環拒否、端数一致                                                | E1    |
| ES05 | 保存→reload→native往復→旧版restore、改竄/欠落閉包        | 全数量根拠・price版・結果保持。旧版hash不変、部分importなし                                  | E1    |
| ES06 | EF9で編集/Undo/close中の計算完了、2重request             | basis/revision/access不一致を不採用、同ID異内容conflict                                      | E1    |
| ES07 | readonly/失効をUI、shortcut、paste、headless、proposalで | trusted境界でも拒否。派生小計・CSV・参照を失効時に隠す/拒否                                  | E1    |
| ES08 | 独立/通常Host、desktop/390px、keyboard/native IME        | package CSS/public APIのみ、buffer/IME/保存のguard、focusとerrorなし                         | E1    |
| ES09 | CSV/Dataコピー、式風text、精度超過、creation再送         | 無害化、decimal/単位保持、独立copy、atomic putIfAbsent                                       | E1    |
| ES10 | Source価格Data新版、手入力override、未検証import結果     | 勝手な単価更新なし。根拠表示、再検証前に正式出力しない                                       | E1    |
| ES11 | EF1をCAD quantity adapterで取得                          | 6個/1,350円、body ID/occurrence/部品版、既存BOM/CSVの回帰                                    | E2    |
| ES12 | buy/make、親子同時計上、配賦合計>1、材料+工賃            | 重複拒否と正当な別categoryを区別、除外/未配賦表示                                            | E2    |
| ES13 | EF6で並替、rename、pattern、削除、part版差替             | stable identity、ambiguous拒否、元lineの単価/備考保持                                        | E2    |
| ES14 | EF2のsource/rate更新→preview→Cancel→採用                 | 75+45=120円、1Undoでoldへ、current/old calculationの区別                                     | E2    |
| ES15 | part失効・閉包欠落・異hash・depth/coverage上限           | count0や除外へfallbackせずblocked、import/更新は原子的                                       | E2    |
| ES16 | EF4でmm3→m3、gross/net、開口変更                         | net0.55m3/11,000円、二重控除なし、差額と根拠                                                 | E3    |
| ES17 | EF5、全体ok/element error、source none、metric欠落       | 各element/metric検査、stale/blocked、代替計測や0埋めなし                                     | E3    |
| ES18 | 同一CAD配置をBIMとCADから読む                            | 重複scopeを解決しない限り完全totalなし、同名推測なし                                         | E3    |
| ES19 | geometry変更→kernel遅延→旧計測到着、offline/import       | evaluation basis照合、権限/再検証、旧結果を現行に使わない                                    | E3    |
| ES20 | 保存見積を4 destinationへ固定/追従参照                   | 当時の単価/数量/丸め、保存失敗で更新なし、source移動                                         | E4    |
| ES21 | capture中の編集/失効、未対応Office、上限                 | 非同期preflight/冷cache/偽verifiedを検査し既存resolverを通る。未検証結果出力・無断切捨てなし | E4    |
| ES22 | EF7/EF8、hour/day計算、zero effort/milestone             | 稼働日・exclusive境界、祝日を推定しない、型違い拒否                                          | E5    |
| ES23 | FS cycle/lag/休日のみ/計画期間超過                       | cycle拒否、無限探索しない、resource前提の表示                                                | E5    |
| ES24 | 初回Data公開→担当/備考/日付の編集→新版提案               | 3者比較、管理外field保持、conflict対象だけ明示、1target1transaction                          | E5    |
| ES25 | Estimate保存成功→Data失敗→retry→重複、Data Undo          | 部分完了を表示、idempotent、別成果物のUndo非連動、再提案時の再照合                           | E5    |
| ES26 | 工程row削除、source task削除、receipt欠落、target失効    | 人の変更を失わない、再同期拒否/再対応付け、静的copyと区別                                    | E5    |
| ES27 | 保存Data Timeline→Schedule lane、row link、date境界      | 同じ工程の表示、会議/外部予定を作らない、全日付の往復一致                                    | E5    |

## 共通受け入れ条件と回帰

| 条件                | 対応                                                                |
| ------------------- | ------------------------------------------------------------------- |
| N01–N03             | 設計のdomain区分、ES01/05/10/14/19                                  |
| N04–N05             | ES01/06/14/24/25、pure commandの入力freezeとCancel無変更            |
| N06–N08             | ES08、通常Host登録/選択、ES11/13/16                                 |
| N09–N10             | ES05/06/07/09/15/19、保存failure/retry/16 MiB上限                   |
| N11–N12             | ES02/07/08/09、JSON/式/CSVはdataとして扱う                          |
| N13–N14             | 変更PRごとのsource/実行結果、対応範囲、errorと制限の文書更新        |
| C01/C03             | ES08/14/24、UIとheadlessの同じpreviewと採用結果                     |
| C07/C09             | ES05/09/15/19/20/21/27、全retained versionとsource閉包              |
| C10                 | 実browser/実機/支援技術の宣言対象でES08。未実施はNOT RUN            |
| C02/C04/C05/C06/C08 | 初期非対応につきN/A。入口・codec・catalog・formatの拒否を負例で確認 |

E0/E1はCAD/BIMをimportしない見積Hostで検証する。E2は既存BOM flat/hierarchical/pattern/excludeの数量・CSVと
assembly保存/再読込を回帰する。E3はBIM analytic/kernelの表示・quantity計算とnative保存を回帰する。
E4は既存ReferenceResolverの全version/capture権限/上限、E5はData Timelineの日付編集・UndoとScheduleのlane/予定を回帰する。

実装PRでは`npm run lint`、`npm run check:files`、`npm run test:tooling`、`npm run typecheck`、
`npm test`、`npm run build`と関連E2Eをローカルで実施する。suiteは既存`tests/playwright/suites.ts`に登録し、
検出確認後、通常Hostと独立Hostのproduction buildをdesktop/390pxで操作する。
native IME、合成event、viewport、実機、他browserを区別し、console/page errorと目視したscreenshotを記録する。

## 性能計画（未実施）

fixtureは20/200/1,000lines、CAD coverage100/1,000/10,000件、工程50/500/1,000tasksとする。
domain 2 MiB以内の固定fixtureで、数量取得/geometry評価、費用計算、差分、描画、保存を分ける。
BIM kernelの性能は既存の測定条件へ無断追加しない。本domainのbudgetは取得済み数量からの費用・工程計算に限定する。

測定前に環境を固定しcold5回、warmup3回、warm20回。median/p95/max、失敗/取消率、peak memoryを記録する。
提案budgetは1,000line再計算p95 1秒以下、1,000task/3,000edgeの工程計算p95 2秒以下、
取消応答p95 200ms以下、Worker peak memory 128 MiB以下。単一job30秒上限、scenarioは直列。
失敗・blockedを高速な成功sampleへ混ぜない。機能受け入れと性能合格を分け、現行の追加測定停止を維持する。
