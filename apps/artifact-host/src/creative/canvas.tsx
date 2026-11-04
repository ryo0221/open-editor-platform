import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { clone } from '@editor-platform/artifact-core';
import type { LocalDraftRevision, Region } from '@editor-platform/editor-core';
import { CommitInput, Section } from '@editor-platform/editor-ui';
import { readImage } from '@editor-platform/canvas-ui';
import { DesignSurface } from '@editor-platform/design';
import {
  appearance,
  applyDesignOverride,
  exportDesignSvg,
  type DesignContent,
  type DesignElement,
} from '@editor-platform/design/model';
import {
  creativeDesignAddressKey,
  creativeDesignEditCommand,
  designCreativeProposalDiff,
  parseCreativeDesignAddress,
  type CreativeDesignAddress,
} from '@editor-platform/design/creative-proposal-diff';
import {
  candidateFrames,
  candidateInstance,
  type CreativeEdit,
  type CreativeProject,
} from './project';
import type { CreativeSourceCard } from './types';
import './creative-canvas.css';
import { CreativeGenerationPanel } from './generation-panel';
import { isCreativeWorldLayerProposal, type CreativeLayerConnection } from './generation';

interface CanvasProps<T> {
  worldContext?: ReactNode;
  generation?: CreativeLayerConnection;
  project: CreativeProject<T>;
  card: CreativeSourceCard;
  changed(): void;
  onError(error: unknown): void;
}
const svgSource = (content: DesignContent, frameId: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(exportDesignSvg(content, [frameId], { padding: 2 }))}`;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const diffValue = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === 'string' && item.startsWith('data:image/')
      ? `画像データ (${item.length}文字)`
      : item,
  ) ?? '未設定';

function currentPart(content: DesignContent, address: CreativeDesignAddress): DesignElement {
  const native = address.componentId
    ? content.components
        .find((component) => component.id === address.componentId)
        ?.elements?.find((element) => element.id === address.elementId)
    : content.elements.find((element) => element.id === address.elementId);
  if (!native) throw Error('編集中の部位が見つかりません。');
  if (!address.instanceId) return appearance(content, native);
  const owner = content.elements.find(
    (element) => element.id === address.instanceId && element.componentId === address.componentId,
  );
  if (!owner) throw Error('編集中の候補と共有部品の対応が変わりました。');
  return applyDesignOverride(appearance(content, native), owner.overrides?.[address.elementId]);
}

function proposalFrames(content: DesignContent, keys: string[]): DesignElement[] {
  const affected = new Set<string>();
  const byId = new Map(content.elements.map((element) => [element.id, element]));
  const includeOwner = (id: string) => {
    const seen = new Set<string>();
    for (
      let element = byId.get(id);
      element && !seen.has(element.id);
      element = byId.get(element.parentId ?? '')
    ) {
      seen.add(element.id);
      if (element.type === 'frame' && !element.parentId) affected.add(element.id);
    }
  };
  for (const key of new Set(keys)) {
    const address = parseCreativeDesignAddress(key);
    if (address.componentId && !address.instanceId)
      content.elements
        .filter(
          (element) => element.type === 'instance' && element.componentId === address.componentId,
        )
        .forEach((element) => includeOwner(element.id));
    else includeOwner(address.instanceId ?? address.elementId);
  }
  return candidateFrames(content).filter((frame) => affected.has(frame.id));
}

/** External tool output is data; UI selection supplies the allowed part scope. */
function externalChanges(text: string): { base: LocalDraftRevision; edits: CreativeEdit[] } {
  const value: unknown = JSON.parse(text);
  if (
    !record(value) ||
    Object.keys(value).some((key) => !['baseLocalRevision', 'changes'].includes(key))
  )
    throw Error('baseLocalRevision と changes を含むJSONを入力してください。');
  const base = value.baseLocalRevision;
  if (
    !record(base) ||
    base.kind !== 'local-draft' ||
    typeof base.sessionId !== 'string' ||
    !base.sessionId ||
    !Number.isSafeInteger(base.sequence) ||
    Number(base.sequence) < 0 ||
    !Array.isArray(value.changes) ||
    !value.changes.length ||
    value.changes.length > 32
  )
    throw Error('変更案のrevisionまたはchangesが不正です。');
  for (const edit of value.changes)
    if (
      !record(edit) ||
      Object.keys(edit).some((key) => !['address', 'patch'].includes(key)) ||
      !record(edit.address) ||
      !record(edit.patch)
    )
      throw Error('各changeにはaddressとpatchが必要です。');
  return { base: base as unknown as LocalDraftRevision, edits: value.changes as CreativeEdit[] };
}

export function CreativeCanvas<T>(props: CanvasProps<T>) {
  const editor = props.project.editor(props.card);
  return editor ? (
    <CanvasEditor key={editor.id} {...props} />
  ) : (
    <p>設定画を開くと、候補と部位を編集できます。</p>
  );
}

function CanvasEditor<T>({
  project,
  card,
  changed,
  onError,
  generation,
  worldContext,
}: CanvasProps<T>) {
  const editor = project.editor(card)!;
  const content = editor.content;
  const frames = candidateFrames(content);
  const chosen = project.binding(card)?.chosenFrameId;
  const [active, setActive] = useState(chosen);
  const [partId, setPartId] = useState(project.mode.groups[0]?.parts[0]?.id ?? '');
  const [shared, setShared] = useState(false);
  const [standard, setStandard] = useState(false);
  const [candidateName, setCandidateName] = useState('新しい候補');
  const frame = frames.find((item) => item.id === active) ?? frames[0];
  let owner: DesignElement | undefined;
  let targetProblem = '';
  try {
    if (frame) owner = candidateInstance(content, frame.id, project.mode.componentId);
  } catch (error) {
    targetProblem = error instanceof Error ? error.message : String(error);
  }
  const component = content.components.find((item) => item.id === project.mode.componentId);
  const nativePart = component?.elements?.find((item) => item.id === partId);
  const part =
    nativePart &&
    (shared || !owner
      ? appearance(content, nativePart)
      : applyDesignOverride(appearance(content, nativePart), owner.overrides?.[partId]));
  const address: CreativeDesignAddress = {
    componentId: project.mode.componentId,
    elementId: partId,
    ...(!shared && owner ? { instanceId: owner.id } : {}),
  };
  const focus = useMemo(() => (owner ? { id: owner.id } : undefined), [owner?.id]);
  const thumbnails = useMemo(
    () =>
      frames.map((candidate) => ({
        id: candidate.id,
        src: svgSource(content, candidate.id),
      })),
    [content],
  );
  // DesignSurface focus also observes this callback: retain it across view-only refreshes.
  const select = useCallback(
    (ids: string[], region?: Region) => {
      editor.select({
        addresses: ids.map((elementId) => ({ artifactId: editor.id, elementId, region })),
      });
      const latest = editor.content;
      const selected = latest.elements.find((element) => element.id === ids[0]);
      const selectedFrame = candidateFrames(latest).find(
        (candidate) => candidate.id === selected?.id || candidate.id === selected?.parentId,
      );
      if (selectedFrame) setActive(selectedFrame.id);
    },
    [editor],
  );
  const readOnly = editor.readOnly || project.saving;
  const run = (action: () => unknown): boolean => {
    try {
      action();
      changed();
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  };
  const selectFrame = (id: string) =>
    run(() => {
      editor.flushInputs();
      if (generation?.world?.pending)
        throw Error('利用記録を保存・再照合してから候補を切り替えてください。');
      setActive(id);
    });
  const left = (
    <div className="creative-parts">
      <label>
        変更の範囲
        <select
          aria-label="変更の範囲"
          value={shared ? 'shared' : 'instance'}
          onChange={(event) =>
            run(() => {
              editor.flushInputs();
              setShared(event.target.value === 'shared');
            })
          }
        >
          <option value="instance">表示中の候補だけ</option>
          <option value="shared">共有部品・全候補</option>
        </select>
      </label>
      <p>
        {shared ? '共有部品の変更は全候補へ反映されます。' : '選んだ候補の部位だけを変更します。'}
      </p>
      {project.mode.groups.map((group) => (
        <Section key={group.id} title={group.label}>
          {[{ id: group.id, label: `${group.label}全体` }, ...group.parts].map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={partId === item.id}
              onClick={() =>
                run(() => {
                  editor.flushInputs();
                  setPartId(item.id);
                })
              }
            >
              {item.label}
            </button>
          ))}
        </Section>
      ))}
    </div>
  );
  return (
    <div className="creative-canvas">
      <section className="creative-candidates" aria-label="設定画の候補">
        {frames.map((candidate) => (
          <article key={candidate.id}>
            <button
              type="button"
              className="creative-candidate-preview"
              aria-pressed={frame?.id === candidate.id}
              onClick={() => selectFrame(candidate.id)}
            >
              <img
                src={thumbnails.find((item) => item.id === candidate.id)!.src}
                alt={`${candidate.name}の比較画像`}
              />
              <span>{candidate.name}</span>
            </button>
            <button
              type="button"
              disabled={readOnly}
              aria-pressed={chosen === candidate.id}
              onClick={() =>
                run(() => {
                  editor.flushInputs();
                  project.choose(card, candidate.id);
                })
              }
            >
              {chosen === candidate.id ? '保存する候補・選択中' : 'この候補を選ぶ'}
            </button>
          </article>
        ))}
      </section>
      <div className="creative-canvas-tools">
        <span>表示中：{frame?.name ?? '候補なし'}</span>
        <label>
          候補名{' '}
          <input
            aria-label="追加する候補名"
            value={candidateName}
            disabled={readOnly}
            onChange={(event) => setCandidateName(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={readOnly || !frame}
          onClick={() =>
            run(() => {
              editor.flushInputs();
              setActive(project.addCandidate(card, frame!.id, candidateName));
            })
          }
        >
          候補を複製
        </button>
        <button
          type="button"
          aria-pressed={standard}
          onClick={() =>
            run(() => {
              editor.flushInputs();
              setStandard(!standard);
            })
          }
        >
          {standard ? '部位の編集に戻る' : '標準レイヤー・プロパティ'}
        </button>
      </div>
      {frame && (
        <CreativeGenerationPanel
          key={frame.id + ':' + (generation?.sceneId ?? '')}
          project={project}
          card={card}
          frame={frame}
          connection={generation}
          changed={changed}
          onError={onError}
          editRough={() => setStandard(true)}
        />
      )}
      {targetProblem && <p role="alert">{targetProblem}</p>}
      <div className="creative-design-surface">
        <DesignSurface
          extension={{ workspaceReferences: () => worldContext }}
          inkInput
          rasterInput={standard}
          workspace="design"
          onWorkspaceRequest={() => {}}
          content={content}
          readOnly={readOnly}
          execute={(command) => run(() => project.execute(card, command))}
          focusRequest={focus}
          select={select}
          layout={
            standard
              ? undefined
              : {
                  viewKey: `creative-${project.mode.id}-canvas`,
                  leftLabel: `${project.mode.itemLabel}の部位`,
                  inspectorLabel: '部位の編集',
                  left,
                  inspector: (
                    <>
                      {' '}
                      {worldContext}{' '}
                      {part && owner ? (
                        <PartInspector
                          key={creativeDesignAddressKey(address)}
                          {...{ project, card, changed, onError, part, address }}
                        />
                      ) : (
                        <p>部位を選んでください。{targetProblem}</p>
                      )}
                    </>
                  ),
                }
          }
        />
      </div>
      <p className="creative-canvas-note">
        表示候補の切替は一時表示です。「この候補を選ぶ」の結果は設定画と一緒に保存されます。
      </p>
    </div>
  );
}

function PartInspector<T>({
  project,
  card,
  part,
  address,
  changed,
  onError,
}: CanvasProps<T> & { part: DesignElement; address: CreativeDesignAddress }) {
  const editor = project.editor(card)!;
  const [route, setRoute] = useState('direct');
  const [draft, setDraft] = useState<{ patch: Partial<DesignElement>; base?: LocalDraftRevision }>({
    patch: {},
  });
  const draftRef = useRef(draft);
  const updateDraft = (next: typeof draft) => {
    draftRef.current = next;
    setDraft(next);
  };
  const [external, setExternal] = useState('');
  const [upload, setUpload] = useState<{ src: string; name: string }>();
  const [imageSource, setImageSource] = useState('');
  const [imageLicense, setImageLicense] = useState('');
  const effective = route === 'proposal' ? applyDesignOverride(part, draft.patch) : part;
  const readOnly = editor.readOnly || project.saving;
  const run = (action: () => unknown): boolean => {
    try {
      action();
      changed();
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  };
  const patch = (
    value: Partial<DesignElement> | ((current: DesignElement) => Partial<DesignElement>),
  ) =>
    run(() => {
      const staged = draftRef.current;
      const latest = currentPart(editor.content, address);
      const current = route === 'proposal' ? applyDesignOverride(latest, staged.patch) : latest;
      const next = typeof value === 'function' ? value(current) : value;
      if (route === 'direct') project.execute(card, creativeDesignEditCommand(address, next));
      else
        updateDraft({
          patch: { ...staged.patch, ...next },
          base: staged.base ?? clone(editor.revision),
        });
    });
  return (
    <div className="creative-part-inspector">
      <p>
        <strong>{part.name}</strong> ·{' '}
        {address.instanceId ? '表示中の候補だけ' : '共有部品・全候補'}
      </p>
      <fieldset disabled={readOnly}>
        <label>
          操作
          <select
            aria-label="部位の操作"
            value={route}
            onChange={(event) => {
              const next = event.target.value;
              run(() => {
                editor.flushInputs();
                setRoute(next);
                updateDraft({ patch: {} });
              });
            }}
          >
            <option value="direct">直接編集</option>
            <option value="proposal">変更案を準備</option>
          </select>
        </label>
        <Section title="位置と見た目">
          {part.type !== 'group' && (
            <>
              {(['x', 'y', 'width', 'height'] as const).map((key, index) => (
                <CommitInput
                  key={key}
                  label={['X', 'Y', '幅', '高さ'][index]}
                  type="number"
                  min={index > 1 ? 1 : undefined}
                  value={effective.bounds[key]}
                  onCommit={(value) =>
                    patch((current) => ({ bounds: { ...current.bounds, [key]: Number(value) } }))
                  }
                />
              ))}
              <CommitInput
                label="回転"
                type="number"
                value={effective.rotation ?? 0}
                onCommit={(value) => patch({ rotation: Number(value) })}
              />
              <CommitInput
                label="塗り"
                value={effective.fill}
                onCommit={(fill) => patch({ fill })}
              />
              <CommitInput
                label="不透明度"
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={effective.opacity ?? 1}
                onCommit={(value) => patch({ opacity: Number(value) })}
              />
            </>
          )}
          <label>
            <input
              type="checkbox"
              checked={effective.hidden ?? false}
              onChange={(event) => patch({ hidden: event.target.checked })}
            />
            非表示
          </label>
          <label>
            <input
              type="checkbox"
              checked={effective.locked ?? false}
              onChange={(event) => patch({ locked: event.target.checked })}
            />
            ロック
          </label>
        </Section>
        {part.type === 'image' && (
          <Section title="画像と出典">
            {effective.src && (
              <img
                className="creative-image-part"
                src={effective.src}
                alt={`${part.name}の現在の画像`}
              />
            )}
            <p>
              現在の出典：{effective.provenance?.source ?? '未記録'}
              <br />
              利用条件：{effective.provenance?.license ?? '未記録'}
            </p>
            <label>
              差替画像
              <input
                aria-label="差替画像"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file)
                    try {
                      const src = await readImage(file);
                      setUpload({ src, name: file.name });
                      setImageSource('');
                      setImageLicense('');
                    } catch (error) {
                      onError(error);
                    }
                }}
              />
            </label>
            {upload && (
              <img className="creative-image-part" src={upload.src} alt="差替画像の確認" />
            )}
            <label>
              新画像の出典
              <input
                aria-label="新画像の出典"
                value={imageSource}
                onChange={(event) => setImageSource(event.target.value)}
              />
            </label>
            <label>
              新画像の利用条件
              <input
                aria-label="新画像の利用条件"
                value={imageLicense}
                onChange={(event) => setImageLicense(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={!upload || !imageSource.trim() || !imageLicense.trim()}
              onClick={() => {
                if (
                  upload &&
                  patch({
                    src: upload.src,
                    provenance: {
                      src: upload.src,
                      source: imageSource.trim(),
                      license: imageLicense.trim(),
                      name: upload.name,
                    },
                  })
                )
                  setUpload(undefined);
              }}
            >
              画像と出典を差し替える
            </button>
          </Section>
        )}
        {route === 'proposal' && (
          <button
            type="button"
            disabled={!Object.keys(draft.patch).length}
            onClick={() =>
              run(() => {
                editor.flushInputs();
                const staged = draftRef.current;
                project.propose(card, [{ address, patch: staged.patch }], [address], staged.base);
                updateDraft({ patch: {} });
              })
            }
          >
            変更案をプレビュー
          </button>
        )}
      </fieldset>
      <Section title="AI・外部ツールの変更案" open={false}>
        <p>
          AI生成サービスは接続していません。同じ部位操作の変更案、または外部ツールのJSONを確認して適用できます。
        </p>
        <p>
          許可する範囲：{part.name} / {address.instanceId ? '表示中の候補だけ' : '共有部品・全候補'}
        </p>
        <button
          type="button"
          onClick={() =>
            setExternal(
              JSON.stringify(
                {
                  baseLocalRevision: editor.revision,
                  changes: [
                    {
                      address,
                      patch: part.type === 'group' ? { hidden: !part.hidden } : { opacity: 0.8 },
                    },
                  ],
                },
                null,
                2,
              ),
            )
          }
        >
          JSON入力例を入れる
        </button>
        <textarea
          aria-label="外部変更案JSON"
          value={external}
          onChange={(event) => setExternal(event.target.value)}
        />
        <button
          type="button"
          disabled={readOnly || !external.trim()}
          onClick={() =>
            run(() => {
              const incoming = externalChanges(external);
              project.propose(card, incoming.edits, [address], incoming.base);
            })
          }
        >
          外部変更案をプレビュー
        </button>
      </Section>
      {editor.proposals
        .filter((p) => !isCreativeWorldLayerProposal(p, editor))
        .map((proposal) => {
          const diff = designCreativeProposalDiff.diff(
            proposal.preview.baseContent,
            proposal.preview.content,
          );
          const affected = proposalFrames(
            proposal.preview.baseContent,
            diff.changes.map((change) => change.elementId),
          );
          return (
            <Section key={proposal.id} title="変更案の確認">
              <p role="status">
                {proposal.stale
                  ? '編集後のため古い変更案です。作り直してください。'
                  : '未適用の変更案'}
              </p>
              <p>
                対象候補：
                {affected.map((candidate) => candidate.name).join('、') || '特定できません'}
              </p>
              {affected.map((candidate) => (
                <div className="creative-proposal-images" key={candidate.id}>
                  <figure>
                    <figcaption>{candidate.name} / 変更前</figcaption>
                    <img
                      src={svgSource(proposal.preview.baseContent, candidate.id)}
                      alt={`変更前の候補：${candidate.name}`}
                    />
                  </figure>
                  <figure>
                    <figcaption>{candidate.name} / 変更後</figcaption>
                    <img
                      src={svgSource(proposal.preview.content, candidate.id)}
                      alt={`変更後の候補：${candidate.name}`}
                    />
                  </figure>
                </div>
              ))}
              <dl>
                {diff.changes.map((change, index) => (
                  <div key={index}>
                    <dt>
                      {change.elementLabel ?? change.elementId} / {change.property}
                      <br />
                      <code>{change.elementId}</code>
                    </dt>
                    <dd>
                      <del>{diffValue(change.before)}</del> → <ins>{diffValue(change.after)}</ins>
                    </dd>
                  </div>
                ))}
              </dl>
              {!!diff.fallback.length && (
                <p role="alert">表示できない差分があるため適用できません。</p>
              )}
              <button
                type="button"
                disabled={readOnly || proposal.stale || !!diff.fallback.length || !affected.length}
                onClick={() => run(() => editor.acceptProposal(proposal.id))}
              >
                変更案を適用
              </button>
              <button type="button" onClick={() => run(() => editor.rejectProposal(proposal.id))}>
                変更案を却下
              </button>
            </Section>
          );
        })}
    </div>
  );
}
