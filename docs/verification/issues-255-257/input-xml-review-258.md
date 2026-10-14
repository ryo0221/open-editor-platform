# PR #258 入力・XML 追加レビュー修正

2026-10-14。レビュー対象 `1ef1b2d` の追加4指摘を修正した。
[初回検証](README.md) と先行する3つのレビュー修正報告の履歴は保持する。

## 指摘と修正

| Review comment                       | 修正と回帰検証                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4267533477`: provenance の XML 文字 | source/name/version/license を XML 1.0 Char に限定。禁止制御文字、孤立 surrogate、U+FFFE/U+FFFF を validator / constructor / native validation で拒否。日本語、emoji、補助面の境界、有効な tab/CR/LF と delimiter escaping、native roundtrip、SVG XML parse を確認                       |
| `4267533484`: 隣接 arc flags         | A/a の引数位置に従い flag を1文字ずつ読み、後続の flag / 座標を分ける。絶対・相対、小数座標、符号付き座標、反復 arc を含む5組の compact / expanded 表記を検証。原本 path は保持し、不正 flag・半径・座標上限の拒否を維持                                                                 |
| `4267533488`: 空テキストの拡張       | 空 text を拡張対象から除外。固定/hug/fill、入れ子、縮尺、auto-layout、8px未満の空 placeholder で bounds / sizing / 定義を保持し、不要な override を作らない                                                                                                                              |
| `4267533493`: 診断の input slot      | DesignDrawing.textSourcePath が実効 text の native 欄を指す。展開時に binding の owner を追跡して入力キーへ対応付け、repeat/asset resolve と ID remap 後の参照も反映。同名 part、入れ子、singleton template、instance/nested overrides、remap 有無、overflow/clip 診断、定義不変性を検証 |

textSourcePath は Design の描画用メタデータであり、native schema / content / SVG に
保存しない。通常の公開 layoutDiagnostics は従来の描画アドレスを返し、template 展開が
bound input を示す診断へ変換する。旧 textScope 未指定定義の処理と hash は維持する。
必須入力の空値を許可する変更は行っていない。

## 検証結果

Linux 6.18.44 / Debian 13、Node 20.20.2 / npm 10.8.2、Chromium 151.0.7922.173。
desktop 1440×900、mobile 390×844、既存 mobile 回帰は 768px を含む。
固定 Noto CJK JP/Mono 四つの SHA-256 検査を維持した。
Node 20.20.2 の PATH を選択して repository root で実行。
browser / Office / tooling の子プロセスは実行環境の network 権限付き sandbox を使用。

| Command / scope                                                                                                                                                                                                                       | 結果                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `npm run lint` / `npm run typecheck`                                                                                                                                                                                                  | PASS                                                     |
| `npm test`                                                                                                                                                                                                                            | PASS。147 files / 1,310 passed / 9 skipped / 1,319 total |
| `npm run build`                                                                                                                                                                                                                       | PASS。通常 Vite build / registered React preview build   |
| `npm run check:files` / `npm run test:tooling`                                                                                                                                                                                        | PASS。tooling 25 tests                                   |
| `npx vitest run packages/design/src/vector-xml-arc-review.test.ts packages/templates/src/design-input-diagnostics-review.test.ts packages/design/src/vector.test.ts packages/templates/src/design-text-fit-review.test.ts`            | PASS。4 files / 62 tests。後続 full unit に含む          |
| `npm run test:e2e -- tests/e2e/design-reuse-graphics.spec.ts tests/e2e/design-reuse-graphics-mobile.spec.ts tests/e2e/issue2-canvas.spec.ts tests/e2e/issue2-mobile.spec.ts --output=/tmp/pr258-fourth-final-browser --reporter=list` | PASS。21 cases                                           |
| `npm run test:e2e -- --config=playwright.design-reuse.production.config.ts --output=/tmp/pr258-fourth-final-production`                                                                                                               | PASS。17 cases                                           |
| 上記の後、フォーム fixture の layout / ESM 化に対し `--grep 'TemplateInputForm\|input form'` で再検証                                                                                                                                 | dev 2 / production 2 cases PASS                          |

公開 TemplateInputForm と DesignSurface だけを使う独立 Host で、同名 local part を持つ
2つの component のうち問題の入力欄だけに aria-invalid と clip error を表示し、
失敗時に表示中の native content を変えないことを確認した。
実 SVG の compact / expanded arc 5組は長さと始点/中点/終点が一致し、補助面 Unicode を
含む provenance の export は XML として parse できた。
browser console error / uncaught exception をすべて検査し、desktop / mobile / production
の screenshots を目視確認した。9 skipped を PASS に含めない。

## 失敗履歴・証拠

修正前の focused は2 files / 26 tests中18 failed / 8 passed。
XML 文字・compact arc・slot 対応付けは実不具合を再現した。空 text の最初の3ケースは
必須入力の空値で invalid-input となり、拡張処理に到達しなかったため再現 fixture を
修正した。空 placeholder を直接持つ native content と、入れ子の scaled auto-layout を
使い、空 text guard を一時的に旧処理へ戻す確認では6 casesすべてが不要な override /
fixed sizing で失敗した。guard は直後に復元した。フィルタ外の10 casesは未実行。
修正後の中間 focused は3 failed / 52 passed。fixture 修正と追加回帰後に62 passed。

XML 出力の追加確認で、viewBox の未定義 onload / 制御文字属性が clip 矩形へ渡ることを
別の1ケースで再現した。clip 矩形を x/y/width/height だけに限定し、未定義 native
データを保持してもSVGへ出さない。最終のfull unitと21 / 17 browserを再実行した。

初期フォームのスクリーンショットで label の並びを確認し、Host 側の layout を補正した。
Template UI root の IIFE bundle に出た Office worker の import.meta 警告は、フォーム
fixture を ESM script にして解消した。変更した dev/production のフォーム2 casesを
それぞれ再実行した。Office worker の単独 fixture 能力を宣言していない。

初回・中間 logs は `/tmp/pr258-fourth-repro.log`、`/tmp/pr258-fourth-focused.log`、
`/tmp/pr258-fourth-empty-repro.log`、`/tmp/pr258-fourth-viewbox-repro.log`、
`/tmp/pr258-fourth-unit.log`、`/tmp/pr258-fourth-browser.log`、`/tmp/pr258-fourth-production.log`。
最終 logs は `/tmp/pr258-fourth-focused-final.log`、`/tmp/pr258-fourth-final-unit.log`、
`/tmp/pr258-fourth-final-typecheck.log`、`/tmp/pr258-fourth-final-lint.log`、
`/tmp/pr258-fourth-final-build.log`、`/tmp/pr258-fourth-final-browser.log`、
`/tmp/pr258-fourth-final-production.log`、
`/tmp/pr258-fourth-form-browser.log`、`/tmp/pr258-fourth-form-production.log`、
`/tmp/pr258-fourth-files.log`、`/tmp/pr258-fourth-tooling.log`。
screenshots は上記 browser 出力先と `/tmp/pr258-fourth-form-browser` /
`/tmp/pr258-fourth-form-production` に保持する。
raw evidence / build / font / export は Git 外に置き、公開アーカイブは作成していない。
この環境以外では記載 command で再現する。

追加4指摘の対象範囲は修正・検証済み。vector 固有の複数 browser context/fault、
実機/native IME/全 browser/外部 SVG reader は NOT RUN。
performance の追加測定・tuning は行わず、既存の停止・保留を維持する。
