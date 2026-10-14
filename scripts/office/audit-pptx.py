"""Independent XML/source checks plus all-page renders and bounded shape/image geometry checks."""
from pathlib import Path
import base64, collections, io, json, math, sys, zipfile
import xml.etree.ElementTree as ET
import fitz
from PIL import Image, ImageChops, ImageFilter, ImageStat

root = Path(sys.argv[1])
ns = {'p':'http://schemas.openxmlformats.org/presentationml/2006/main', 'a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
NATIVE = {'rectangle','rounded-rectangle','ellipse','triangle','diamond','line','arrow','double-arrow','arrow-right','arrow-left','arrow-up','arrow-down','arrow-both'}
results = []

def exact_text_lines(actual, original):
    # Only represented line boundaries are normalized. Spaces/tabs/punctuation are never stripped.
    source = original.split('\n')
    assert ''.join(actual) == ''.join(source), (actual, original)
    expected = collections.Counter(); at = 0
    for part in source[:-1]: at += len(part); expected[at] += 1
    observed = collections.Counter(); at = 0
    for part in actual[:-1]: at += len(part); observed[at] += 1
    assert all(observed[n] >= count for n,count in expected.items()), ('Hard line break missing', actual, original)

def texts(element):
    return [''.join(t.text or '' for t in p.findall('.//a:t',ns)) for p in element.findall('.//a:p',ns)]

def extent(obj):
    b=obj['bounds']; angle=math.radians(obj.get('rotation',0)); c=math.cos(angle); s=math.sin(angle)
    points=[(b['x']+b['width']/2+x*c-y*s,b['y']+b['height']/2+x*s+y*c) for x in [-b['width']/2,b['width']/2] for y in [-b['height']/2,b['height']/2]]
    return (math.floor(min(p[0] for p in points)-5),math.floor(min(p[1] for p in points)-5),math.ceil(max(p[0] for p in points)+5),math.ceil(max(p[1] for p in points)+5))

def image_frame(source, picture, raster):
    b=source['bounds']; x,y,w,h=b['x'],b['y'],b['width'],b['height']
    crop=dict(left=0,right=0,top=0,bottom=0)
    if not raster:
        image=Image.open(io.BytesIO(base64.b64decode(source['src'].split(',',1)[1])))
        c=source.get('crop',dict(x=0,y=0,scale=1)); vw,vh=w*c['scale'],h*c['scale']
        scale=(min if source.get('imageFit')=='fit' else max)(vw/image.width,vh/image.height)
        iw,ih=image.width*scale,image.height*scale
        ix,iy=x+c['x']+(vw-iw)/2,y+c['y']+(vh-ih)/2
        right,bottom=min(x+w,ix+iw),min(y+h,iy+ih); x,y=max(x,ix),max(y,iy)
        w,h=right-x,bottom-y
        crop=dict(left=(x-ix)/iw,right=(ix+iw-right)/iw,top=(y-iy)/ih,bottom=(iy+ih-bottom)/ih)
    cx,cy=b['x']+b['width']/2,b['y']+b['height']/2
    dx,dy=(x+w/2-cx)*(-1 if source.get('flipX') else 1),(y+h/2-cy)*(-1 if source.get('flipY') else 1)
    angle=math.radians(source.get('rotation',0)); x=cx+dx*math.cos(angle)-dy*math.sin(angle)-w/2; y=cy+dx*math.sin(angle)+dy*math.cos(angle)-h/2
    transform=picture.find('p:spPr/a:xfrm',ns); off=transform.find('a:off',ns); size=transform.find('a:ext',ns)
    for actual,expected in [(off.attrib['x'],x),(off.attrib['y'],y),(size.attrib['cx'],w),(size.attrib['cy'],h)]: assert abs(int(actual)/9525-expected)<1, ('Image frame differs by at least one CSS pixel',actual,expected)
    assert abs(int(transform.attrib.get('rot',0))/60000-source.get('rotation',0)%360)<.001
    assert (transform.attrib.get('flipH')=='1')==bool(source.get('flipX'))
    assert (transform.attrib.get('flipV')=='1')==bool(source.get('flipY'))
    rect=picture.find('p:blipFill/a:srcRect',ns); assert rect is not None
    for attr,key in [('l','left'),('r','right'),('t','top'),('b','bottom')]: assert abs(int(rect.attrib[attr])/100000-crop[key])<=.00001

for native_file in sorted(root.glob('*.native.json')):
    name=native_file.name.removesuffix('.native.json')
    content=json.loads(native_file.read_text()); report=json.loads((root/(name+'.report.json')).read_text())
    pages={p['id']:p for p in content['slides']}; selected=report['selectedPageIds']
    counts=collections.Counter('approximated' if e['representation']=='native-approximation' else 'rasterized' if e['representation']=='png' else e['representation'] for e in report['elements'] if e['counted'])
    assert {k:counts[k] for k in report['counts']}==report['counts']
    with zipfile.ZipFile(root/(name+'.pptx')) as archive:
        xml={p:ET.fromstring(archive.read(p)) for p in archive.namelist() if p.endswith(('.xml','.rels'))}
        for p in archive.namelist():
            assert 'vba' not in p.lower() and not p.startswith('ppt/fonts/')
            if p.endswith(('.xml','.rels')):
                value=archive.read(p).decode()
                assert 'PRIVATE_ARTIFACT_SENTINEL' not in value and 'PRIVATE_VERSION_SENTINEL' not in value
                assert 'TargetMode="External"' not in value
        presentation=xml['ppt/presentation.xml']; size=presentation.find('p:sldSz',ns)
        assert int(size.attrib['cx'])==round(content['width']*9525)
        assert int(size.attrib['cy'])==round(content['height']*9525)
        assert len(presentation.findall('p:sldIdLst/p:sldId',ns))==len(selected)
        part_objects={}
        for i in range(len(selected)):
            file=f'ppt/slides/slide{i+1}.xml'; page_xml=xml[file]
            ids=[n.attrib['id'] for n in page_xml.findall('.//p:cNvPr',ns)]
            assert len(ids)==len(set(ids)), 'Duplicate Office object IDs'
            for tag in ['sp','pic','graphicFrame']:
                for obj in page_xml.findall('.//p:'+tag,ns):
                    nv=obj.find('.//p:cNvPr',ns)
                    part_objects[file+'#'+nv.attrib['name']]=(tag,obj)
        mapped=[]
        for e in report['elements']:
            address=e['address']; page=pages[address['slideId']]
            source=next((o for o in page['objects'] if o['id']==address.get('elementId')),None)
            parts=[part_objects[p] for p in e['outputPartNames']]; mapped.extend(e['outputPartNames'])
            if e['counted'] and e['representation']!='omitted': assert parts, ('Missing mapping',address)
            if e['representation']=='png': assert len(parts)==1 and parts[0][0]=='pic'
            if source and source['type']=='image' and e['representation']!='omitted': image_frame(source,parts[0][1],e['representation']=='png')
            if e['representation'] in ['native','native-approximation'] and source:
                if source['type'] in ['text','shape']:
                    lines=[]
                    for p in e['outputPartNames']:
                        if '-text-' in p: lines.extend(texts(part_objects[p][1]))
                    if source.get('text') or source['type']=='text': exact_text_lines(lines,source['text'])
                if source['type']=='table':
                    table=parts[0][1].find('.//a:tbl',ns); assert table is not None
                    expected=source['table']['rows']; cols=max(map(len,expected))
                    rows=table.findall('a:tr',ns); assert len(rows)==len(expected)
                    for r,row in enumerate(rows):
                        cells=row.findall('a:tc',ns); assert len(cells)==cols
                        for c,cell in enumerate(cells): exact_text_lines(texts(cell),expected[r][c] if c<len(expected[r]) else '')
                    widths=source['table'].get('columnWidths',[source['bounds']['width']/cols]*cols)
                    heights=source['table'].get('rowHeights',[source['bounds']['height']/len(rows)]*len(rows))
                    assert all(abs(int(n.attrib['w'])-round(w*9525))<=1 for n,w in zip(table.findall('a:tblGrid/a:gridCol',ns),widths))
                    assert all(abs(int(n.attrib['h'])-round(h*9525))<=1 for n,h in zip(rows,heights))
                if source['type']=='image':
                    assert parts[0][0]=='pic'
                    original=base64.b64decode(source['src'].split(',',1)[1])
                    assert any(archive.read(p)==original for p in archive.namelist() if p.startswith('ppt/media/') and not p.endswith('/')), 'Original image binary lost'
            if address['slideId']=='G04' and source and source['type']=='shape':
                assert (e['representation']!='png') == (source['shape'] in NATIVE)
        assert len(mapped)==len(set(mapped)), 'Output mapped to two source elements'
        assert set(mapped)==set(part_objects), 'Unmapped rendered element'
    document=fitz.open(root/(name+'.pdf')); assert len(document)==len(selected)
    geometry=[]
    for i,page in enumerate(document):
        assert abs(page.rect.width*4/3-content['width'])<.1 and abs(page.rect.height*4/3-content['height'])<.1
        output=root/f'{name}-office-{i+1}.png'
        page.get_pixmap(matrix=fitz.Matrix(4/3,4/3),alpha=False).save(output)
        actual=Image.open(output).convert('RGB'); reference=Image.open(root/f'{name}-reference-{i+1}.png').convert('RGB')
        pair=Image.new('RGB',(reference.width*2,reference.height),'white');pair.paste(reference,(0,0));pair.paste(actual,(reference.width,0));pair.save(root/f'{name}-pair-{i+1}.png')
        # No broad page masks: each atlas contour has a hard one-pixel check. Image frames,
        # transforms and crops are checked above against source geometry; bitmap interpolation
        # (including lettering already inside the bitmap) is recorded separately below.
        source=pages[selected[i]]
        if source['id'] in ['G04','G06']:
            for obj in source['objects']:
                if obj['type'] not in ['shape','image']: continue
                bounds=extent(obj)
                def mask(image):
                    crop=image.crop(bounds)
                    return ImageChops.darker(ImageChops.darker(*crop.split()[:2]),crop.split()[2]).point(lambda p:255 if p<225 else 0)
                a,b=mask(reference),mask(actual)
                am=ImageChops.subtract(a,b.filter(ImageFilter.MaxFilter(3)))
                bm=ImageChops.subtract(b,a.filter(ImageFilter.MaxFilter(3)))
                unmatched=sum(am.histogram()[1:])+sum(bm.histogram()[1:])
                geometry.append(dict(id=obj['id'],outsideOnePixel=unmatched,meanAbsoluteRGB=ImageStat.Stat(ImageChops.difference(reference.crop(bounds),actual.crop(bounds))).mean))
                if obj['type']=='shape': assert unmatched==0, (name,source['id'],obj['id'],'geometry differs beyond one pixel',unmatched)
        if source['id']=='G03':
            spans=[s for b in page.get_text('dict')['blocks'] for l in b.get('lines',[]) for s in l['spans']]
            for value,y in [('行間と文字間隔',132),('二行目の表示',175.2),('三行目の表示',218.4)]:
                span=next(s for s in spans if s['text']==value)
                assert abs(span['origin'][0]*4/3-353)<1 and abs(span['origin'][1]*4/3-y)<1, ('Text baseline shifted',span)
    results.append(dict(name=name,pages=len(selected),counts=report['counts'],geometry=geometry,result='passed'))
(root/'audit.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(results,ensure_ascii=False))
