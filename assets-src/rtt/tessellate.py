#!/usr/bin/env python
"""tessellate.py - phase 2: mesh the parts worth displaying and write `mesh-cache.npz` in the demo's
own robot frame.

Reads the STEP once (~200 s), applies the keep/drop rules below, tessellates what survives, and
caches the result PER LEAF in `leaf-cache.npz`. Grouping, welding and every later re-run come off
that cache in about a second, so the four anatomy groups can be re-cut without OCCT in the loop.
`pack.py` turns the grouped output into the shipped asset.

    ./cadenv/bin/python tessellate.py            # uses leaf-cache.npz if it is there
    ./cadenv/bin/python tessellate.py --remesh   # re-reads the STEP and re-meshes

WHY NOT AN OCAF CACHE. `extract.py` writes `assembly.xbf` and it is a 26 MB red herring: OCP binds
`TDocStd_Application::Open(path, doc)` with the document as a handle REFERENCE, and OCCT reassigns
that handle internally, so the Python-side object it was called with is still the empty document it
started as. The reader reports PCDM_RS_OK, `NbDocuments()` reports 1, and `GetFreeShapes` reports 0.
`GetDocument()` has the same signature and the same problem. Caching the TRIANGLES instead sidesteps
the binding entirely and is the cache that actually matters, because tessellation - not parsing - is
what a re-grouping would otherwise repeat.

WHAT IS DROPPED, and why the threshold is a size rather than a name list. This is a manufacturing
assembly: of 972 leaves, 496 are under 10 mm and most of those are 1.8 mm SMD resistors and 0603
capacitors on five PCBs. None of them is legible on a 180 mm robot rendered 400 px tall, and all of
them cost triangles. So the rule is: drop anything whose bounding box diagonal is under
MIN_DIAG_MM, drop the fastener families by name at any size (a 17 mm torx screw is legible and is
still not anatomy), and drop the CAD's own GolfBall - the demo scene has its own tracked ball, and a
ball welded to the robot's geometry would be a fabricated pose.

THE FRAME. The CAD is in millimetres with +y up, the dribbler face along -z and the hull axis at
(x -1.483, z 15.05). Both of those datums are measured, not assumed, and by two independent methods
that agree to 0.06 mm: the hull's x span is the full 179.0 mm diameter so its midpoint is the axis,
and the four wheel centres are symmetric about the same point (see the AXIS block below). The demo's
robot frame is metres with +x the dribbler face, +y up, and the carpet at y = 0, so:

    demo = (-(z - AXIS_Z), y - GROUND_Y, x - AXIS_X) / 1000 * FIT

which is a rotation (determinant +1, so triangle winding survives it) plus a translation.

FIT is the one scale applied to the real robot: 1.0056, which is `maxRobotRadius` 0.09 m from the
log's own SSL_GeometryData packet divided by the CAD's measured 0.0895 m hull radius. The scene
already reads that field for its procedural hull, so the CAD lands at exactly the size the log says
this robot is. It puts the 140.5 mm CAD height at 141.3 mm, inside the 147 mm the scene uses.
"""

import argparse
import json
import sys
import time

import numpy as np

from OCP.TCollection import TCollection_ExtendedString, TCollection_AsciiString
from OCP.TDocStd import TDocStd_Document, TDocStd_Application

from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.TDF import TDF_LabelSequence, TDF_Label
from OCP.TDataStd import TDataStd_Name
from OCP.TopLoc import TopLoc_Location
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRep import BRep_Tool
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
from OCP.TopoDS import TopoDS

T0 = time.time()

# ---------------------------------------------------------------------------- the frame
AXIS_X = -1.483  # hull axis, mm: midpoint of the 179.0 mm x span, confirmed by the wheel symmetry
AXIS_Z = 15.05  # hull axis, mm: 89.5 mm in front of the plates' back arc, and the wheel-symmetry fit
GROUND_Y = -27.7257  # the lowest point of the wheels: the carpet plane
CAD_R = 0.0895  # measured hull radius, m (179.0 mm across)
DEMO_R = 0.09  # geometry.maxRobotRadius from the log's SSL_GeometryData packet
FIT = DEMO_R / CAD_R

# ---------------------------------------------------------------------------- keep / drop
MIN_DIAG_MM = 12.0
# Fastener and hardware families: legible or not, none of these is anatomy, and they are 20% of the
# leaves that survive the size gate.
DROP_NAME = (
    "torx_socket",
    "hexalobular",
    "nylon_torx",
    "axle_small_wheel",
    "iso 15 abb",  # a ball bearing
    "iso 4762",
    "din 9",
    "washer_",
)
# The CAD ships a golf ball in the dribbler mouth as a fit check. The demo has its own tracked ball.
DROP_PATH = ("golfball",)

# ---------------------------------------------------------------------------- the four groups
#
# Each rule is a path substring, tested in order, first match wins. The ids are the demo's own
# anatomy part ids (ssl/experience.js), and every one of them names a real subassembly of this CAD
# rather than a region invented to have something to point at - with ONE documented exception, `imu`,
# which is called out in RTT-MODEL-NOTICE.md and in ssl/experience.js: this published CAD names no
# IMU part anywhere (there is no imu, gyro, BNO, MPU, LSM or ICM leaf in all 972), so the group is
# the top-plate control electronics the card's claim is actually about - the BeagleBone that closes
# the motion loop and the motor-driver boards beside it.
#
# ONE RULE IS A DISPLAY DECISION RATHER THAN A TAXONOMY ONE, and it is the `hull` entry sitting ahead
# of `kicker`: `Big_Foot_1_0_BOARD` is the kicker board, and by parts taxonomy it belongs with the
# kicker. Drawn SOLID it is a 170 mm cross-shaped plate through the middle of the robot, and it hides
# the thing the card is about - rendered, the "capacitor bank" beat lit up as a flat board with the
# solenoid and both 35 mm electrolytics behind it. So the BOARD is context and the KICK CHAIN is the
# subject: the solenoid, its shield plates, the chipper and the two WCAP-AIG5 capacitors stay in
# `kicker`, and the plate they are mounted on is drawn as faintly as the chassis it spans.
#
# `motorassembly/motormount` is the same decision for the same reason. The mount is a 74 mm bracket,
# four of them, and drawn solid they are the biggest flat things on the machine: the "four wheels move
# in any direction" beat rendered as four bright plates with the wheels showing through them as line
# work. The bracket is context; the WHEEL - frame, cap, twenty-five rollers - and the motor that drives
# it are the subject, because "wheels" is the word on the card. The dribbler's own front mount
# (`frontassembly/motormountfrontassembly`) is a different part and this pattern does not match it.
GROUPS = [
    ("hull", ("big_foot_1_0_board", "motorassembly/motormount")),
    ("kicker", ("solenoid assembly", "big_foot", "chipper")),
    ("dribbler", ("frontassembly",)),
    ("omni", ("motorassembly",)),
    ("imu", ("bbb-aka_top_board", "the_spin_master")),
    # everything else: the three chassis plates, the covers, the battery, the standoffs, the juice
    # board, the speaker, the cable plate. The faintest layer, and in a wireframe it hides nothing.
    ("hull", ()),
]


# ---------------------------------------------------------------------------- the display budget
#
# TWO RULES, and between them they are what turns a manufacturing assembly into something a
# wireframe can draw. Both are applied at GROUPING time, off the per-leaf mesh cache, so they can be
# re-cut in a second.
#
# PCB COMPONENT FOOTPRINTS. Five of this robot's subassemblies are populated circuit boards, and the
# CAD carries every component on them as real geometry: an LQFP144 with 144 pins, motor-driver
# connectors with forty each. Those are the most expensive parts in the whole assembly - one chip
# costs 19,712 triangles, more than the entire dribbler - and on a 180 mm robot drawn 400 px tall
# not one of them is a pixel wide. They are dropped by name, with ONE exception kept deliberately:
# the two WCAP-AIG5 D35H35 electrolytics on the kicker board are 35 mm across and they ARE the
# capacitor bank the `kicker` card is about, so they stay and the card can point at them.
FOOTPRINT_HINTS = ("cmp-", "footprint", "-mfg", "-ipc")
KEEP_COMPONENT = ("wcap-aig5",)
# A TRIANGLE BUDGET PROPORTIONAL TO SIZE. A part may spend triangles in proportion to how big it is.
# A 200 mm chassis plate earns 12,000 (it is most of the silhouette and it is full of real holes); a
# 30 mm part that cannot be drawn in 600 is not detail at this scale, it is a grey smudge with a line
# on every facet, and it is dropped. This is what makes the budget hold without a hand-written list:
# coarsening cannot save a part whose triangle count comes from FEATURE COUNT rather than from chord
# error, and this rule notices that and stops paying for it.
TRI_BUDGET = ((40.0, 600), (100.0, 3000), (1e9, 12000))


def is_footprint(name):
    return any(h in name for h in FOOTPRINT_HINTS)


def tri_budget(diag):
    for lim, budget in TRI_BUDGET:
        if diag < lim:
            return budget
    return TRI_BUDGET[-1][1]


def log(*a):
    print(f"[{time.time() - T0:7.1f}s]", *a, flush=True)


def call(obj, base, *args):
    fn = getattr(obj, base + "_s", None) or getattr(obj, base, None)
    if fn is None:
        raise AttributeError(base)
    return fn(*args)


def label_name(label):
    attr = TDataStd_Name()
    if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
        return TCollection_AsciiString(attr.Get()).ToCString()
    return ""


def group_of(path):
    low = path.lower()
    for gid, pats in GROUPS:
        if not pats:
            return gid
        if any(p in low for p in pats):
            return gid
    return "hull"


def leaves():
    """Every leaf of the assembly as (path, located shape), read out of the STEP."""
    from OCP.STEPCAFControl import STEPCAFControl_Reader

    doc = TDocStd_Document(TCollection_ExtendedString("doc"))
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(False)
    reader.SetLayerMode(False)
    log("reading full-assembly.step ...")
    reader.ReadFile("full-assembly.step")
    log("transferring ...")
    reader.Transfer(doc)
    log("transferred")
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    roots = TDF_LabelSequence()
    call(tool, "GetFreeShapes", roots)
    out = []

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
                    walk(ref, cloc, path + [label_name(ref) or nm], depth + 1)
                else:
                    walk(comp, cloc, path + [nm], depth + 1)
            return
        shp = call(tool, "GetShape", label)
        if shp is None or shp.IsNull():
            return
        out.append(("/".join(p for p in path if p), shp.Moved(loc) if not loc.IsIdentity() else shp))

    for i in range(1, roots.Length() + 1):
        walk(roots.Value(i), TopLoc_Location(), [label_name(roots.Value(i)) or f"root{i}"], 0)
    log(f"{len(out)} leaves")
    return out


def face_triangles(shape):
    """Every triangle of an already-meshed shape, as (nodes Nx3 mm, tris Mx3), in world mm."""
    verts = []
    tris = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        face = TopoDS.Face_s(exp.Current())
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is not None:
            trsf = loc.Transformation()
            base = len(verts)
            n = tri.NbNodes()
            for i in range(1, n + 1):
                p = tri.Node(i).Transformed(trsf)
                verts.append((p.X(), p.Y(), p.Z()))
            rev = face.Orientation() == TopAbs_REVERSED
            for i in range(1, tri.NbTriangles() + 1):
                a, b, c = tri.Triangle(i).Get()
                if rev:
                    b, c = c, b
                tris.append((base + a - 1, base + b - 1, base + c - 1))
        exp.Next()
    if not verts or not tris:
        return None, None
    return np.asarray(verts, dtype=np.float64), np.asarray(tris, dtype=np.int64)


def to_demo(v):
    """CAD mm -> the demo's robot frame in metres. A rotation plus a translation; det = +1."""
    out = np.empty_like(v)
    out[:, 0] = -(v[:, 2] - AXIS_Z)
    out[:, 1] = v[:, 1] - GROUND_Y
    out[:, 2] = v[:, 0] - AXIS_X
    return out * (0.001 * FIT)


def build_leaf_cache(args):
    """Per-leaf triangles in the demo frame, from `leaf-cache.npz` or from the STEP.

    Returns (verts Nx3 float32, tris Mx3 uint32 indexing verts, ranges Lx4, paths list).
    """
    import os

    if os.path.exists("leaf-cache.npz") and not args.remesh:
        z = np.load("leaf-cache.npz", allow_pickle=False)
        paths = json.load(open("leaf-paths.json"))
        log(f"loaded leaf-cache.npz: {len(paths)} leaves, {len(z['t'])} tris")
        return z["v"], z["t"], z["r"], paths

    manifest = {p["path"]: p for p in json.load(open("parts.json"))["parts"]}
    kept, dropped = [], 0
    for path, shape in leaves():
        low = path.lower()
        if any(p in low for p in DROP_PATH) or any(p in low for p in DROP_NAME):
            dropped += 1
            continue
        meta = manifest.get(path)
        diag = meta["diag"] if meta else 0.0
        if diag < args.min_diag:
            dropped += 1
            continue
        kept.append((path, shape, diag))
    log(f"keeping {len(kept)} leaves, dropped {dropped}")

    from OCP.BRepTools import BRepTools

    vs, ts, ranges, paths = [], [], [], []
    costly = []
    vn = tn = 0
    for i, (path, shape, diag) in enumerate(kept):
        # Deflection scales with the part: a 15 mm roller and a 180 mm chassis plate want the same
        # number of facets, not the same chord error. Clamped either end so a tiny part is not
        # meshed to a single triangle and a big one does not run away.
        defl = min(args.defl_max, max(args.defl_min, diag * args.defl_scale))
        v = t = None
        # ADAPTIVE CAP. A handful of parts - PCB outlines with two hundred holes in them, a
        # connector with forty pins - answer a reasonable chord error with tens of thousands of
        # triangles. On a wireframe that is not detail, it is a grey smudge with a line on every
        # facet, so a part that overruns is re-meshed coarser until it fits or the budget runs out.
        # BRepMesh only re-meshes a face whose existing triangulation is COARSER than asked, so the
        # previous attempt has to be cleaned off the shared TFace first.
        for attempt in range(4):
            try:
                if attempt:
                    BRepTools.Clean_s(shape)
                BRepMesh_IncrementalMesh(shape, defl, False, args.angle * (1 + 0.35 * attempt), True)
                v, t = face_triangles(shape)
            except Exception as exc:
                log(f"  mesh failed on {path}: {exc}")
                v = t = None
                break
            if v is None or len(t) <= args.max_tris:
                break
            defl *= 2.2
        if v is None:
            continue
        if len(t) > args.max_tris:
            costly.append((len(t), path))
        v = to_demo(v)
        vs.append(v.astype(np.float32))
        ts.append((t + vn).astype(np.uint32))
        ranges.append((vn, len(v), tn, len(t)))
        paths.append(path)
        vn += len(v)
        tn += len(t)
        if i % 50 == 0:
            log(f"  meshed {i}/{len(kept)}  {tn} tris so far")

    V = np.concatenate(vs)
    T = np.concatenate(ts)
    R = np.asarray(ranges, dtype=np.int64)
    np.savez_compressed("leaf-cache.npz", v=V, t=T, r=R)
    json.dump(paths, open("leaf-paths.json", "w"))
    if costly:
        log(f"{len(costly)} parts still over the {args.max_tris}-triangle cap:")
        for n, path in sorted(costly, reverse=True)[:12]:
            log(f"    {n:7} tris  {path[:96]}")
    log(f"wrote leaf-cache.npz: {len(paths)} leaves, {len(V)} verts, {len(T)} tris")
    return V, T, R, paths


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--remesh", action="store_true", help="re-read the STEP and re-tessellate")
    ap.add_argument("--defl-scale", type=float, default=0.09)
    ap.add_argument("--defl-min", type=float, default=0.5)
    ap.add_argument("--defl-max", type=float, default=2.5)
    ap.add_argument("--angle", type=float, default=1.0)
    ap.add_argument("--max-tris", type=int, default=600, help="per-part triangle cap")
    ap.add_argument("--min-diag", type=float, default=14.0)
    ap.add_argument("--no-orings", action="store_true", help="drop the 100 roller O-rings")
    args = ap.parse_args()

    leaf_v, leaf_t, leaf_range, leaf_path = build_leaf_cache(args)
    manifest = {p["path"]: p for p in json.load(open("parts.json"))["parts"]}

    pools = {gid: {"v": [], "t": [], "n": 0, "parts": 0} for gid, _ in GROUPS}
    tri_total = 0
    cut = {"orings": 0, "footprints": 0, "budget": 0}
    for i, path in enumerate(leaf_path):
        v0, vn, t0, tn = leaf_range[i]
        if vn == 0 or tn == 0:
            continue
        low = path.lower()
        name = low.rsplit("/", 1)[-1]
        diag = manifest[path]["diag"] if path in manifest else 0.0
        if args.no_orings and name.endswith("o-ring"):
            cut["orings"] += 1
            continue
        if is_footprint(name) and not any(k in name for k in KEEP_COMPONENT):
            cut["footprints"] += 1
            continue
        if tn > tri_budget(diag):
            cut["budget"] += 1
            continue
        gid = group_of(path)
        pool = pools[gid]
        pool["v"].append(leaf_v[v0 : v0 + vn])
        pool["t"].append(leaf_t[t0 : t0 + tn] - v0 + pool["n"])
        pool["n"] += int(vn)
        pool["parts"] += 1
        tri_total += int(tn)

    log(f"grouped: {tri_total} triangles raw")
    log(f"  cut at grouping: {cut}")

    # ------------------------------------------------------------------ fit the robot envelope
    #
    # The two datum estimates in THE FRAME put the hull axis within about a millimetre, which is
    # close enough to see and not close enough to ship: measured off the tessellation, the widest
    # point of the robot came out at 91.1 mm from that axis, and an SSL robot is required to fit
    # inside a 180 mm cylinder. So the axis is FITTED to the geometry rather than estimated from two
    # features of it: Badoiu-Clarkson on the vertices projected into the ground plane converges on
    # the centre of the smallest circle that contains the whole robot, and one uniform scale then
    # puts that circle's radius exactly on the log's own `maxRobotRadius`. The ground datum is
    # re-zeroed on the lowest vertex at the same time, so the wheels touch the carpet rather than
    # hovering a fraction of a millimetre over it.
    allv = np.concatenate([np.concatenate(p["v"]) for p in pools.values() if p["v"]])
    pts = allv[:, [0, 2]].astype(np.float64)
    c = pts.mean(axis=0)
    for k in range(4000):
        far = pts[np.argmax(((pts - c) ** 2).sum(axis=1))]
        c = c + (far - c) / (k + 2)
    r_fit = float(np.sqrt(((pts - c) ** 2).sum(axis=1)).max())
    y0 = float(allv[:, 1].min())
    scale = DEMO_R / r_fit
    log(f"  fitted axis offset ({c[0]*1000:+.2f}, {c[1]*1000:+.2f}) mm, radius {r_fit*1000:.2f} mm")
    log(f"  applying scale {scale:.5f} and ground offset {y0*1000:+.2f} mm")
    # Persisted so `anchors.py` measures anchor points in exactly the frame the asset shipped in,
    # rather than recomputing the fit and drifting from it.
    json.dump({"c": [float(c[0]), float(c[1])], "y0": y0, "scale": scale}, open("fit.json", "w"))

    def fit(v):
        w = np.empty_like(v)
        w[:, 0] = (v[:, 0] - c[0]) * scale
        w[:, 1] = (v[:, 1] - y0) * scale
        w[:, 2] = (v[:, 2] - c[1]) * scale
        return w

    out = {}
    summary = {}
    # dict.fromkeys, not the GROUPS list: `hull` appears twice in it (once as a display override for
    # the kicker board, once as the catch-all) and it is still one group.
    for gid in dict.fromkeys(g for g, _ in GROUPS):
        pool = pools[gid]
        if not pool["v"]:
            log(f"  GROUP {gid}: EMPTY - a grouping rule matches nothing")
            continue
        v = fit(np.concatenate(pool["v"]))
        t = np.concatenate(pool["t"])
        # Weld: the tessellator emits per-face vertex pools, so every shared edge is duplicated.
        # Welding at 1 micron both shrinks the asset and gives THREE.EdgesGeometry a coherent mesh
        # to find feature edges in - it hashes vertex positions, so an unwelded seam reads as a
        # boundary edge and would draw a line down the middle of every smooth surface.
        keys = np.round(v / 1e-6).astype(np.int64)
        _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
        vw = v[first]
        tw = inverse.reshape(-1)[t]
        # Drop degenerate triangles the weld collapsed.
        good = (tw[:, 0] != tw[:, 1]) & (tw[:, 1] != tw[:, 2]) & (tw[:, 0] != tw[:, 2])
        tw = tw[good]
        out[f"{gid}_v"] = vw.astype(np.float32)
        out[f"{gid}_t"] = tw.astype(np.uint32)
        summary[gid] = {
            "parts": pool["parts"],
            "verts_raw": pool["n"],
            "verts": int(len(vw)),
            "tris": int(len(tw)),
            "bbox": [float(x) for x in list(vw.min(axis=0)) + list(vw.max(axis=0))],
        }
        log(
            f"  GROUP {gid:9} parts {pool['parts']:4}  verts {len(vw):7} (raw {pool['n']:7})"
            f"  tris {len(tw):7}"
        )

    np.savez_compressed("mesh-cache.npz", **out)
    json.dump(summary, open("mesh-summary.json", "w"), indent=1)
    tris = sum(s["tris"] for s in summary.values())
    verts = sum(s["verts"] for s in summary.values())
    log(f"wrote mesh-cache.npz: {verts} verts, {tris} tris across {len(summary)} groups")

    allv = np.concatenate([out[f"{g}_v"] for g in summary])
    lo, hi = allv.min(axis=0), allv.max(axis=0)
    log(f"robot bbox in demo frame (m): x {lo[0]:.4f}..{hi[0]:.4f}  y {lo[1]:.4f}..{hi[1]:.4f}"
        f"  z {lo[2]:.4f}..{hi[2]:.4f}")
    r = float(np.hypot(allv[:, 0], allv[:, 2]).max())
    log(f"hull radius {r:.4f} m (demo maxRobotRadius {DEMO_R}), height {hi[1]:.4f} m (demo 0.147)")
    if r > DEMO_R + 0.0005 or hi[1] > 0.147:
        log("WARNING: the model does not fit the demo's robot envelope")


if __name__ == "__main__":
    main()
