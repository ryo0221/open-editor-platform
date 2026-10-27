/**
 * R2b-5 (docs/cad/r2b-assembly.md, STEP AP242): an assembly as STEP AP242 through OCCT's XDE.
 * One product per plan product (its shape written once, from the version's normalized BRep),
 * one `NEXT_ASSEMBLY_USAGE_OCCURRENCE` per instance with its placement, names and body colours.
 */
import { cadLimits, type CadStepPlan } from '@editor-platform/cad-core';
import { CadKernelError, type OcModule } from './evaluator';

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
  if (
    typeof oc.STEPCAFControl_Writer_1 !== 'function' ||
    typeof oc.OCJS?.setStaticInteger !== 'function'
  )
    throw new CadKernelError('step-unsupported-build');
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
    if (!writer.Transfer_1(doc, oc.STEPControl_StepModelType.STEPControl_AsIs, null, progress()))
      throw new CadKernelError('step-write-failed');
    if (writer.Write(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
      throw new CadKernelError('step-write-failed');
    const bytes = named(oc.FS.readFile(path) as Uint8Array, plan, instanceNames);
    if (bytes.byteLength > cadLimits.stepBytes) throw new CadKernelError('step-too-large');
    return bytes;
  } finally {
    oc.OCJS.setStaticInteger('write.step.schema', schema);
    if (oc.FS.analyzePath(path).exists) oc.FS.unlink(path);
    for (const x of owned.reverse()) x.delete();
  }
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
 * The file with each placeholder replaced: a product's id and name, an instance's name. The
 * file holds no other names, and one pass never reads the text it puts in.
 */
function named(bytes: Uint8Array, plan: CadStepPlan, instances: readonly string[]): Uint8Array {
  // OCCT writes the file in ASCII.
  const text = new TextDecoder('latin1').decode(bytes);
  const renamed = text.replace(
    /PRODUCT\('R2B5P(\d+)','R2B5P\1'|'R2B5([PI])(\d+)'/g,
    (_, both: string | undefined, kind: string | undefined, i: string | undefined) => {
      if (both !== undefined) {
        const product = plan.products[Number(both)]!;
        return `PRODUCT(${p21String(product.id)},${p21String(product.name)}`;
      }
      return p21String(kind === 'P' ? plan.products[Number(i)]!.name : instances[Number(i)]!);
    },
  );
  return new TextEncoder().encode(renamed);
}
