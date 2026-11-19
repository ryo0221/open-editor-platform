/**
 * R2b-5 (docs/cad/r2b-assembly.md, STEP AP242): an assembly as STEP AP242 through OCCT's XDE.
 * One product per plan product (its shape written once, from the version's normalized BRep),
 * one `NEXT_ASSEMBLY_USAGE_OCCURRENCE` per instance with its placement, names and body colours.
 */
import {
  cadLimits,
  cadPmiTrackedIndex,
  rotateVector,
  type CadPmiAsset,
  type CadPmiItem,
  type CadPmiItemState,
  type CadPmiPlacement,
  type CadPmiTarget,
  type CadStepPlan,
} from '@editor-platform/cad-core';
import { CadKernelError, type OcModule } from './evaluator';
import type { CadAssemblyStepPmi, CadAssemblyStepPmiWritten, CadBrepPmi } from './protocol';
import { noPmiWritten, pmiWriteSpec } from './step-pmi-write';

/** `write.step.schema` 5 selects AP242 (DIS); the writer's default (AP214) is restored after. */
const ap242 = 5;

/**
 * Writes `plan` with each shaped product's BRep compound from `breps` (by content hash).
 * Every OCCT object it makes is deleted before it returns.
 */
export function writeAssemblyStep(
  oc: OcModule,
  plan: CadStepPlan,
  breps: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  return writeAssemblyStepPmi(oc, plan, breps).step;
}

/** `writeAssemblyStep` with PMI-5c's PMI, and what of it is written. */
export function writeAssemblyStepPmi(
  oc: OcModule,
  plan: CadStepPlan,
  breps: ReadonlyMap<string, Uint8Array>,
  /** PMI-5c: the products' and the assembly's PMI to write (`assemblyPmiLines`). */
  pmi?: CadAssemblyStepPmi,
): { step: Uint8Array; pmi?: CadAssemblyStepPmiWritten } {
  if (
    typeof oc.STEPCAFControl_Writer_1 !== 'function' ||
    typeof oc.OCJS?.setStaticInteger !== 'function'
  )
    throw new CadKernelError('step-unsupported-build');
  const written = pmi
    ? assemblyPmiLines(plan, pmi, {
        face: oc.TopAbs_ShapeEnum.TopAbs_FACE.value,
        edge: oc.TopAbs_ShapeEnum.TopAbs_EDGE.value,
        vertex: oc.TopAbs_ShapeEnum.TopAbs_VERTEX.value,
      })
    : undefined;
  const pmiOf = written?.lines ?? new Map<string, string[][]>();
  if (pmiOf.size && typeof oc.OCJS?.addPmi !== 'function')
    throw new CadKernelError('step-pmi-unsupported-build');
  const owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(x: T) => (owned.push(x), x);
  const text = (s: string) => own(new oc.TCollection_ExtendedString_2(s, false));
  const progress = () => own(new oc.Message_ProgressRange_1());
  const name = (label: unknown, value: string) => own(oc.TDataStd_Name.Set_1(label, text(value)));
  const color = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return own(
      new oc.Quantity_Color_3(
        ((n >> 16) & 255) / 255,
        ((n >> 8) & 255) / 255,
        (n & 255) / 255,
        oc.Quantity_TypeOfColor.Quantity_TOC_sRGB,
      ),
    );
  };
  // The STEP statics exist once a writer (its controller) is made, and a writer's model takes
  // the schema when it is made: one writer first, then the schema, then the one that writes.
  new oc.STEPCAFControl_Writer_1().delete();
  const schema = oc.OCJS.staticInteger('write.step.schema');
  const path = '/a.step';
  try {
    const doc = own(new oc.Handle_TDocStd_Document_2(new oc.TDocStd_Document(text('MDTV-XCAF'))));
    const main = doc.get().Main();
    const shapes = own(oc.XCAFDoc_DocumentTool.ShapeTool(main)).get();
    const colors = own(oc.XCAFDoc_DocumentTool.ColorTool(main)).get();
    const surface = oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf;
    const labels = new Map<string, unknown>();
    /** Each instance's name, by its placeholder's number. */
    const instanceNames: string[] = [];
    for (const product of plan.products) {
      let label;
      if (product.shape) {
        const bytes = breps.get(product.shape.contentHash);
        if (!bytes) throw new CadKernelError('step-part-missing', product.key);
        const shape = readBrep(oc, own, bytes, product.key);
        label = own(shapes.AddShape(shape, false, true));
        const { bodies } = product.shape;
        if (new Set(bodies.map((b) => b.color)).size === 1)
          colors.SetColor_2(label, color(bodies[0]!.color), surface);
        else {
          // The compound holds one child per body, in order. A body may hold several solids (K1),
          // so each body's own solids (or a sheet's shells) take its colour.
          const within = (of: unknown, kind: 'solid' | 'sheet') => {
            const found: unknown[] = [];
            const explorer = own(
              new oc.TopExp_Explorer_2(
                of,
                kind === 'solid'
                  ? oc.TopAbs_ShapeEnum.TopAbs_SOLID
                  : oc.TopAbs_ShapeEnum.TopAbs_SHELL,
                kind === 'solid'
                  ? oc.TopAbs_ShapeEnum.TopAbs_SHAPE
                  : oc.TopAbs_ShapeEnum.TopAbs_SOLID,
              ),
            );
            for (; explorer.More(); explorer.Next()) found.push(own(explorer.Current()));
            return found;
          };
          // `MapShapes` lists the compound first, then each child before its own sub-shapes:
          // the next body's shape follows the previous one's sub-shapes (bodies share none).
          const all = own(new oc.TopTools_IndexedMapOfShape_1());
          oc.TopExp.MapShapes_2(shape, all, true, true);
          let next = 2;
          for (const body of bodies) {
            if (next > all.Size()) break;
            const child = own(all.FindKey(next));
            const subs = own(new oc.TopTools_IndexedMapOfShape_1());
            oc.TopExp.MapShapes_2(child, subs, true, true);
            next += subs.Size();
            for (const sub of within(child, body.kind))
              colors.SetColor_2(own(shapes.AddSubShape_1(label, sub)), color(body.color), surface);
          }
        }
      } else {
        label = own(shapes.NewShape());
        for (const instance of product.instances) {
          const placed = labels.get(instance.product);
          if (!placed) throw new CadKernelError('step-part-missing', instance.product);
          const { translationMm: t, rotation: q } = instance.pose;
          const trsf = own(new oc.gp_Trsf_1());
          trsf.SetTransformation_3(
            own(new oc.gp_Quaternion_2(q[0], q[1], q[2], q[3])),
            own(new oc.gp_Vec_4(t[0], t[1], t[2])),
          );
          const component = own(
            shapes.AddComponent_1(label, placed, own(new oc.TopLoc_Location_2(trsf))),
          );
          // A placeholder too: every name in the file is written by `named`.
          name(component, token('I', instanceNames.push(instance.name) - 1));
        }
      }
      // PMI-5c: the product's PMI on its own shape's sub-shapes (one product, one shape).
      // One call per spec: a spec's datum ordinals count its own datums only.
      for (const lines of (product.shape && pmiOf.get(product.key)) || []) {
        const spec = own(new oc.TCollection_AsciiString_2(lines.join('\n')));
        if (oc.OCJS.addPmi(doc, label, spec) !== lines.length)
          throw new CadKernelError('step-write-failed', product.key);
      }
      // A placeholder the file's products are renamed from: XDE writes a label's name as both the
      // product's id and name, and two products may share a name.
      name(label, token('P', labels.size));
      labels.set(product.key, label);
    }
    shapes.UpdateAssemblies();
    if (!oc.OCJS.setStaticInteger('write.step.schema', ap242))
      throw new CadKernelError('step-unsupported-build');
    const writer = own(new oc.STEPCAFControl_Writer_1());
    writer.SetNameMode(true);
    writer.SetColorMode(true);
    if (pmiOf.size) writer.SetDimTolMode(true);
    if (!writer.Transfer_1(doc, oc.STEPControl_StepModelType.STEPControl_AsIs, null, progress()))
      throw new CadKernelError('step-write-failed');
    if (writer.Write(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
      throw new CadKernelError('step-write-failed');
    const bytes = named(oc.FS.readFile(path) as Uint8Array, plan, instanceNames);
    if (bytes.byteLength > cadLimits.stepBytes) throw new CadKernelError('step-export-too-large');
    return { step: bytes, ...(written ? { pmi: written.report } : {}) };
  } finally {
    oc.OCJS.setStaticInteger('write.step.schema', schema);
    if (oc.FS.analyzePath(path).exists) oc.FS.unlink(path);
    for (const x of owned.reverse()) x.delete();
  }
}

/** How many times each product is placed in the whole file (the root once). */
function placements(plan: CadStepPlan): Map<string, number> {
  const times = new Map<string, number>([[plan.root, 1]]);
  // Instances name products earlier in the list: from the root down.
  for (let i = plan.products.length - 1; i >= 0; i--) {
    const p = plan.products[i]!;
    const n = times.get(p.key) ?? 0;
    for (const instance of p.instances)
      times.set(instance.product, (times.get(instance.product) ?? 0) + n);
  }
  return times;
}

/** The placement that takes a point from the assembly's frame into a component's part. */
function inverse(pose: { translationMm: readonly number[]; rotation: readonly number[] }) {
  const [x, y, z, w] = pose.rotation as [number, number, number, number];
  const rotation: [number, number, number, number] = [-x, -y, -z, w];
  const t = rotateVector(rotation, pose.translationMm as [number, number, number]);
  return { rotation, translation: [-t[0], -t[1], -t[2]] } as CadPmiPlacement;
}

/**
 * PMI-5c (docs/cad/pmi.md, 書き出し): the `OCJS.addPmi` specs of each shaped product, and what is
 * and is not written. A product's bodies write their own current PMI on their sub-shapes in the
 * product's compound. The assembly's own items are written on a product only when all their
 * targets (and the datums a tolerance references) are on one component, its product is placed
 * once in the whole file (so the item means that instance alone, as in the assembly), and the
 * component's version tracks the sub-shapes it was imported with; their lines are taken from the
 * assembly's frame into the part's by the component's pose at the import. Datum names are merged
 * across the file by OCCT's writer, so a name written once is not written again (`pmiWriteSpec`).
 */
export function assemblyPmiLines(
  plan: CadStepPlan,
  pmi: CadAssemblyStepPmi,
  kinds: { face: number; edge: number; vertex: number },
): { lines: Map<string, string[][]>; report: CadAssemblyStepPmiWritten } {
  const report: CadAssemblyStepPmiWritten = {
    ...noPmiWritten(),
    assembly: { written: 0, shared: 0, across: 0, stale: 0, unwritable: 0 },
    presentationOneFrame: 0,
  };
  const lines = new Map<string, string[][]>();
  const datumNames = new Set<string>();
  const add = (key: string, more: string[]) => {
    // Each spec numbers its datums from 0, so specs are never joined (`OCJS.addPmi` per spec).
    if (more.length) lines.set(key, [...(lines.get(key) ?? []), more]);
  };
  // What no file can write: counted once per version, however often it is placed.
  const counted = new Set<string>();
  const shaped = plan.products.filter((p) => p.shape);
  for (const product of shaped) {
    const hash = product.shape!.contentHash;
    const brep: CadBrepPmi | undefined = pmi.products[hash];
    if (!brep) continue;
    if (!counted.has(hash)) {
      counted.add(hash);
      const r = brep.report;
      report.stale += r.stale;
      report.views += r.views;
      report.unsupportedBuild += r.unsupportedBuild;
    }
    for (const body of brep.bodies) {
      if (!body.pmi) continue;
      const tracking = body.tracking.find((t) => t.featureId === body.pmi!.featureId);
      add(
        product.key,
        pmiWriteSpec(
          body.pmi.asset,
          new Map(body.pmi.states),
          kinds,
          (t) => (tracking ? cadPmiTrackedIndex(tracking, t) : undefined),
          body.pmi.placements,
          report,
          datumNames,
        ),
      );
    }
  }
  const own = pmi.assembly;
  if (own) {
    // The assembly's saved views are not written, like a part's.
    report.views += own.asset.views?.length ?? 0;
    const times = placements(plan);
    const states = new Map(own.states);
    const componentsOf = (i: CadPmiItem) =>
      new Set(
        [...i.targets, ...(i.kind === 'dimension' ? (i.targets2 ?? []) : [])].map(
          (t) => t.component,
        ),
      );
    const byId = new Map(own.asset.items.map((i) => [i.id, i]));
    // Each item's one component, with the datums it references; undefined: not one.
    const oneComponent = (i: CadPmiItem): string | undefined => {
      const all = componentsOf(i);
      if (i.kind === 'geometric-tolerance')
        for (const r of i.references)
          for (const d of r.datums) {
            const datum = byId.get(d);
            if (!datum) return undefined;
            for (const c of componentsOf(datum)) all.add(c);
          }
      return all.size === 1 ? [...all][0] : undefined;
    };
    const groups = new Map<string, CadPmiItem[]>();
    for (const item of own.asset.items) {
      if (states.get(item.id)?.current !== true) {
        report.assembly.stale++;
        continue;
      }
      const component = oneComponent(item);
      const hash = component === undefined ? undefined : own.components[component];
      if (component === undefined || hash === undefined) {
        report.assembly.across++;
        continue;
      }
      if (times.get(hash) !== 1) {
        report.assembly.shared++;
        continue;
      }
      groups.set(component, [...(groups.get(component) ?? []), item]);
    }
    for (const [component, items] of groups) {
      const hash = own.components[component]!;
      const product = plan.products.find((p) => p.key === hash);
      // A component that is an assembly has no shape of its own to write them on.
      if (!product?.shape) {
        report.assembly.unwritable += items.length;
        continue;
      }
      const brep = pmi.products[hash];
      // The version's one tracked import: the sub-shapes the asset's indices are of.
      const tracked = brep?.bodies.flatMap((b) => b.tracking.map((t) => ({ t, body: b }))) ?? [];
      const one = tracked.length === 1 ? tracked[0] : undefined;
      const tracking = one?.t;
      const read = own.asset.parts[component];
      const strip = (ts: readonly CadPmiTarget[]) => ts.map(({ component: _, ...t }) => t);
      const asset: CadPmiAsset = {
        version: 1,
        items: items.map((i) => ({
          ...i,
          targets: strip(i.targets),
          ...(i.kind === 'dimension' && i.targets2 ? { targets2: strip(i.targets2) } : {}),
        })) as CadPmiItem[],
      };
      const before = { ...report.written };
      const unwritable = report.unwritable;
      const itemStates = new Map<string, CadPmiItemState>(
        items.map((i) => [i.id, { current: true }]),
      );
      add(
        product.key,
        pmiWriteSpec(
          asset,
          itemStates,
          kinds,
          (t) => (tracking ? cadPmiTrackedIndex(tracking, t) : undefined),
          // The lines are in the assembly's frame; the part's shape is where the pose places it from.
          read ? [inverse(read.pose)] : undefined,
          report,
          datumNames,
        ),
      );
      // Moved from the bodies' counts to the assembly's.
      const n = (Object.keys(before) as (keyof typeof before)[]).reduce(
        (k, kind) => k + report.written[kind] - before[kind],
        0,
      );
      report.written = before;
      report.assembly.written += n;
      report.assembly.unwritable += report.unwritable - unwritable;
      report.unwritable = unwritable;
    }
  }
  // OCCT 7.6's writer puts every presentation line of the file in one draughting model, in the
  // frame of one product (the last item's it writes, found on the JAMA files, PMI-5d): another
  // product's lines would be read in that product's frame. So lines are written only when one
  // product carries all of the file's PMI.
  const carrying = [...lines].filter(([, specs]) => specs.some((spec) => spec.length));
  const only = carrying.length === 1 ? carrying[0]![0] : undefined;
  for (const [key, specs] of lines) {
    if (key === only) continue;
    for (const spec of specs)
      spec.forEach((line, i) => {
        const at = line.indexOf(' prs ');
        if (at < 0) return;
        spec[i] = line.slice(0, at);
        report.presented--;
        report.presentationOneFrame++;
      });
  }
  return { lines, report };
}

function readBrep(
  oc: OcModule,
  own: <T extends { delete(): void }>(x: T) => T,
  bytes: Uint8Array,
  key: string,
) {
  // One job runs at a time in a Worker, so a fixed path is safe.
  const path = '/p.brep';
  try {
    oc.FS.writeFile(path, bytes);
    const shape = own(new oc.TopoDS_Shape());
    if (
      !oc.BRepTools.Read_2(
        shape,
        path,
        own(new oc.BRep_Builder()),
        own(new oc.Message_ProgressRange_1()),
      )
    )
      throw new CadKernelError('asset-unreadable', key);
    return shape;
  } finally {
    if (oc.FS.analyzePath(path).exists) oc.FS.unlink(path);
  }
}

/** A product's (`P`) or an instance's (`I`) placeholder name. */
const token = (kind: 'P' | 'I', i: number) => `R2B5${kind}${i}`;
/** A P21 string literal: `'` doubled, `\` escaped, anything else outside ASCII as `\X2\…\X0\`. */
export function p21String(value: string): string {
  let out = '';
  let wide = '';
  const flush = () => {
    if (wide) out += `\\X2\\${wide}\\X0\\`;
    wide = '';
  };
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code < 0x7f) {
      flush();
      out += ch === "'" ? "''" : ch === '\\' ? '\\\\' : ch;
    } else
      for (let i = 0; i < ch.length; i++)
        wide += ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  }
  flush();
  return `'${out}'`;
}
/**
 * The file with each placeholder replaced: a product's id and name, an instance's name. Only
 * those fields are read (PMI-5c: a datum's name is the file's too, and may look like one), and
 * one pass never reads the text it puts in.
 */
function named(bytes: Uint8Array, plan: CadStepPlan, instances: readonly string[]): Uint8Array {
  // OCCT writes the file in ASCII.
  const text = new TextDecoder('latin1').decode(bytes);
  const renamed = text.replace(
    /PRODUCT\('R2B5P(\d+)','R2B5P\1'|(NEXT_ASSEMBLY_USAGE_OCCURRENCE\('(?:[^']|'')*',)'R2B5I(\d+)'/g,
    (match, product: string | undefined, usage: string | undefined, i: string | undefined) => {
      if (product !== undefined) {
        const p = plan.products[Number(product)];
        return p ? `PRODUCT(${p21String(p.id)},${p21String(p.name)}` : match;
      }
      const name = instances[Number(i)];
      return name === undefined ? match : `${usage}${p21String(name)}`;
    },
  );
  return new TextEncoder().encode(renamed);
}
