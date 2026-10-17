import { createVisualTimeline } from './visual-timeline';
import { assertVideoDemoContent, prepareVideoDemoOrder } from './demo';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  add,
  subtract,
  compare,
  frameTime,
  time,
  validateVideoContent,
  videoCommand,
  type Time,
  type VideoContent,
  type VideoEdit,
} from '@editor-platform/video-core';
import {
  SCHEMA_EDIT_EXPERIMENT_VERSION,
  type SchemaEditControllerFactory,
  type SchemaEditDefinition,
} from '@editor-platform/extension-contract/schema-edit-experiment';
import type {
  ControlledSurfaceController,
  PreparedSurfaceCommand,
  SurfaceOperation,
} from '@editor-platform/extension-contract/controlled-surface';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
export { videoTimelineFixture } from './edit-fixture';

const schema = 'video-core-prototype-v0' as const;
const format = (value: Time) => `${value.value}/${value.timescale}`;
function parseTime(value: string): Time {
  const match = /^(-?\d+)(?:\/(\d+))?$/.exec(value.trim());
  if (!match) throw Error('Use integer seconds or numerator/denominator seconds');
  return time(Number(match[1]), Number(match[2] ?? 1));
}
const sameRevision = (
  a: LocalReadSnapshot<VideoContent>['revision'],
  b: LocalReadSnapshot<VideoContent>['revision'],
) => a.kind === b.kind && a.sessionId === b.sessionId && a.sequence === b.sequence;
/** Pure preparation shared by UI/non-UI. Trusted submission still belongs to the controller. */
export function prepareVideoTimelineEdit(
  snapshot: LocalReadSnapshot<VideoContent>,
  edit: VideoEdit,
): PreparedSurfaceCommand<VideoContent> {
  const command = videoCommand(edit);
  const next = command.apply(snapshot.content);
  return {
    baseRevision: snapshot.revision,
    command: canonicalJson(next) === canonicalJson(snapshot.content) ? null : command,
  };
}
export function submitVideoTimelineEdit(
  editor: ControlledSurfaceController<VideoContent>,
  snapshot: LocalReadSnapshot<VideoContent>,
  edit: VideoEdit,
): SurfaceOperation {
  try {
    return editor.execute(prepareVideoTimelineEdit(snapshot, edit));
  } catch (error) {
    return { state: 'refused', code: 'VideoInput', message: String(error) };
  }
}
export function videoTimelineExtension(
  packageHash: string,
  options: {
    createController: SchemaEditControllerFactory;
    onError(error: unknown): void;
    onTimelineIntent?(): void;
    onPlayhead?(at: Time): void;
    mounted?(editor: ControlledSurfaceController<VideoContent>): void;
  },
): SchemaEditDefinition<VideoContent> {
  if (!/^[a-f0-9]{64}$/.test(packageHash)) throw Error('Invalid package hash');
  return {
    manifest: {
      id: 'video-metadata-timeline',
      version: '0.0.0-experiment.1',
      packageHash,
      contractVersion: SCHEMA_EDIT_EXPERIMENT_VERSION,
      artifactKind: 'video',
      schemaIdentity: { kind: 'literal', value: schema },
      surface: true,
      permissions: ['artifact:read', 'artifact:edit', 'artifact:save'],
      addons: {
        lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
        edit: { version: 'local-edit@0-draft', requirement: 'optional' },
        inputs: { version: 'inputs@0-draft', requirement: 'optional' },
        save: { version: 'local-persistence@0-draft', requirement: 'optional' },
      },
      licenseNotices: ['Repository license applies; no additional license grant.'],
    },
    validate(value): value is VideoContent {
      return validateVideoContent(value).valid;
    },
    schemaOf(content) {
      if (content.schema !== schema) throw Error('Unsupported video schema');
      return { kind: 'literal', value: content.schema };
    },
    mount(container, context) {
      const lifecycle = context.addons.lifecycle.api;
      let disposed = false,
        stop = () => {},
        unregister = () => {};
      let visual: ReturnType<typeof createVisualTimeline> | undefined;
      const root = container.ownerDocument.createElement('section');
      root.setAttribute('aria-label', 'Video metadata timeline');
      root.style.cssText =
        'font:14px/1.5 system-ui;max-width:100%;overflow-wrap:anywhere;padding:12px;box-sizing:border-box';
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        visual?.dispose();
        lifecycle.signal.removeEventListener('abort', dispose);
        try {
          stop();
        } finally {
          try {
            unregister();
          } finally {
            root.remove();
          }
        }
      };
      const current = () => {
        lifecycle.assertCurrent();
        if (disposed || lifecycle.signal.aborted) throw Error('ScopeRevoked');
      };
      const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
        const node = container.ownerDocument.createElement(tag);
        node.textContent = text;
        return node;
      };
      try {
        current();
        if (context.contractVersion !== SCHEMA_EDIT_EXPERIMENT_VERSION)
          throw Error('VideoContract');
        lifecycle.signal.addEventListener('abort', dispose, { once: true });
        lifecycle.registerDisposable('video-timeline-surface', dispose);
        current();
        const editor = options.createController(context, { onError: options.onError });
        current();
        let selected = '',
          dirty = false,
          gesturing = false;
        let inputKind: 'trim' | 'duration' | undefined;
        const composing = new Set<HTMLInputElement>();
        let base: LocalReadSnapshot<VideoContent> | undefined;
        let binding: ReturnType<typeof editor.bindInputs> | undefined;
        const status = element('p');
        status.setAttribute('role', 'status');
        let statusVersion = 0;
        const setStatus = (message: string) => {
          if (disposed) return;
          statusVersion++;
          status.textContent = message;
        };
        const sourceInfo = element('p'),
          timeline = element('div');
        const detail = element('details');
        detail.append(element('summary', 'Clip and source details'), timeline);
        const selection = element('select');
        selection.setAttribute('aria-label', 'Selected clip');
        const start = element('input'),
          end = element('input'),
          duration = element('input'),
          playhead = element('input'),
          moveTarget = element('input');
        moveTarget.value = '0';
        playhead.value = '50';
        playhead.setAttribute(
          'aria-description',
          'Split target in sequence frames. This target does not follow Player playback or Player seeking.',
        );
        const fields = element('div');
        fields.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;margin:12px 0';
        for (const [input, label] of [
          [start, 'Trim start (rational seconds)'],
          [end, 'Trim end (rational seconds)'],
          [playhead, 'Split at sequence frame'],
          [moveTarget, 'Move linked clips to frame'],
          [duration, 'Sequence duration (rational seconds)'],
        ] as const) {
          const wrapper = element('label', label + ' ');
          input.type = 'text';
          input.style.cssText = 'max-width:100%;box-sizing:border-box';
          wrapper.append(input);
          wrapper.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:13px';
          input.style.cssText =
            'width:180px;max-width:100%;box-sizing:border-box;padding:6px;border:1px solid #a8b7c8;border-radius:4px';
          fields.append(wrapper);
        }
        const toolbar = element('div');
        toolbar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:12px 0';
        const buttons = new Map<string, HTMLButtonElement>();
        const report = (result: SurfaceOperation) => {
          setStatus(
            result.state === 'refused' ? `${result.code}: ${result.message}` : result.state,
          );
        };
        const snapshot = () => {
          current();
          const view = editor.getSnapshot();
          if (view.state !== 'open') throw Error('ScopeRevoked');
          return view.snapshot;
        };
        const resetFields = () => {
          const snap = snapshot(),
            clip = snap.content.sequence.clips.find((c) => c.id === selected);
          duration.value = format(snap.content.sequence.duration);
          if (clip) {
            start.value = format(clip.start);
            end.value = format(add(clip.start, clip.duration));
          } else {
            start.value = '';
            end.value = '';
          }
        };
        const render = () => {
          if (disposed || lifecycle.signal.aborted) return;
          const view = editor.getSnapshot();
          if (view.state !== 'open') {
            dispose();
            return;
          }
          const content = view.snapshot.content;
          const validation = validateVideoContent(content);
          if (!validation.valid) {
            setStatus(`First validation failure: ${validation.reason}`);
            for (const button of buttons.values()) button.disabled = true;
            return;
          }
          if (!dirty && !content.sequence.clips.some((c) => c.id === selected))
            selected = content.sequence.clips[0]?.id ?? '';
          selection.replaceChildren();
          for (const clip of content.sequence.clips) {
            const option = element('option', `${clip.id} (${clip.kind})`);
            option.value = clip.id;
            selection.append(option);
          }
          selection.value = selected;
          selection.disabled = dirty || composing.size > 0 || gesturing;
          if (!dirty && composing.size === 0) resetFields();
          start.disabled = end.disabled = !view.canEdit || !selected || inputKind === 'duration';
          duration.disabled = !view.canEdit || inputKind === 'trim';
          timeline.replaceChildren();
          for (const track of content.sequence.tracks) {
            timeline.append(
              element(
                'h3',
                `${track.id} · ${track.kind} · ${track.locked ? 'locked' : 'unlocked'}`,
              ),
            );
            for (const clip of content.sequence.clips.filter((c) => c.trackId === track.id))
              timeline.append(
                element(
                  'p',
                  `${clip.id} [${format(clip.start)}, ${format(add(clip.start, clip.duration))}) s · source ${clip.sourceId}/${clip.streamId} · ${clip.kind === 'video' ? `[${format(clip.sourceIn)}, ${format(clip.sourceOut)}) rate ${format(clip.rate)}` : `samples [${clip.sampleIn}, ${clip.sampleOut})`} · link ${clip.linkGroupId ?? 'none'}`,
                ),
              );
          }
          visual?.render();
          let canOrder = true;
          try {
            assertVideoDemoContent(content);
          } catch {
            canOrder = false;
          }
          sourceInfo.textContent = `${content.sequence.clips.length} clips · ${content.sequence.tracks.length} tracks · ${content.sequence.frameRate.value}/${content.sequence.frameRate.timescale} fps · duration ${format(content.sequence.duration)} s · decoding and media bytes are Host-owned.`;
          for (const [name, button] of buttons)
            button.disabled =
              (name === 'Move earlier' || name === 'Move later') && !canOrder
                ? true
                : (name === 'Apply sequence duration' && inputKind === 'trim') ||
                    (name === 'Apply independent trim' && inputKind === 'duration')
                  ? true
                  : name === 'Save native JSON'
                    ? !view.canSave || view.saving
                    : name === 'Cancel inputs'
                      ? !dirty && composing.size === 0 && !gesturing
                      : !view.canEdit ||
                        (!selected && !['Undo', 'Redo', 'Apply sequence duration'].includes(name));
        };
        const act = (work: () => void) => {
          try {
            current();
            work();
          } catch (error) {
            setStatus(String(error));
          }
        };
        const button = (name: string, work: () => void) => {
          const b = element('button', name);
          b.type = 'button';
          if (name === 'Split linked clips')
            b.title =
              'Split the selected clip and linked clips at the red Split target, not the current Player position.';
          b.style.cssText =
            'padding:7px 10px;border:1px solid #a8b7c8;border-radius:5px;cursor:pointer;font:inherit';
          b.onclick = () =>
            act(() => {
              if (!['Save native JSON', 'Cancel inputs'].includes(name)) {
                options.onTimelineIntent?.();
                current();
              }
              work();
            });
          buttons.set(name, b);
          toolbar.append(b);
        };
        const edit = (value: VideoEdit) =>
          report(submitVideoTimelineEdit(editor, snapshot(), value));
        for (const [name, sign] of [
          ['Move −1 frame', -1],
          ['Move +1 frame', 1],
        ] as const)
          button(name, () => {
            const delta = frameTime(1, snapshot().content.sequence.frameRate);
            edit({
              type: 'move',
              clipId: selected,
              delta: time(sign * delta.value, delta.timescale),
            });
          });
        button('Move linked clips to target', () => {
          if (!/^\d+$/.test(moveTarget.value.trim())) throw Error('Invalid move frame');
          const snap = snapshot(),
            clip = snap.content.sequence.clips.find((c) => c.id === selected);
          if (!clip) throw Error('Missing clip');
          edit({
            type: 'move',
            clipId: clip.id,
            delta: subtract(
              frameTime(Number(moveTarget.value), snap.content.sequence.frameRate),
              clip.start,
            ),
          });
        });
        button('Split linked clips', () => {
          if (!/^\d+$/.test(playhead.value.trim())) throw Error('Invalid split frame');
          const snap = snapshot(),
            clip = snap.content.sequence.clips.find((c) => c.id === selected);
          if (!clip) throw Error('Missing clip');
          const targets = snap.content.sequence.clips.filter(
            (c) => c.id === clip.id || (!!clip.linkGroupId && c.linkGroupId === clip.linkGroupId),
          );
          const used = new Set([
            ...snap.content.sequence.clips.flatMap((c) => [c.id, c.linkGroupId ?? '']),
            ...snap.content.sequence.tracks.map((t) => t.id),
            ...snap.content.sources.map((s) => s.id),
            snap.content.sequence.id,
          ]);
          const allocate = (prefix: string) => {
            let n = 1;
            while (used.has(`${prefix}-${n}`)) n++;
            const id = `${prefix}-${n}`;
            used.add(id);
            return id;
          };
          edit({
            type: 'split',
            clipId: clip.id,
            at: frameTime(Number(playhead.value), snap.content.sequence.frameRate),
            rightIds: Object.fromEntries(targets.map((c) => [c.id, allocate('clip')])),
            ...(targets.length > 1 ? { rightLinkGroupId: allocate('link') } : {}),
          });
        });
        button('Delete linked clips', () => edit({ type: 'delete', clipId: selected }));
        button('Apply independent trim', () => report(editor.applyInputs()));
        button('Apply sequence duration', () => report(editor.applyInputs()));
        duration.title =
          'Change the sequence end without cutting clips. Duration must include every clip.';
        button('Cancel inputs', () => {
          const previousStatusVersion = statusVersion;
          dirty = false;
          inputKind = undefined;
          composing.clear();
          base = undefined;
          visual?.cancel();
          binding?.changed();
          render();
          // Synchronous notifications may create another draft or report an error.
          if (
            !dirty &&
            !gesturing &&
            composing.size === 0 &&
            statusVersion === previousStatusVersion
          )
            setStatus('Inputs cancelled');
        });
        for (const [name, delta] of [
          ['Move earlier', -1],
          ['Move later', 1],
        ] as const)
          button(name, () => {
            const snap = snapshot();
            const ids = [...snap.content.sequence.clips]
              .sort((a, b) => compare(a.start, b.start))
              .map((c) => c.id);
            const i = ids.indexOf(selected),
              j = i + delta;
            if (i < 0 || j < 0 || j >= ids.length) return;
            [ids[i], ids[j]] = [ids[j], ids[i]];
            report(editor.execute(prepareVideoDemoOrder(snap, ids)));
          });
        button('Undo', () => report(editor.undo()));
        button('Redo', () => report(editor.redo()));
        button('Save native JSON', () => {
          const previousStatusVersion = statusVersion;
          void editor
            .save()
            .then((result) => {
              if (disposed || lifecycle.signal.aborted || statusVersion !== previousStatusVersion)
                return;
              current();
              // Host authority checks can synchronously report a newer status.
              if (statusVersion !== previousStatusVersion) return;
              if (result.state === 'refused') setStatus(`${result.code}: ${result.message}`);
              else if (!dirty && !gesturing && composing.size === 0) {
                const outcome = result.outcome;
                setStatus(
                  `${outcome.state} · captured revision ${outcome.capture.revision.sequence} · hash ${outcome.capture.contentHash}${outcome.state === 'committed' ? ` · receipt ${outcome.receipt.adapterReceiptId} (${outcome.receipt.durability})` : ''}`,
                );
              }
            })
            .catch((error) => {
              if (statusVersion === previousStatusVersion) setStatus(String(error));
            });
        });
        selection.onchange = () =>
          act(() => {
            if (dirty || composing.size) {
              selection.value = selected;
              throw Error('Apply or cancel pending inputs');
            }
            selected = selection.value;
            render();
          });
        const selectInput = (kind: 'trim' | 'duration') => {
          if (inputKind && inputKind !== kind)
            throw Error(`${kind} input rejected: apply or cancel pending ${inputKind} inputs`);
        };
        const changed = (kind: 'trim' | 'duration') =>
          act(() => {
            selectInput(kind);
            if (!dirty) {
              options.onTimelineIntent?.();
              current();
              // The Host callback can synchronously accept another input draft.
              // Preserve that owner instead of overwriting its pending command.
              selectInput(kind);
            }
            base ??= snapshot();
            inputKind = kind;
            dirty = true;
            binding?.changed();
            render();
          });
        for (const input of [start, end, duration]) {
          const kind = input === duration ? 'duration' : 'trim';
          input.oninput = () => changed(kind);
          input.addEventListener('compositionstart', () =>
            act(() => {
              selectInput(kind);
              base ??= snapshot();
              inputKind = kind;
              composing.add(input);
              binding?.changed();
            }),
          );
          input.addEventListener('compositionend', () =>
            act(() => {
              composing.delete(input);
              changed(kind);
            }),
          );
        }
        visual = createVisualTimeline(container.ownerDocument, {
          read() {
            current();
            const view = editor.getSnapshot();
            if (view.state !== 'open') throw Error('ScopeRevoked');
            return view;
          },
          selected: () => selected,
          select(id) {
            current();
            if (dirty || composing.size || gesturing) {
              setStatus('Apply or cancel pending inputs');
              return false;
            }
            selected = id;
            render();
            return true;
          },
          begin() {
            current();
            if (dirty || composing.size || gesturing) throw Error('Apply or cancel pending inputs');
            options.onTimelineIntent?.();
            current();
          },
          gesture(active) {
            current();
            gesturing = active;
            binding?.changed();
          },
          submit(value, snap) {
            act(() => report(editor.execute(prepareVideoTimelineEdit(snap, value))));
          },
          seek(value) {
            current();
            const at = frameTime(value, snapshot().content.sequence.frameRate);
            if (compare(at, snapshot().content.sequence.duration) > 0)
              throw Error('PlayheadOutsideSequence');
            playhead.value = String(value);
            options.onPlayhead?.(at);
            current();
          },
          action(name) {
            buttons.get(name)?.click();
          },
          error(error) {
            setStatus(String(error));
          },
        });
        try {
          visual.setFrame(Number(playhead.value));
        } catch {
          visual.setFrame(0);
          playhead.value = '0';
        }
        playhead.oninput = () =>
          act(() => {
            let at: Time;
            try {
              if (!/^\d+$/.test(playhead.value)) throw Error('Invalid playhead frame');
              at = visual!.setFrame(Number(playhead.value));
            } catch (error) {
              playhead.value = String(visual!.getFrame());
              throw error;
            }
            options.onPlayhead?.(at);
            current();
          });
        root.append(
          element('h2', 'Video timeline'),
          element(
            'p',
            'Select a clip to edit. Drag its body to move it or an edge to trim. Media preview and connections are provided by the Host. This Surface does not export movies or persist media bytes.',
          ),
          sourceInfo,
          visual.root,
          selection,
          fields,
          toolbar,
          status,
          detail,
        );
        const view = editor.getSnapshot();
        if (view.state === 'open' && view.canEdit) {
          const registered = editor.bindInputs({
            label: 'Video trim or sequence duration',
            read: () => ({ dirty: dirty || gesturing, composing: composing.size > 0 }),
            prepare(snap) {
              current();
              if (composing.size) throw Error('InputComposing');
              if (gesturing) throw Error('TimelineGestureInProgress');
              if (!dirty) return { baseRevision: snap.revision, command: null };
              if (!base || !sameRevision(base.revision, snap.revision)) throw Error('StaleInput');
              if (inputKind === 'duration')
                return prepareVideoTimelineEdit(snap, {
                  type: 'resize',
                  duration: parseTime(duration.value),
                });
              return prepareVideoTimelineEdit(snap, {
                type: 'trim',
                clipId: selected,
                start: parseTime(start.value),
                end: parseTime(end.value),
                independent: true,
              });
            },
            committed() {
              dirty = false;
              inputKind = undefined;
              base = undefined;
            },
            focus() {
              (inputKind === 'duration' ? duration : start).focus();
            },
          });
          if (disposed) registered.unregister();
          else {
            binding = registered;
            unregister = () => {
              if (!lifecycle.signal.aborted) registered.unregister();
            };
          }
        }
        current();
        const subscribed = editor.subscribe(() => {
          try {
            render();
          } catch (error) {
            dispose();
            options.onError(error);
          }
        });
        if (disposed) subscribed();
        else stop = subscribed;
        current();
        render();
        current();
        container.append(root);
        current();
        options.mounted?.(editor);
        current();
      } catch (error) {
        dispose();
        throw error;
      }
    },
  };
}
