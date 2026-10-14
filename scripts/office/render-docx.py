"""Open every DOCX in a corpus with fixed LibreOffice Writer and render all pages."""
from pathlib import Path
import json, os, subprocess, sys, time, uuid
import uno

root = Path(sys.argv[1]).resolve()
soffice = os.environ['EDITOR_SOFFICE']
def prop(name, value):
    p = uno.createUnoStruct('com.sun.star.beans.PropertyValue'); p.Name=name; p.Value=value
    return p
local = uno.getComponentContext()
resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver',local)
key = 'editor-docx-' + uuid.uuid4().hex
results = []
files = sorted(root.glob('*.docx')); assert files, 'No DOCX files'
with (root/'office-render.log').open('w') as log:
    process = subprocess.Popen([soffice,'-env:UserInstallation=file:///tmp/'+key,'--headless','--norestore','--nodefault','--nofirststartwizard','--accept=pipe,name='+key+';urp;StarOffice.ComponentContext'],stdout=log,stderr=subprocess.STDOUT)
    try:
        deadline=time.monotonic()+30
        while True:
            try:
                context=resolver.resolve('uno:pipe,name='+key+';urp;StarOffice.ComponentContext'); break
            except Exception:
                if process.poll() is not None or time.monotonic()>deadline: raise
                time.sleep(.1)
        desktop=context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop',context)
        options=(prop('Hidden',True),prop('MacroExecutionMode',uno.getConstantByName('com.sun.star.document.MacroExecMode.NEVER_EXECUTE')),prop('UpdateDocMode',uno.getConstantByName('com.sun.star.document.UpdateDocMode.NO_UPDATE')))
        for file in files:
            document=desktop.loadComponentFromURL(file.as_uri(),'_blank',0,options)
            assert document and document.supportsService('com.sun.star.text.TextDocument')
            paragraphs=[]; enumeration=document.Text.createEnumeration()
            while enumeration.hasMoreElements():
                item=enumeration.nextElement()
                if item.supportsService('com.sun.star.text.Paragraph'):
                    paragraphs.append(dict(text=item.String,style=item.ParaStyleName,numberingLevel=item.NumberingLevel,listLabel=item.ListLabelString if hasattr(item,'ListLabelString') else None))
            tables=[]
            for name in document.TextTables.ElementNames:
                table=document.TextTables.getByName(name)
                tables.append(dict(name=name, cells=[dict(name=c,text=table.getCellByName(c).String) for c in table.getCellNames()]))
            pictures=[]
            for name in document.GraphicObjects.ElementNames:
                pic=document.GraphicObjects.getByName(name)
                pictures.append(dict(name=name,title=pic.Title,description=pic.Description,width=pic.Width,height=pic.Height))
            document.storeToURL(file.with_suffix('.pdf').as_uri(),(prop('FilterName','writer_pdf_Export'),prop('Overwrite',True)))
            cursor=document.CurrentController.ViewCursor; cursor.jumpToLastPage()
            results.append(dict(file=file.name,pages=cursor.Page,paragraphs=paragraphs,tables=tables,pictures=pictures))
            document.close(True)
        desktop.terminate(); process.wait(timeout=15)
    finally:
        if process.poll() is None: process.terminate(); process.wait(timeout=15)
(root/'office-structure.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(result='passed',files=[dict(file=r['file'],pages=r['pages']) for r in results])))
