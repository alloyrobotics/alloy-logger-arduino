#!/usr/bin/env python
"""pack.py - phase 3: turn `mesh-cache.npz` into the one file the demo ships.

    ./cadenv/bin/python pack.py

Writes:
    ../../demo/js/robots/ssl/rtt-model.mesh       the asset
    ../../demo/js/robots/ssl/RTT-MODEL-NOTICE.md  the MIT notice that travels with it

WHY THE EXTENSION IS `.mesh` AND NOT `.bin`, which is not cosmetic and cost an hour to notice: this
repository is an Arduino library as well as a demo, and `.gitignore` line 3 is `*.bin` for compiled
firmware. Written as `rtt-model.bin` the shipped asset is silently untracked - it never reaches the
repository, never reaches the CDN, and the anatomy step takes its 404 fallback in production forever
while working perfectly on the machine that built it. `git status` is the only place that says so, by
omission. `.mesh` is ignored by neither `.gitignore` nor `.assetsignore`.

THE FORMAT, and why it is not glTF. The demo has no loader stack and is not getting one for this:
GLTFLoader is 200 KB of parser to read a container whose every feature but "here are some triangles"
is unused, and it would have to be fetched before the first triangle appeared. So the asset is the
smallest thing that answers the question, and the reader is thirty lines in `ssl/rtt-model.js`:

    0                 4 bytes   magic "RTT1"
    4                 uint32    length of the JSON header, little endian
    8                 H bytes   the JSON header (below), utf8
    then, 4-byte aligned, one positions block and one index block per group, in header order

    positions   int16 x3 per vertex, dequantized as `offset[axis] + q * scale[axis]`
    indices     uint16 x3 per triangle

int16 positions over a 180 mm robot are quantized to about 3 microns, which is four orders of
magnitude finer than the 0.5 mm chord error the tessellation itself carries - the quantization is
free accuracy-wise and halves the vertex block. Every group is under 65,536 vertices, so the index
block is uint16 rather than uint32 and the reader needs no chunking; pack.py fails loudly rather
than silently widening if a future re-cut breaks that.

FORMAT 2, AND WHY THE ASSET NOW KNOWS WHAT A WHEEL IS. Round 10's note is that the wheels should turn
with the robot's tracked motion, and a display group cannot turn if it is not a thing: `mesh-cache.npz`
carries ONE `omni` group with all four wheel assemblies welded into it, so a single rotation of it
would swing the whole set around the hull axis. So this file now splits that group into four - one per
wheel assembly - and records, per wheel, the AXLE it turns about: a unit axis and a point on it, in
the same frame as the positions, plus the wheel radius and the mount radius the drive kinematics need.
The split is geometric and is measured rather than assumed (see `split_wheels`), which is what keeps
the pipeline honest: nothing here authors a wheel position, it reads back the one Twente's CAD has.

Two header fields carry it, and both are new in format 2:

    anatomy   anatomy part id -> the display group ids that make it up. The demo's tour lights FOUR
              parts and the asset now ships EIGHT groups, so this is the indirection that keeps
              `setSubject('omni')` lighting all four wheels exactly as one group did. Every other
              part maps to a single group of the same name.
    wheels    one entry per spinning group: {group, axis, centre, radius, mountRadius, mountAngle}.

The version string moves with the shape, and `ssl/rtt-model.js` checks it strictly: an old asset
against a new reader (or the reverse) resolves to null rather than to a robot with an inside-out
drive, and the step keeps the procedural hull it has always been able to fall back to.
"""

import json
import os
import struct
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SSL = os.path.normpath(os.path.join(HERE, "..", "..", "demo", "js", "robots", "ssl"))
MAGIC = b"RTT1"
FORMAT = "rtt-wireframe/2"
SOURCE = "RoboTeam Twente, Full Assembly (2024)"
UPSTREAM = "https://github.com/RoboTeamTwente/roboteam_hardware"

# The order the cached groups are read in. `hull` is first because it is the layer the other four are
# read against, and a reader that draws in file order gets the faintest thing first. `omni` is not a
# shipped group any more: it is split into four wheels below, in the slot it occupies here, so the
# file order is still faintest-first with the four wheels where the one wheel group used to be.
ORDER = ["hull", "omni", "kicker", "dribbler", "imu"]
# The anatomy part the four wheel groups belong to. It is the id the demo's tour beat names
# (`ssl/experience.js`), which is why the split is invisible to every part of the demo but the
# spin: one card, one highlight, four groups.
WHEEL_PART = "omni"
# How far off radial a measured axle may sit before this is not the drive layout the kinematics in
# `ssl/rtt-model.js` assume. Twente's wheels come back 0.001 degrees off horizontal and 0.27 degrees
# off their own mount bearing (the hub hardware makes the roller ring very slightly asymmetric, which
# moves the CENTRE and not the axle), so these are tripwires for a future re-cut rather than
# tolerances anything is leaning on. The 0.27 costs nothing either way: `mountRadius` is written as
# centre . axis, which is exact whether or not the two agree.
MAX_AXLE_TILT_DEG = 1.0
MAX_AXLE_SKEW_DEG = 2.0


def split_wheels(v, t):
    """The welded `omni` group -> one group per wheel assembly, with its axle measured.

    WHY THE SPLIT IS ANGULAR. The four wheel assemblies sit at the league angles around the hull, and
    between them there is nothing: this group's vertices occupy four 38-degree arcs with at least 37
    degrees of empty carpet between each pair. So the split needs no clustering heuristic with a seed
    and a tolerance, it needs the four connected arcs of a one-degree occupancy histogram, and it
    fails loudly if there are not exactly four of them. Every triangle in this group has all three
    vertices inside one arc, which is asserted rather than assumed - a triangle spanning two wheels
    would mean the weld had bridged two assemblies and the whole premise is wrong.

    WHY THE AXLE IS MEASURED AND NOT WRITTEN DOWN. An axle read off the CAD is the axle the wheels
    actually have; a pair of angles typed into a pipeline is a guess that agrees with it until a
    re-cut. The wheel is a solid of revolution, so the smallest-variance principal direction of its
    vertex cloud IS its axle: a 53 mm wheel 15 mm wide has 36 times more spread across the axle than
    along it, which is not a close call. The measured direction comes back 0.001 degrees off
    horizontal, and it is snapped flat: these wheels have no camber, and a hundredth of a degree of
    fitted tilt would put a slow wobble on a part the visitor is being asked to look at.

    THE CENTRE IS THE CIRCLE CENTRE, and only its two in-plane components matter - a rotation about
    an axis is the same rotation about any point on it, so where along the axle the pivot sits is
    free. The wheel's silhouette in its own plane is a circle, so the midpoint of the projected
    bounding box IS that circle's centre, which is a stronger measurement than a centroid (unevenly
    tessellated hub geometry pulls a centroid off the axis and cannot pull a bounding box off it).

    THE RADIUS IS THE AXLE HEIGHT. The tessellation's ground datum is the lowest vertex of the wheels
    (`tessellate.py`, GROUND_Y), so the wheels touch y = 0 by construction and the height of the axle
    above the carpet is the ROLLING radius - the number the demo divides a surface speed by. It is
    cross-checked against the silhouette radius, which is the same thing measured the other way round,
    and the two agree to 40 microns.

    @return list of (verts, tris, spec) ordered by mount angle, one per wheel.
    """
    ang = np.degrees(np.arctan2(v[:, 2], v[:, 0]))
    radial = np.hypot(v[:, 0], v[:, 2])
    if radial.min() < 0.02:
        raise SystemExit(
            f"the omni group reaches {radial.min()*1000:.1f} mm of the hull axis, where a bearing"
            " angle is noise. The angular split cannot be trusted; re-cut the group."
        )
    occupied = np.zeros(360, dtype=bool)
    occupied[np.clip(np.floor(ang + 180).astype(np.int64), 0, 359)] = True
    if occupied.all():
        raise SystemExit("the omni group is a continuous ring: there are no wheels to separate")
    # Scan from a degree that is empty, so a wheel straddling +/-180 is one run rather than two.
    shift = int(np.argmin(occupied))
    rolled = np.roll(occupied, -shift)
    runs = []
    start = None
    for i, on in enumerate(rolled):
        if on and start is None:
            start = i
        elif not on and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, 359))
    if len(runs) != 4:
        raise SystemExit(f"expected four wheel arcs in the omni group, found {len(runs)}")
    mids = np.array([(((s + e) / 2.0 + shift) % 360) - 180 for s, e in runs])
    widths = np.array([e - s + 1 for s, e in runs])
    if widths.max() > 90:
        raise SystemExit(f"a wheel arc spans {int(widths.max())} degrees, which is not one wheel")
    # Nearest arc midpoint, measured the short way round the circle.
    lab = np.argmin(np.abs(((ang[:, None] - mids[None, :] + 180) % 360) - 180), axis=1)
    tri_lab = lab[t]
    if not ((tri_lab[:, 0] == tri_lab[:, 1]) & (tri_lab[:, 1] == tri_lab[:, 2])).all():
        raise SystemExit("a triangle spans two wheel arcs: the weld bridged two assemblies")

    out = []
    for k in np.argsort(mids):
        idx = np.where(lab == k)[0]
        remap = np.full(len(v), -1, dtype=np.int64)
        remap[idx] = np.arange(len(idx))
        vw = v[idx]
        tw = remap[t[tri_lab[:, 0] == k]]
        if (tw < 0).any():
            raise SystemExit("wheel re-index left a dangling vertex")
        out.append((vw, tw, axle_of(vw, float(mids[k]))))
    return out


def axle_of(vw, mount_angle):
    """One wheel's axle, in the frame the positions ship in. See `split_wheels` for the reasoning."""
    mean = vw.mean(axis=0)
    _eig, vec = np.linalg.eigh(np.cov((vw - mean).T))
    raw = vec[:, 0]
    tilt = np.degrees(np.arcsin(min(1.0, abs(float(raw[1])))))
    if tilt > MAX_AXLE_TILT_DEG:
        raise SystemExit(f"a wheel axle came back {tilt:.2f} degrees off horizontal: not a wheel")
    axis = np.array([raw[0], 0.0, raw[2]], dtype=np.float64)
    axis /= np.linalg.norm(axis)
    # Point it AWAY from the hull axis, so the four axes are consistently signed and the sign of a
    # spin rate means the same thing on every wheel. The kinematics in the loader depend on it.
    if axis[0] * mean[0] + axis[2] * mean[2] < 0:
        axis = -axis
    axis[1] = 0.0  # and not the -0.0 the flip above leaves, which JSON writes out as "-0.0"
    skew = abs(((np.degrees(np.arctan2(axis[2], axis[0])) - mount_angle + 180) % 360) - 180)
    if skew > MAX_AXLE_SKEW_DEG:
        raise SystemExit(
            f"a wheel axle sits {skew:.2f} degrees off its own mount bearing. The demo's omni"
            " kinematics assume a radial axle; teach them the general case before shipping this."
        )
    up = np.array([0.0, 1.0, 0.0])
    tang = np.array([axis[2], 0.0, -axis[0]])  # up x axis: the direction this wheel rolls
    pa, pu, pt = vw @ axis, vw @ up, vw @ tang
    ca = (pa.min() + pa.max()) / 2
    cu = (pu.min() + pu.max()) / 2
    ct = (pt.min() + pt.max()) / 2
    centre = axis * ca + up * cu + tang * ct
    silhouette = float(np.hypot(pu - cu, pt - ct).max())
    if abs(silhouette - cu) > 0.0015:
        raise SystemExit(
            f"axle height {cu*1000:.2f} mm and silhouette radius {silhouette*1000:.2f} mm disagree:"
            " this wheel is not standing on the carpet the ground datum was zeroed to."
        )
    return {
        # Eight decimals rather than the six every length here carries, because this one is a
        # DIRECTION: rounding a unit vector to microns can move its length by a part in a million,
        # and the reader checks that length before it will spin anything.
        "axis": [round(float(x), 8) for x in axis],
        "centre": [round(float(x), 6) for x in centre],
        # The rolling radius, and the two ways of measuring it, for the record.
        "radius": round(float(cu), 6),
        # The effective drive radius: the axle-wise distance from the hull axis to this wheel, which
        # is what multiplies a yaw rate in the omni kinematics. Written as centre . axis rather than
        # as |centre| so it stays exact if a future wheel is not perfectly radial.
        "mountRadius": round(float(centre[0] * axis[0] + centre[2] * axis[2]), 6),
        "mountAngle": round(float(np.degrees(np.arctan2(centre[2], centre[0]))), 3),
        "_silhouette": silhouette,
        "_axial": float(pa.max() - pa.min()),
        "_tilt": tilt,
    }


def main():
    z = np.load(os.path.join(HERE, "mesh-cache.npz"))
    summary = json.load(open(os.path.join(HERE, "mesh-summary.json")))

    blocks = []
    groups = []
    wheels = []
    anatomy = {}

    # The cached groups, in file order, with `omni` expanded into its four wheels. `parts` is split
    # evenly across them, which the equal vertex counts asserted below are the evidence for: four
    # identical wheel assemblies, 27 kept parts each.
    cut = []
    for gid in ORDER:
        key_v, key_t = f"{gid}_v", f"{gid}_t"
        if key_v not in z:
            raise SystemExit(f"group {gid} is not in mesh-cache.npz")
        v = z[key_v].astype(np.float64)
        t = z[key_t]
        parts = summary[gid]["parts"]
        if gid != WHEEL_PART:
            cut.append((gid, gid, v, t, parts, None))
            continue
        split = split_wheels(v, t)
        counts = {len(vw) for vw, _, _ in split}
        if len(counts) != 1:
            raise SystemExit(f"the four wheels came out at different sizes: {sorted(counts)}")
        if parts % len(split):
            raise SystemExit(f"{parts} parts do not divide across {len(split)} identical wheels")
        for i, (vw, tw, spec) in enumerate(split):
            wid = f"wheel{i}"
            spec["group"] = wid
            cut.append((wid, WHEEL_PART, vw, tw, parts // len(split), spec))

    for gid, part, v, t, parts, spec in cut:
        anatomy.setdefault(part, []).append(gid)
        if spec is not None:
            print(
                f"  {gid:9} axle ({spec['axis'][0]:+.4f},{spec['axis'][1]:+.4f},{spec['axis'][2]:+.4f})"
                f" at {spec['mountAngle']:+7.2f} deg, R {spec['mountRadius']*1000:.2f} mm,"
                f" r {spec['radius']*1000:.2f} mm (silhouette {spec['_silhouette']*1000:.2f},"
                f" width {spec['_axial']*1000:.2f}, tilt {spec['_tilt']:.3f} deg)"
            )
            wheels.append({k: v2 for k, v2 in spec.items() if not k.startswith("_")})
        if len(v) > 65535:
            raise SystemExit(
                f"group {gid} has {len(v)} vertices, over the 65535 a uint16 index block can address."
                " Re-cut the group or teach the reader about chunking - do not silently widen."
            )
        lo, hi = v.min(axis=0), v.max(axis=0)
        # Per-axis quantization over the group's own extent, symmetric about its centre so the full
        # int16 range is used in both directions.
        scale = np.maximum((hi - lo) / 65534.0, 1e-12)
        centre = (hi + lo) / 2.0
        q = np.rint((v - centre) / scale).astype(np.int32)
        q = np.clip(q, -32767, 32767).astype("<i2")
        err = float(np.abs(q.astype(np.float64) * scale + centre - v).max())
        pos_bytes = q.tobytes()
        idx_bytes = t.astype("<u2").tobytes()

        groups.append(
            {
                "id": gid,
                # The anatomy part this group is a piece of. Four wheels answer to one card, so the
                # reader groups by THIS and not by `id`, and the highlight semantics are unchanged
                # from format 1 where the four wheels were one group.
                "anatomy": part,
                "parts": parts,
                "verts": int(len(v)),
                "tris": int(len(t)),
                "offset": [float(x) for x in centre],
                "scale": [float(x) for x in scale],
                "pos": {"byteLength": len(pos_bytes)},
                "idx": {"byteLength": len(idx_bytes)},
            }
        )
        blocks.append((pos_bytes, idx_bytes))
        print(f"  {gid:9} verts {len(v):6}  tris {len(t):6}  quantization error {err*1e6:.2f} um")

    allv = np.concatenate([z[f"{g}_v"] for g in ORDER]).astype(np.float64)
    radius = float(np.hypot(allv[:, 0], allv[:, 2]).max())
    height = float(allv[:, 1].max())

    header = {
        "format": FORMAT,
        "source": SOURCE,
        "upstream": UPSTREAM,
        "license": "MIT",
        "copyright": "Copyright (c) 2024 RoboTeam Twente",
        "notice": "RTT-MODEL-NOTICE.md",
        # The frame the positions are already in, so the reader applies no transform of its own.
        "frame": {"unit": "m", "x": "dribbler face", "y": "up", "origin": "hull axis at the carpet"},
        "radius": round(radius, 6),
        "height": round(height, 6),
        # anatomy part id -> the display groups that make it up, so a reader can light a card's part
        # without knowing how many pieces the pipeline cut it into.
        "anatomy": anatomy,
        # The spinning groups and the axles they spin about. Metres and unit vectors, in the same
        # frame as the positions. `radius` is the rolling radius, `mountRadius` the drive radius a
        # yaw rate multiplies; `mountAngle` is degrees around the hull axis and is informational.
        "wheels": wheels,
        "groups": groups,
    }

    # The header carries the byte offsets of the blocks, and the header's own length decides where
    # those blocks start, so it is a fixed point: serialize, lay out against that length, re-serialize,
    # and stop when the length stops moving. THE SUBTLETY, and it shipped a broken asset once: the
    # serialization that goes in the file has to be the one whose offsets match the layout. Breaking
    # out of this loop while writing the PREVIOUS pass's text gives a file whose bytes are laid out
    # correctly and whose header points a few hundred bytes short of every block, which reads back as
    # plausible-looking geometry with out-of-range indices. Hence `head_bytes = candidate` before the
    # break, and hence verify() below, which re-reads the finished file the way the browser will.
    for g in header["groups"]:
        g["pos"]["byteOffset"] = 0
        g["idx"]["byteOffset"] = 0
    head_bytes = json.dumps(header, separators=(",", ":")).encode("utf8")
    for _ in range(6):
        base = 8 + len(head_bytes)
        base += (-base) % 4
        cursor = base
        for g, (pos_bytes, idx_bytes) in zip(header["groups"], blocks):
            g["pos"]["byteOffset"] = cursor
            cursor += len(pos_bytes)
            cursor += (-cursor) % 4
            g["idx"]["byteOffset"] = cursor
            cursor += len(idx_bytes)
            cursor += (-cursor) % 4
        candidate = json.dumps(header, separators=(",", ":")).encode("utf8")
        if len(candidate) == len(head_bytes):
            head_bytes = candidate
            break
        head_bytes = candidate
    else:
        raise SystemExit("the header length never settled")

    out = bytearray()
    out += MAGIC
    out += struct.pack("<I", len(head_bytes))
    out += head_bytes
    out += b"\0" * ((-len(out)) % 4)
    assert len(out) == header["groups"][0]["pos"]["byteOffset"], "header size drifted"
    for g, (pos_bytes, idx_bytes) in zip(header["groups"], blocks):
        assert len(out) == g["pos"]["byteOffset"], f"{g['id']} pos offset drifted"
        out += pos_bytes
        out += b"\0" * ((-len(out)) % 4)
        assert len(out) == g["idx"]["byteOffset"], f"{g['id']} idx offset drifted"
        out += idx_bytes
        out += b"\0" * ((-len(out)) % 4)

    path = os.path.join(SSL, "rtt-model.mesh")
    with open(path, "wb") as fh:
        fh.write(bytes(out))

    tris = sum(g["tris"] for g in header["groups"])
    verts = sum(g["verts"] for g in header["groups"])
    parts = sum(g["parts"] for g in header["groups"])
    print(f"\nwrote {path}")
    print(f"  {len(out)} bytes  ({len(out)/1024:.1f} KB)  header {len(head_bytes)} B")
    print(f"  {parts} parts, {verts} vertices, {tris} triangles")
    print(f"  radius {radius:.4f} m, height {height:.4f} m")

    verify(path, allv)
    write_notice()


def verify(path, allv):
    """Re-read the finished file the way `ssl/rtt-model.js` will, and check what the GPU would check.

    This exists because the failure it catches is silent everywhere else: a header whose offsets are
    off by a few hundred bytes still parses, still yields the right vertex and triangle counts, and
    still hands the GPU index buffers that address vertices which are not there. The browser's only
    complaint is a WebGL warning, and the model draws as a shredded cloud.
    """
    raw = open(path, "rb").read()
    assert raw[:4] == MAGIC, "magic"
    head_len = struct.unpack_from("<I", raw, 4)[0]
    head = json.loads(raw[8 : 8 + head_len].decode("utf8"))
    seen = 0
    by_id = {}  # group id -> its dequantized vertices, for the axle checks below
    for g in head["groups"]:
        p_off, p_len = g["pos"]["byteOffset"], g["pos"]["byteLength"]
        i_off, i_len = g["idx"]["byteOffset"], g["idx"]["byteLength"]
        assert p_off % 2 == 0 and i_off % 2 == 0, f"{g['id']}: unaligned block"
        assert p_off + p_len <= len(raw) and i_off + i_len <= len(raw), f"{g['id']}: block past EOF"
        assert p_len == g["verts"] * 6, f"{g['id']}: position block is not verts*6 bytes"
        assert i_len == g["tris"] * 6, f"{g['id']}: index block is not tris*6 bytes"
        q = np.frombuffer(raw, dtype="<i2", count=g["verts"] * 3, offset=p_off).reshape(-1, 3)
        idx = np.frombuffer(raw, dtype="<u2", count=g["tris"] * 3, offset=i_off)
        assert int(idx.max()) < g["verts"], (
            f"{g['id']}: index {int(idx.max())} addresses vertex {g['verts']} or beyond"
        )
        # And dequantize, to prove the header's offset/scale reproduce the geometry rather than
        # something the right shape.
        v = q.astype(np.float64) * np.asarray(g["scale"]) + np.asarray(g["offset"])
        assert np.abs(v).max() < 0.2, f"{g['id']}: dequantized geometry is off the robot"
        seen += g["tris"]
        by_id[g["id"]] = v
    r = float(np.hypot(allv[:, 0], allv[:, 2]).max())
    assert abs(r - head["radius"]) < 1e-5, "header radius does not match the geometry"

    # Format 2. Everything the reader in `ssl/rtt-model.js` refuses to load without, checked here so
    # the failure is a build failure rather than a step that silently keeps the procedural hull.
    assert head["format"] == FORMAT, f"format {head['format']}, expected {FORMAT}"
    anatomy = head["anatomy"]
    listed = [gid for ids in anatomy.values() for gid in ids]
    assert sorted(listed) == sorted(by_id), "the anatomy map and the group list disagree"
    assert len(listed) == len(set(listed)), "a group is claimed by two anatomy parts"
    for g in head["groups"]:
        assert g["id"] in anatomy[g["anatomy"]], f"{g['id']}: not listed under its own anatomy part"
    assert len(anatomy[WHEEL_PART]) == 4, f"{WHEEL_PART} has {len(anatomy[WHEEL_PART])} groups, not 4"
    assert len(head["wheels"]) == 4, "the header does not carry four wheels"
    for wh in head["wheels"]:
        gid = wh["group"]
        assert gid in anatomy[WHEEL_PART], f"{gid}: a wheel that is not part of {WHEEL_PART}"
        axis = np.asarray(wh["axis"], dtype=np.float64)
        assert abs(np.linalg.norm(axis) - 1) < 1e-6, f"{gid}: axle axis is not a unit vector"
        assert axis[1] == 0, f"{gid}: axle axis is not horizontal"
        # The one geometric claim the demo's kinematics rest on: this axis, through this point, is
        # the axle the group's own vertices turn about. Every vertex therefore has to sit within the
        # wheel's radius of that line, which a wrong axis or a centre off the axle both break.
        rel = by_id[gid] - np.asarray(wh["centre"], dtype=np.float64)
        off = rel - np.outer(rel @ axis, axis)
        assert float(np.linalg.norm(off, axis=1).max()) <= wh["radius"] + 1e-4, (
            f"{gid}: geometry reaches past the rolling radius from the declared axle"
        )
        assert abs(wh["centre"][1] - wh["radius"]) < 1e-6, f"{gid}: axle height is not the radius"
        assert wh["mountRadius"] > 0.05, f"{gid}: drive radius {wh['mountRadius']} is not a mount"
    print(f"  verified: {len(head['groups'])} groups, {seen} triangles, every index in range")
    print(
        f"  verified: format {FORMAT}, {len(head['wheels'])} axles unit-length and radial,"
        f" anatomy {{{', '.join(f'{k}:{len(v2)}' for k, v2 in anatomy.items())}}}"
    )


def write_notice():
    """The MIT notice that ships beside the asset. MIT requires the copyright notice and the licence
    text to travel with any redistribution, and `rtt-model.mesh` is a redistribution of Twente's
    published CAD in a different form. The house pattern for this is the repo's THIRD_PARTY_NOTICES
    (donna's Wolfgang-OP meshes), and this file is the same thing served next to the asset so the
    notice is reachable from the page that renders it, not only from the repository."""
    license_text = open(os.path.join(HERE, "LICENSE-roboteamtwente")).read().rstrip("\n")
    body = f"""# Robot model: {SOURCE}

The SSL robot rendered on "Understand the robot" is RoboTeam Twente's own published CAD, converted
to a wireframe display asset (`rtt-model.mesh`) by `assets-src/rtt/` in this repository. Nothing about
the robot's shape is authored here: the geometry is theirs, tessellated and grouped, and the pipeline
that did it is committed beside the STEP it read.

Source: {SOURCE}
Upstream: {UPSTREAM}
License: MIT

WHAT WAS CHANGED. The published Full Assembly is a manufacturing model: 972 leaf parts including
fasteners, bearings and every SMD component on five circuit boards. The display asset keeps 184 of
them - the chassis plates, the four omni wheel assemblies with their rollers, the solenoid kicker and
its capacitor bank, the dribbler mouth, and the top-plate control boards - tessellated at a coarse
chord error and grouped into the five layers the anatomy tour lights. Fasteners, PCB component
footprints and parts under 14 mm are dropped, as is the CAD's own golf ball: the demo scene has its
own tracked ball from the match log, and a ball welded into the robot's geometry would be a pose the
log never recorded.

ONE GROUP IS NOT A PART OF THIS CAD, and it is called out here rather than glossed. The anatomy
tour's `imu` card names an inertial measurement unit. This published assembly names no IMU anywhere -
there is no imu, gyro, BNO, MPU, LSM or ICM part among its 972 leaves - so the group the card lights
is the top-plate control electronics it sits on: the BeagleBone that closes the motion loop and the
motor-driver boards beside it. The marker over it is the anatomy overlay's own anchored halo, which
is how that overlay has always pointed at a part it does not model.

{license_text}
"""
    path = os.path.join(SSL, "RTT-MODEL-NOTICE.md")
    with open(path, "w") as fh:
        fh.write(body)
    print(f"wrote {path}  ({len(body)} B)")


if __name__ == "__main__":
    main()
