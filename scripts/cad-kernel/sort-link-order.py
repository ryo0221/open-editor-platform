"""Links the objects in name order (README.md, Reproducing the hash).

The pinned buildFromYaml.py passes the binding and OCCT objects to emcc in os.walk order, which is
the directory order of the filesystem the image is unpacked on. Sorting both lists makes the Wasm
independent of it. Fails if the pinned script no longer has the line it changes.
"""
import sys

path = sys.argv[1]
with open(path) as f:
    text = f.read()
old = "*bindingsO, *sourcesO,"
new = "*sorted(bindingsO), *sorted(sourcesO),"
if text.count(old) != 1:
    sys.exit("sort-link-order: link line not found in " + path)
with open(path, "w") as f:
    f.write(text.replace(old, new))
