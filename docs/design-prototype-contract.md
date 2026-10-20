# Design の画面試作（#246）

設計版 1、2026-10-13。既存の `design` domain に interaction と flow を追加する。新しい Artifact kind や Host の製品モデルは作らない。検証結果は別の検証報告に記録する。

## 目的と所有境界

要素や部品の instance を押して次の frame、状態違いの frame、重ねた frame を開き、名前つきの流れを通す。Platform が native model、command、診断、試作 Surface を提供する。試作の移動履歴、表示設定、進捗は private state とし、編集の content、version、Undo に入れない。Host が完了通知の保存、仕様との対応付け、公開・共有を担当する。

代表操作は、ボタンの遷移先を設定して保存、instance の部品だけを上書き、流れを選んで重ね開きを含む画面を通すこと。存在しない遷移先、切れた流れ、不正な JSON は診断または入力拒否で扱い、壊れた参照を黙って削除しない。

## Native と互換性

2026-10-19 の #294/#295 では、新たな `setDesignInteractions` /
`setDesignPrototype` および patch の書き込み時に、指定された遷移・開始・flow の
frame が実在することを検証する。frame の削除後や既存 JSON の参照切れは従来どおり
保持・診断し、無関係な編集で黙って書き換えない。JSON intent の API は
[headless 契約](design-headless-contract.md)を参照。

`setDesignPrototype` は設定を書く際に、未指定の `startFrameId` キーを省く。
開始 frame が未指定かつ flows が空なら `prototyping` 自体を削除するため、
設定の追加と取り消しで従来の未指定状態へ戻る。開くだけでは書き換えない。
既存の明示的な空設定や保存版を読み込み時に正規化することはない。

Design の schemaVersion 1/2 を保持し、要素と component template に任意の `interactions`、content に任意の `prototyping` を追加する。interaction の trigger は click/tap、action は navigate/switch/back/open-overlay/close-overlay。参照は frame の安定 ID。空の interactions は継承を明示的に無効化し、未指定は既存部品の定義を継承する。instance の部品は既存の overrides を使う。

prototyping は独自 schemaVersion 1、任意の startFrameId、ID・名前・frameIds の順序を持つ flows。上限は要素あたり 2 triggers、flow 100 本、各 flow 256 frames、文字列 256 文字。実行履歴は 256、overlay は 8、instance 展開は 16 段。flow 診断は各段の異なる履歴候補 64 を上限とし、超過は route-limit 診断を返す。既存の hierarchy/geometry validator は維持する。

参照切れは保存できる構造上正しい draft とし、同じ public 診断関数を UI/headless で使う。frame 削除は参照を残して診断し Undo で回復する。frame をまとめて複製・template remap すると内部の遷移先も remap する。SVG/PNG は見た目のみで interaction/flow を含めず、既存の書き出し結果を変えない。

旧 reader（main 5a32d35）は任意の追加欄を検証しないまま読み、試作を表示できない。旧 reader の汎用 JSON 保存は欄を保持するが、旧 template/remap/shared adapter は新しい参照の意味を理解しない。試作の編集・再利用には新 reader を使う。追加欄のない Design は移行も欄追加もせず roundtrip する。retained version を変更しない。

## Surface と API

通常の Design Inspector で trigger/action/遷移先、instance 部品の継承・上書き、start frame、flow の名前と順序を編集する。編集は既存 command/Session 境界を通す。独立した DesignPrototypeSurface は content と Host callback を受け、編集 command を要求しない。開始 frame、flow、押せる所の表示、戻る、再開始を提供する。mobile の通常 Host は既存の More editor tools から Open prototype を開く。overlay は背景を暗く覆い中央に表示し、最上位だけが操作を受ける。

navigate は現在の表示を履歴に積み、base frame を変更して overlay を閉じる。
switch は表示中の frame の状態を置き換える（overlay 中は最上位 overlay を置き換える）ため、履歴を増やさない。
back は前の表示を復元する。open-overlay は現在の表示を履歴に積んで重ね、close-overlay はその重ね開きの履歴も消す。
重ね開きを閉じた後の back が同じ画面に一度留まることはない。

Flow の隣接 frame を結ぶ操作を次の候補として示す。順に通過すると一回の実行につき完了通知を返す。記録は保存しない。注釈モードでは要素または frame 上の位置を、既存 ElementAddress と canvas Region（Design の world pixels）で Host に渡す。Host の既存 anchored comments が保存を担当する。送信 callback の Promise は authority の受理または永続書込み完了まで解決せず、拒否・保存失敗では reject する。Surface は失敗・権限失効時にも入力を保持し、Host は未確定の操作 ID を再試行時に照合する。 authority が拒否した操作は同じ thread/reply ID の retained proposal 経路で再試行し、受理確認後に該当する retained entry だけを取り除く。再試行の応答が不明な場合は同じ proposal ID を照合し、無関係な保持編集と Save/Leave の確認条件を維持する。

## 能力と検証計画

| 能力                          | 範囲                                                        | 実装と対象検証 |
| ----------------------------- | ----------------------------------------------------------- | -------------- |
| Local 編集・native 保存・Undo | 既存 Session、任意 metadata                                 | 対象検証済み   |
| Viewer/headless 試作          | 5 actions、click/tap、重ね開き、flow、診断                  | 対象検証済み   |
| Selection/annotation          | native ID、world pixels、Host 所有 comments                 | 対象検証済み   |
| Shared 編集                   | 既存 trusted Design transaction の metadata、selective Undo | 対象検証済み   |
| Template copy                 | 内部 frame 参照 remap、外部参照は診断                       | 対象検証済み   |
| SVG/PNG                       | 既存 graphic export の見た目維持                            | 対象検証済み   |
| React/Office への試作変換     | 対象外。別 domain の runtime に持ち込まない                 | 非対応         |
| Product records/publication   | Host 所有                                                   | 非対応         |
| Performance                   | 測定停止を維持。functional 上限のみ                         | NOT RUN        |

N01–N14 の該当部分は pure model の正常/異常/atomic failure、旧 JSON と version/hash、read-only と Host 拒否、通常/独立 Host、desktop/mobile の 3–5 frame flow、keyboard、ブラウザエラーと screenshot で検証する。C02/C03/C05 および shared metadata は該当する。native IME、Office 試作出力、別 domain の prototype runtime は対象外。実機 mobile、全 browser、production 認証・永続サーバーは宣言しない。
