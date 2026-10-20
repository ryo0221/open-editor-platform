import { useRef, useState } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import type { EditorInputs } from '@editor-platform/editor-core';
import type { SourceRef } from '@editor-platform/animation-core';
import type { AnimationContent2, AnimationCommand2 } from '@editor-platform/animation-core/v2';
import type { DesignContent } from '@editor-platform/design/model';
import { AnimationReactPlayer2 } from '@editor-platform/animation/player-v2';
import {
  captureDesignAnimation,
  adoptDesignAnimation,
  type AnimationConversionPlan,
} from './index';
export interface DesignAnimationSource {
  source: SourceRef;
  content: DesignContent;
  label: string;
}
export function AnimationDesignImportPanel(props: {
  sources: readonly DesignAnimationSource[];
  inputs: EditorInputs;
  readOnly: boolean;
  read(): AnimationContent2;
  execute(command: AnimationCommand2): boolean | void;
}) {
  const latest = useRef(props);
  latest.current = props;
  const [selected, setSelected] = useState(''),
    [fontId, setFontId] = useState(''),
    [plan, setPlan] = useState<AnimationConversionPlan>(),
    [error, setError] = useState('');
  const source = props.sources.find((source) => canonicalJson(source.source) === selected),
    fonts = props.read().assets.filter((asset) => asset.mediaType.startsWith('font/'));
  return (
    <details>
      <summary>Convert saved Design</summary>
      <p>
        Choose a saved frame. Review the captured appearance and reported losses before adding it as
        a composition.
      </p>
      <fieldset disabled={props.readOnly}>
        <label>
          Saved Design frame
          <select
            aria-label="Saved Design frame"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setPlan(undefined);
            }}
          >
            <option value="">Choose frame</option>
            {props.sources.map((source) => (
              <option key={canonicalJson(source.source)} value={canonicalJson(source.source)}>
                {source.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Conversion font
          <select
            aria-label="Conversion font"
            value={fontId}
            onChange={(e) => {
              setFontId(e.target.value);
              setPlan(undefined);
            }}
          >
            <option value="">No text font</option>
            {fonts.map((font) => (
              <option key={font.id} value={font.id}>
                {font.attribution}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!source}
          onClick={() => {
            try {
              props.inputs.flush();
              const target = props.read();
              setPlan(
                captureDesignAnimation(
                  source!.source,
                  source!.content,
                  [source!.source.compositionId],
                  target.assets.find((asset) => asset.id === fontId) ?? null,
                ),
              );
              setError('');
            } catch (error) {
              setError(String(error));
            }
          }}
        >
          Preview Design conversion
        </button>
        {plan && (
          <section aria-label="Design conversion preview">
            <ul>
              {plan.diagnostics.map((d, i) => (
                <li key={i}>
                  {d.severity}: {d.sourceId}: {d.message}
                </li>
              ))}
            </ul>
            {plan.content && (
              <>
                <div style={{ height: 180 }}>
                  <AnimationReactPlayer2
                    content={plan.content}
                    label="Captured Design"
                    controls={false}
                  />
                </div>
                <button
                  onClick={() => {
                    try {
                      props.inputs.flush();
                      const command = adoptDesignAnimation(plan, props.read(), plan.planHash, {
                        canEdit: () => !latest.current.readOnly,
                      });
                      if (props.execute(command) === false) throw Error('Design import refused');
                      setPlan(undefined);
                      setError('');
                    } catch (error) {
                      setError(String(error));
                    }
                  }}
                >
                  Accept static conversion
                </button>
              </>
            )}
            <button onClick={() => setPlan(undefined)}>Cancel conversion</button>
          </section>
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
