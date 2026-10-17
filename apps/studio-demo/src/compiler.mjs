import * as Babel from '@babel/standalone';
export function compileSource(source, filename = 'Component.tsx') {
  if (typeof source !== 'string' || source.length > 150000)
    throw Error('ソースは150KB以内の文字列にしてください');
  const exported = [];
  let hasDefault = false;
  const check = () => ({
    visitor: {
      ImportDeclaration(path) {
        if (path.node.source.value !== 'react')
          throw path.buildCodeFrameError(
            'このデモではimportはreactのみ対応しています。依存を単一ファイルにまとめてください。',
          );
      },
      ExportAllDeclaration(path) {
        throw path.buildCodeFrameError('export * は未対応です');
      },
      ExportNamedDeclaration(path) {
        if (path.node.source)
          throw path.buildCodeFrameError('外部モジュールの再exportは未対応です');
        const d = path.node.declaration;
        if (d?.id) exported.push(d.id.name);
        if (d?.declarations)
          for (const v of d.declarations) if (v.id.type === 'Identifier') exported.push(v.id.name);
        for (const s of path.node.specifiers || []) {
          const name = s.exported.name ?? s.exported.value;
          exported.push(name);
          if (name === 'default') hasDefault = true;
        }
      },
      ExportDefaultDeclaration() {
        hasDefault = true;
      },
    },
  });
  let result;
  try {
    result = Babel.transform(source, {
      filename,
      presets: [
        ['typescript', { allExtensions: true, isTSX: true }],
        ['react', { runtime: 'classic' }],
      ],
      plugins: [check, 'transform-modules-commonjs'],
      sourceType: 'module',
    });
  } catch (e) {
    throw Error(e.message);
  }
  return { code: result.code, exports: exported, hasDefault };
}
export function importComponent(source, filename = 'Component.tsx') {
  const match = source.match(/\/\*\s*@editor\s+([\s\S]*?)\*\//);
  if (!match)
    throw Error('登録情報 /* @editor {...} */ が必要です。サンプルを参考にしてください。');
  let meta;
  try {
    meta = JSON.parse(match[1]);
  } catch {
    throw Error('@editorのJSONが不正です');
  }
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(meta.name || ''))
    throw Error('nameは大文字で始まるReact部品名にしてください');
  if (typeof meta.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(meta.version))
    throw Error('versionは1.0.0の形式で指定してください');
  if (
    !meta.props ||
    typeof meta.props !== 'object' ||
    Array.isArray(meta.props) ||
    Object.keys(meta.props).length > 20
  )
    throw Error('props schemaが必要です（20項目まで）');
  if (meta.children !== undefined && typeof meta.children !== 'boolean')
    throw Error('childrenはbooleanで指定してください');
  for (const [key, s] of Object.entries(meta.props)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) ||
      [
        'children',
        'key',
        'ref',
        'style',
        'className',
        'dangerouslySetInnerHTML',
        '__proto__',
        'constructor',
        'prototype',
      ].includes(key) ||
      key.startsWith('on')
    )
      throw Error('未対応のprop名: ' + key);
    if (!s || !['string', 'enum', 'number', 'boolean'].includes(s.type))
      throw Error('未対応のprops型: ' + key);
    if (
      s.type === 'enum' &&
      (!Array.isArray(s.options) ||
        !s.options.length ||
        s.options.some((x) => typeof x !== 'string') ||
        !s.options.includes(s.default))
    )
      throw Error('enumのoptions/defaultが不正: ' + key);
    if (
      (s.type === 'string' && typeof s.default !== 'string') ||
      (s.type === 'number' && !Number.isFinite(s.default)) ||
      (s.type === 'boolean' && typeof s.default !== 'boolean')
    )
      throw Error('defaultの型が不正: ' + key);
  }
  const compiled = compileSource(source, filename);
  if (meta.export === 'default' ? !compiled.hasDefault : !compiled.exports.includes(meta.name))
    throw Error(meta.name + 'のexportが見つかりません');
  const name = meta.name;
  return {
    id: 'custom.' + name,
    label: name,
    description: 'Imported · ' + meta.version,
    name,
    exportName: name,
    importPath: './components/' + name,
    isDefault: meta.export === 'default',
    version: meta.version,
    props: meta.props,
    children: !!meta.children,
    source,
    filename: name + '.tsx',
    compiled: compiled.code,
    custom: true,
  };
}
