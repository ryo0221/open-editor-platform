import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/** Targeted OOXML mutations of the independently authored CC0 Impress fixture. */
export function makeReviewPptx(source: Uint8Array): Uint8Array {
  const files = unzipSync(source);
  const replace = (
    part: string,
    find: string | RegExp,
    value: string | ((text: string) => string),
  ) => {
    const before = strFromU8(files[part]);
    const after =
      typeof value === 'string' ? before.replace(find, value) : before.replace(find, value);
    if (before === after) throw Error(`Review fixture no longer matches ${part}: ${find}`);
    files[part] = strToU8(after);
  };
  const slide = 'ppt/slides/slide1.xml';
  replace(slide, '<p:cNvPr id="2" name="">', '<p:cNvPr id="2" name="" hidden="true">');
  replace(slide, '<a:t>受付</a:t>', '<a:t>非表示の受付</a:t>');
  replace(slide, '<a:t>確認</a:t>', '<a:t>非表示の確認</a:t>');
  const style = (effect: number) =>
    `<p:style><a:lnRef idx="0"><a:srgbClr val="000000"/></a:lnRef><a:fillRef idx="0"><a:srgbClr val="000000"/></a:fillRef><a:effectRef idx="${effect}"><a:srgbClr val="000000"/></a:effectRef><a:fontRef idx="minor"><a:srgbClr val="ff0000"/></a:fontRef></p:style>`;
  replace(slide, /<p:sp>[\s\S]*?<\/p:sp>/, (shape) =>
    shape
      .replace('cy="540000"', 'cy="1047750"')
      .replace(
        /<p:txBody>[\s\S]*?<\/p:txBody>/,
        `${style(0)}<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1800"/></a:pPr><a:r><a:t>継承された赤い文字</a:t></a:r><a:br/><a:r><a:rPr><a:solidFill><a:srgbClr val="0000ff"/></a:solidFill></a:rPr><a:t>個別の青い文字</a:t></a:r></a:p></p:txBody>`,
      ),
  );
  replace(slide, /<p:sp><p:nvSpPr><p:cNvPr id="5"[\s\S]*?<\/p:sp>/, (shape) =>
    shape.replace('</p:spPr>', `</p:spPr>${style(1)}`),
  );
  // Picture references must be checked by the same effect policy as ordinary shapes.
  replace(slide, '</p:pic>', `${style(1)}</p:pic>`);
  replace(slide, '<a:t>項目</a:t>', '<a:t>氏名</a:t></a:r><a:br/><a:r><a:t>部署</a:t>');
  // Reserve two text lines plus native padding; export correctly rejects row overflow.
  replace(slide, '<a:tr h="540000">', '<a:tr h="720000">');
  replace(slide, '<a:ext cx="5760000" cy="1080000"/>', '<a:ext cx="5760000" cy="1260000"/>');
  replace(
    'ppt/theme/theme1.xml',
    '<a:effectStyle><a:effectLst/></a:effectStyle>',
    '<a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="2700000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="50000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>',
  );
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  replace(
    'ppt/slides/_rels/slide1.xml.rels',
    '</Relationships>',
    `<Relationship Id="reviewNotes" Type="${rel}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
  );
  replace(
    '[Content_Types].xml',
    '</Types>',
    '<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/></Types>',
  );
  files['ppt/notesSlides/notesSlide1.xml'] = strToU8(
    `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="0" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="1" name="notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>第一段落</a:t></a:r><a:br/><a:r><a:t>続き</a:t></a:r></a:p><a:p/><a:p><a:r><a:t>次の段落</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
  );
  return zipSync(files);
}
