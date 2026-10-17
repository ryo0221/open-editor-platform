import ts from 'typescript';
/** Host compilation only; execution belongs exclusively to the opaque preview. */
export function compileProject(files: Record<string, string>, entry: string, symbol = 'default') {
  const modules: Record<string, string> = {};
  for (const [filename, source] of Object.entries(files)) {
    if (!filename.endsWith('.tsx')) continue;
    if (source.length > 150000) throw Error('TSX source exceeds 150 KB');
    const tree = ts.createSourceFile(
      filename,
      source,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TSX,
    );
    const inspect = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) throw Error('Unsupported module specifier');
        const name = node.moduleSpecifier.text;
        if (name !== 'react' && (!name.startsWith('./') || name.includes('..')))
          throw Error('Only React and generated local modules are supported: ' + name);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            ['require', 'eval', 'Function'].includes(node.expression.text)))
      )
        throw Error('Dynamic import/execution is unsupported');
      ts.forEachChild(node, inspect);
    };
    inspect(tree);
    const output = ts.transpileModule(source, {
      fileName: filename,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    const errors =
      output.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length)
      throw Error(
        errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'),
      );
    modules[filename] = output.outputText;
  }
  if (!modules[entry]) throw Error('Missing TSX entry');
  return {
    modules,
    entry,
    symbol,
    css: Object.entries(files)
      .filter(([f]) => f.endsWith('.css'))
      .map(([, text]) => text)
      .join('\n'),
  };
}
