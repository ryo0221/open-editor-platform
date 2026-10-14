import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TemplateInputForm } from '@editor-platform/template-ui';
import {
  expandTemplate,
  inputDefaults,
  TemplateError,
  type TemplateDefinition,
  type Diagnostic,
} from '@editor-platform/templates';
import { DesignSurface, type DesignContent } from '@editor-platform/design';
import { textDiagnosticTemplate } from './content';
import '@editor-platform/editor-ui/styles.css';

function Host({ definition }: { definition: TemplateDefinition }) {
  const [values, setValues] = useState(() => inputDefaults(definition.inputs));
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [content, setContent] = useState(
    () => expandTemplate(definition, definition.sample).content as DesignContent,
  );
  return (
    <>
      <style>{`.review-inputs .tp-input-form{display:grid;gap:12px}.review-inputs label{display:grid;gap:4px}.review-inputs textarea{width:100%;box-sizing:border-box;font:inherit}.review-inputs small{color:#667085}.review-inputs [aria-invalid="true"]{border:2px solid #b42318}`}</style>
      <div
        className="review-inputs"
        style={{ margin: 16, maxWidth: 600, fontFamily: 'Noto Sans CJK JP, sans-serif' }}
      >
        <TemplateInputForm
          fields={definition.inputs}
          values={values}
          onChange={setValues}
          diagnostics={diagnostics}
        />
        <button
          onClick={() => {
            try {
              const next = expandTemplate(definition, values).content as DesignContent;
              setContent(next);
              setDiagnostics([]);
            } catch (error) {
              if (!(error instanceof TemplateError)) throw error;
              setDiagnostics(error.diagnostics);
            }
          }}
        >
          Host validate input
        </button>
      </div>
      <div style={{ height: 400 }}>
        <DesignSurface content={content} execute={() => false} select={() => {}} readOnly />
      </div>
      <pre data-testid="diagnostic-native" style={{ display: 'none' }}>
        {JSON.stringify(content)}
      </pre>
      <pre data-testid="input-diagnostics" style={{ display: 'none' }}>
        {JSON.stringify(diagnostics)}
      </pre>
    </>
  );
}
void textDiagnosticTemplate().then((definition) =>
  createRoot(document.getElementById('root')!).render(<Host definition={definition} />),
);
