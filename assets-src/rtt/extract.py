#!/usr/bin/env python
"""extract.py - phase 1 of the RoboTeam Twente CAD pipeline: walk the STEP assembly and write a
part manifest (name path + bounding box + placement), with NO tessellation.

Reading `full-assembly.step` costs about 3.5 minutes (35 s of ReadFile, 175 s of Transfer), and the
assembly has hundreds of leaves, most of which are fasteners and gearbox internals a wireframe
display must not carry. Tessellating first and filtering second would spend minutes meshing M3
screws. So this phase answers one question - what parts are in here, how big is each, and where does
it sit - and writes it to `parts.json`. `tessellate.py` reads the manifest, decides what to keep, and
meshes only that.

Run from this directory:

    ./cadenv/bin/python extract.py

Output: parts.json  {unit_hint, root_bbox, parts: [{path, name, bbox:[minx..maxz], diag, volume_hint}]}
"""

import json
import sys
import time

from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString, TCollection_AsciiString
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.TDF import TDF_LabelSequence, TDF_Label
from OCP.TDataStd import TDataStd_Name
from OCP.TopLoc import TopLoc_Location
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib

T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:7.1f}s]", *a, flush=True)


def call(obj, base, *args):
    """OCP exposes OCCT statics as `Name_s` and instance methods as `Name`; accept either."""
    fn = getattr(obj, base + "_s", None) or getattr(obj, base, None)
    if fn is None:
        raise AttributeError(base)
    return fn(*args)


def label_name(label):
    attr = TDataStd_Name()
    if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
        return TCollection_AsciiString(attr.Get()).ToCString()
    return ""


def open_step_doc():
    """Read the STEP into an OCAF document, and cache that document as `assembly.xbf`.

    The STEP costs ~160 s (32 s ReadFile, 127 s Transfer) every time, which makes iterating on the
    grouping unaffordable. OCCT's own binary XCAF format reloads the same document in about a
    second, so the expensive read happens once and every later phase loads the cache.
    """
    from OCP.TDocStd import TDocStd_Application
    from OCP.BinXCAFDrivers import BinXCAFDrivers
    import os

    app = TDocStd_Application()
    BinXCAFDrivers.DefineFormat_s(app)
    fmt = TCollection_ExtendedString("BinXCAF")

    if os.path.exists("assembly.xbf"):
        log("loading cached assembly.xbf ...")
        doc = TDocStd_Document(fmt)
        app.Open(TCollection_ExtendedString("assembly.xbf"), doc)
        log("loaded")
        return doc

    doc = TDocStd_Document(fmt)
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(False)
    reader.SetLayerMode(False)
    log("reading full-assembly.step ...")
    reader.ReadFile("full-assembly.step")
    log("transferring ...")
    reader.Transfer(doc)
    log("transferred")
    try:
        app.SaveAs(doc, TCollection_ExtendedString("assembly.xbf"))
        log("cached assembly.xbf")
    except Exception as exc:  # a cache miss is a slow re-read, never a failure
        log("could not cache the document:", exc)
    return doc


def main():
    doc = open_step_doc()
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    roots = TDF_LabelSequence()
    call(tool, "GetFreeShapes", roots)
    log("free shapes:", roots.Length())

    parts = []

    def walk(label, loc, path, depth):
        if depth > 24:
            return
        if call(tool, "IsAssembly", label):
            comps = TDF_LabelSequence()
            call(tool, "GetComponents", label, comps)
            for i in range(1, comps.Length() + 1):
                comp = comps.Value(i)
                cloc = loc.Multiplied(call(tool, "GetLocation", comp))
                ref = TDF_Label()
                nm = label_name(comp)
                if call(tool, "GetReferredShape", comp, ref):
                    # The PRODUCT name is on the referred label. A component label carries the STEP
                    # instance id (`NAUO307`), which names nothing a grouping rule can read, so the
                    # referred label wins and the instance id is only a fallback.
                    walk(ref, cloc, path + [label_name(ref) or nm], depth + 1)
                else:
                    walk(comp, cloc, path + [nm], depth + 1)
            return
        # a leaf: a simple shape label
        shp = call(tool, "GetShape", label)
        if shp is None or shp.IsNull():
            return
        moved = shp.Moved(loc) if not loc.IsIdentity() else shp
        box = Bnd_Box()
        BRepBndLib.Add_s(moved, box, False)
        if box.IsVoid():
            return
        xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
        dx, dy, dz = xmax - xmin, ymax - ymin, zmax - zmin
        parts.append(
            {
                "path": "/".join([p for p in path if p]),
                "name": (path[-1] if path else label_name(label)) or "?",
                "bbox": [xmin, ymin, zmin, xmax, ymax, zmax],
                "dims": sorted([dx, dy, dz], reverse=True),
                "diag": (dx * dx + dy * dy + dz * dz) ** 0.5,
            }
        )

    for i in range(1, roots.Length() + 1):
        root = roots.Value(i)
        walk(root, TopLoc_Location(), [label_name(root) or f"root{i}"], 0)
        log(f"root {i}: {len(parts)} leaves so far")

    if not parts:
        log("NO LEAVES FOUND - the walk is wrong, not the file")
        sys.exit(1)

    allb = [p["bbox"] for p in parts]
    root_bbox = [
        min(b[0] for b in allb),
        min(b[1] for b in allb),
        min(b[2] for b in allb),
        max(b[3] for b in allb),
        max(b[4] for b in allb),
        max(b[5] for b in allb),
    ]
    span = [root_bbox[3] - root_bbox[0], root_bbox[4] - root_bbox[1], root_bbox[5] - root_bbox[2]]
    log("leaves:", len(parts))
    log("assembly bbox span:", [round(s, 2) for s in span])
    log("unit hint:", "mm" if max(span) > 20 else "m")

    with open("parts.json", "w") as fh:
        json.dump({"root_bbox": root_bbox, "span": span, "parts": parts}, fh)
    log("wrote parts.json")

    # A quick human read on the biggest leaves, which is what the grouping will be built from.
    for p in sorted(parts, key=lambda q: -q["diag"])[:40]:
        log(f'  {p["diag"]:8.1f}  {p["path"][:110]}')


if __name__ == "__main__":
    main()
