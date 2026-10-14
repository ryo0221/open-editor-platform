"""Edit the product-generated PPTX through LibreOffice UNO, save, reopen and verify."""
from pathlib import Path
import hashlib,json,os,subprocess,sys,time,uuid,posixpath
from zipfile import ZipFile
from xml.etree import ElementTree as ET
import uno
source=Path(sys.argv[1]).resolve();root=Path(sys.argv[2]).resolve();root.mkdir(parents=True,exist_ok=True)
replacement=Path('tests/fixtures/office/images/quadrants.jpeg').resolve()
def prop(name,value):
 p=uno.createUnoStruct('com.sun.star.beans.PropertyValue');p.Name=name;p.Value=value;return p
def shape(document,target):
 page=document.getDrawPages().getByIndex(target[0]);return next(page.getByIndex(i) for i in range(page.Count) if page.getByIndex(i).Name==target[1])
def snapshot(document):
 result={}
 pages=document.getDrawPages()
 for p in range(pages.Count):
  page=pages.getByIndex(p)
  for n in range(page.Count):
   s=page.getByIndex(n);entry=dict(type=s.ShapeType,name=s.Name,text=s.String if hasattr(s,'String') else None,box=[s.Position.X,s.Position.Y,s.Size.Width,s.Size.Height])
   if s.ShapeType=='com.sun.star.drawing.TableShape':
    t=s.Model;entry['cells']=[[t.getCellByPosition(c,r).String for c in range(t.Columns.Count)] for r in range(t.Rows.Count)]
   if s.ShapeType=='com.sun.star.drawing.GraphicObjectShape':
    crop=s.GraphicCrop;entry['crop']=[crop.Left,crop.Top,crop.Right,crop.Bottom]
   result[f'{p}:{s.Name}']=entry
 return result
local=uno.getComponentContext();resolver=local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver',local)
key='editor-pptx-edit-'+uuid.uuid4().hex
with (root/'office-edit.log').open('w') as log:
 process=subprocess.Popen([os.environ['EDITOR_SOFFICE'],'-env:UserInstallation=file:///tmp/'+key,'--headless','--norestore','--nodefault','--nofirststartwizard','--accept=pipe,name='+key+';urp;StarOffice.ComponentContext'],stdout=log,stderr=subprocess.STDOUT)
 try:
  deadline=time.monotonic()+30
  while True:
   try:context=resolver.resolve('uno:pipe,name='+key+';urp;StarOffice.ComponentContext');break
   except Exception:
    if process.poll() is not None or time.monotonic()>deadline:raise
    time.sleep(.1)
  desktop=context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop',context)
  provider=context.ServiceManager.createInstanceWithContext('com.sun.star.graphic.GraphicProvider',context)
  options=(prop('Hidden',True),prop('MacroExecutionMode',uno.getConstantByName('com.sun.star.document.MacroExecMode.NEVER_EXECUTE')),prop('UpdateDocMode',uno.getConstantByName('com.sun.star.document.UpdateDocMode.NO_UPDATE')))
  document=desktop.loadComponentFromURL(source.as_uri(),'_blank',0,options);assert document
  before=snapshot(document)
  pageCount=document.getDrawPages().Count
  candidates=[]
  for p in range(pageCount):
   page=document.getDrawPages().getByIndex(p)
   candidates += [(p,page.getByIndex(i)) for i in range(page.Count)]
  def target(predicate):
   p,s=next((p,s) for p,s in candidates if predicate(s));return p,s.Name
  targets=dict(
   text=target(lambda s:hasattr(s,'String') and ('取り込み後' in s.String or '外部作成の受付改善資料' in s.String or '別案件' in s.String)),
   shape=target(lambda s:s.ShapeType in ['com.sun.star.drawing.CustomShape','com.sun.star.drawing.RectangleShape'] and (not hasattr(s,'String') or not s.String)),
   table=target(lambda s:s.ShapeType=='com.sun.star.drawing.TableShape'),
   image=target(lambda s:s.ShapeType=='com.sun.star.drawing.GraphicObjectShape'))
  shape(document,targets['text']).String='外部アプリで編集した日本語'
  s=shape(document,targets['shape']);position=s.Position;position.X+=265;s.Position=position
  shape(document,targets['table']).Model.getCellByPosition(1,1).String='外部で変更'
  picture=shape(document,targets['image'])
  provider.storeGraphic(picture.Graphic,(prop('URL',(root/'before-picture.png').as_uri()),prop('MimeType','image/png')))
  picture.Graphic=provider.queryGraphic((prop('URL',replacement.as_uri()),))
  provider.storeGraphic(picture.Graphic,(prop('URL',(root/'replacement-picture.png').as_uri()),prop('MimeType','image/png')))
  assert (root/'before-picture.png').read_bytes()!=(root/'replacement-picture.png').read_bytes()
  document.storeToURL((root/'replacement.pdf').as_uri(),(prop('FilterName','impress_pdf_Export'),prop('Overwrite',True)))
  edited=root/'edited.pptx';document.storeAsURL(edited.as_uri(),(prop('FilterName','Impress MS PowerPoint 2007 XML'),prop('Overwrite',True)));document.close(True)
  reopened=desktop.loadComponentFromURL(edited.as_uri(),'_blank',0,options);assert reopened
  after=snapshot(reopened);assert set(before)==set(after)
  changed={f'{p}:{name}' for p,name in targets.values()}
  for name,item in before.items():
   actual=after[name]
   assert actual['type']==item['type'],(name,'Lost native type',item,actual)
   if name in changed:continue
   assert actual['text']==item['text'] and actual.get('cells')==item.get('cells'),(name,'Untouched content changed',item,actual)
   assert all(abs(a-b)<=2 for a,b in zip(actual['box'],item['box'])),(name,'Untouched geometry changed',item,actual)
  assert shape(reopened,targets['text']).String=='外部アプリで編集した日本語'
  assert abs(shape(reopened,targets['shape']).Position.X-before[f"{targets['shape'][0]}:{targets['shape'][1]}"]['box'][0]-265)<=2
  assert shape(reopened,targets['table']).Model.getCellByPosition(1,1).String=='外部で変更'
  reopened.storeToURL((root/'edited.pdf').as_uri(),(prop('FilterName','impress_pdf_Export'),prop('Overwrite',True)))

  # Per-shape GraphicExportFilter/GraphicProvider are unreliable after reopen.
  # Verify exact replacement bytes, native crop/geometry, and the actual full-page
  # PDF rendering before/after save (audited by audit-import-edit.py).
  with ZipFile(edited) as archive:
   slidepart=f"ppt/slides/slide{targets['image'][0]+1}.xml"
   pns={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
   pictureNode=next(n for n in ET.fromstring(archive.read(slidepart)).findall('.//p:pic',pns) if n.find('p:nvPicPr/p:cNvPr',pns).get('name')==targets['image'][1])
   rid=pictureNode.find('p:blipFill/a:blip',pns).get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed')
   relations=ET.fromstring(archive.read(posixpath.dirname(slidepart)+'/_rels/'+posixpath.basename(slidepart)+'.rels'))
   target=next(n.get('Target') for n in relations if n.get('Id')==rid)
   asset=archive.read(posixpath.normpath(posixpath.join(posixpath.dirname(slidepart),target)))
   assert asset==replacement.read_bytes(),'Replacement asset bytes changed'
  imageKey=f"{targets['image'][0]}:{targets['image'][1]}"
  assert all(abs(a-b)<=2 for a,b in zip(before[imageKey]['box'],after[imageKey]['box'])),'Image placement changed'
  assert all(abs(a-b)<=2 for a,b in zip(before[imageKey]['crop'],after[imageKey]['crop'])),'Image crop changed'

  assert reopened.getDrawPages().Count==pageCount
  reopened.storeToURL((root/'edited.pdf').as_uri(),(prop('FilterName','impress_pdf_Export'),prop('Overwrite',True)));reopened.close(True)
  desktop.terminate();process.wait(timeout=15)
  result=dict(result='passed',app=subprocess.check_output([os.environ['EDITOR_SOFFICE'],'--version'],text=True).strip(),os='Debian 13 amd64',sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),targets=targets,before=before,after=after,operations=['XText.String Japanese replacement','native non-text shape move 2.65mm','native table cell replacement','XGraphic replacement via GraphicProvider','save PPTX','reopen and assert all edits and untouched native content/geometry','render all reopened pages to PDF'])
  (root/'edit-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ['before','after']},ensure_ascii=False))
 finally:
  if process.poll() is None:process.terminate();process.wait(timeout=15)
