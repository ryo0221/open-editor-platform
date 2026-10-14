"""Independent XML/native structure, original-text, page and all-page render audit.

Flow rewrapping is allowed; OOXML explicit whitespace is compared exactly. PDF text
is only a continuity aid. Retained PNGs require visual inspection for Japanese glyphs.
"""
from pathlib import Path
import json, re, sys, zipfile, hashlib
import xml.etree.ElementTree as ET
import fitz

root=Path(sys.argv[1]); ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main','pic':'http://schemas.openxmlformats.org/drawingml/2006/picture','wp':'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'}
w='{'+ns['w']+'}'
def text(p):
    result=''
    for e in p.iter():
        if e.tag==w+'t': result+=e.text or ''
        elif e.tag==w+'tab': result+='\t'
        elif e.tag in (w+'cr',w+'br'): result+='\n'
    return result
def rich(spans): return ''.join(s['text'] for s in spans).replace('\r\n','\n').replace('\r','\n')
def part_index(part,kind): return int(part.split('#'+kind+':',1)[1])-1
results=[]
office={d['file']:d for d in json.loads((root/'office-structure.json').read_text())}
files=sorted(root.glob('*.docx')); assert files
for file in files:
    base=file.with_suffix(''); source=json.loads(base.with_suffix('.native.json').read_text()); report=json.loads(base.with_suffix('.report.json').read_text())
    z=zipfile.ZipFile(file); names=z.namelist(); xml=ET.fromstring(z.read('word/document.xml'))
    for path in names:
        assert not re.search(r'vba|oleObject|altChunk|embeddings|attachedTemplate',path,re.I),path
        if path.endswith(('.xml','.rels')):
            raw=z.read(path).decode('utf8'); assert 'PRIVATE_' not in raw
            assert 'COVERED_' not in raw and 'STALE_RICH_TEXT' not in raw
            if path.endswith('.rels'):
                for rel in ET.fromstring(raw):
                    if rel.get('TargetMode')=='External':
                        assert rel.get('Type').endswith('/hyperlink')
                        assert re.match(r'^(https?://|mailto:)',rel.get('Target',''),re.I)
    paragraphs=xml.findall('.//w:body//w:p',ns); tables=xml.findall('.//w:tbl',ns); pictures=xml.findall('.//pic:pic',ns)
    assert len(office[file.name]['tables'])==len(tables), 'Office merged or lost a native table'
    assert len(office[file.name]['pictures'])==len(pictures), 'Office lost a native picture'
    drawing_ids=[e.get('id') for e in xml.findall('.//wp:docPr',ns)]
    assert len(drawing_ids)==len(set(drawing_ids)), 'Duplicate drawing identifiers'
    assert not xml.findall('.//w:trHeight',ns), 'No fixed row heights'
    assert len(report['blocks'])==len(source['blocks'])
    details=report['details']; byid={b['id']:b for b in source['blocks']}
    expected_strings=[]
    def items(block):
        result={}
        def visit(items):
            for i in items:
                result[i['id']]=i
                lists=i.get('childLists')
                if lists is None: lists=[dict(items=i.get('children',[]))]
                for child in lists: visit(child['items'])
        visit(block.get('items',[])); return result
    covered_ids=set()
    for detail in details:
        addr=detail['address']; block=byid[addr['blockId']]
        assert len(detail['outputPartNames'])==1,detail
        part=detail['outputPartNames'][0]
        if detail['kind']=='paragraph':
            index=part_index(part,'p'); assert index not in covered_ids; covered_ids.add(index)
            p=paragraphs[index]; actual=text(p)
            if 'cell' in addr:
                r,c=addr['cell']['row'],addr['cell']['column']
                values=block.get('cellParagraphs',[])
                parts=values[r][c] if r<len(values) and c<len(values[r]) else None
                if parts is not None: expected=rich(parts[addr['paragraph']]['rich'])
                else:
                    values=block.get('cellRich',[])
                    spans=values[r][c] if r<len(values) and c<len(values[r]) else None
                    expected=rich(spans) if spans is not None else block['cells'][r][c]
            elif 'itemId' in addr:
                item=items(block).get(addr['itemId'])
                expected=rich(item['rich']) if item else block['text'].split('\n')[int(addr['itemId'].rsplit(':',1)[1])]
                if actual.startswith(('[x] ','[ ] ')):
                    if item: assert actual.startswith('[x] ' if item.get('checked',False) else '[ ] ')
                    actual=actual[4:]
            elif addr.get('path')=='caption': expected=block['caption']
            elif addr.get('path')=='language': expected=block.get('language') if block['type']=='code' else block['type']
            else: expected=rich(block['rich']) if 'rich' in block and block['type'] in ('paragraph','heading') else block['text'].replace('\r\n','\n').replace('\r','\n')
            assert actual==expected,(file.name,addr,actual,expected)
            expected_strings.append(expected)
            if block['type']=='heading': assert p.find('w:pPr/w:pStyle',ns).get(w+'val')=='Heading'+str(block.get('level',1))
        elif detail['kind']=='image':
            # Word's alt text belongs to the containing drawing's docPr, not cNvPr.
            pic=xml.findall('.//wp:docPr',ns)[part_index(part,'image')]
            assert pic.get('descr')==block.get('alt','Mermaid diagram' if block['type']=='mermaid' else '')
        else:
            match=re.search(r'#table:(\d+)/row:(\d+)/cell:(\d+)$',part); assert match
            t,r,c=map(int,match.groups()); assert tables[t-1].findall('w:tr',ns)[r-1].findall('w:tc',ns)[c-1] is not None
    for i,p in enumerate(paragraphs):
        assert not text(p) or i in covered_ids, ('Unmapped text paragraph',i,text(p))
    for b in report['blocks']: assert b['outputPartNames'],b
    page=source.get('page',dict(size='A4',margin=64)); size={'A4':(11906,16838),'Letter':(12240,15840)}[page['size']]
    if page.get('landscape'): size=size[::-1]
    props=xml.find('.//w:sectPr',ns); pg=props.find('w:pgSz',ns)
    assert (int(pg.get(w+'w')),int(pg.get(w+'h')))==size
    assert int(props.find('w:pgMar',ns).get(w+'top'))==round(page['margin']*15)
    pdf=fitz.open(file.with_suffix('.pdf'))
    header_texts=[]
    for table in tables:
        headers=[]
        for row in table.findall('w:tr',ns):
            flag=row.find('w:trPr/w:tblHeader',ns)
            if flag is None or flag.get(w+'val') in ('false','0'): break
            headers.append(re.sub(r'\s','',text(row)))
        if headers: header_texts.append(''.join(headers))
    compact=''; seen_headers=set()
    for i,p in enumerate(pdf):
        body=re.sub(r'\s','',p.get_text())
        # A continued row can span pages with an explicit repeated table header
        # between its two halves. Remove only that known prefix on later pages.
        if i:
            for header in header_texts:
                if header in seen_headers and body.startswith(header): body=body[len(header):]; break
        for header in header_texts:
            if header in body: seen_headers.add(header)
        compact+=body
    # Check content in the render after layout-inserted line breaks. Exact spaces above.
    missing=[s for s in expected_strings if re.sub(r'\s','',s) not in compact]
    assert not missing,(file.name,'Rendered text missing',missing[:4])
    pages=[]
    for i,p in enumerate(pdf):
        assert abs(p.rect.width-size[0]/20)<1 and abs(p.rect.height-size[1]/20)<1
        assert p.get_text().strip() or p.get_images(), 'Unexpected blank page'
        pix=p.get_pixmap(matrix=fitz.Matrix(1.2,1.2),alpha=False)
        name=f'{file.stem}-page-{i+1}.png'; pix.save(root/name)
        pages.append(dict(page=i+1,image=name,width=p.rect.width,height=p.rect.height,text=p.get_text(),sha256=hashlib.sha256((root/name).read_bytes()).hexdigest()))
    if file.stem=='long-table': assert len(pdf)>=3
    results.append(dict(file=file.name,result='passed',paragraphs=len(paragraphs),tables=len(tables),pictures=len(pictures),pages=pages))
(root/'audit.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(result='passed',files=[dict(file=r['file'],pages=len(r['pages'])) for r in results])))
