import {
  namespaces as ns,
  type XmlNode,
  type ImportReportBuilder,
} from '@editor-platform/office-import-core';
// Vocabulary actually interpreted or explicitly diagnosed by the limited mapper.
// Unknown namespace/local names are never treated as successful content.
const presentation = new Set(
  'sp cxnSp pic grpSp graphicFrame nvSpPr nvCxnSpPr nvPicPr nvGrpSpPr nvGraphicFramePr cNvPr cNvSpPr cNvCxnSpPr cNvPicPr cNvGrpSpPr cNvGraphicFramePr nvPr ph spPr grpSpPr txBody style blipFill xfrm'.split(
    ' ',
  ),
);
const drawing = new Set(
  'xfrm off ext chOff chExt prstGeom custGeom avLst gd gdLst ahLst cxnLst rect pathLst path pt moveTo lnTo close solidFill noFill gradFill pattFill grpFill srgbClr schemeClr sysClr scrgbClr prstClr hslClr tint shade alpha alphaMod alphaOff alphaModFix lumMod lumOff satMod satOff hueMod hueOff ln w prstDash custDash ds round bevel miter headEnd tailEnd effectLst bodyPr txBody lstStyle p pPr r rPr endParaRPr defRPr t br fld noAutofit normAutofit spAutoFit latin ea cs sym uFillTx uLnTx hlinkClick hlinkMouseOver blip srcRect stretch fillRect graphic graphicData tbl tblPr tblGrid gridCol tr tc tcPr lnL lnR lnT lnB lnTlToBr lnBlToTr tableStyleId cell3D fillRef lnRef effectRef fontRef spcBef spcAft lnSpc spcPct spcPts buNone buChar buAutoNum buBlip buFont buFontTx buClr buClrTx buSzPct buSzPts buSzTx tabLst tab stCxn endCxn spLocks picLocks cxnSpLocks graphicFrameLocks'.split(
    ' ',
  ),
);
for (let i = 1; i <= 9; i++) drawing.add(`lvl${i}pPr`);
export function auditSlideVocabulary(node: XmlNode, part: string, builder: ImportReportBuilder) {
  if (
    node.uri === ns.p &&
    node.local === 'extLst' &&
    node.children.length > 0 &&
    node.children.every(
      (ext) =>
        ext.uri === ns.p &&
        ext.local === 'ext' &&
        ext.attributes.some(
          (a) =>
            !a.uri &&
            a.local === 'uri' &&
            [
              '{D42A27DB-BD31-4B8C-83A1-F6EECF244321}',
              '{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}',
            ].includes(a.value),
        ) &&
        ext.children.length === 1 &&
        ext.children[0].uri === 'http://schemas.microsoft.com/office/powerpoint/2010/main' &&
        ['modId', 'creationId'].includes(ext.children[0].local),
    )
  ) {
    builder.add(
      'OFFICE_IDENTITY_EXCLUDED',
      'excluded',
      { part, path: node.path },
      'Office creation/modification identity is not copied into the native artifact.',
    );
    return;
  }
  const known =
    node.uri === ns.p
      ? presentation.has(node.local)
      : node.uri === ns.a
        ? drawing.has(node.local)
        : false;
  if (!known) {
    builder.unsupported(
      'UNKNOWN_CAPABILITY',
      { part, path: node.path },
      `Unsupported ${node.local} in namespace ${node.uri}. This feature cannot be silently omitted.`,
    );
    return;
  }
  for (const c of node.children) auditSlideVocabulary(c, part, builder);
}
