#!/usr/bin/python3
"""Restores `delete()` for the bindings a custom build links (issue #355).

The pinned OpenCascade.js generator emits `raw_destructor<T> { /* do nothing */ }` for every class
with a placement `operator delete`, which DEFINE_STANDARD_ALLOC gives almost every OCCT value
class. Embind then never frees a TopoDS_Shape, gp_Pnt, Bnd_Box, ... that a method returned by
value, nor what it references, even after `.delete()`. This rewrites the no-op to `delete ptr`
for the requested symbols and recompiles them; a class whose destructor is not public keeps the
no-op (the compiler rejects the delete). Standard_Transient subclasses keep the no-op:
they are owned by OCCT handles, and JS only sees them through Handle_* or raw pointers.

Runs inside the pinned image before buildFromYaml.py: patch-destructors.py <build.yml>
"""
import os
import re
import subprocess
import sys

import yaml

sys.path.insert(0, "/opencascade.js/src")
from compileBindings import buildOneFile  # noqa: E402

bindings_root = "/opencascade.js/build/bindings"
config = yaml.safe_load(open(sys.argv[1]))
symbols = [b["symbol"] for b in config["mainBuild"].get("bindings", [])]

sources = {}
for dirpath, _, filenames in os.walk(bindings_root):
    for name in filenames:
        if name.endswith(".cpp") and not dirpath.startswith(bindings_root + "/myMain.h"):
            sources.setdefault(name[:-4], os.path.join(dirpath, name))


def base_of(symbol):
    text = open(sources[symbol]).read()
    m = re.search(r"class_<%s\s*,\s*base<([A-Za-z0-9_]+)>>" % re.escape(symbol), text)
    return m.group(1) if m else None


def is_transient(symbol):
    while symbol:
        if symbol == "Standard_Transient":
            return True
        symbol = base_of(symbol) if symbol in sources else None
    return False


no_op = re.compile(
    r"(template<> void raw_destructor<([A-Za-z0-9_:<> ]+)>\(\2\* ptr\) \{) /\* do nothing \*/ (\})"
)
patched, kept = [], []
for symbol in symbols:
    path = sources.get(symbol)
    if path is None or is_transient(symbol):
        continue
    text = open(path).read()
    fixed = no_op.sub(r"\1 delete ptr; \3", text)
    if fixed == text:
        continue
    open(path, "w").write(fixed)
    if os.path.exists(path + ".o"):
        os.remove(path + ".o")
    try:
        buildOneFile({"threading": os.environ["threading"]}, path)
        patched.append(symbol)
    except subprocess.CalledProcessError:
        # A protected destructor (abstract API bases): JS never owns these, keep the original.
        open(path, "w").write(text)
        buildOneFile({"threading": os.environ["threading"]}, path)
        kept.append(symbol)
print("patched destructors: " + " ".join(patched))
print("kept (destructor not public): " + " ".join(kept))
