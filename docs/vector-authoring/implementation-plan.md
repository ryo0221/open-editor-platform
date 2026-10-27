# パス編集の実装段階

契約の正本は[設計v0.3](design.md)。実装はIssue #502で追跡し、部分PRはRefsで関連付けます。

| 段階 | 変更                                        | 依存                                 |
| ---- | ------------------------------------------- | ------------------------------------ |
| D1   | pure cubic Bézier / Animation共通化         | なし                                 |
| D2   | path値・validator・固定frame描画・bounds    | D1                                   |
| D3   | schema3明示受理・native command・保存・拒否 | D2                                   |
| D4   | 独立path-handles・入力調停                  | 実装上は独立、レビューはD3の後に積む |
| D5   | 通常Surface・Host・独立embedの検証          | D3/D4                                |
| C1   | CAD内B-spline重複整理                       | 独立                                 |

Design P2はD1–D5で判定し、C1やCAD UI移行を前提にしません。
[操作ガイド](guide.md)・実行結果と未実施範囲。
Actions・追加性能測定・公開同期・deploymentは停止を継続します。
