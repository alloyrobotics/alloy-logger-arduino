#!/usr/bin/env python
"""anchors.py - phase 4: measure where the real parts are, in the frame the asset shipped in.

The anatomy overlay attaches four labels to four points in the robot's own frame (`PART_OFFSETS` in
`ssl/experience.js`). Those points were authored against the round 7 PROCEDURAL robot - wheels on
+/-60 and +/-120 degree mounts, an IMU board on a top plate 147 mm up - and the real machine does not
agree with all of it: Twente's rear wheels are on +/-135, and the whole robot is 139 mm tall, so an
anchor at 149 mm floats above it. This script reports the measured centroid and bounding box of any
named part set, in metres, in the demo's robot frame, so the four offsets can be moved onto the
geometry they now point at instead of being guessed at.

    ./cadenv/bin/python anchors.py                 # the four anatomy candidates
    ./cadenv/bin/python anchors.py "Dribbler Bar"  # any part-name substring
"""

import json
import sys

import numpy as np

Z = np.load("leaf-cache.npz")
PATHS = json.load(open("leaf-paths.json"))
FIT = json.load(open("fit.json"))
V, R = Z["v"], Z["r"]


def fit(v):
    c, y0, s = FIT["c"], FIT["y0"], FIT["scale"]
    w = np.empty_like(v, dtype=np.float64)
    w[:, 0] = (v[:, 0] - c[0]) * s
    w[:, 1] = (v[:, 1] - y0) * s
    w[:, 2] = (v[:, 2] - c[1]) * s
    return w


def cloud(pattern, side=None):
    """Every vertex of every leaf whose path matches, optionally restricted to one side (+/-z)."""
    out = []
    hits = 0
    for i, path in enumerate(PATHS):
        if pattern.lower() not in path.lower():
            continue
        v0, vn, _, _ = R[i]
        v = fit(V[v0 : v0 + vn])
        if side == "+" and v[:, 2].mean() < 0:
            continue
        if side == "-" and v[:, 2].mean() > 0:
            continue
        if side == "back" and v[:, 0].mean() > 0:
            continue
        if side == "front" and v[:, 0].mean() < 0:
            continue
        out.append(v)
        hits += 1
    if not out:
        return None, 0
    return np.concatenate(out), hits


def report(label, pattern, side=None):
    v, n = cloud(pattern, side)
    if v is None:
        print(f"  {label:26} NO MATCH for {pattern!r}")
        return
    ctr = v.mean(axis=0)
    lo, hi = v.min(axis=0), v.max(axis=0)
    mid = (lo + hi) / 2
    print(
        f"  {label:26} n={n:4}  centroid ({ctr[0]:+.4f},{ctr[1]:+.4f},{ctr[2]:+.4f})"
        f"  bbox-mid ({mid[0]:+.4f},{mid[1]:+.4f},{mid[2]:+.4f})"
        f"  size ({hi[0]-lo[0]:.3f},{hi[1]-lo[1]:.3f},{hi[2]-lo[2]:.3f})"
    )


if len(sys.argv) > 1:
    for pat in sys.argv[1:]:
        report(pat, pat)
    sys.exit(0)

print("measured anchor candidates, metres, demo robot frame (+x dribbler face, +y up):\n")
# omni: ONE wheel, and deliberately the rear one on the +z side, which is the quadrant round 7's own
# omni anchor pointed into - so the leader line keeps coming from the same side of the machine and the
# tour's framing does not have to be re-solved around a different wheel.
report("omni  rear wheel (+z)", "Wheel Assembly", side="+")
report("omni  wheel frames (+z)", "Wheel Main Frame", side="+")
# imu: the top-plate control electronics. This CAD names no IMU (see RTT-MODEL-NOTICE.md), so the
# anchor goes on the board stack the card's claim is about.
report("imu   top board", "BBB-aka_top_board_BOARD")
report("imu   spin master", "The_Spin_Master_BOARD")
# kicker: the CAPACITOR BANK, because that is what the card names. The two 35 mm WCAP-AIG5
# electrolytics on the kicker board are it.
report("kicker  capacitor bank", "WCAP-AIG5")
report("kicker  solenoid", "Solenoid Assembly")
# dribbler: the bar itself, which is the roller the card names.
report("dribbler bar", "Dribbler Bar")
report("dribbler shaft", "Dribbler_Shaft")
print()
allv = fit(V)
print(f"  whole robot: height {allv[:,1].max():.4f} m, radius {np.hypot(allv[:,0],allv[:,2]).max():.4f} m")
print(f"  front-most point x = {allv[:,0].max():+.4f} m, rear-most x = {allv[:,0].min():+.4f} m")
