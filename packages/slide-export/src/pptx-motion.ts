import type { PptxMotionEffect, PptxPage } from './types';

export interface PptxShapePart {
  id: number;
  centerX: number;
  centerY: number;
}

type Transition = NonNullable<PptxPage['transition']>;

export function pptxTransition(transition: Transition | undefined) {
  if (!transition) return '';
  const { durationMs } = transition;
  const speed = durationMs <= 300 ? 'fast' : durationMs <= 700 ? 'med' : 'slow';
  const direction = { left: 'l', right: 'r', up: 'u', down: 'd' } as const;
  const effect =
    transition.kind === 'fade'
      ? '<p:fade thruBlk="0"/>'
      : `<p:push dir="${direction[transition.direction]}"/>`;
  // Office 2010+ reads the exact duration. Older readers can use the native speed category.
  return (
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">' +
    `<mc:Choice Requires="p14"><p:transition spd="${speed}" p14:dur="${durationMs}">${effect}</p:transition></mc:Choice>` +
    `<mc:Fallback><p:transition spd="${speed}">${effect}</p:transition></mc:Fallback></mc:AlternateContent>`
  );
}

const starts = {
  'on-click': 'clickEffect',
  'with-previous': 'withEffect',
  'after-previous': 'afterEffect',
} as const;

function delay(ms: number | 'indefinite') {
  return `<p:stCondLst><p:cond delay="${ms}"/></p:stCondLst>`;
}
function sequenceCondition(direction: 'prev' | 'next', event: 'onPrev' | 'onNext') {
  return `<p:${direction}CondLst><p:cond evt="${event}" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:${direction}CondLst>`;
}

function node(id: number, attributes: string, children: string, condition = '') {
  return `<p:par><p:cTn id="${id}" ${attributes}>${condition}<p:childTnLst>${children}</p:childTnLst></p:cTn></p:par>`;
}

type NextId = () => number;
type Keyframe = { time: number; value: string };

function behavior(
  nextId: NextId,
  part: PptxShapePart,
  duration: number,
  attributes: string[] = [],
  fill = 'hold',
  condition = '',
) {
  const names = attributes.map((a) => `<p:attrName>${a}</p:attrName>`).join('');
  return (
    `<p:cBhvr${names ? ' additive="base"' : ''}><p:cTn id="${nextId()}" dur="${duration}" fill="${fill}">${condition}</p:cTn>` +
    `<p:tgtEl><p:spTgt spid="${part.id}"/></p:tgtEl>` +
    (names ? `<p:attrNameLst>${names}</p:attrNameLst>` : '') +
    '</p:cBhvr>'
  );
}

function visibility(nextId: NextId, part: PptxShapePart, visible: boolean, at = 0, duration = 1) {
  return (
    '<p:set>' +
    behavior(nextId, part, duration, ['style.visibility'], 'hold', delay(at)) +
    `<p:to><p:strVal val="${visible ? 'visible' : 'hidden'}"/></p:to></p:set>`
  );
}

function animate(
  nextId: NextId,
  part: PptxShapePart,
  duration: number,
  attribute: string,
  frames: Keyframe[],
) {
  const values = frames
    .map(
      ({ time, value }) => `<p:tav tm="${time}"><p:val><p:strVal val="${value}"/></p:val></p:tav>`,
    )
    .join('');
  return (
    '<p:anim calcmode="lin" valueType="num">' +
    behavior(nextId, part, duration, [attribute], 'remove') +
    `<p:tavLst>${values}</p:tavLst></p:anim>`
  );
}

function positionValue(attribute: string, offset: number) {
  const value = Number(offset.toFixed(10));
  return `#${attribute}${value === 0 ? '' : value > 0 ? `+${value}` : String(value)}`;
}

function transformations(
  nextId: NextId,
  part: PptxShapePart,
  { effect, poses, bounds }: PptxMotionEffect,
  width: number,
  height: number,
) {
  if (!poses || !bounds) throw Error('Missing motion geometry');
  const { durationMs } = effect;
  const offsets = [
    {
      attribute: 'ppt_x',
      axis: 'offsetX',
      pivot: bounds.x + bounds.width / 2 - part.centerX,
      size: width,
    },
    {
      attribute: 'ppt_y',
      axis: 'offsetY',
      pivot: bounds.y + bounds.height / 2 - part.centerY,
      size: height,
    },
  ] as const;
  const frames = (sample: (pose: NonNullable<PptxMotionEffect['poses']>[number]) => string) =>
    poses.map((pose, index) => ({
      time: (index * 100000) / (poses.length - 1),
      value: sample(pose),
    }));

  // Zooming each native part around its own center would pull separate lines toward
  // separate vanishing points. Translate each part by the difference between pivots.
  let xml = '';
  for (const { attribute, axis, pivot, size } of offsets) {
    const positions = frames((pose) =>
      positionValue(attribute, (pose[axis] + (1 - pose.scale) * pivot) / size),
    );
    if (positions.some(({ value }) => value !== `#${attribute}`))
      xml += animate(nextId, part, durationMs, attribute, positions);
  }
  if (effect.effect !== 'zoom') return xml;
  if (effect.phase === 'emphasis') {
    const scales = frames(({ scale }) => String(scale));
    for (const axis of ['ScaleX', 'ScaleY']) xml += animate(nextId, part, durationMs, axis, scales);
    return xml;
  }
  const from = Math.round(poses[0].scale * 100000);
  const to = Math.round(poses[1].scale * 100000);
  return (
    xml +
    '<p:animScale>' +
    behavior(nextId, part, durationMs, ['ScaleX', 'ScaleY'], 'remove') +
    `<p:from x="${from}" y="${from}"/><p:to x="${to}" y="${to}"/></p:animScale>`
  );
}

function partEffect(
  nextId: NextId,
  motion: PptxMotionEffect,
  part: PptxShapePart,
  nodeType: string,
  width: number,
  height: number,
) {
  const id = nextId();
  const { effect, bounds } = motion;
  const { phase, durationMs } = effect;
  if (!bounds)
    return node(
      id,
      `presetID="0" presetClass="emph" fill="hold" nodeType="${nodeType}"`,
      visibility(nextId, part, false, 0, durationMs),
      delay(0),
    );

  const presetClass = { enter: 'entr', exit: 'exit', emphasis: 'emph' }[phase];
  const presetId = { fade: 10, 'slide-in': 2, 'slide-out': 2, zoom: phase === 'emphasis' ? 6 : 23 }[
    effect.effect
  ];
  const direction = { left: 8, right: 2, up: 4, down: 1 };
  const opposite = { left: 'right', right: 'left', up: 'down', down: 'up' } as const;
  const subtype = effect.direction
    ? direction[phase === 'enter' ? opposite[effect.direction] : effect.direction]
    : 0;
  let children = phase === 'enter' ? visibility(nextId, part, true) : '';
  if (effect.effect === 'fade') {
    children +=
      `<p:animEffect transition="${phase === 'enter' ? 'in' : 'out'}" filter="fade">` +
      behavior(nextId, part, durationMs, [], 'remove') +
      '</p:animEffect>';
  } else {
    children += transformations(nextId, part, motion, width, height);
  }
  if (phase === 'exit') children += visibility(nextId, part, false, durationMs - 1);
  return node(
    id,
    `presetID="${presetId}" presetClass="${presetClass}" presetSubtype="${subtype}" fill="hold" nodeType="${nodeType}"`,
    children,
    delay(0),
  );
}

/** A PowerPoint main sequence contains one click gate per Slide step. */
export function pptxTiming(
  steps: PptxPage['steps'],
  partsByTarget: ReadonlyMap<string, PptxShapePart[]>,
  timingMarker: PptxShapePart | undefined,
  width: number,
  height: number,
) {
  if (!steps?.length) return '';
  let id = 2; // 1 = timing root, 2 = main sequence
  const nextId = () => ++id;
  const stepNodes = steps.map((step) => {
    const stepId = nextId();
    const effects = step.map((motion) => {
      const wrapperId = nextId();
      const parts = motion.bounds ? partsByTarget.get(motion.effect.targetId) : [timingMarker];
      if (!parts?.length) throw Error('Motion target has no output parts');
      const children = parts
        .map((part, i) => {
          if (!part) throw Error('Missing timing marker');
          return partEffect(
            nextId,
            motion,
            part,
            i === 0 ? starts[motion.effect.trigger] : 'withEffect',
            width,
            height,
          );
        })
        .join('');
      return node(wrapperId, 'fill="hold"', children, delay(motion.startMs));
    });
    return node(stepId, 'fill="hold"', effects.join(''), delay('indefinite'));
  });
  const sequence =
    '<p:seq concurrent="1" nextAc="seek" prevAc="skipTimed">' +
    '<p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>' +
    stepNodes.join('') +
    '</p:childTnLst></p:cTn>' +
    sequenceCondition('prev', 'onPrev') +
    sequenceCondition('next', 'onNext') +
    '</p:seq>';
  return (
    '<p:timing><p:tnLst>' +
    node(1, 'dur="indefinite" restart="never" nodeType="tmRoot"', sequence) +
    '</p:tnLst></p:timing>'
  );
}
