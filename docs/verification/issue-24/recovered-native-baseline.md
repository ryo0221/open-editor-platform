# 復旧後のnative比較基準（2026-10-18）

[比較契約](native-regression-protocol.md)の同じ前版を、現行版より先に復旧後のinstanceで再測定した。
旧数値は同契約の履歴表とrawへ保持し、今回の3反復と混合しない。

source `b4514b9c467184cdf2cbfdd444223883ee698fcf`、bundle SHA-256 `9bd2ce7797448c3818cdba8a3acbc2332edc705e3d6b448125149ee54fd9b8cd`。
driver SHA-256 `d8c7df0b321cbf369d03ee17a9d5d00c9ac66eb19f5425e3317d8bc6c56ae4a9`、計測本体 SHA-256 `56c30fa668a55d59ddf7d4fbb7b196b4be7675923612a7dcc7c3bd0c4fc298b9`。
driverの計測本体は前版/現行版/replayでbyte一致し、bundle読込とsource metadataだけを計測外で変更した。
boot ID `b089dce4-0b56-4c0e-81a5-e5cf64cf1b97`、Node20.20.2/CPU/quota/fixtureは最終受入記録に記す。
各5 warm-up＋20 measured、nearest-rank p95、3 fresh process。全rawを保存し値の除外はしない。

| 操作             | 前版全3 p95 ms                    |    最大 ms | 20%上限 ms |
| ---------------- | --------------------------------- | ---------: | ---------: |
| prop             | 69.184029, 75.194075, 72.328771   |  75.194075 |  90.232890 |
| insert           | 65.038215, 45.546765, 51.497294   |  65.038215 |  78.045858 |
| move             | 130.673660, 92.522716, 127.284306 | 130.673660 | 156.808392 |
| undo             | 2.831814, 2.382083, 7.101763      |   7.101763 |   8.522116 |
| native-roundtrip | 68.061261, 70.917670, 35.644154   |  70.917670 |  85.101204 |
| tsx-export       | 10.200254, 10.110720, 9.289293    |  10.200254 |  12.240305 |
| host-resolution  | 0.723392, 0.854811, 0.766796      |   0.854811 |   1.025773 |

この比較前版はnative Hard 19/21で、2条件のmoveが100msを超えた保留source。受入済みには扱わない。
現行版は独立に全95 Hardと、この全7比較を満たす必要がある。基準値を候補版の結果に合わせて選び直さない。

原結果のSHA-256:

- `work/complete24/recovered-native-baseline/run-1/results.json`: `d6e87e8c6ae9254ffcdaa0caad5873eb73e957725a086db3c8f0ee11e198ea46`
- `work/complete24/recovered-native-baseline/run-2/results.json`: `aa5dc38eac06b22941404245c6d294725cf6705d82dc91c126b7add3efc50aff`
- `work/complete24/recovered-native-baseline/run-3/results.json`: `d7271836a28c1d9dc296448337ffcfc00bf6ddad2d4aaed9df4313c32d00700e`
