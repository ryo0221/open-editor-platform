# Animationのレイヤー複製・削除

通常のAnimation編集画面と、独立したAnimation Hostの矩形・グループを対象にします。
レイヤー一覧で対象を選び、`Duplicate selected layer`で複製、
`Delete selected layer…`で削除対象を確認できます。

## 操作と保持する内容

- グループを選ぶと、その子孫レイヤーと、対象レイヤーのtrack・keyをまとめて扱います。
  子が親より前に保存されている場合や、別のレイヤーが間にある場合も同じです。
- 複製は元の内容を変更せず、全レイヤー・track・keyに新しいIDを割り当てます。
  外側の親は同じまま、複製内の親子関係とtrackの参照先だけを振り直します。
  配置、時間範囲、値、easingは保持し、コピーを元の描画順のまま末尾へ追加します。
  同じ場所に重なるため、移動したい場合は複製後にBase transformを変更してください。
- 削除はレイヤーIDの一覧と、削除するlayer・track・keyの件数を表示します。
  `Confirm layer deletion`で確定し、`Cancel layer deletion`で変更せず戻れます。
  兄弟、外側の親、別のcomposition、保存済み版を変更しません。
- 複製・削除はそれぞれ既存Hostの履歴の一操作です。Undo/Redoは子孫とkeyも一緒に復元します。
  保存後のnative JSON・再読込・保存版Playerは既存の経路を使います。

未確定の数値入力・IME変換・key移動中は、先に確定または取り消してください。
read-only中や保存中は操作できません。削除確認後に編集・履歴移動などでrevisionが変わると、
確定ボタンが無効になります。確認を取り消し、最新の対象を見直してください。

## 公開コマンド

`@editor-platform/animation-core`は次のlocal v1 APIを公開します。

```ts
const plan = inspectAnimationLayerSubtreeV1(content, compositionId, layerId);
const newIds = [...plan.layerIds, ...plan.trackIds, ...plan.keyIds].map((sourceId) => ({
  sourceId,
  id: crypto.randomUUID(),
}));
const copy = duplicateAnimationLayerV1(content, compositionId, layerId, newIds, scope);
const remove = removeAnimationLayerV1(content, compositionId, layerId, scope);
// Hostが既存SessionまたはControlledSurfaceController.executeへ渡す。
```

`plan`は変更できないID一覧です。複製のID対応は準備時に取り込み、対象の全IDに一つずつ必要です。
不足・余分・重複・無効なID、既存の全compositionとのID衝突、既存の容量上限超過は拒否します。
内容の省略で上限へ収めません。コマンドは実行時の`scope.canEdit()`と準備時の内容を検証し、
古い内容への実行を拒否します。失敗した操作は内容・履歴に部分変更を残しません。

Hostは入力保護、revision・lifecycle・権限の確認、永続保存を引き続き担当します。
UIとheadless利用は同じコマンドを使います。新しい保存・履歴基盤は追加していません。

numeric schema 1と既存の矩形Player契約を保ちます。prototypeの暗黙移行、文字・画像・path、
レイヤーの並べ替え・グループ化、shared codec/selective Undo、template/reuseは今回の追加範囲に含みません。
Issue #74全体の完了や、plugin配布版への反映を示すものではありません。
通常Hostとの接続は[既存の連携契約](playground-slide-integration.md)、
実行した検査は[検証記録](../verification/issue-74/layer-actions.md)を参照してください。
