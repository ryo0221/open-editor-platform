"""Load every exported PPTX with the fixed LibreOffice and export all pages as PDF."""
from pathlib import Path
import json, os, subprocess, sys, time, uuid
import uno

root = Path(sys.argv[1]).resolve()
soffice = os.environ.get('EDITOR_SOFFICE', '/workspace/.tools/office-deps/root/usr/lib/libreoffice/program/soffice')
def prop(name, value):
    p = uno.createUnoStruct('com.sun.star.beans.PropertyValue'); p.Name = name; p.Value = value
    return p
local = uno.getComponentContext()
resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
key = 'editor-pptx-' + uuid.uuid4().hex
results = []
with (root/'office-render.log').open('w') as log:
    process = subprocess.Popen([soffice, '-env:UserInstallation=file:///tmp/'+key, '--headless', '--norestore', '--nodefault', '--nofirststartwizard', '--accept=pipe,name='+key+';urp;StarOffice.ComponentContext'], stdout=log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic()+30
        while True:
            try:
                context = resolver.resolve('uno:pipe,name='+key+';urp;StarOffice.ComponentContext'); break
            except Exception:
                if process.poll() is not None or time.monotonic()>deadline: raise
                time.sleep(.1)
        desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
        options = (prop('Hidden', True), prop('MacroExecutionMode', uno.getConstantByName('com.sun.star.document.MacroExecMode.NEVER_EXECUTE')), prop('UpdateDocMode', uno.getConstantByName('com.sun.star.document.UpdateDocMode.NO_UPDATE')))
        for file in sorted(root.glob('*.pptx')):
            document = desktop.loadComponentFromURL(file.as_uri(), '_blank', 0, options)
            assert document, f'Office did not open {file}'
            pages = document.getDrawPages()
            description = []
            for i in range(pages.Count):
                page = pages.getByIndex(i)
                shapes = []
                for j in range(page.Count):
                    shape = page.getByIndex(j)
                    shapes.append(dict(type=shape.ShapeType,name=shape.Name,text=shape.String if hasattr(shape,'String') else None,x=shape.Position.X,y=shape.Position.Y,width=shape.Size.Width,height=shape.Size.Height))
                description.append(dict(index=i+1,width=page.Width,height=page.Height,shapes=shapes))
            document.storeToURL(file.with_suffix('.pdf').as_uri(), (prop('FilterName', 'impress_pdf_Export'), prop('Overwrite', True)))
            document.close(True)
            results.append(dict(file=file.name,pages=description))
        desktop.terminate()
        process.wait(timeout=15)
    finally:
        if process.poll() is None: process.terminate(); process.wait(timeout=15)
(root/'office-structure.json').write_text(json.dumps(results, ensure_ascii=False, indent=2)+'\n')
print(json.dumps(dict(result='passed',files=[dict(file=r['file'],pages=len(r['pages'])) for r in results])))
