# 汎用の成果物受け渡し — #35

`@editor-platform/artifact-output`は既存Artifactのimmutable版をHostへ渡す任意API。
新しい保存、Undo、承認、domain modelを作らない。Session／呼出し・保存・終了は
#35／PR #37で扱い、React UIの汎用改善は#38で追跡する。

```ts
import {
  createArtifactOutputManifest,
  verifyArtifactOutputManifest,
} from '@editor-platform/artifact-output';

// Hostが既存lifecycleで明示保存したversionのcontentからfilesを出力する。
const manifest = await createArtifactOutputManifest(
  savedArtifact,
  selectedVersionId,
  { id: 'my-format', version: '1.0.0' },
  [{ path: 'generated/Screen.tsx', mediaType: 'text/plain', bytes: generatedBytes }],
  hostSuppliedExactDependencyPins,
);
await verifyArtifactOutputManifest(manifest, transferredFiles, {
  source: expectedSavedSource,
  generator: expectedGenerator,
  dependencies: trustedHostPins,
});
```

manifest schema v1はsource（artifactId/kind/versionId/contentHash）、generator（id/version）、
Host依存（id/version/hash）、file（相対path/mediaType/byteLength/hash）、全体fingerprintを
保持する。sourceは既存immutable版を1つ指定し、選択版のartifactIdが元Artifactに属することと、保持contentのcanonical SHA256を検査する。
draftの暗黙commitや保存済み版の変更をしない。Hostが選んだ版から生成したfilesを渡す責任は
Hostにあり、このAPIはファイルの意味を解析してsourceとの等価性を証明するものではない。

出力fileのhashは実bytesのSHA256。manifest自体は自身のfile一覧に含めない。
元実装・依存はHostがexact版/hashを提供し、Editorは記録・expected pinと照合する。
Editorが元codeを取得・実行・hash算出する契約にはしない。hashはHostの認証や承認の証明
ではない。受け取り側はmanifestだけを自己申告のexpectedとして信頼せず、信頼したsource／
generator／依存pinを別経路で提供する。

入力はhashのawait前にcopyし、出力はdeep-frozen。変更bytes、欠損／追加／重複file、
不一致pin、未知schema/field、getter/hook、unsafe path、非finite sizeを拒否する。
pathは安全な相対segment、大小文字差だけの重複も拒否。`a`と`a/file.txt`のような
file／directoryの祖先衝突もcreate／verifyの双方で拒否する。最大256file／合計16MiB、
依存256。能力・上限はHostが出力形式ごとに宣言する。

配置先、承認物としての状態、後続生成、original dependency bytesの解決、永続配布、
画像差分の表示、認証／権限はHostの責務。本APIをauthorityや業務承認へ代用しない。
既存React独立driverは明示保存したsource-artifactと生成器版、5生成fileのmanifestを
Git外へ保存し、同じsource pinの再出力とverifyを行う。CSS/assets/原本は既存Hostの
依存解決・exact hash契約で扱う。詳細は[React UI portability](react-ui-portability.md)。
