"""Inspect every actual LibreOffice PDF page, including adopted colors and image pixels."""
from pathlib import Path
import json, sys
import fitz
from PIL import Image, ImageChops, ImageStat

root = Path(sys.argv[1])
results = []
for domain in ['document', 'slide']:
    directory = root / domain
    pictures = {}
    for name in ['pinned', 'adopted', 'replacement', 'edited']:
        document = fitz.open(directory / (name + '.pdf'))
        assert len(document) == 1, ('Unexpected page count', domain, name, len(document))
        page = document[0]
        spans = [s for block in page.get_text('dict')['blocks'] if 'lines' in block
                 for line in block['lines'] for s in line['spans']]
        text = ''.join(s['text'] for s in spans)
        compact = ''.join(text.split())  # PDF extraction inserts spaces at CJK/Latin font boundaries.
        assert '採用済みブランドのご案内' in text, ('Missing rendered Japanese title', domain, name, text)
        assert ('案件Aの本文を保持します。' if name in ['pinned', 'adopted']
                else '外部Officeで編集した案件Aの本文です。') in compact
        target_color = 0x336699 if name == 'pinned' else 0x99331a
        titles = [s for s in spans if '採用済みブランド' in s['text']]
        assert titles and all(s['color'] == target_color for s in titles), ('Rendered brand color differs', titles)
        images = page.get_image_info()
        assert len(images) == 1, ('Missing or duplicated rendered image', domain, name, images)
        box = fitz.Rect(images[0]['bbox'])
        image = page.get_pixmap(matrix=fitz.Matrix(4/3, 4/3), clip=box, alpha=False)
        image.save(directory / (name + '-picture.png'))
        pixels = Image.open(directory / (name + '-picture.png')).convert('RGB')
        assert max(ImageStat.Stat(pixels).stddev) > 20, ('Blank picture', domain, name)
        pictures[name] = (tuple(box), pixels)
        page.get_pixmap(matrix=fitz.Matrix(4/3, 4/3), alpha=False).save(directory / (name + '-1.png'))
        results.append(dict(domain=domain, file=name, pages=1, text=text,
                            titleColors=[s['color'] for s in titles], pictureBox=tuple(box)))
    before_box, before = pictures['replacement']
    after_box, after = pictures['edited']
    assert all(abs(a-b) < .05 for a,b in zip(before_box, after_box))
    assert before.size == after.size
    mean = ImageStat.Stat(ImageChops.difference(before, after)).mean
    assert max(mean) < 3, ('Picture changed after Office reopen', domain, mean)
    results.append(dict(domain=domain, check='full picture pixels before/after Office reopen', meanAbsoluteRGB=mean))
(root / 'render-audit.json').write_text(json.dumps(dict(result='passed', files=results), ensure_ascii=False, indent=2) + '\n')
print(json.dumps(dict(result='passed', pages=8, pictureReopenComparisons=2)))
