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
"""

import json
import os
import struct
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SSL = os.path.normpath(os.path.join(HERE, "..", "..", "demo", "js", "robots", "ssl"))
MAGIC = b"RTT1"
SOURCE = "RoboTeam Twente, Full Assembly (2024)"
UPSTREAM = "https://github.com/RoboTeamTwente/roboteam_hardware"

# The group order in the file. `hull` is first because it is the layer the other four are read
# against, and a reader that draws in file order gets the faintest thing first.
ORDER = ["hull", "omni", "kicker", "dribbler", "imu"]


def main():
    z = np.load(os.path.join(HERE, "mesh-cache.npz"))
    summary = json.load(open(os.path.join(HERE, "mesh-summary.json")))

    blocks = []
    groups = []
    offset = 0  # byte offset within the payload, filled in against the real base below

    for gid in ORDER:
        key_v, key_t = f"{gid}_v", f"{gid}_t"
        if key_v not in z:
            raise SystemExit(f"group {gid} is not in mesh-cache.npz")
        v = z[key_v].astype(np.float64)
        t = z[key_t]
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
                "parts": summary[gid]["parts"],
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
        "format": "rtt-wireframe/1",
        "source": SOURCE,
        "upstream": UPSTREAM,
        "license": "MIT",
        "copyright": "Copyright (c) 2024 RoboTeam Twente",
        "notice": "RTT-MODEL-NOTICE.md",
        # The frame the positions are already in, so the reader applies no transform of its own.
        "frame": {"unit": "m", "x": "dribbler face", "y": "up", "origin": "hull axis at the carpet"},
        "radius": round(radius, 6),
        "height": round(height, 6),
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
    r = float(np.hypot(allv[:, 0], allv[:, 2]).max())
    assert abs(r - head["radius"]) < 1e-5, "header radius does not match the geometry"
    print(f"  verified: {len(head['groups'])} groups, {seen} triangles, every index in range")


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
