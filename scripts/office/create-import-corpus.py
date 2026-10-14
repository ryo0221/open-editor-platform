"""Independently author Office fixtures in LibreOffice UNO; no OOXML patching."""
from pathlib import Path
import json,os,subprocess,time,uuid,hashlib,sys
import uno
root=Path(sys.argv[1]).resolve();root.mkdir(parents=True,exist_ok=True)
repo=Path(__file__).resolve().parents[2]
def prop(name,value):
 p=uno.createUnoStruct('com.sun.star.beans.PropertyValue');p.Name=name;p.Value=value;return p
def point(x,y):p=uno.createUnoStruct('com.sun.star.awt.Point');p.X=x;p.Y=y;return p
def size(w,h):p=uno.createUnoStruct('com.sun.star.awt.Size');p.Width=w;p.Height=h;return p
ctx=uno.getComponentContext();resolver=ctx.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver',ctx);key='import-spike-'+uuid.uuid4().hex
with (root/'office.log').open('w') as log:
 process=subprocess.Popen([os.environ['EDITOR_SOFFICE'],'-env:UserInstallation=file:///tmp/'+key,'--headless','--norestore','--nodefault','--nofirststartwizard','--accept=pipe,name='+key+';urp;StarOffice.ComponentContext'],stdout=log,stderr=subprocess.STDOUT)
 try:
  deadline=time.monotonic()+30
  while True:
   try:context=resolver.resolve('uno:pipe,name='+key+';urp;StarOffice.ComponentContext');break
   except Exception:
    if process.poll()is not None or time.monotonic()>deadline:raise
    time.sleep(.1)
  desktop=context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop',context)
  options=(prop('Hidden',True),)
  document=desktop.loadComponentFromURL('private:factory/swriter','_blank',0,options)
  document.DocumentProperties.Author='PRIVATE_OFFICE_AUTHOR_SENTINEL'
  styles=document.StyleFamilies.getByName('ParagraphStyles');base=styles.getByName('Standard');base.CharFontName='Noto Sans CJK JP';base.CharFontNameAsian='Noto Sans CJK JP';base.CharHeight=11;base.CharHeightAsian=11
  custom=document.createInstance('com.sun.star.style.ParagraphStyle');styles.insertByName('Company Section',custom);custom.setParentStyle('Heading 2');custom.OutlineLevel=2
  def paragraph(text,style='Standard',rules=None,level=0,start=None):
   cursor=document.Text.createTextCursor();cursor.gotoEnd(False);cursor.ParaStyleName=style;cursor.NumberingStyleName=''
   if rules is not None:cursor.NumberingStyleName='Numbering 123';cursor.NumberingLevel=level
   if start is not None:cursor.ParaIsNumberingRestart=True;cursor.NumberingStartValue=start
   document.Text.insertString(cursor,text,False);document.Text.insertControlCharacter(cursor,uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'),False)
  paragraph('外部作成の受付改善提案書','Heading 1')
  paragraph('独自スタイルを継承した見出し','Company Section')
  paragraph('来訪者と担当者が同じ案内を確認します。公式資料を参照します。')
  search=document.createSearchDescriptor();search.SearchString='公式資料';found=document.findFirst(search);found.HyperLinkURL='https://example.com/guide';found.CharWeight=150.0
  print('NumberingStyles',document.StyleFamilies.getByName('NumberingStyles').getElementNames(),flush=True)
  rules=True
  paragraph('確認する項目',rules=rules);paragraph('入れ子の確認',rules=rules,level=1);paragraph('次の項目',rules=rules)
  paragraph('番号の再開を確認します。')
  paragraph('番号を再開した項目',rules=rules,start=7)
  paragraph('表と画像の概要','Heading 2')
  paragraph('結合表の内容')
  cursor=document.Text.createTextCursor();cursor.gotoEnd(False);table=document.createInstance('com.sun.star.text.TextTable');table.initialize(3,3);document.Text.insertTextContent(cursor,table,False)
  for cell,text in [('A1','結合した見出し'),('C1','判定'),('A2','複数段落のセル\n次の段落'),('B2','本文'),('C2','確認'),('B3','終端'),('C3','完了')]:table.getCellByName(cell).String=text
  cell=table.getCellByName('A2');cell.String='';cellCursor=cell.createTextCursor();cell.insertString(cellCursor,'複数段落のセル',False);cell.insertControlCharacter(cellCursor,uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'),False);cell.insertString(cellCursor,'次の段落',False)
  cursor=table.createCursorByCellName('A1');cursor.gotoCellByName('B1',True);cursor.mergeRange()
  cursor=table.createCursorByCellName('A2');cursor.gotoCellByName('A3',True);cursor.mergeRange()
  provider=context.ServiceManager.createInstanceWithContext('com.sun.star.graphic.GraphicProvider',context)
  picture=provider.queryGraphic((prop('URL',(repo/'tests/fixtures/office/images/quadrants.png').as_uri()),))
  cursor=document.Text.createTextCursor();cursor.gotoEnd(False)
  image=document.createInstance('com.sun.star.text.TextGraphicObject');image.Graphic=picture;image.Width=6000;image.Height=3000;image.Description='四分割の検証画像';image.AnchorType=uno.Enum('com.sun.star.text.TextContentAnchorType','AS_CHARACTER');document.Text.insertTextContent(cursor,image,False);document.Text.insertControlCharacter(cursor,uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'),False)
  paragraph('外部作成文書の最終段落。')
  writer=root/'external.docx';document.storeAsURL(writer.as_uri(),(prop('FilterName','Office Open XML Text'),prop('Overwrite',True)));document.storeToURL((root/'external-docx.pdf').as_uri(),(prop('FilterName','writer_pdf_Export'),));document.close(True)
  deck=desktop.loadComponentFromURL('private:factory/simpress','_blank',0,options);deck.DocumentProperties.Author='PRIVATE_OFFICE_AUTHOR_SENTINEL'
  pages=deck.getDrawPages();page=pages.getByIndex(0);page.Layout=20;page.Width=25400;page.Height=14288
  for i in range(page.Count-1,-1,-1):page.remove(page.getByIndex(i))
  def text(target,string,x,y,w,h):
   shape=deck.createInstance('com.sun.star.drawing.TextShape');target.add(shape);shape.Position=point(x,y);shape.Size=size(w,h);shape.String=string;shape.CharFontName='Noto Sans CJK JP';shape.CharFontNameAsian='Noto Sans CJK JP';shape.CharHeight=20;return shape
  master=page.getMasterPage()
  for i in range(master.Count-1,-1,-1):master.remove(master.getByIndex(i))
  text(master,'共通の受付案内',1000,12500,13000,800)
  text(page,'外部作成の受付改善資料',1000,700,18000,1500)
  group=deck.createInstance('com.sun.star.drawing.GroupShape');page.add(group)
  text(group,'受付',2000,4000,4000,1800);text(group,'確認',8500,4000,4000,1800)
  rectangle=deck.createInstance('com.sun.star.drawing.RectangleShape');page.add(rectangle);rectangle.Position=point(17000,4000);rectangle.Size=size(5000,2200);rectangle.FillColor=0x336699
  table=deck.createInstance('com.sun.star.drawing.TableShape');page.add(table);table.Position=point(2000,8000);table.Size=size(16000,3000)
  model=table.Model
  if model.Rows.Count<2:model.Rows.insertByIndex(model.Rows.Count,2-model.Rows.Count)
  if model.Columns.Count<2:model.Columns.insertByIndex(model.Columns.Count,2-model.Columns.Count)
  for c in range(model.Columns.Count):model.Columns.getByIndex(c).Width=8000
  for r in range(model.Rows.Count):model.Rows.getByIndex(r).Height=1500
  for r,row in enumerate([['項目','確認'],['受付','完了']]):
   for c,value in enumerate(row):model.getCellByPosition(c,r).String=value
  image=deck.createInstance('com.sun.star.drawing.GraphicObjectShape');page.add(image);image.Graphic=picture;image.Position=point(19000,8500);image.Size=size(4500,2769);crop=uno.createUnoStruct('com.sun.star.text.GraphicCrop');crop.Left=1270;image.GraphicCrop=crop;image.Description='左側を切り取った検証画像'
  powerpoint=root/'external.pptx';deck.storeAsURL(powerpoint.as_uri(),(prop('FilterName','Impress MS PowerPoint 2007 XML'),prop('Overwrite',True)));deck.storeToURL((root/'external-pptx.pdf').as_uri(),(prop('FilterName','impress_pdf_Export'),));deck.close(True)
  desktop.terminate();process.wait(timeout=15)
  result=dict(app=subprocess.check_output([os.environ['EDITOR_SOFFICE'],'--version'],text=True).strip(),os='Debian 13 amd64',font='Noto Sans CJK JP 2.004',authoring='New LibreOffice Writer/Impress documents through public UNO objects. No self-export input and no OOXML mutation.',license='Task-authored test fixtures, CC0-1.0',files=[dict(file=f.name,sha256=hashlib.sha256(f.read_bytes()).hexdigest())for f in root.glob('external.*')])
  (root/'provenance.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
 finally:
  if process.poll()is None:process.terminate();process.wait(timeout=15)
