import { geometryLimits, type GeometryStepRequest } from '@editor-platform/geometry-core';
import type { OcModule } from './module';

/**
 * PB7c (ADR 017): named shapes as one STEP file through OCCT's XDE: a top product holding one
 * product per part, each placed once where it is, its surfaces in its colour. No kernel
 * rebuild: the writer is the one CAD's AP242 export uses. Names go in as placeholders and are
 * written back as P21 strings, so any text survives the file's ASCII.
 */

/** `write.step.schema`: 4 is AP214 IS, 5 is AP242 DIS; the writer's own default is restored. */
const schemaCode = { ap214: 4, ap242: 5 } as const;

export class GeometryStepError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** A P21 string literal: `'` doubled, `\` escaped, anything outside ASCII as `\X2\…\X0\`. */
export function stepString(value: string): string {
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

const token = (i: number) => `GKSTEP${i}N`;

/** Writes `shapes` (one per part, in order) as `request` says. Every OCCT object is deleted. */
export function writeStep(
  oc: OcModule,
  request: GeometryStepRequest,
  shapes: readonly unknown[],
): Uint8Array {
  if (
    typeof oc.STEPCAFControl_Writer_1 !== 'function' ||
    typeof oc.OCJS?.setStaticInteger !== 'function'
  )
    throw new GeometryStepError('step-unsupported-build');
  const owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(x: T) => (owned.push(x), x);
  const text = (s: string) => own(new oc.TCollection_ExtendedString_2(s, false));
  const name = (label: unknown, i: number) => own(oc.TDataStd_Name.Set_1(label, text(token(i))));
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
  // The STEP statics exist once a writer is made, and a writer's model takes the schema when
  // it is made: one writer first, then the schema, then the one that writes.
  new oc.STEPCAFControl_Writer_1().delete();
  const before = oc.OCJS.staticInteger('write.step.schema');
  const path = '/geometry.step';
  try {
    const doc = own(new oc.Handle_TDocStd_Document_2(new oc.TDocStd_Document(text('MDTV-XCAF'))));
    const main = doc.get().Main();
    const tool = own(oc.XCAFDoc_DocumentTool.ShapeTool(main)).get();
    const colors = own(oc.XCAFDoc_DocumentTool.ColorTool(main)).get();
    const surface = oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf;
    // Names: the top product is 0, part i is i + 1 (its product and its one instance).
    const names = [request.name, ...request.parts.map((p) => p.name)];
    const top = own(tool.NewShape());
    name(top, 0);
    const identity = own(new oc.TopLoc_Location_2(own(new oc.gp_Trsf_1())));
    // `AddShape` hands back the label of a shape it already holds, so a node asked for twice
    // would be one product named twice: a repeat gets its own copy and so its own product.
    const used = new Set<unknown>();
    request.parts.forEach((part, i) => {
      let shape = shapes[i];
      if (used.has(shape)) {
        const copy = own(new oc.BRepBuilderAPI_Transform_2(shape, own(new oc.gp_Trsf_1()), true));
        shape = own(copy.Shape());
      } else used.add(shape);
      const label = own(tool.AddShape(shape, false, true));
      name(label, i + 1);
      if (part.color) colors.SetColor_2(label, color(part.color), surface);
      name(own(tool.AddComponent_1(top, label, identity)), i + 1);
    });
    tool.UpdateAssemblies();
    if (!oc.OCJS.setStaticInteger('write.step.schema', schemaCode[request.schema]))
      throw new GeometryStepError('step-unsupported-build');
    const writer = own(new oc.STEPCAFControl_Writer_1());
    writer.SetNameMode(true);
    writer.SetColorMode(true);
    const progress = own(new oc.Message_ProgressRange_1());
    if (!writer.Transfer_1(doc, oc.STEPControl_StepModelType.STEPControl_AsIs, null, progress))
      throw new GeometryStepError('step-write-failed');
    if (writer.Write(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
      throw new GeometryStepError('step-write-failed');
    // OCCT writes the file in ASCII; one pass puts each name back and never reads what it puts in.
    const written = new TextDecoder('latin1').decode(oc.FS.readFile(path) as Uint8Array);
    const out = new TextEncoder().encode(
      written.replace(/'GKSTEP(\d+)N'/g, (_, i: string) => stepString(names[Number(i)]!)),
    );
    if (out.byteLength > geometryLimits.stepBytes) throw new GeometryStepError('step-too-large');
    return out;
  } finally {
    oc.OCJS.setStaticInteger('write.step.schema', before);
    if (oc.FS.analyzePath(path).exists) oc.FS.unlink(path);
    for (const x of owned.reverse()) x.delete();
  }
}
