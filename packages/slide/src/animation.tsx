import type { SourceRef } from '@editor-platform/animation-core';
import { useState } from 'react';
import {
  createPlayableAnimationEmbed,
  adoptPlayableAnimationEmbed,
  inspectPlayableAnimationEmbed,
  animationCompositionInputs2,
  animationSystemFontText2,
  type PlayableAnimationEmbed,
} from '@editor-platform/animation-core/v2';
import { AnimationViewer } from '@editor-platform/animation/viewer';
import { slideAnimationPoster } from './animation-poster';
import { Dialog, CommitInput } from '@editor-platform/editor-ui';
import type { SlideAnimationSource, SlideObject } from './model';
export interface SlideAnimationProps {
  animationSources?: readonly SlideAnimationSource[];
  openAnimation?(source: SourceRef, objectId: string, pageId: string): void;
}
const systemFontNote =
  '端末のフォントで仮表示しています。見た目を固定するには、元の Animation で text にフォントを指定してください。';
const sourceChoiceKey = (source: SlideAnimationSource) =>
  JSON.stringify([
    source.source.artifactId,
    source.source.versionId,
    source.source.contentHash,
    source.source.compositionId,
  ]);
/** The embed the dialog would place or adopt for the selected saved version. */
function animationCandidate(
  sources: readonly SlideAnimationSource[],
  selected: string,
  current: PlayableAnimationEmbed | undefined,
): { candidate?: PlayableAnimationEmbed; candidateError: string } {
  try {
    const source = sources.find((source) => sourceChoiceKey(source) === selected);
    if (!source) return { candidateError: '' };
    const created = createPlayableAnimationEmbed(
      source.source,
      source.content,
      current?.label ?? source.label,
    );
    return {
      candidate: current
        ? adoptPlayableAnimationEmbed(current, source.source, source.content)
        : created,
      candidateError: '',
    };
  } catch (error) {
    return { candidateError: String(error) };
  }
}
export function AnimationChoiceDialog({
  sources,
  current,
  apply,
  close,
}: {
  sources: readonly SlideAnimationSource[];
  current?: PlayableAnimationEmbed;
  apply(value: PlayableAnimationEmbed): boolean;
  close(): void;
}) {
  const [selected, setSelected] = useState(() => (sources[0] ? sourceChoiceKey(sources[0]) : '')),
    [error, setError] = useState('');
  const { candidate, candidateError } = animationCandidate(sources, selected, current);
  const preview = candidate && inspectPlayableAnimationEmbed(candidate);
  return (
    <Dialog title={current ? 'Animation の版を選ぶ' : 'Animation を配置'} onClose={close}>
      {!sources.length && <p>Animation を作成し、版を保存するとここから配置できます。</p>}
      <label>
        保存した Animation
        <select
          aria-label="保存した Animation"
          value={sources.some((source) => sourceChoiceKey(source) === selected) ? selected : ''}
          disabled={!sources.length}
          onChange={(e) => {
            setSelected(e.target.value);
            setError('');
          }}
        >
          <option value="" disabled>
            保存した版を選択
          </option>
          {sources.map((source) => (
            <option key={sourceChoiceKey(source)} value={sourceChoiceKey(source)}>
              {source.label} / {source.versionLabel} / {source.source.compositionId}
            </option>
          ))}
        </select>
      </label>
      {!!sources.length && !candidate && (
        <p role="alert">
          {candidateError || '選択した保存版が利用できません。選び直してください。'}
        </p>
      )}
      {preview && (
        <AnimationChoicePreview
          embed={preview.embed}
          current={current}
          adopt={() => {
            try {
              if (apply(preview.embed)) close();
            } catch (error) {
              setError(String(error));
            }
          }}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
function AnimationChoicePreview({
  embed,
  current,
  adopt,
}: {
  embed: PlayableAnimationEmbed;
  current: PlayableAnimationEmbed | undefined;
  adopt(): void;
}) {
  const poster = slideAnimationPoster(embed);
  if (!poster) return null;
  return (
    <>
      <p>選択した保存版を固定して保持します。元の下書きの変更は自動反映されません。</p>
      {current && current.posterTick !== embed.posterTick && (
        <p>
          ポスター時刻を新しい長さに合わせます: {current.posterTick} → {embed.posterTick}
        </p>
      )}
      <img
        alt="選択した Animation のプレビュー"
        style={{ width: '100%', maxHeight: 260, objectFit: 'contain' }}
        src={poster.src}
      />
      {poster.status === 'unavailable' && <p role="alert">{poster.message}</p>}
      <button disabled={poster.status !== 'ready'} onClick={adopt}>
        この版を{current ? '採用' : '配置'}
      </button>
    </>
  );
}
export function AnimationObjectInspector({
  object,
  pageId,
  readOnly,
  patch,
  choose,
  preview,
  openSource,
}: {
  object: SlideObject;
  pageId: string;
  readOnly: boolean;
  patch(embed: PlayableAnimationEmbed): boolean;
  choose?(): void;
  preview(): void;
  openSource?: SlideAnimationProps['openAnimation'];
}) {
  const [error, setError] = useState('');
  if (!object.animation) return null;
  const a = object.animation,
    duration = a.snapshot.compositions.find((c) => c.id === a.source.compositionId)!.duration,
    publicInputs =
      a.format === 'animation-embed-2'
        ? animationCompositionInputs2(a.snapshot, a.source.compositionId)
        : [];
  return (
    <section aria-label="Animation settings">
      <h3>Animation</h3>
      <p>保存した版を固定して再生します。</p>
      <button onClick={preview}>Animation をプレビュー</button>
      {openSource && (
        <button
          onClick={() => {
            try {
              openSource(a.source, object.id, pageId);
              setError('');
            } catch (error) {
              setError(String(error));
            }
          }}
        >
          元の Animation を開く
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {a.format === 'animation-embed-2' && animationSystemFontText2(a.snapshot, a.inputs) && (
        <p role="note">{systemFontNote}</p>
      )}
      <p>PPTXへのアニメーション出力は未対応です。</p>
      <fieldset disabled={readOnly}>
        {choose && <button onClick={choose}>保存した別の版を選ぶ</button>}
        {a.format === 'animation-embed-2' &&
          publicInputs.map((input) => (
            <CommitInput
              key={input.id}
              label={`Animation input: ${input.name}`}
              type={input.kind === 'number' ? 'number' : 'text'}
              value={a.inputs.find((value) => value.inputId === input.id)?.value ?? input.default}
              onCommit={(value) =>
                patch({
                  ...a,
                  inputs: [
                    ...a.inputs.filter(
                      (v) =>
                        v.inputId !== input.id &&
                        publicInputs.some((input) => input.id === v.inputId),
                    ),
                    {
                      inputId: input.id,
                      value: input.kind === 'number' ? Number(value) : String(value),
                    },
                  ],
                })
              }
            />
          ))}
        <CommitInput
          label="Animation label"
          value={a.label}
          onCommit={(label) => patch({ ...a, label })}
        />
        <CommitInput
          label="Animation poster tick"
          type="number"
          min={0}
          max={duration}
          value={a.posterTick}
          onCommit={(tick) => patch({ ...a, posterTick: Number(tick) })}
        />
        <label>
          再生開始
          <select
            aria-label="Animation playback trigger"
            value={a.trigger}
            onChange={(e) =>
              patch({ ...a, trigger: e.target.value as PlayableAnimationEmbed['trigger'] })
            }
          >
            <option value="on-enter">スライド表示時</option>
            <option value="manual">手動</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            aria-label="Loop animation"
            checked={a.loop}
            onChange={(e) => patch({ ...a, loop: e.target.checked })}
          />
          繰り返す
        </label>
      </fieldset>
    </section>
  );
}
export function AnimationPresentationObject({ object }: { object: SlideObject }) {
  if (!object.animation || object.hidden) return null;
  const { x, y, width, height } = object.bounds;
  return (
    <g
      opacity={object.opacity ?? 1}
      transform={`translate(${x + width / 2} ${y + height / 2}) rotate(${object.rotation ?? 0}) scale(${object.flipX ? -1 : 1} ${object.flipY ? -1 : 1}) translate(${-width / 2} ${-height / 2})`}
    >
      <foreignObject width={width} height={height}>
        <div style={{ width: '100%', height: '100%' }}>
          <AnimationViewer
            animation={object.animation}
            autoPlay={object.animation.trigger === 'on-enter'}
          />
        </div>
      </foreignObject>
    </g>
  );
}
export function AnimationPreviewDialog({
  animation,
  close,
}: {
  animation: PlayableAnimationEmbed;
  close(): void;
}) {
  return (
    <Dialog title="Animation プレビュー" onClose={close}>
      <div style={{ width: '100%', height: 340 }}>
        <AnimationViewer animation={animation} />
      </div>
    </Dialog>
  );
}
