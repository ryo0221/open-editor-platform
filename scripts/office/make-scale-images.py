"""Deterministic, independently measured image-load fixture; not the 50×20 standard deck."""
from pathlib import Path
from PIL import Image
import hashlib,json,random,sys
root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
files=[]
for i in range(8):
    image=Image.frombytes('RGB',(1024,768),random.Random(i).randbytes(1024*768*3))
    file=root/f'image-{i}.png';image.save(file)
    files.append(dict(file=file.name,width=1024,height=768,bytes=file.stat().st_size,sha256=hashlib.sha256(file.read_bytes()).hexdigest()))
(root/'manifest.json').write_text(json.dumps(dict(description='8 distinct noisy 1024×768 PNGs reused across 8 slides; 64 pictures plus 8 text headings',files=files),indent=2)+'\n')
