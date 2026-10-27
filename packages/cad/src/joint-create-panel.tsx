/**
 * R2b-2c Surface entry (docs/cad/r2b-assembly.md, Surface・jointの作成): the parent's connector,
 * the child's, the type, and the preview of the joint before it is applied as one edit.
 * Clicks in the viewport pick the connectors (AssemblyLayer turns the viewport's tool on).
 */
import { useState } from 'react';
import { cadJointTypes, type CadDocument, type CadJointType } from '@editor-platform/cad-core';
import type { CadAssembly, CadJointCreation } from './assembly';
import type { CadConnectorChoice } from './joint-authoring';

export const jointTypeLabel: Record<CadJointType, string> = {
  fastened: 'Fastened',
  revolute: 'Revolute',
  slider: 'Slider',
  cylindrical: 'Cylindrical',
  planar: 'Planar',
};
const statusText: Record<CadJointCreation['status'], string> = {
  idle: '',
  preparing: 'previewを計算しています…',
  ready: 'previewを表示しています。Applyで1つの編集として追加します（Undoで戻せます）。',
  broken: 'このjointは解けません。',
  refused: 'このjointは作れません。',
};

function Side({
  title,
  choice,
  onAgain,
}: {
  title: string;
  choice: CadConnectorChoice | undefined;
  onAgain: () => void;
}) {
  if (!choice) return null;
  return (
    <p className="cad-joint-side">
      <span className="cad-muted">{title}</span> {choice.label}{' '}
      <button type="button" onClick={onAgain}>
        Pick again
      </button>
    </p>
  );
}

/** Origins to choose instead of a picked element: a part's, or for the parent this document's. */
function Origins({
  assembly,
  doc,
  step,
  exclude,
}: {
  assembly: CadAssembly;
  doc: CadDocument;
  step: 'parent' | 'child';
  exclude: string | undefined;
}) {
  const options = doc.components.filter((c) => c.id !== exclude);
  const [chosen, setChosen] = useState(step === 'parent' ? '' : (options[0]?.id ?? ''));
  return (
    <div className="cad-row" role="group" aria-label="Origin">
      <select
        aria-label={step === 'parent' ? 'Parent origin' : 'Child origin'}
        value={chosen}
        onChange={(e) => setChosen(e.target.value)}
      >
        {step === 'parent' && <option value="">This document</option>}
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={step === 'child' && !chosen}
        onClick={() => void assembly.useOrigin(chosen || undefined)}
      >
        Use origin
      </button>
    </div>
  );
}

export function JointCreator({
  assembly,
  creating,
  doc,
  busy,
}: {
  assembly: CadAssembly;
  creating: CadJointCreation;
  doc: CadDocument;
  busy: boolean;
}) {
  const { step, parent, child, status, message } = creating;
  return (
    <div className="cad-component cad-joint-create" data-testid="cad-joint-create">
      <p>
        <strong>New joint</strong>
      </p>
      <Side title="Parent" choice={parent} onAgain={() => assembly.pickAgain('parent')} />
      <Side title="Child" choice={child} onAgain={() => assembly.pickAgain('child')} />
      {step !== 'type' && (
        <>
          <p role="status">
            {step === 'parent'
              ? '親の接続点：viewportで面・辺・頂点をクリックするか、原点を選びます。'
              : '子の接続点：動かす部品の面・辺・頂点をクリックするか、その部品の原点を選びます。'}
          </p>
          <Origins
            key={step}
            assembly={assembly}
            doc={doc}
            step={step}
            exclude={step === 'child' ? parent?.connector.componentPath[0] : undefined}
          />
        </>
      )}
      <label>
        <span>Type</span>
        <select
          aria-label="Joint type"
          value={creating.type}
          onChange={(e) => assembly.setJointType(e.target.value as CadJointType)}
        >
          {cadJointTypes.map((t) => (
            <option key={t} value={t}>
              {jointTypeLabel[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="cad-check">
        <input
          type="checkbox"
          checked={creating.flip}
          onChange={(e) => assembly.setJointFlip(e.target.checked)}
        />
        <span>Flip child (face to face)</span>
      </label>
      {statusText[status] && (
        <p
          role={status === 'broken' || status === 'refused' ? 'alert' : 'status'}
          className={status === 'broken' || status === 'refused' ? 'cad-diagnostic' : undefined}
          data-testid="cad-joint-preview"
          data-status={status}
        >
          {statusText[status]}
          {message ? ` ${message}` : ''}
        </p>
      )}
      <div className="cad-row">
        <button
          type="button"
          disabled={status !== 'ready' || busy}
          onClick={() => void assembly.applyJoint()}
        >
          Apply joint
        </button>
        <button type="button" onClick={() => assembly.cancelJoint()}>
          Cancel
        </button>
      </div>
    </div>
  );
}
