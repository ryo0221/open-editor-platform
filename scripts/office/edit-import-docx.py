"""Edit independently imported DOCX through stable LibreOffice Writer UNO, save and reopen.

No OOXML mutation: paragraphs, list, native table rows/cells and image use the
application's public document model. Retain all untouched paragraphs and cells.
"""
from pathlib import Path
import hashlib, json, os, subprocess, sys, time, uuid
import uno

source=Path(sys.argv[1]).resolve(); root=Path(sys.argv[2]).resolve(); root.mkdir(parents=True,exist_ok=True)
def prop(name,value):
    p=uno.createUnoStruct('com.sun.star.beans.PropertyValue'); p.Name=name; p.Value=value; return p
def paragraphs(document):
    result=[]; enumeration=document.Text.createEnumeration()
    while enumeration.hasMoreElements():
        item=enumeration.nextElement()
        if item.supportsService('com.sun.star.text.Paragraph'): result.append(item)
    return result
def snapshot(document):
    return dict(paragraphs=[dict(text=p.String,style=p.ParaStyleName,level=p.NumberingLevel,label=p.ListLabelString) for p in paragraphs(document)],
        tables=[dict(name=name,cells={c:document.TextTables.getByName(name).getCellByName(c).String for c in document.TextTables.getByName(name).getCellNames()}) for name in document.TextTables.ElementNames],
        pictures=[dict(name=name,width=document.GraphicObjects.getByName(name).Width,height=document.GraphicObjects.getByName(name).Height,description=document.GraphicObjects.getByName(name).Description) for name in document.GraphicObjects.ElementNames])
local=uno.getComponentContext(); resolver=local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver',local)
key='editor-docx-edit-'+uuid.uuid4().hex
with (root/'office-edit.log').open('w') as log:
    process=subprocess.Popen([os.environ['EDITOR_SOFFICE'],'-env:UserInstallation=file:///tmp/'+key,'--headless','--norestore','--nodefault','--nofirststartwizard','--accept=pipe,name='+key+';urp;StarOffice.ComponentContext'],stdout=log,stderr=subprocess.STDOUT)
    try:
        deadline=time.monotonic()+30
        while True:
            try: context=resolver.resolve('uno:pipe,name='+key+';urp;StarOffice.ComponentContext'); break
            except Exception:
                if process.poll() is not None or time.monotonic()>deadline: raise
                time.sleep(.1)
        desktop=context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop',context)
        provider=context.ServiceManager.createInstanceWithContext('com.sun.star.graphic.GraphicProvider',context)
        options=(prop('Hidden',True),prop('MacroExecutionMode',uno.getConstantByName('com.sun.star.document.MacroExecMode.NEVER_EXECUTE')),prop('UpdateDocMode',uno.getConstantByName('com.sun.star.document.UpdateDocMode.NO_UPDATE')))
        document=desktop.loadComponentFromURL(source.as_uri(),'_blank',0,options); assert document
        before=snapshot(document)
        ps=paragraphs(document)
        heading=next(i for i,p in enumerate(ps) if p.String in ('外部作成の受付改善提案書','取り込み後に編集した日本語の提案書','別案件の提案','別案件の共同提案'))
        body=next(i for i,p in enumerate(ps) if p.String.startswith('来訪者と担当者が'))
        listing=next(i for i,p in enumerate(ps) if p.String=='番号を再開した項目')
        ps[heading].ParaStyleName='Heading 2'
        ps[body].String='外部アプリで本文を編集し、内容を再確認しました。'
        ps[listing].String='外部アプリで更新した番号7の項目'
        table=document.TextTables.getByIndex(0); row_count=table.Rows.Count
        table.Rows.insertByIndex(row_count,1)
        table.getCellByName('A'+str(row_count+1)).String='追加した行'
        table.getCellByName('B'+str(row_count+1)).String='外部アプリで追加した内容'
        merged=document.TextTables.getByIndex(0); merged.getCellByName('A1').String='外部アプリで結合セルを編集'
        picture=document.GraphicObjects.getByIndex(0)
        provider.storeGraphic(picture.Graphic,(prop('URL',(root/'before-picture.png').as_uri()),prop('MimeType','image/png')))
        picture.Graphic=provider.queryGraphic((prop('URL',Path('tests/fixtures/office/images/quadrants.jpeg').resolve().as_uri()),))
        provider.storeGraphic(picture.Graphic,(prop('URL',(root/'replacement-picture.png').as_uri()),prop('MimeType','image/png')))
        assert (root/'before-picture.png').read_bytes()!=(root/'replacement-picture.png').read_bytes()
        edited=root/'edited.docx'; document.storeAsURL(edited.as_uri(),(prop('FilterName','Office Open XML Text'),prop('Overwrite',True))); document.close(True)
        reopened=desktop.loadComponentFromURL(edited.as_uri(),'_blank',0,options); assert reopened
        after=snapshot(reopened)
        assert len(before['paragraphs'])==len(after['paragraphs'])
        for i,p in enumerate(before['paragraphs']):
            actual=after['paragraphs'][i]
            if i not in (heading,body,listing): assert p==actual,('Untouched paragraph changed',i,p,actual)
        assert after['paragraphs'][heading]['style']=='Heading 2'
        assert after['paragraphs'][heading]['text']==before['paragraphs'][heading]['text']
        assert after['paragraphs'][body]['text']=='外部アプリで本文を編集し、内容を再確認しました。'
        assert after['paragraphs'][listing]['text']=='外部アプリで更新した番号7の項目'
        assert after['paragraphs'][listing]['label']==before['paragraphs'][listing]['label']
        assert after['paragraphs'][listing]['level']==before['paragraphs'][listing]['level']
        assert len(before['tables'])==len(after['tables'])
        for i,t in enumerate(before['tables']):
            for cell,value in t['cells'].items():
                if i==0 and cell=='A1': continue
                assert after['tables'][i]['cells'][cell]==value,('Untouched table cell changed',i,cell)
        assert after['tables'][0]['cells']['A'+str(row_count+1)]=='追加した行'
        assert after['tables'][0]['cells']['B'+str(row_count+1)]=='外部アプリで追加した内容'
        assert after['tables'][0]['cells']['A1']=='外部アプリで結合セルを編集'
        assert set(before['tables'][0]['cells']) | {'A'+str(row_count+1),'B'+str(row_count+1),'C'+str(row_count+1)} == set(after['tables'][0]['cells']), 'Merged table topology changed'
        assert after['paragraphs'][listing]['label']=='7.'
        assert before['pictures']==after['pictures'],'Untouched image layout or alt text changed'
        provider.storeGraphic(reopened.GraphicObjects.getByIndex(0).Graphic,(prop('URL',(root/'reopened-picture.png').as_uri()),prop('MimeType','image/png')))
        assert (root/'reopened-picture.png').read_bytes()==(root/'replacement-picture.png').read_bytes()
        reopened.storeToURL((root/'edited.pdf').as_uri(),(prop('FilterName','writer_pdf_Export'),prop('Overwrite',True))); reopened.close(True)
        desktop.terminate(); process.wait(timeout=15)
        result=dict(result='passed',app=subprocess.check_output([os.environ['EDITOR_SOFFICE'],'--version'],text=True).strip(),os='Debian 13 amd64',sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),before=before,after=after,operations=['XText.String body replacement','Heading 1 to Heading 2 using ParaStyleName','numbered list item replacement, preserving label and level','native table row insertion','rectangular merged cell replacement','XGraphic replacement using GraphicProvider','save DOCX, reopen and assert edits and all untouched paragraphs/cells/image layout','render every reopened page'])
        (root/'edit-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps({k:v for k,v in result.items() if k not in ('before','after')},ensure_ascii=False))
    finally:
        if process.poll() is None: process.terminate(); process.wait(timeout=15)
