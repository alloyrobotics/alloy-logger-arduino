# GENSPEC v1: def.json contract for generated personalized demos

> **This in-repo copy is canonical.** It started as `Projects/alloylogger-demo-gen/GENSPEC.md` in
> Hugh's Obsidian vault and moved here once the interpreters, the validator and the worker existed.
> The vault file is now a pointer to this one. Where the original spec and the shipped code
> disagreed, the CODE won and this file was corrected to match it; those corrections are marked
> `BUILT:` inline. Assetsignored, so it is never served.
>
> Normative implementations: `demo/js/core/gendata.js` (data), `demo/js/core/genscene.js` (scene),
> `demo/js/core/matcher.js` (chat matching), `demo/js/robots/generated.js` (loader gate),
> `worker/demo-gen.js` `validateDefStructural()` (publish-time re-check), and the runner's
> `validate.mjs` (the deep gate, `~/.local/bin/alloylogger-demo-runner/`). Ops live in
> `worker/README.md`; the demo app's build contract lives in `demo/DESIGN.md`.

Normative spec for `spec_version: 1`. The generator (headless Opus job) emits ONE JSON document;
trusted interpreters render it. **No generated code, ever.**

Compatibility rule: this DSL + interpreter behavior are a **published API**. Every emailed demo
link depends on them forever. Changes are additive only; `spec_version` gates breaking changes;
interpreters must keep rendering v1 forever.

## 1. Top level

```jsonc
{
  "spec_version": 1,
  "robot_name": "RoboCup 2v2 squad",     // ≤48 chars, display
  "device_line": "4x ESP32-S3, BNO085 IMU, hall encoders",  // ≤72, picker-style hardware line
  "device_id": "soccer-2v2",             // ^[a-z0-9][a-z0-9-]{1,22}$ — faux-ingest device naming
  "tagline": "Loses the ball on defensive clears",          // ≤80, story phrase
  "accent": "#61d4a3",                   // ^#[0-9a-fA-F]{6}$
  "seed": 482911,                        // int 1..2147483647; ALL determinism roots here
  "duration": 75,                        // seconds, 15..180
  "rate": 50,                            // Hz, 10..100 (per-channel override allowed)
  "channels": [ ... ],                   // §2
  "data_spec": { ... },                  // §3
  "scene_spec": { ... },                 // §4
  "findings": [ ... ],                   // §5
  "chat": { ... },                       // §6
  "facts_notes": "...",                  // ≤2000 chars; analyst context for the facts pack; every
                                         // number in it MUST be derivable from data_spec (validator cross-checks)
  "email_summary": "..."                 // ≤140 chars, one plain line for the fixed email template
}
```

Refusal shape (generator-side only, never published): `{ "refuse": true, "refuse_reason": "≤200 chars" }`.

`BUILT:` all sixteen keys above are required and `additionalProperties` is false. A refusal with any
sibling key is rejected by the runner validator, and `refuse: true` is rejected outright at publish
time by the worker (`worker/demo-gen.js` `validateDefStructural`), so a refusal can never become a
servable bundle even if the runner mis-routes it.

`BUILT:` **`schema.json` sets `required: []`, and that is deliberate, not an oversight.** The
generation schema has to describe BOTH shapes in one flat object, because the API rejects a
top-level `oneOf`/`anyOf`/`allOf` and there is no `if`/`then` to lean on either (verified live,
claude CLI 2.1.220). Listing the sixteen keys as `required` would make the refusal shape
unrepresentable, and a generator that cannot refuse is a generator that invents a robot for
whatever a stranger typed. So the exclusivity is enforced one layer down instead: `validate.mjs`
requires all sixteen on a non-refusal document (`schema.required`, one error per missing key) and
allows only `refuse` + `refuse_reason` on a refusal (`schema.additional`). `brief.md` states the
same rule in prose. Do not "fix" `required: []` in `schema.json`.

All display strings (robot_name, device_line, tagline, channel labels/units, finding titles, chat text): charset `[\x20-\x7E\n]` (printable ASCII + newline), no em dashes, length limits enforced post-parse. Rendering must use textContent/DOM construction — never innerHTML.

`BUILT:` three checkers apply the display-string rules, deliberately at different tightnesses.
The runner's `validate.mjs` `STRING_LIMITS` is normative and tightest: it is the gate a def has to
pass to be published at all. The worker's `DISPLAY_LIMITS` is a structural backstop that runs on
bytes it did not generate, and the loader's `gateReason()` in `demo/js/robots/generated.js` is a
cheap third layer whose only job is to make a truncated bundle render the "not available" card.
Where the three differ the tightest one binds, so a def that passes the runner passes the other two.

Two rules bind identically in all three, and both are contracts rather than slack:

- **Non-empty.** Every display string must carry at least one non-whitespace character. An empty
  or all-whitespace string passes a length cap and a charset scan and renders as a hole in the
  page, so it is a hard error in the runner validator and in the worker re-check, and the loader's
  `isStr()` has always required `length > 0`.
- **Single line.** Every display string that can reach an email subject or a one-line context
  (`robot_name`, `device_line`, `tagline`, `email_summary`, `channels[].fields[].label` and
  `.unit`, `findings[].title`, `chat.first_question`, `chat.suggested[]`,
  `chat.script[].matchers[]`) is printable ASCII with NO newline. A newline in any of those is a
  header-injection primitive the moment the string reaches a mail transport. Only `facts_notes`
  and `chat.script[].answer` are prose that wraps, and only those two keep `\n` in their charset.

Known slack, all of it in the direction the tightest-binds rule allows: `findings[].title` is 80 in
the validator, 96 in the worker and 120 in the loader; `chat.suggested` and `chat.script` counts
are enforced exactly (3..4 and 4..6) in the validator and the worker, and only checked for
non-emptiness in the loader. A dimensionless field states its unit as a word (`count`, `score`,
`ratio`, `1/s`), never as the empty string.

## 2. channels

Same shape the canned robots use (chart + ingest consume unchanged):

```jsonc
{ "path": "/drive",                      // ^/[a-z][a-z0-9_]{0,15}$, 1..6 channels
  "rate": 50,                            // optional override, 1..100
  "fields": [                            // 1..6 fields
    { "key": "vel",  "label": "Velocity",   "unit": "m/s" }   // key ^[a-z][a-z0-9_]{0,15}$
  ] }
```

Mesh-table names derive as today: `alloy.fleet.<path>` (ingest.js does this already).

## 3. data_spec — deterministic telemetry DSL

One entry per `"<path>.<key>"`. Every declared channel field MUST have an entry. Evaluation order per field: **base segments → couplings → events → noise → clamp**. Each field's PRNG stream = `mulberry32(hash(seed, "<path>.<key>"))` (same helper exported to browser + validator + facts builder — single source in `gendata.js`).

```jsonc
"/drive.vel": {
  "base": [                              // 1..12 segments, contiguous [t0,t1) covering [0,duration]
    { "t0": 0,  "t1": 8,  "kind": "ramp", "from": 0, "to": 1.6, "ease": "smooth" }, // ease: "linear"|"smooth"
    { "t0": 8,  "t1": 51, "kind": "hold", "value": 1.6 },
    { "t0": 51, "t1": 75, "kind": "decay", "from": 1.6, "to": 0, "tau": 3.0 },
    // also: { "kind": "sine", "mean": 0, "amp": 0.4, "freq": 0.5, "phase": 0 }
    //       { "kind": "ramp" ... } chains; validator checks contiguity + coverage
  ],
  "couple": [                            // 0..2; applied after base
    { "from": "/drive.current", "kind": "lag1", "gain": 0.3, "tau": 2.5 },  // first-order lag of source
    // { "from": ..., "kind": "scale", "gain": ... }  — direct scaled add
  ],
  "events": [                            // 0..8
    { "t": 51.7, "kind": "spike", "amp": -1.2, "width": 0.8 },   // gaussian bump
    { "t": 60.0, "kind": "step",  "to": 0.0 },                   // holds until next event/end
    { "t": 30.0, "kind": "dropout", "width": 1.2 },              // freeze last value (never NaN)
    { "t": 12.0, "kind": "burst", "amp": 0.5, "freq": 8, "width": 2.0 }  // decaying oscillation
  ],
  "noise": { "kind": "fbm", "octaves": 3, "amp": 0.06, "hz": 2 },  // or {"kind":"gauss","sd":0.05} or null
  "clamp": [0, 3.5]                      // optional [min,max]
}
```

Coupling graph must be acyclic; `from` must be a declared field. Numeric bounds: |values| ≤ 1e6, tau/width/freq > 0, freq ≤ 30.

Interpreter contract (isomorphic ES module, no DOM):
`buildDataFromSpec(def) -> { "<path>": { t: Float64Array, <key>: Float64Array, ... }, ... }`
Bounds enforced at build: total samples 500..60,000; all finite; t monotonic from ~0 to within 2% of duration. Deterministic: two builds hash-identical.

`BUILT:` `demo/js/core/gendata.js` is the single source and additionally exports `LIMITS`,
`hashString`, `hash`, `streamSeed`, `streamFor`, `fieldPathsOf`, `channelIndex`, `couplingOrder`
and `SpecError`. It imports its primitives from `demo/js/core/prng.js` (`mulberry32`, `fbm1D`,
`sampleAt`, `clamp`, `remap`, `smoothstep`, ...), so `prng.js` is part of the published surface too.
The runner carries byte-identical copies as `gendata.mjs` + `prng.js`; parity is asserted by
`demo/js/robots/gen-fixture/harness.mjs` and by the runner's `test/facts-pack.test.mjs`.

## 4. scene_spec — procedural scene DSL

```jsonc
"scene_spec": {
  "environment": "grid",                 // grid | field | warehouse | water | rubble
  "environment_params": { },             // v1.1, OPTIONAL: arena dimensions (see 4.1)
  "scale": 1.0,                          // 0.3..3
  "units": [                             // 1..6 (fleet); each unit is one robot
    { "id": "bot1",                      // ^[a-z][a-z0-9_]{0,15}$, unique
      "archetype": "wheeled",            // wheeled | legged | arm | multirotor | marine
      "tint": "#2a6fd6",                 // body accent color
      "params": { },                     // per-archetype knobs, ALL optional + clamped (see below)
      "parent": "base1.body",            // v1.1, OPTIONAL: mount this unit on another unit's part
      "extra_parts": [                   // 0..12 decorative/functional primitives
        { "id": "kicker", "kind": "box", "size": [0.12,0.04,0.02],
          "pos": [0,0.05,0.2], "rot": [0,0,0], "color": "#cccccc", "parent": "body",
          "finish": "metal" }            // v1.1, OPTIONAL
        // kind: box | cylinder | sphere | torus | capsule | cone
        // finish: matte (default) | metal | rubber | glass | emissive
      ],
      "motion": { "kind": "waypoints", "loop": false,
                  "points": [ [x, z, tSec], ... ],              // 2..40 points
                  "yaw": "face:ball" }   // v1.1, OPTIONAL; absent = robot yaws toward travel
        // or   { "kind": "channels", "x": "/pose.x", "z": "/pose.z", "yaw": "/pose.yaw" }
        // or   { "kind": "static", "pos": [x, 0, z], "yaw": 0 }
    }
  ],
  "props": [                             // 0..8 non-robot objects (ball, payload, gate, rock)
    { "id": "ball", "kind": "sphere", "radius": 0.11, "color": "#f5f5f5", "finish": "matte",
      "motion": { "kind": "waypoints", "points": [...] } }
  ],
  "bindings": [                          // 0..24 channel→motion links, the "alive" layer
    { "part": "bot1.wheel_fl", "kind": "spin",   "axis": "x", "channel": "/drive.vel",  "gain": 6 },
    { "part": "bot1.body",     "kind": "glow",   "channel": "/sys.temp", "min": 40, "max": 90 },
    { "part": "arm1.j2",       "kind": "rotate", "axis": "z", "channel": "/joints.j2", "gain": 1 },
    { "part": "bot1.body",     "kind": "tilt",   "axis": "z", "channel": "/att.roll",  "gain": 1 },
    { "part": "drone1.rotor3", "kind": "wobble", "channel": "/motors.m3_vib", "gain": 0.5 }
    // kind: spin | rotate | tilt | glow | wobble | offset (translate by value*gain along axis)
  ],
  "camera": { "height": 2.2, "dist": 3.4, "focus": "bot1" }   // focus: unit id | "auto" (bbox)
}
```

Archetype part trees (fixed ids the interpreter guarantees, so `bindings.part` and `findings.highlight` resolve):
- `wheeled`: body, wheel_fl, wheel_fr, wheel_bl, wheel_br, one `<wheelId>_steer` per wheel (params: wheels 2|3|4|6, body_len/w/h, wheel_r, mast bool, mast_h, body_shape, front_flat, clearance, wheel_layout, wheel_angles, wheel_kind)
- `legged`: body, leg_fl..leg_br (hip+shin per leg), head (params: legs 4|6, body_len, stance, body_w, body_h, thigh, shin, crouch, splay)
- `arm`: base, j1..j6, gripper (params: joints 4..6, reach, mount, mount_h, span, pedestal bool; mount "gantry" adds rail + carriage, mount "pedestal" adds pedestal)
- `multirotor`: body, arm1..armN, rotor1..rotorN, skid_l, skid_r (params: rotors 4|6|8, span, hover_h)
- `marine`: hull, prop_l, prop_r, fin, mast (params: hull_len, beam, mast_h, sub bool; sub adds ballast + dive planes)

Param-driven id families, in full: `wheel_layout:"radial"` REPLACES the named wheel row with `wheel_1..wheel_N` (N = 3|4|6); every wheel id in either layout has a `<wheelId>_steer` sibling that parents it (`wheel_fl` is still the ROLL pivot, so an existing `spin` binding is unchanged, and `wheel_fl_steer` is the steer pivot a `rotate` binding drives without tumbling the roll integral).

Part refs are `"<unitId>.<partId>"` or a prop id. Hard caps enforced by the interpreter regardless of spec: ≤40 parts/unit, ≤6 units, ≤8 props, tri budget ≤50k total (interpreter downgrades segment counts to fit), all sizes clamped to [0.002, 5] world units.

Interpreter contract (browser-only): `buildSceneFromSpec(spec)` returns a `buildScene(THREE, mount)` per today's RobotDefinition: `{ update(tSec, data), setHighlight(partRef|null), dispose(), cameraHome }`.

`BUILT:` `mount` is a `THREE.Group` parented at the world origin, not a DOM node: `viewer.js` owns
the renderer, camera, lights, ground and grid, so `genscene.js` only ever touches scene graph.
`buildSceneFromSpec` never throws on a bad spec: unknown archetypes, kinds, axes and colours fall
back to a safe default, and every cap in this section is re-applied silently at construction
whatever the spec asked for (`SCENE_CAPS` in `demo/js/core/genscene.js`). `update()` allocates
nothing, because it runs inside the viewer's 60 fps rAF loop.

### 4.1 DSL v1.1 (ratified 2026-07-27): scene additions

**`spec_version` STAYS `1`.** Every addition below is an OPTIONAL key with an interpreter default
equal to today's behaviour, so a def written before v1.1 parses, validates and renders unchanged,
and a def written after it is still `spec_version: 1`. There is no v1.1 document shape to detect.
The one non-additive change is the size floor (G10), recorded in section 8.

The additions exist because five things a real robot IS could not be said at all: a round chassis,
an omni wheel ring, a heading that is not the direction of travel, an arena with a rulebook's
dimensions, and one robot mounted on another.

**wheeled chassis (G1).** `body_shape`: `"box"` (default) | `"cylinder"`; a cylinder takes its
diameter from `body_w` and its height from `body_h` and IGNORES `body_len`. `front_flat`: 0..0.45,
the fraction of the diameter cut away as a flat front face (the kicker/dribbler face). `clearance`:
0.002..0.08 m under the chassis, default 0.02, which is what the interpreter hardcoded before.

**wheeled drivetrain (G2).** `wheel_layout`: `"corners"` (default, today's fore/aft rows) |
`"radial"`, which yaws each wheel about the chassis centre and renames the row to
`wheel_1..wheel_N`. `wheel_angles`: one yaw in DEGREES per wheel, in `wheel_1..wheel_N` order,
each -360..360; defaults are `[33,-33,135,-135]` for 4 and `[0,120,240]` for 3. `wheel_kind`:
`"tyre"` (default) | `"omni"` (draws the roller ring) | `"caster"`. `wheels` accepts 3 under the
radial layout (2 remains corners-only; 4 and 6 are legal in both).

**steer pivots (G9).** every wheel id gains `<wheelId>_steer`, unconditionally and in both
layouts. The steer pivot PARENTS the roll pivot, so `{"part":"bot1.wheel_fl_steer","kind":"rotate",
"axis":"y","channel":"/steer.fl"}` is a real Ackermann or swerve angle instead of a second Euler
component fighting the roll integral.

**holonomic heading (G3).** waypoints motion takes an optional `yaw`. Absent is today's
force-yaw along the direction of travel. A **number** is a fixed heading in radians. A
**`"<path>.<key>"`** string reads the heading from telemetry. **`"face:<unitId|propId>"`** tracks
another object every frame. This is the difference between a differential base and a holonomic one:
an omni robot strafes sideways while its dribbler stays locked on the ball, and before v1.1 the
only way to say that was to burn pose fields out of the 6-channel budget.

**environment (G4).** optional `scene_spec.environment_params`, ignored when absent:
```jsonc
"environment_params": {
  "size": [2.19, 1.58],
  "markings": "soccer",
  "goal": { "width": 0.6, "height": 0.1, "depth": 0.074 },
  "goal_colors": ["#2f7dff", "#f2c500"],
  "walls": { "height": 0.22, "band": 0.12 },
  "wall_color": "#141414", "floor_color": "#1d5c34", "line_color": "#f2f2f2",
  "center_circle": 0.3,
  "penalty_area": { "depth": 0.25, "width": 0.8, "corner_r": 0.15 }
}
```

Every key is optional. These are the ONLY names; there are no aliases.

| key | type / range | absent means |
|---|---|---|
| `size` | `[length along z, width along x]` metres, each 0.5..80 | the 18 x 12 m layout the interpreter has always drawn |
| `markings` | `"soccer"` \| `"none"` | `"soccer"` |
| `goal` | `{ width 0.05..20, height 0.02..5, depth 0.02..5 }` metres, drawn at BOTH ends | no goals |
| `goal_colors` | `[hexA, hexB]`, indexed by END: `[-z end, +z end]` | yellow `#f2c318` at -z, blue `#2f78ff` at +z, which is the rule in every league that colours its goals |
| `walls.height` | 0..1.5 m perimeter wall | no wall; an explicit `0` also means no wall |
| `walls.band` | 0..0.5 m of floor between the boundary line and the wall (RCJ's outer area, stated at 12 cm) | 0, i.e. the wall stands on the boundary line, which is also legal |
| `wall_color` | hex | matte black `#15161a` |
| `floor_color` | hex | pitch green `#1b3a26`; it is also the horizon/fog colour, so the floor never ends in a seam |
| `line_color` | hex | the brand line colour |
| `center_circle` | circle RADIUS in metres, 0..20, or `null` | a radius of 0.183 x the short side. `null` is the explicit "this arena has no centre circle" and is NOT the same statement as an absent key |
| `penalty_area` | `{ depth 0.02..20, width 0.05..40, corner_r }` metres, or `null` | width 0.417 x the arena width, depth 0.083 x its length. `null` draws no penalty area at either end |
| `penalty_area.corner_r` | 0..0.5 m fillet on the box's two FRONT corners | the interpreter's scale heuristic: an arena 4 m or shorter gets rounded fronts (junior rulebooks mark them that way), a full-size pitch gets square ones. This is the one key whose absence is a fallback rather than a fixed default |

`size` is the MARKED playing area, boundary line included; `walls` and their `band` sit OUTSIDE it,
which is how every rulebook states a field. `size` also sets the floor extent for `warehouse`,
`water` and `rubble`. Getting the arena wrong is the first thing a domain expert checks, and a
handful of rulebook numbers is the whole fix.

**legged stance (G5).** `body_w` (default `stance*0.9`, so the torso stops being welded to the
stance), `body_h` (default 0.12), `crouch` 0..0.7 rad of knee bend in the rest pose with the foot
re-planted so body height is unchanged, `splay` 0..0.5 rad of outward roll for an insect sprawl.
Bindings capture the built node's `baseRot`, so a `rotate` binding composes on top of the rest pose.

**arm mount (G6).** `mount`: `"floor"` (default) | `"pedestal"` | `"gantry"` | `"wall"`;
`mount_h` 0..2.5 m; `span` 0.5..6 m (gantry rail length only). `mount:"gantry"` inverts the chain
so it hangs DOWN and adds the `rail` and `carriage` parts; the carriage is an ordinary pivot, so
an `offset` binding on axis x drives gantry traverse straight from a channel. The legacy
`pedestal: true` is still honoured and means exactly `mount: "pedestal"`; when both are present,
`mount` wins.

**unit parenting (G7).** optional `units[].parent`: `"<unitId>.<partId>"`. The child's root is
added to that part's pivot instead of the scene root, so it rides the parent (a manipulator on a
mobile base, a sensor mast on a quadruped) instead of two units hand-copying identical waypoints.
The child's own `motion` must be `"static"` and its `pos`/`yaw` are a LOCAL offset on that part.
**Depth is capped at 1**: a unit whose parent is itself parented is rejected, which makes cycles
structurally impossible without a graph walk. Self-parenting is rejected. The ≤6 unit cap counts
mounted units normally.

**primitives (G8).** `"cone"` joins the primitive kinds (base radius `size[0]`, height `size[1]`,
tapering to a point): sensor beams, nose cones, funnels, suction cups. Optional `finish` on
extra_parts AND props: `"matte"` (default, today's numbers) | `"metal"` | `"rubber"` | `"glass"`
(transparent, casts no shadow) | `"emissive"` (always-on indicator). A glass cone is a sensor
volume; there is deliberately no raw roughness/metalness/opacity, so no def can ask for an
invisible or blown-out part.

**previously unreachable params (G0).** `wheeled.mast_h`, `legged.thigh`, `legged.shin`,
`multirotor.hover_h`, `marine.beam`, `marine.mast_h`. The interpreter already implemented all six;
`schema.json`'s `additionalProperties:false` param list omitted them, so structured output stripped
them and a quadruped's leg proportions were whatever the default said. Schema-only fix.

New validator rule ids: `scene.wheel_angles`, `scene.unit_parent`, `scene.yaw_ref`. Everything else
reports on an existing id (`bounds.range`, `schema.enum`, `schema.additional`, `schema.pattern`,
`scene.part_unresolved`, `scene.channel_ref`).

`unit.params` stays FREE FORM at the validator: an unknown param key is `schema.json`'s problem, so
the next knob is a schema-only edit and never a validator release. What the validator checks is the
meaning of the keys the DSL does define.

## 5. findings

Exactly today's shape; 2..5 entries; ids unique `^[a-z0-9-]{2,24}$`:
```jsonc
{ "id": "clear-loss", "title": "Ball lost on defensive clear",
  "window": [49.5, 56.0], "t": 51.7, "severity": "alert",   // alert | warn | info
  "focus": { "channel": "/drive", "fields": ["vel","current"] },
  "highlight": "bot1.kicker",            // part ref or null
  "slowmo": true }
```
Storyline requirements (mirrors canned robots): exactly one `alert` headline failure with a begin/fail/recover arc in the data; ≥1 systemic slow-burn (`warn`, wide window); the headline failure must have a cross-channel root cause reachable in data_spec (coupling or correlated events); every finding's window must contain visible signal change in its focus fields (validator checks variance inside vs outside window).

## 6. chat + facts (live-chat-everywhere era)

```jsonc
"chat": {
  "first_question": "Why did we lose the ball at 51s?",   // ≤120
  "suggested": [ "...", "...", "..." ],                   // 3..4, ≤72 each
  "script": [                                             // 4..6 entries, OFFLINE FALLBACK path
    { "id": "why-clear-loss",                             // ^[a-z0-9-]{2,24}$, same as a finding id
      "matchers": ["ball","clear","lose","51"],           // 1..16, ≤48 chars each, single line
      "answer": "markdown ≤3000, may embed {{ev:clear-loss}}", "evidence": ["clear-loss"] }
  ]
}
```

`BUILT:` `script[].id` is `^[a-z0-9-]{2,24}$`, the SAME pattern as `findings[].id`. It was written
as `{2,32}` in the runner validator and `{2,24}` in the worker and in `schema.json`, which meant a
25 to 32 character id passed the deep gate and then 422'd at publish. One pattern now, in all
three. `matchers[]` are display-adjacent (they are echoed in Hugh's approval mail), so each one is
capped at 48 characters of single-line printable ASCII with no em or en dashes, enforced in the
runner validator, in `schema.json` and in the worker re-check.

Primary chat = live `POST /demo/api/chat` (`worker/chat.js`). `script[]` remains the no-API/offline
fallback and the validator still enforces: `matchEntry(first_question)` (shared matcher) hits an
evidence-bearing entry; every `suggested[]` matches some entry; every `{{ev:}}`/evidence id
resolves; every finding reachable from ≥1 entry.

`BUILT:` the facts-pack rebase point is CLOSED, and this is how it landed.

- The runner's `facts-pack.mjs` does not reimplement the pack. It imports this repo's own
  `worker/build-facts.mjs` out of its `runtime/` snapshot (refreshed by `sync-template.sh`), so a
  generated mission is described to the model in byte-compatible format with the canned missions.
- `buildFacts(def, data, all, opts)` grew a third `opts` hook alongside `analystContext` and
  `otherMissions`: **`aboutProduct`**. It replaces the trailing product section per pack rather
  than editing the shared `PERSONA` prefix, so correcting the public demo's mission-count line for
  a private mission costs no prompt-cache hit on the canned robots. All three default to the canned
  behaviour, so `facts.generated.js` is unchanged byte for byte by their existence
  (`worker/build-facts.mjs` `buildFacts`, and the freshness gate in `worker/README.md` proves it).
- Three sections differ for a generated mission: `## Analyst context` carries `def.facts_notes`
  verbatim; `## Other missions on this page` says the mission is private and points at the public
  demo page; the robot id is `g-<slug>`.
- Delivery: the pack is published in the SAME `POST /api/demo-gen/runner/publish` call as the def
  (`facts_json`, ≤256 KB), stored in the DO beside the bundle, and fetched per request by
  `worker/chat.js` `resolveRobot()` via `DemoGenDO.factsPack(slug)` when the posted robot id is not
  canned and matches `^g-[a-z2-7]{20}$`. `factsPack()` answers for `generated`, `approved` and
  `emailed`, one state wider than the def.json gate, so a demo Hugh is previewing from the confirm
  page has a working chat panel.
- Data for the pack is built with the same interpreter `validate.mjs` just ran, so every number the
  analyst can quote is a number that passed validation.
- A pack failure is logged and does NOT block publishing: the demo still renders and the chat panel
  falls back to `def.chat.script`.

## 7. Validation summary (normative for validate.mjs + worker re-check)

Schema (structural, additionalProperties:false) → bounds/charset post-parse (structured outputs can't enforce maxLength) → data build x2 determinism + shape/finite/monotonic/sample-count → coupling acyclicity → scene caps + every bindings.part/finding.highlight resolves against archetype part tables → findings variance-in-window check → chat matcher checks → facts_notes number cross-check (§7.1) → Arduino snippet method allowlist (`alloy.begin/describe/log/.set/end/wifi` only) in any script answer → display-string charset/length/em-dash. Failure messages must name the exact path + rule (they become retry notes).

Errors are `{ path, rule, message }` and the tests assert on the stable `rule` id, not the message
text. Rule ids in use: `schema.type`, `schema.required`, `schema.additional`, `schema.enum`,
`schema.pattern`, `schema.count`, `bounds.length`, `bounds.range`, `charset.ascii`,
`charset.em_dash`, `channels.coverage`, `channels.orphan`, `channels.duplicate`, `coupling.cycle`,
`coupling.unknown_source`, `base.contiguity`, `data.build`, `data.finite`, `data.monotonic`,
`data.sample_count`, `data.determinism`, `scene.part_unresolved`, `scene.caps`, `scene.channel_ref`,
`scene.camera_focus`, `findings.count`, `findings.window`, `findings.focus`, `findings.variance`,
`findings.storyline`, `chat.count`, `chat.first_question`, `chat.suggested`, `chat.evidence`,
`chat.reachable`, `arduino.method`, `facts.unverifiable_number`, and from v1.1 (section 4.1)
`scene.wheel_angles`, `scene.unit_parent`, `scene.yaw_ref`.

Scene RENDERING is deliberately out of scope for `validate.mjs` (it needs THREE and a browser):
part references are resolved against the part tables there, and the generated-demo smoke test owns
actually building the scene graph.

### 7.1 facts_notes number cross-check (BUILT: the rule as implemented)

`facts_notes` is the only prose in the def that reaches the live analyst as fact, so every number in
it must be derivable. `checkFactsNotes` in the runner's `validate.mjs` implements this as FOUR pools
in a deliberate order, tolerance `max(1% of the claim, 0.05)`:

1. **times** (exclusive): a token carrying a seconds unit (`s`, `sec`, `secs`, `second`, `seconds`)
   must lie inside the mission, `-0.05 ≤ v ≤ duration * 1.02`. **Nothing else can rescue it.** That
   exclusivity is the point: a plausible timestamp past the end of the log is the classic
   hallucination, and letting the value pools answer for it would let any unrelated field's reading
   excuse it.
2. **units**: a token carrying a unit some channel field declares ("215 V", "6300 rpm") must appear
   as an actual SAMPLE of a field with that unit. Not a range check.
3. **literals + statistics**: any literal written in `data_spec`, any finding window or cited
   instant, `duration`, `rate`, or any channel statistic (min/max/mean/first/last).
4. **derived**: `|gain| x` each declared coupling's source-field literals and statistics. The notes
   routinely narrate exactly this arithmetic ("gain -6.0 takes about 18 V off at the 3.1 A cruise")
   and it IS derivable from data_spec, so it is computed rather than waved through. Without this
   pool the first real generation failed on one token.

A unit word the def does not declare is not treated as a unit; the number is read as unitless.
Numbers welded to an identifier (`blue1`, `lag1`, `j2`, `BNO085`) are not claims and are skipped.
**Known limit:** a wrong-but-in-range timestamp is not catchable this way, only a timestamp outside
the mission is.

### 7.2 Worker re-validation (BUILT)

`validateDefStructural()` in `worker/demo-gen.js` runs again at publish time on the exact bytes that
will be stored, so no bundle can become servable without passing, whatever happens on the Mac. It is
deliberately structural only (shapes, bounds, regexes, a charset scan over every display string, a
finite-number walk capped at 12 levels of nesting) and does not build data or resolve part refs.
Hard limits it also enforces: `def_json` ≤128 KB, `facts_json` ≤256 KB, `spec_version === 1`, and
`refuse: true` is never publishable.

## 8. v1.0 clarifications (ratified 2026-07-27; interpreter behavior = normative)

Resolved during the reference implementation; all RATIFIED:
- Sample grid: `n = floor(duration*rate)+1`, `t[i] = i/rate`. "Total samples 500..60,000" = sum across ALL declared fields.
- Field stream seed: FNV-1a 32-bit over the string `"<seed>:<path>.<key>"` → mulberry32.
- Couplings read the source field's FINAL array (post-clamp), built in topological order; cross-rate sources resampled via `sampleAt`. lag1: `a = min(1, dt/tau)` on the target's grid, `y[0] = src[0]`.
- Events: spike sigma = `width/2`; burst decay tau = `width/3`, zero outside `[t, t+width)`; dropout freezes the last sample strictly before `t`; step holds until the next event of any kind.
- fbm noise amp is a half-range: `v += (sample(t*hz) - 0.5) * 2 * amp`.
- Display caps: channel field label ≤32, unit ≤16. En dash and horizontal bar banned alongside em dash.
- Param-driven part ids: wheels=2 → `wheel_l/wheel_r`; wheels=6 adds `wheel_ml/wheel_mr`; legged exposes `<leg>`, `<leg>_hip`, `<leg>_shin`; `mast`/`pedestal`/`sub` params add their named parts.
- Variance-in-window check: population variance per focus field, best field wins, inside/outside ratio ≥1.5, enforced for alert+warn; a window spanning ~everything passes trivially (acceptable — storyline rules still bind).
- "Cross-channel root cause": the alert finding's focus channel must be source or target of a channel-crossing coupling. "Wide window" slow-burn: ≥25% of duration.
- Arduino allowlist applies to every `.method(` call in every ```cpp fence (not only `alloy.`-prefixed).
- chat.script: **4..6 entries** (GENSPEC wins over the older 3-entry note elsewhere).
- Props accept `size` [x,y,z] or `radius`; any motion kind. Refusal shape rejects sibling keys.
- Interpreter motion semantics: `tilt` clamps to ±0.7 rad and `rotate` to ±π (degree-valued channels lean, never spin through the floor); `spin` is a cumulative integral of its channel so timeline scrubbing unwinds exactly (zero drift back at t=0); `glow` clones the part's material (shared materials must not co-glow). Sizes outside [0.002,5] are CLAMPED by the interpreter; the validator rejects only non-finite/non-positive.

**DSL v1.1, 2026-07-27 (all ratified; see section 4.1 for the full surface):**
- **Additive, `spec_version` stays 1**: `wheeled.body_shape/front_flat/clearance/wheel_layout/wheel_angles/wheel_kind`; `<wheelId>_steer` on every wheel; optional `yaw` on waypoints motion (number | `"<path>.<key>"` | `"face:<id>"`); `scene_spec.environment_params`; `legged.body_w/body_h/crouch/splay`; `arm.mount/mount_h/span` with `rail`+`carriage` under `mount:"gantry"`; `units[].parent` at depth 1; primitive kind `cone`; `finish` on extra_parts and props; and the six params the schema previously stripped (`mast_h`, `thigh`, `shin`, `hover_h`, `beam`).
- **COMPAT, not additive. `SCENE_CAPS.sizeMin` 0.01 → 0.002 (2026-07-27).** No def becomes invalid and no schema changed, but a def that specified a 2 to 10 mm part (marker discs, kicker plates, PCB stacks, dive planes) previously rendered it CLAMPED at 10 mm and now renders it true. On a 180 mm robot the old floor was a 67% error on exactly the parts a small-robot person looks at, so this is a visual improvement, and it is an accepted rendering drift on any bundle published before this date rather than a side effect of the chassis work. Taken consciously per the compatibility rule; the system had no approved bundles older than this week. The floor is NOT removed: a 0 or 1e-9 dimension is a z-fighting sliver and the floor is what stops it. `sizeMax` and every other cap are unchanged. `part-tables.mjs` and `genscene.js` must carry the same value.
- Radial wheel layout renames rather than extends: under `wheel_layout:"radial"` there is no `wheel_fl`, only `wheel_1..wheel_N`. A def that switches layout must move its bindings and highlights with it, and the validator says so (`scene.part_unresolved`).
- `arm.span` is bounded 0.5..6 only on an arm (the gantry rail); `multirotor.span` keeps its old unbounded-but-clamped meaning, because the two have never been the same quantity.
- `environment_params.center_circle` is a RADIUS, not a diameter.
- **`environment_params` key names were reconciled 2026-07-27.** The validator and the interpreter
  were built in parallel and shipped two vocabularies for the same block: the interpreter had
  `surface_color`, `wall: {height, band}`, `center_circle_r`, `goal.color_a/color_b` and
  `goal_area: [w,d]`, while the schema had `floor_color`, `walls`, `wall_color`, `center_circle`,
  `goal_colors` and `penalty_area`. The SCHEMA's names are canonical and section 4.1's table is the
  whole surface. NO legacy alias is accepted on either side: nothing had been published, so an
  alias would only have preserved a name that was never correct. Also fixed in the same pass:
  `goal_colors` is indexed by the END (`[-z, +z]`) as documented, where the interpreter had been
  reading it in build order and so painted the two ends the wrong way round.
- **ADDED `environment_params.walls.band`, 0..0.5 m (2026-07-27).** The outer area: floor between
  the boundary line and the wall. The interpreter always implemented it (RCJ states 12 cm) but the
  schema had no key for it, so no generated def could ask for it and every generated arena put its
  wall on the boundary line. Default stays 0, so nothing renders differently unless a def says so.
- **ADDED `environment_params.penalty_area.corner_r`, 0..0.5 m (2026-07-27), narrowed from the
  0..10 the schema first stated.** It is a fillet on the box's two front corners, not a penalty
  arc, so half a metre covers the whole real range and 10 m was a value no arena could use.
  `corner_r` is OPTIONAL and its absence keeps the interpreter's scale heuristic (arena ≤ 4 m long
  gets rounded fronts, longer gets square ones) rather than falling back to a fixed number, so a
  def that says nothing still gets the right-looking box for its league.
- **COMPAT, not additive. `legged.crouch` upper bound 0.6 → 0.7 rad (2026-07-27).** The
  interpreter's own rest-pose default is 0.62 rad and the validator's ceiling was 0.6, so the one
  value the interpreter actually ships could not be written down: a def that stated its real
  stance anywhere in 0.6..0.7 was REJECTED outright rather than clamped, and the only way through
  the gate was to declare a straighter leg than the robot has. That matters because the deck
  height is `(thigh + shin) * cos(crouch) * cos(splay) + footR` and the hips sit at deck height, so
  crouch is what plants the foot on y = 0 — under-declaring it is exactly the case the interpreter
  fixed when it stopped burying feet 120 mm under the floor, and the validator was reintroducing
  it from the other side. No def becomes invalid (the bound only widened) and `schema.json` carries
  the same 0.7.
- **TODO (open): part-tables consolidation.** The archetype part ids and scene caps still exist in
  two places: the runner's `part-tables.mjs` (which `validate.mjs` resolves `bindings[].part` and
  `findings[].highlight` against) and a hand-checked copy inside `demo/js/core/genscene.js`, marked
  `REBASE POINT` at the top of its tables block. They MUST NOT drift: the validator accepts a def on
  the strength of one table and the browser has to honour it with the other, and a divergence is a
  highlight that silently does nothing in the visitor's browser. Consolidating means moving
  `part-tables.mjs` into `demo/js/core/`, importing `archetypeParts` / `SCENE_CAPS` from it in
  `genscene.js`, and pointing the runner's `runtime/` snapshot at it. Not done yet.

## 9. Worked micro-example (validator fixture)

Two hand-written fixtures exist, neither ever model-emitted:

- `fixtures/minimal-rover.def.json` beside the runner's validator, the v1.0 baseline: a def that
  uses none of the v1.1 keys and must keep validating byte-for-byte clean.
- `fixtures/rcj-vision.def.json` beside it, THE v1.1 golden def and the acceptance case for
  section 4.1 — there is exactly one, and it lives here: a RoboCupJunior Soccer Vision match at
  real scale (1.58 x 2.19 m field, 22 cm matte black walls standing 12 cm outside the boundary
  line, 60 x 10 cm goals in blue at -z and yellow at +z, 25 x 80 cm penalty areas with 15 cm
  corners), four 18 cm cylindrical robots on radial omni wheels (two on four wheels, two on three,
  so both default angle tables are exercised) with a flat kicker face, a cone catadioptric mirror,
  4 mm white top-marker discs, all four yawed `"face:ball"` instead of along their track. It must
  pass `validateDef` with zero errors, render through the harness, and pass the browser smoke. If
  any of the three stops holding, v1.1 has regressed.
- 31 negative variants under `fixtures/negative/` that each isolate exactly one rule id, nine of
  them covering the v1.1 surface (wheel-angle count, radial ids, gantry ids, parent depth, parent
  motion, finish enum, param range, arena size, face target).
- `demo/js/robots/gen-fixture/def.json` in this repo, the loader and interpreter fixture, driven by
  `demo/js/robots/gen-fixture/harness.mjs` (`node demo/js/robots/gen-fixture/harness.mjs` from the
  repo root). It proves browser/runner interpreter parity, determinism across two builds, and that
  every binding and highlight in the fixture resolves against the built parts map. The directory is
  assetsignored and `demo/js/robots/index.js` does not know it exists.

## 10. Where a def is served from (BUILT)

A published bundle is not a directory of files. Exactly one path is servable per slug:

```
GET /demo/js/robots/g-<slug>/def.json
```

404 unless the job is `approved`; any other file under a real slug is a 404 too, so a bundle
directory can never become a general-purpose static host. A slug the DO has never heard of falls
THROUGH to the asset handler rather than 404ing, which is what keeps a committed fixture directory
addressable. `?preview=<approve token>` serves an unapproved bundle to whoever holds the signed
approval token and only to them, `no-store`. Approved responses carry
`Cache-Control: public, max-age=3600` plus `Cache-Tag: demogen-<slug>`, `nosniff` and
`Cross-Origin-Resource-Policy: same-origin`.

`BUILT:` **no cache purge is implemented.** The `Cache-Tag` header is emitted so a purge CAN be
wired later, but nothing calls the purge API today, so rejecting an already-approved demo deletes
the bundle row and 404s the origin while an edge that already cached the def keeps serving it for
up to one hour. That is an accepted residual: a reject almost always happens minutes after
generation, before any visitor has been given the link at all, and the window closes by itself.
Do not read the `Cache-Tag` header as evidence that a reject invalidates caches.

The loader composes the fetched def into a normal `RobotDefinition` (see `demo/DESIGN.md`), adding
`deviceId` (from `device_id`, so the faux ingest reads like the visitor's robot rather than a
mailing-list token) and `generated: true`. `buildData` ignores the prng `app.js` hands it: every
field's stream is rooted in the def's own `seed`, which is the seed the runner evaluated the same
spec with when it built the facts pack.
