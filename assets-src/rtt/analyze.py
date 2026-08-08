#!/usr/bin/env python
"""analyze.py - read parts.json and report what the assembly is made of, so the grouping rules in
tessellate.py are written against measured facts rather than guesses.

    ./cadenv/bin/python analyze.py            # subassembly rollup + axis probes
    ./cadenv/bin/python analyze.py imu gyro   # grep the leaf paths
"""

import json
import sys
from collections import defaultdict

D = json.load(open("parts.json"))
parts = D["parts"]

if len(sys.argv) > 1:
    for pat in sys.argv[1:]:
        print(f"--- leaves matching {pat!r} ---")
        hits = [p for p in parts if pat.lower() in p["path"].lower()]
        for p in sorted(hits, key=lambda q: -q["diag"])[:30]:
            c = [(p["bbox"][i] + p["bbox"][i + 3]) / 2 for i in range(3)]
            print(f'  {p["diag"]:7.1f}  c=({c[0]:7.1f},{c[1]:7.1f},{c[2]:7.1f})  {p["path"]}')
        print(f"  ({len(hits)} leaves)\n")
    sys.exit(0)

print(f'{len(parts)} leaves, span {[round(s,2) for s in D["span"]]}\n')

# Which axis is up, and which way does the front face? Both answered off named parts rather than
# assumed: the plate stack ordering gives the up axis, FrontAssembly gives the forward axis.
def centre(p):
    return [(p["bbox"][i] + p["bbox"][i + 3]) / 2 for i in range(3)]


def group_centre(pat):
    hits = [p for p in parts if pat.lower() in p["path"].lower()]
    if not hits:
        return None
    n = len(hits)
    return [sum(centre(p)[i] for p in hits) / n for i in range(3)], n


for probe in ["Bottom Plate", "Middle Plate", "Top Plate", "FrontAssembly", "Solenoid Assembly",
              "MotorAssembly", "GolfBall", "Dribbler Bar", "BBB-aka_top_board", "lipo"]:
    got = group_centre(probe)
    if got:
        c, n = got
        print(f"  {probe:22} n={n:4}  centre=({c[0]:8.2f},{c[1]:8.2f},{c[2]:8.2f})")
print()

# Second-level subassembly rollup: leaf count and triangle-cost proxy (bbox diagonal) per branch.
roll = defaultdict(lambda: [0, 0.0])
for p in parts:
    seg = p["path"].split("/")
    key = "/".join(seg[1:3]) if len(seg) > 2 else "/".join(seg[1:])
    roll[key][0] += 1
    roll[key][1] += p["diag"]
print("second-level subassemblies, by leaf count:")
for k, (n, dsum) in sorted(roll.items(), key=lambda kv: -kv[1][0]):
    print(f"  {n:5}  sumdiag {dsum:9.0f}  {k}")
print()

# Size histogram: how much of this assembly is hardware small enough to drop outright.
buckets = [(0, 5), (5, 10), (10, 20), (20, 40), (40, 80), (80, 1e9)]
print("leaf size histogram (bbox diagonal, mm):")
for lo, hi in buckets:
    n = sum(1 for p in parts if lo <= p["diag"] < hi)
    print(f"  {lo:5.0f}-{hi if hi < 1e9 else 999:5.0f} mm  {n:5} leaves")
print()

# The names that repeat most: fastener families show up here and are the cheapest thing to drop.
byname = defaultdict(int)
for p in parts:
    byname[p["name"]] += 1
print("most repeated leaf names:")
for k, n in sorted(byname.items(), key=lambda kv: -kv[1])[:30]:
    d = max(p["diag"] for p in parts if p["name"] == k)
    print(f"  {n:5}  maxdiag {d:7.1f}  {k}")
