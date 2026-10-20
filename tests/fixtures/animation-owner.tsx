import { useState } from 'react';
import { EditorInputs } from '@editor-platform/editor-core';
import { AnimationSurface2 } from '@editor-platform/animation/v2';
import type { AnimationContent2, AnimationInputValues2 } from '@editor-platform/animation-core/v2';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { AnimationReactPlayer2 } from '@editor-platform/animation/player-v2';
import { RegisteredAnimationPlayer } from '../../apps/animation-reference/src/registered-player';
import {
  createAnimation2,
  createPlayableAnimationEmbed,
  createAnimationLayer2,
  prepareAnimation2,
  animationCommand2,
} from '@editor-platform/animation-core/v2';
import {
  mountAnimationPlayer2,
  planAnimationFrame2,
  exportAnimationFrame2,
} from '@editor-platform/animation-player/v2';

function EditingHost() {
  const [scene, setScene] = useState(() => {
    const content = createAnimation2(),
      root = content.compositions[0];
    root.width = 640;
    root.height = 360;
    const box = createAnimationLayer2('rect', 'edit-box', root.duration),
      text = createAnimationLayer2('text', 'edit-text', root.duration);
    box.transform.x = 350;
    text.transform.x = 20;
    root.layers = [box, text];
    content.compositions.push({
      ...structuredClone(root),
      id: 'other',
      name: 'Other',
      layers: [{ ...structuredClone(box), id: 'other-box' }],
    });
    return content;
  });
  const [inputs] = useState(() => new EditorInputs()),
    [focus, setFocus] = useState<string>();
  function remove(move: boolean) {
    setScene((current) =>
      animationCommand2(
        current,
        [
          { type: 'layer.remove', compositionId: 'root', id: 'edit-text' },
          ...(move
            ? [
                {
                  type: 'layer.insert' as const,
                  compositionId: 'other',
                  layer: structuredClone(
                    current.compositions[0].layers.find((l) => l.id === 'edit-text')!,
                  ),
                },
              ]
            : []),
        ],
        { canEdit: () => true },
      ).apply(current),
    );
  }
  return (
    <div id="editing-host">
      <button onClick={() => remove(false)}>Remove edited target</button>
      <button onClick={() => remove(true)}>Move edited target</button>
      <button onClick={() => setFocus('other')}>Focus other composition</button>
      <AnimationSurface2
        content={scene}
        inputs={inputs}
        readOnly={false}
        focusId={focus}
        read={() => scene}
        execute={(command) => setScene(command.apply(scene))}
      />
      <output id="editing-native">{JSON.stringify(scene)}</output>
    </div>
  );
}

async function fractionalFrame() {
  const content = createAnimation2(),
    root = content.compositions[0];
  root.width = 100.9;
  root.height = 80.9;
  const rect = (id: string, x: number, y: number, width: number, height: number, fill: string) => {
    const layer = createAnimationLayer2('rect', id, root.duration);
    if (layer.type !== 'rect') throw Error('Rectangle fixture');
    layer.transform.x = x;
    layer.transform.y = y;
    Object.assign(layer, { width, height, fill, strokeWidth: 0 });
    return layer;
  };
  root.layers = [
    rect('background', 0, 0, root.width, root.height, '#00ff00'),
    rect('right', 99.9, 0, 1, root.height, '#ff0000'),
    rect('bottom', 0, 79.9, root.width, 1, '#0000ff'),
  ];
  const plan = planAnimationFrame2(prepareAnimation2(content), 'root', 0),
    blob = await exportAnimationFrame2(plan, {
      acceptedPlanHash: plan.planHash,
      format: 'png',
      document,
      canRead: () => true,
    }),
    url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = 'fractional-frame.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const content = createAnimation2();
content.compositions[0].layers = [
  createAnimationLayer2('rect', 'box', content.compositions[0].duration),
];
const registeredEmbed = createPlayableAnimationEmbed(
  {
    artifactId: 'registered-fixture',
    versionId: 'v1',
    contentHash: prepareAnimation2(content).contentHash,
    compositionId: content.rootCompositionId,
  },
  content,
  'Registered trigger',
);
function OwnerHost() {
  const [editingHost, setEditingHost] = useState(false);
  const [registeredTrigger, setRegisteredTrigger] = useState<'on-enter' | 'manual' | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [controlled, setControlled] = useState<AnimationContent2 | null>(null);
  const [values, setValues] = useState<AnimationInputValues2>([]);
  const [poster, setPoster] = useState<AnimationContent2 | null>(null);
  return (
    <>
      <button onClick={() => setEditingHost(true)}>Mount editing Host</button>
      <button onClick={() => void fractionalFrame()}>Export fractional frame</button>
      {editingHost && <EditingHost />}
      <button onClick={() => setTarget(document.querySelector('iframe')!.contentDocument!.body)}>
        Mount portal
      </button>
      <button onClick={() => setTarget(null)}>Unmount portal</button>
      <button onClick={async () => setPoster(await (await fetch('./player-poster.json')).json())}>
        Mount poster
      </button>
      {poster && (
        <div id="poster-stage" style={{ width: 300, height: 220 }}>
          <AnimationReactPlayer2 content={poster} posterTick={480000} label="Lightweight poster" />
        </div>
      )}
      <button
        onClick={async () => setControlled(await (await fetch('./player-source.json')).json())}
      >
        Mount controlled inputs
      </button>
      <button onClick={() => setValues([{ inputId: 'caption-input', value: 'B' }])}>
        Update controlled inputs
      </button>
      <button onClick={() => setValues([{ inputId: 'caption-input', value: 'A\n'.repeat(6000) }])}>
        Reject controlled inputs
      </button>
      {controlled && (
        <div id="controlled-stage" style={{ width: 300, height: 220 }}>
          <AnimationReactPlayer2
            content={controlled}
            inputs={values}
            label="Controlled inputs"
            loop
          />
        </div>
      )}
      <button onClick={() => setRegisteredTrigger('on-enter')}>Mount registered automatic</button>
      <button onClick={() => setRegisteredTrigger('manual')}>Mount registered manual</button>
      {registeredTrigger && (
        <div id="registered-stage" style={{ width: 300, height: 220 }}>
          <RegisteredAnimationPlayer
            style={{ height: '100%' }}
            native={JSON.stringify({ ...registeredEmbed, trigger: registeredTrigger, loop: true })}
          />
        </div>
      )}
      <iframe title="Player owner" style={{ width: 300, height: 220 }} />
      {target &&
        createPortal(
          <div style={{ width: 280, height: 180 }}>
            <AnimationReactPlayer2 content={content} label="Owner document" autoPlay loop />
          </div>,
          target,
        )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<OwnerHost />);

const stage = document.getElementById('stage')!,
  status = document.getElementById('status')!;
let player: Awaited<ReturnType<typeof mountAnimationPlayer2>> | undefined;
document.getElementById('mount')!.onclick = async () => {
  try {
    const source = prepareAnimation2(await (await fetch('./player-source.json')).json());
    player = await mountAnimationPlayer2(stage, {
      source,
      compositionId: content.rootCompositionId,
      label: 'Atomic input',
      onError: (error) => {
        status.textContent = 'Playback error: ' + String(error);
      },
    });
    status.textContent = 'Ready';
  } catch (error) {
    status.textContent = String(error);
  }
};
document.getElementById('reject')!.onclick = () => {
  try {
    player!.setInputs([{ inputId: 'caption-input', value: 'A\n'.repeat(6000) }]);
    status.textContent = 'Accepted';
  } catch (error) {
    status.textContent = String(error);
  }
};
document.getElementById('seek')!.onclick = () => {
  try {
    player!.seek(24000);
    status.textContent = 'Seeked';
  } catch (error) {
    status.textContent = String(error);
  }
};
document.getElementById('play')!.onclick = () => {
  player!.play();
};
document.getElementById('pause')!.onclick = () => {
  player!.pause();
};
document.getElementById('dispose')!.onclick = () => {
  player!.dispose();
};
