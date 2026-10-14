"""R15: open, inspect, render, edit and reopen V2.2 adopted/pinned Office files.

Runs against the fixed LibreOffice application through UNO; does not rewrite XML.
"""
from pathlib import Path
import hashlib, json, os, subprocess, sys, time, uuid
import uno

root = Path(sys.argv[1]).resolve()
replacement = Path('tests/fixtures/office/images/quadrants.jpeg').resolve()
body_text = '案件Aの本文を保持します。'
title_text = '採用済みブランドのご案内'
edited_text = '外部Officeで編集した案件Aの本文です。'

def prop(name, value):
    p = uno.createUnoStruct('com.sun.star.beans.PropertyValue')
    p.Name, p.Value = name, value
    return p

def paragraphs(document):
    result = []
    enumeration = document.Text.createEnumeration()
    while enumeration.hasMoreElements():
        item = enumeration.nextElement()
        if item.supportsService('com.sun.star.text.Paragraph'):
            result.append(item)
    return result

def shape_list(document):
    result = []
    pages = document.getDrawPages()
    for p in range(pages.Count):
        page = pages.getByIndex(p)
        for i in range(page.Count):
            result.append((p, page.getByIndex(i)))
    return result

def text_colors(element):
    # Paragraph CharColor describes its default, which need not match its text runs.
    # Read each actual non-empty text portion, recursively for Impress paragraphs.
    colors = set()
    def visit(item):
        if hasattr(item, 'TextPortionType'):
            if item.TextPortionType == 'Text' and item.String:
                colors.add(item.CharColor)
        elif hasattr(item, 'createEnumeration'):
            enumeration = item.createEnumeration()
            while enumeration.hasMoreElements():
                visit(enumeration.nextElement())
    visit(element)
    return sorted(colors)

def capture(document, domain):
    if domain == 'document':
        return dict(
            text=[dict(text=p.String, style=p.ParaStyleName, colors=text_colors(p)) for p in paragraphs(document)],
            pictures=[dict(name=n, width=document.GraphicObjects.getByName(n).Width,
                           height=document.GraphicObjects.getByName(n).Height,
                           description=document.GraphicObjects.getByName(n).Description)
                      for n in document.GraphicObjects.ElementNames],
            tables=document.TextTables.Count,
        )
    return dict(
        text=[dict(page=p, name=s.Name, text=s.String, colors=text_colors(s),
                   box=[s.Position.X, s.Position.Y, s.Size.Width, s.Size.Height])
              for p, s in shape_list(document) if hasattr(s, 'String') and s.String],
        pictures=[dict(page=p, name=s.Name,
                       box=[s.Position.X, s.Position.Y, s.Size.Width, s.Size.Height])
                  for p, s in shape_list(document) if s.ShapeType == 'com.sun.star.drawing.GraphicObjectShape'],
        pages=document.getDrawPages().Count,
        notes=[[s.String for s in [document.getDrawPages().getByIndex(p).getNotesPage().getByIndex(i)
                  for i in range(document.getDrawPages().getByIndex(p).getNotesPage().Count)]
                if hasattr(s, 'String') and s.String]
               for p in range(document.getDrawPages().Count)],
    )

local = uno.getComponentContext()
resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
key = 'editor-linked-' + uuid.uuid4().hex
results = []
document = reopened = None
with (root / 'office-linked.log').open('w') as log:
    process = subprocess.Popen([os.environ['EDITOR_SOFFICE'], '-env:UserInstallation=file:///tmp/' + key,
        '--headless', '--norestore', '--nodefault', '--nofirststartwizard',
        '--accept=pipe,name=' + key + ';urp;StarOffice.ComponentContext'], stdout=log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 30
        while True:
            try:
                context = resolver.resolve('uno:pipe,name=' + key + ';urp;StarOffice.ComponentContext')
                break
            except Exception:
                if process.poll() is not None or time.monotonic() > deadline:
                    raise
                time.sleep(.1)
        desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
        provider = context.ServiceManager.createInstanceWithContext('com.sun.star.graphic.GraphicProvider', context)
        options = (prop('Hidden', True),
            prop('MacroExecutionMode', uno.getConstantByName('com.sun.star.document.MacroExecMode.NEVER_EXECUTE')),
            prop('UpdateDocMode', uno.getConstantByName('com.sun.star.document.UpdateDocMode.NO_UPDATE')))
        for domain, ext, export_filter, pdf_filter in [
            ('document', 'docx', 'Office Open XML Text', 'writer_pdf_Export'),
            ('slide', 'pptx', 'Impress MS PowerPoint 2007 XML', 'impress_pdf_Export')]:
            for version, color in [('pinned', 0x336699), ('adopted', 0x99331a)]:
                source = root / domain / (version + '.' + ext)
                document = desktop.loadComponentFromURL(source.as_uri(), '_blank', 0, options)
                assert document, ('Could not open', source)
                before = capture(document, domain)
                targets = [p for p in before['text'] if p['text'] in (body_text, title_text)]
                assert len(targets) == 2, ('Missing native text', source, before)
                assert all(p['colors'] == [color] for p in targets), ('Adopted color differs', source, targets)
                assert len(before['pictures']) == 1, ('Missing native image', source, before)
                if domain == 'slide':
                    assert before['pages'] == 1
                    assert any('発表者ノート' in text for page in before['notes'] for text in page)
                document.storeToURL(source.with_suffix('.pdf').as_uri(), (prop('FilterName', pdf_filter), prop('Overwrite', True)))
                if version == 'pinned':
                    document.close(True)
                    results.append(dict(domain=domain, version=version, before=before, result='passed'))
                    continue
                if domain == 'document':
                    next(p for p in paragraphs(document) if p.String == body_text).String = edited_text
                    picture = document.GraphicObjects.getByIndex(0)
                else:
                    next(s for _, s in shape_list(document) if hasattr(s, 'String') and s.String == body_text).String = edited_text
                    picture = next(s for _, s in shape_list(document) if s.ShapeType == 'com.sun.star.drawing.GraphicObjectShape')
                picture.Graphic = provider.queryGraphic((prop('URL', replacement.as_uri()),))
                # Compare actual rendered pictures immediately before and after Office save/reopen.
                document.storeToURL((source.parent / 'replacement.pdf').as_uri(), (prop('FilterName', pdf_filter), prop('Overwrite', True)))
                edited = source.parent / ('edited.' + ext)
                document.storeAsURL(edited.as_uri(), (prop('FilterName', export_filter), prop('Overwrite', True)))
                document.close(True)
                reopened = desktop.loadComponentFromURL(edited.as_uri(), '_blank', 0, options)
                assert reopened
                after = capture(reopened, domain)
                assert len(after['text']) == len(before['text'])
                assert next(p for p in after['text'] if p['text'] == edited_text)
                for old in before['text']:
                    if old['text'] == body_text:
                        continue
                    actual = next(p for p in after['text'] if p['text'] == old['text'])
                    assert {k:v for k,v in actual.items() if k != 'box'} == {k:v for k,v in old.items() if k != 'box'}, ('Untouched text or style changed', old, actual)
                    if 'box' in old:
                        # The V2.1 Office round-trip tolerance is 2 hundredths of a mm.
                        assert all(abs(a-b) <= 2 for a,b in zip(old['box'], actual['box'])), ('Untouched geometry changed', old, actual)
                assert len(before['pictures']) == len(after['pictures'])
                for old, actual in zip(before['pictures'], after['pictures']):
                    assert {k:v for k,v in actual.items() if k != 'box'} == {k:v for k,v in old.items() if k != 'box'}
                    if 'box' in old:
                        assert all(abs(a-b) <= 2 for a,b in zip(old['box'], actual['box'])), ('Image placement changed', old, actual)
                if domain == 'slide':
                    assert before['notes'] == after['notes'] and before['pages'] == after['pages']
                else:
                    assert before['tables'] == after['tables']
                reopened.storeToURL((source.parent / 'edited.pdf').as_uri(), (prop('FilterName', pdf_filter), prop('Overwrite', True)))
                reopened.close(True)
                results.append(dict(domain=domain, version=version, result='passed', before=before, after=after,
                    sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                    operations=['replace native Japanese text', 'replace native image through GraphicProvider',
                        'save and reopen Office file', 'assert untouched text/style/placement/notes', 'render all pages']))
        desktop.terminate()
        process.wait(timeout=15)
    finally:
        for component in [reopened, document]:
            if component:
                try:
                    component.close(True)
                except Exception:
                    pass
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=15)
(root / 'office-linked-results.json').write_text(json.dumps(dict(
    result='passed', app=subprocess.check_output([os.environ['EDITOR_SOFFICE'], '--version'], text=True).strip(),
    files=results), ensure_ascii=False, indent=2) + '\n')
print(json.dumps(dict(result='passed', files=len(results))))
