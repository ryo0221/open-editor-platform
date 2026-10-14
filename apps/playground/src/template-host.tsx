/** Independent Host: uses public catalog, form, preview and creation APIs; never App/model. */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IndexedDBStorage, type Artifact } from '@editor-platform/artifact-core';
import {
  TemplateCatalog,
  builtinCatalog,
  LocalCatalog,
  applyInstantiation,
  prepareInstantiation,
  TemplateError,
  type TemplateDefinition,
  type NativeContent,
  type InputValue,
  type Diagnostic,
  type PreparedCreation,
} from '@editor-platform/templates';
import { TemplateInputForm, TemplatePreview, TemplateGallery } from '@editor-platform/template-ui';
import { prepareAgentTemplate } from './template-agent';
import './template-host.css';
const personal = new LocalCatalog('independent-template-catalog');
// This independent Host can start without any preinstalled catalog definitions.
const catalog = new TemplateCatalog(
  new URLSearchParams(location.search).has('empty-catalog')
    ? [personal]
    : [builtinCatalog(), personal],
);
const storage = new IndexedDBStorage<Artifact<NativeContent>>('independent-template-results');
function Host() {
  const [items, setItems] = useState<TemplateDefinition[]>([]),
    [selected, setSelected] = useState<TemplateDefinition>();
  const [values, setValues] = useState<Record<string, InputValue>>({}),
    [agentJson, setAgentJson] = useState('{}');
  const [prepared, setPrepared] = useState<PreparedCreation>(),
    [artifact, setArtifact] = useState<Artifact<NativeContent>>();
  const [error, setError] = useState(''),
    [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]),
    [gallery, setGallery] = useState(false),
    [readOnly, setReadOnly] = useState(false),
    [busy, setBusy] = useState(false);
  const working = useRef(false);
  useEffect(() => {
    void catalog
      .list({ kind: 'whole' })
      .then((list) => {
        setItems(list);
        if (list.length) choose(list[0]);
      })
      .catch((e) => setError(String(e)));
  }, []);
  async function refreshCatalog() {
    const list = await catalog.list({ kind: 'whole' });
    setItems(list);
    if (list.length && (!selected || !list.some((d) => d.templateId === selected.templateId)))
      choose(list[0]);
  }
  function choose(d: TemplateDefinition) {
    setSelected(d);
    setValues(structuredClone(d.sample));
    setAgentJson(JSON.stringify(d.sample, null, 2));
    setPrepared(undefined);
    setError('');
    setDiagnostics([]);
  }
  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setDiagnostics([]);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof TemplateError) setDiagnostics(e.diagnostics);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function create(p: PreparedCreation) {
    const result = await applyInstantiation(p, storage, !readOnly);
    setArtifact(result);
    setPrepared(undefined);
  }
  function download() {
    if (!artifact) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'template-result.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <main className="template-host">
      <header>
        <h1>Independent template host</h1>
        <p>同じcatalogと入力定義を、人向けformとUI非依存の模擬agent clientから使います。</p>
        <button onClick={() => setGallery(true)}>Galleryを開く</button>
        <label>
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
          />
          Host read only
        </label>
      </header>
      {error && <p role="alert">{error}</p>}
      <label>
        Template
        <select
          aria-label="Host template"
          value={selected?.templateId ?? ''}
          onChange={(e) => choose(items.find((d) => d.templateId === e.target.value)!)}
        >
          {items.map((d) => (
            <option key={d.templateId} value={d.templateId}>
              {d.domain} · {d.name} v{d.templateVersion}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <div className="template-host-grid">
          <section className="tp-gallery">
            <h2>Human form</h2>
            <TemplateInputForm
              fields={selected.inputs}
              assets={selected.assets}
              values={values}
              onChange={(v) => {
                setValues(v);
                setPrepared(undefined);
              }}
              diagnostics={diagnostics}
            />
            <button
              disabled={busy || readOnly}
              onClick={() =>
                void run(async () =>
                  setPrepared(await prepareInstantiation(selected, values, crypto.randomUUID())),
                )
              }
            >
              Formから準備
            </button>
          </section>
          <section>
            <h2>Deterministic agent client</h2>
            <p>構造化した入力だけを渡します。説明文やsampleを命令として実行しません。</p>
            <label>
              Agent inputs
              <textarea
                aria-label="Agent inputs"
                value={agentJson}
                onChange={(e) => {
                  setAgentJson(e.target.value);
                  setPrepared(undefined);
                }}
                rows={16}
              />
            </label>
            <button
              disabled={busy || readOnly}
              onClick={() =>
                void run(async () =>
                  setPrepared(
                    await prepareAgentTemplate(catalog, {
                      templateId: selected.templateId,
                      templateVersion: selected.templateVersion,
                      inputs: JSON.parse(agentJson),
                      requestId: crypto.randomUUID(),
                    }),
                  ),
                )
              }
            >
              Agent APIから準備
            </button>
          </section>
        </div>
      )}
      {prepared && (
        <section aria-label="Host prepared preview">
          <h2>適用前プレビュー</h2>
          <TemplatePreview
            domain={prepared.artifact.kind as TemplateDefinition['domain']}
            content={prepared.artifact.draft.content}
          />
          <button disabled={busy || readOnly} onClick={() => void run(() => create(prepared))}>
            Hostに作成
          </button>
        </section>
      )}
      {artifact && (
        <section aria-label="Host result">
          <h2>{artifact.name}</h2>
          <p role="status">Created {artifact.kind}</p>
          <button onClick={download}>Export template result</button>
          <TemplatePreview
            domain={artifact.kind as TemplateDefinition['domain']}
            content={artifact.draft.content}
          />
        </section>
      )}
      {gallery && (
        <TemplateGallery
          catalog={catalog}
          local={personal}
          kind="whole"
          readOnly={readOnly}
          onClose={() => {
            setGallery(false);
            void run(refreshCatalog);
          }}
          onCreate={async (prepared) => {
            await create(prepared);
            await refreshCatalog();
          }}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
