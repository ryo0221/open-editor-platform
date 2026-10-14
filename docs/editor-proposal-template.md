# Editor設計書テンプレート

新しいEditor、または既存Editorへの大きな能力追加を提案するときにコピーして使います。`[記入]`を埋め、適用しない項目には理由を書いてください。[開発ガイド](editor-development.md)と[受け入れ条件](editor-acceptance.md)を併用します。

設計書は予定・合意を記録するものです。検証済みの主張は、別の[検証報告](editor-verification-template.md)へ記録します。

## 提案の情報

| 項目                      | 内容                                          |
| ------------------------- | --------------------------------------------- |
| Editor名 / kind / package | [記入]                                        |
| 設計の版 / 更新日         | [記入]                                        |
| 実装・レビューの担当      | [記入: 公開時は必要最小限のhandle/roleを使う] |
| 対象PR / 検証報告         | [記入]                                        |
| 提案段階                  | [設計 / prototype / local受け入れ / 能力追加] |

## 目的と代表操作

- 想定する利用者と、その人が達成したい作業: [記入]
- 代表的な正常操作を3つ: [記入]
- 想定する拒否・失敗操作を3つ: [記入]
- 新しいnative domainが必要な理由 / 既存projectionでは足りない理由: [記入]
- このEditorで扱わない内容と、Hostに残す機能: [記入]

## 能力matrix

状態には「実装予定」「実装済み・未検証」「検証済み」「非対応」を使います。下の行を必要に応じて具体化し、表示UI、headless API、sharedで範囲が異なる場合は分けて記載します。非対応は入口の無効化/拒否方法まで定義します。

| 能力                                | 宣言する範囲・上限 | 状態   | 非対応の理由・拒否方法 / 関連条件 |
| ----------------------------------- | ------------------ | ------ | --------------------------------- |
| Viewer / local編集                  | [記入]             | [記入] | N01–N14                           |
| Text / native IME                   | [記入]             | [記入] | C01                               |
| Selection / annotation              | [記入]             | [記入] | N08 / C02                         |
| 外部proposal / headless             | [記入]             | [記入] | C03                               |
| Shared editing                      | [記入]             | [記入] | C04 / S01–S06                     |
| Template: whole / fragment / preset | [記入]             | [記入] | C05                               |
| Linked reuse / token / style        | [記入]             | [記入] | C06                               |
| Native JSON                         | [記入]             | [記入] | N10                               |
| Native以外のimport/export           | [記入: formatごと] | [記入] | C07                               |
| React preview / TSX / bridge        | [記入]             | [記入] | C08                               |
| Large asset / offline / recovery    | [記入]             | [記入] | C09                               |
| Browser / 実機 / accessibility      | [記入]             | [記入] | N11 / C10                         |

## Native model

```text
[content schema、安定ID、主要entityと参照関係を記入]
```

- ドメインcontentのschema versionと旧schemaの読み取り範囲: [記入]
- Artifact envelopeとの関係: [記入。envelopeとcontent schemaを混同しない]
- Element IDの生成、並べ替え/複製/importでの保持・remap方針: [記入]
- 座標・単位・範囲・時刻、region/anchorの意味: [記入]
- 必ず守る不変条件、削除時の参照、空状態: [記入]
- Domain validatorの正常/異常入力、未知schemaの扱い: [記入]
- 要素数、ネスト、文字数、byte/asset等の入力上限: [記入]
- Contentとprivate view stateの境界、明示的に保存するview定義: [記入]
- Asset ID/hash・取得元・保持・欠落時の方針: [記入]

## 操作と履歴

| 利用者の操作             | Command / 対象・read依存 | Atomic単位・Undo | 拒否・Cancelの条件 |
| ------------------------ | ------------------------ | ---------------- | ------------------ |
| [代表操作1]              | [記入]                   | [記入]           | [記入]             |
| [代表操作2]              | [記入]                   | [記入]           | [記入]             |
| [Bulk / paste / gesture] | [記入]                   | [記入]           | [記入]             |

- Local history、typing group、input buffer、compositionの役割: [記入]
- Read-onlyと権限の検証境界、UI以外の入口: [記入]
- Proposal preview/apply/reject、base revisionとstale判定: [記入 / 非対応理由]
- Shared wire/codec、text engine、precondition、selective Undo: [記入 / 非対応理由]
- Anchor mapping、deleted/orphan/outdatedの扱い: [記入 / 非対応理由]

## Surface・Host・保存

- Public entrypointとheadless entrypoint、型付けするprops/events: [記入]
- Surface CSS、container、controlled/private panel・camera: [記入]
- Keyboard、focus、mobile/touch、clipboard、IMEの対応: [記入]
- Playground登録箇所と、独立Hostのentry/build設定: [記入]
- Hostが所有する認証、永続化、外部実行、製品データ: [記入]
- Draft更新、version commit、parent/hash、reload、restore: [記入]
- 保存失敗、retry、遅延完了、二重creationの処理: [記入]
- Native importで検証するdraft/retained versions/hash、原子性: [記入]
- 旧schemaの移行方法と、旧version bytes/hashを保持する方法: [記入]

## 機能別adapterと互換性

- 対応するclosed union、factory、validator、command converter、reference Host: [記入]
- Template/reuseのexact version、retained dependency、ID remap、conflict: [記入 / 非対応理由]
- 外部formatのsupported/loss/reject matrixと、実readerの検証環境: [記入 / 非対応理由]
- React原本、preview/build、semantics/routes、regeneration conflict: [記入 / 非対応理由]
- Public API/schema変更による既存Hostへの影響と移行手順: [記入]

## 安全性とperformance計画

- Untrusted JSON/HTML/SVG/URL/assetの検証、sandbox、取得制限: [記入]
- 依存packageとassetのlicense/provenance、公開してよいデータ: [記入]
- 想定規模と固定fixture: [記入]
- 測定前に定義するworkload、budget、sample/repetition、失敗sampleの扱い: [記入]
- 現在の測定停止・performance保留との関係: [記入。追加測定は停止中]

## 実装・検証計画

| 段階                     | 変更対象file/package | 完了条件ID | 検証scenario・環境 |
| ------------------------ | -------------------- | ---------- | ------------------ |
| Pure model / commands    | [記入]               | [記入]     | [記入]             |
| Surface / 独立Host       | [記入]               | [記入]     | [記入]             |
| 通常Host / 保存 / import | [記入]               | [記入]     | [記入]             |
| 宣言能力のadapter        | [記入]               | [記入]     | [記入]             |
| 回帰 / 文書 / レビュー   | [記入]               | [記入]     | [記入]             |

## 設計レビューで残す判断

- 合意した範囲と、意図的に先送りした能力: [記入]
- 未決定事項、互換性リスク、prototypeの露出制限: [記入]
- 機能受け入れを妨げる条件と、performance/releaseの別条件: [記入]
- 設計変更が必要になったときに見直す契約・条件ID: [記入]
