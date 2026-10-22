"""Generate image fixtures; approved bytes were created with Pillow 12.3.0.

Current tooling uses Pillow 13.0.0. Generate into scratch and compare approved
hashes before proposing any fixture change; do not overwrite approved fixtures."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path('tests/fixtures/office/images')
root.mkdir(parents=True, exist_ok=True)
image = Image.new('RGBA', (256, 128), (255, 255, 255, 0))
draw = ImageDraw.Draw(image)
for bounds, color, label in [((0,0,127,63),(210,40,50,255),'A'), ((128,0,255,63),(30,155,70,255),'B'), ((0,64,127,127),(35,80,220,255),'C'), ((128,64,255,127),(240,180,20,100),'D')]:
    draw.rectangle(bounds, fill=color)
    draw.text((bounds[0]+10,bounds[1]+12), label, fill=(255,255,255,255), font_size=28)
image.save(root/'quadrants.png')
image.save(root/'quadrants.webp', lossless=True)
image.convert('RGB').save(root/'quadrants.jpeg', quality=92, subsampling=0)
image.save(root/'quadrants.gif', save_all=False)
