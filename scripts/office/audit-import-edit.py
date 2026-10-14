"""Audit actual Office PDF picture pixels before save and after reopen, with fixed geometry."""
import json,sys
from pathlib import Path
import fitz
from PIL import Image, ImageChops, ImageStat
root=Path(sys.argv[1]); result=json.loads((root/'edit-result.json').read_text())
page,name=result['targets']['image'];key=f'{page}:{name}'
x,y,w,h=result['after'][key]['box'];scale=96/2540
# The actual picture box, not a broad page mask. Both PDFs use the same DPI.
box=(round(x*scale),round(y*scale),round((x+w)*scale),round((y+h)*scale))
images=[]
for kind in ['replacement','edited']:
 document=fitz.open(root/(kind+'.pdf')); assert len(document)>page
 for i,p in enumerate(document):
  path=root/f'{kind}-{i+1}.png';p.get_pixmap(matrix=fitz.Matrix(4/3,4/3),alpha=False).save(path)
 image=Image.open(root/f'{kind}-{page+1}.png').convert('RGB').crop(box)
 image.save(root/(kind+'-picture-region.png'));images.append(image)
assert images[0].size==images[1].size
assert max(ImageStat.Stat(images[1]).stddev)>20,'Reopened picture is blank'
difference=ImageChops.difference(*images);mean=ImageStat.Stat(difference).mean
# Native placement and exact JPEG bytes are independently asserted before this.
# Average RGB delta allows Office's tiny JPEG interpolation changes after reopen.
assert max(mean)<3,('Reopened picture changed',mean)
report=dict(result='passed',box=box,size=images[0].size,meanAbsoluteRGB=mean,maxChannelDelta=max(c[1] for c in difference.getextrema()),scope='Full picture bounding box from two actual Office page renders; exact saved JPEG/crop/geometry checked in edit-result')
(root/'picture-render-audit.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
