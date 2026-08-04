# UX wall port plan (branch ux-wall-port)

Port of the approved UX wall (alloylogger-ux-wall revision e577865) into the live demo.
DESIGN.md remains the base contract; this plan governs where the two differ for the four
active missions. The wall supplies information architecture, interaction sequence, copy
hierarchy and responsive layout. Its placeholder SVG robot art is NOT ported: every robot
visual is the production Three.js scene, telemetry, motion and evidence.

## 1. Existing architecture map (discovery summary)

- Hash routes today: `#/` (doorway), `#/start` (role fork), `#/missions` (picker),
  `#/connect/:id` (brief), `#/demo/:id`. Router in `app.js` with navGen staleness,
  per-route teardown, transactional buildDemo, lazy `loadSceneData` continuations.
- Role model in `core/role.js`: hobbyist/engineer/lead/marketing, persisted in
  `alloy_demo_role`, super-property in PostHog, sent to `/demo/api/chat` and
  `/api/signup-lead`. Worker normalizes via `worker/roles.js`; role registers in
  `worker/chat.js` change answer altitude, never facts.
- Guided flow v1 (`core/guide.js` + `def.choreo.beats`): three-beat chat->chart->stage
  reveal for sbr/ssl/battle, keyed off the role table (`GUIDED_MISSIONS`). Superseded by
  this port for the four active missions; files retained.
- Core surfaces: timeline (loop/speed/seek), viewer (sceneApi contract: update,
  setHighlight, cameraHome, cameraFocus, followTuning, hudState, rendering; no projection
  or label machinery today), chart (channel/field chips, focus(finding) with
  failure-toned shading, no inline labels today), chat (streaming, script matching,
  guided helpers say/askScripted/addAction/announceBeat, role-aware live calls),
  signup (engagement trigger machine, 7-day cooldown, `/api/signup-lead`).
- Registry: `ROBOTS` array is BOTH picker order and route registry (7 missions).
  Facts packs for all 7. Eager gzip gates for ssl/battle/donna static graphs.
- Generated demos: GENSPEC v1 def.json is a published API; unknown top-level fields are
  rejected by the runner and dropped by `generated.js` composition. Canned
  RobotDefinitions accept new optional fields safely.

## 2. Route and flow state machine

New public route table (parseHash):

| Hash | Screen |
| --- | --- |
| `#/` | doorway: stored role -> `#/connect/<roleMission>/robot`; else `#/start` |
| `#/start` | seat fork |
| `#/missions` | mission library (4 cards) |
| `#/connect/:id` | legacy brief for non-experience defs (sbr, rescue, battle, g-*); experience defs redirect (location.replace) to `#/connect/:id/robot` |
| `#/connect/:id/robot` | step 1/4 Understand the robot |
| `#/connect/:id/mission` | step 2/4 Understand the mission |
| `#/connect/:id/failure` | step 3/4 See the failure |
| `#/connect/:id/choose` | step 4/4 Choose how to debug |
| `#/demo/:id` | demo shell; internal modes `chat` -> `proof` <-> `followup` (data-mode, not hash) |

Rules:
- Step routes are real hash routes: Back/Forward walk the steps; reload re-enters a step.
- A step route for a def without `experience` redirects to `#/connect/:id` (legacy).
- Unknown ids keep today's behavior (missions redirect / g-* load path).
- `?robot=` deep link keeps its semantics; for experience defs the "brief" destination is
  `#/connect/:id/robot`, and `alloy_brief_seen_<id>` keeps gating brief vs demo.
- navGen staleness and the loading-card pattern extend to step routes: entering
  mission/failure/choose (or demo) for a lazy def parks the loading card and awaits
  `loadSceneData()` with a generation-aware continuation. `robot` step runs on
  previewData when the full payload is not yet loaded (kick the load off in background).
- Teardown: one flow module owns all four step screens and disposes viewer/labels/RAF/
  listeners on exit; `show()` gains the new screen container; `screenState()` fixture
  helper updated to include it.

Demo internal modes (no new hashes, mirrors wall):
- `chat`: chat-first full-screen answer (composer bottom, single column).
- `proof`: replay + chart + composer (desktop: replay left, chart right-top, composer
  right-bottom; mobile: stacked replay/chart/composer). Entered from chat once the
  answer settles and evidence fires, or via "Show why".
- `followup`: full-screen chat again for a typed follow-up; the answer carries one
  "Show why" action which returns to `proof` with the relevant synchronized state.
  Conversation history and evidence context persist across mode switches (same chat
  instance, same timeline; mode is CSS/data-mode only).

## 3. Mission experience schema (backward compatible)

Optional per-def block, canned defs only. Never added to GENSPEC v1 or def.json.

```js
experience: {
  anatomy: {
    camera: { position:{x,y,z}, target:{x,y,z} } | null,  // default cameraHome
    rotation: 'orbit',            // slow deliberate orbit; reduced-motion = static pose
    heroT: <seconds> | undefined, // default stage3d heroTime(def)
    parts: [ { id, anchor, label, description } ]         // exactly 4
    // anchor resolves through sceneApi.anchors() (below)
  },
  success: {
    window: [a, b],               // real healthy passage; never overlaps failure finding
    camera: {...} | null,
    loopLabel: '...',             // e.g. "success loop"
    contextualLabels: [ { label, note? } ]  // mission-truth labels, role-invariant
  },
  failure: {
    findingId: '...',             // MUST resolve in def.findings
    camera: {...} | null,
    plottedFields: { channel, fields } | undefined  // default finding.focus
  }
}
```

- arm6/drone: `experience` set statically in `script.js` (no eager gate on them).
- ssl/donna: attached by their existing lazy side-module pattern (`applyGuided`-style,
  loaded with `loadSceneData`) so eager gzip gates stay green. A tiny static stub flag
  (`hasExperience: true`) marks them for routing before the payload lands.
- Generated g-* defs and sbr/rescue/battle have no `experience`: legacy flow, untouched.
- Facts builder does not read `experience`; facts:fresh stays byte-identical.

Scene anchor interface (optional, additive):
```js
sceneApi.anchors?.() -> { [partId]: () => THREE.Vector3 /* world position, posed NOW */ }
```
Backward compatible: viewer treats absence as "no anatomy support". update/setHighlight/
cameraHome/cameraFocus/dispose signatures unchanged. Viewer gains an anatomy overlay
(HTML cards + SVG leader lines) projected via `Vector3.project(camera)` every render
frame, so labels stay attached while the camera orbits or the robot moves; anchors
behind the camera or off-frustum hide their leader line. Wall layout keeps the four
cards in corner slots (2x2 rows on mobile); the leader lines tie each card to its
projected anchor per the build contract (wall art had none; task requires them).

## 4. File ownership (exclusive, one writer per path)

| Lane | Model | Paths |
| --- | --- | --- |
| SOL-A flow+shell | GPT-5.6 Sol | `demo/js/app.js`, `demo/js/core/flow.js` (new), `demo/js/core/start.js`, `demo/js/core/role.js`, `demo/index.html`, `demo/js/core/analytics.js`, `demo/js/robots/index.js` |
| SOL-B surfaces | GPT-5.6 Sol | `demo/js/core/chart.js`, `demo/js/core/chat.js`, `demo/js/core/signup.js`, `demo/js/core/flow-copy.js` (new) |
| OPUS-V viewer | Opus 5 | `demo/js/core/viewer.js`, `demo/js/core/stage3d.js` |
| OPUS-M1 | Opus 5 | `demo/js/robots/arm6/**` |
| OPUS-M2 | Opus 5 | `demo/js/robots/drone/**` |
| OPUS-M3 | Opus 5 | `demo/js/robots/ssl/**` |
| OPUS-M4 | Opus 5 | `demo/js/robots/donna/**` |
| SOL-T tests | GPT-5.6 Sol | `demo/js/robots/gen-fixture/*` (new gates + updates), `package.json` scripts |
| Fable | inline | this plan, arbitration, synthesis, final review |

CSS ownership: page and layout CSS (screens, steps, grids, breakpoints) lives in
`demo/index.html` (SOL-A). Component-scoped styles for surfaces owned by other lanes
(chart direct labels, chat modes, viewer anatomy overlay) are injected by their owning
module, following the existing `#v-shud-css` precedent in viewer.js. No lane edits
another lane's file for styling.

Worker files (`worker/*`) are NOT owned by any lane: no interface change was found that
requires touching worker or Durable Object code. `worker/roles.js` registers already
cover all four roles. If a lane believes it needs a worker change it must stop and
escalate to the orchestrator.

## 5. Anatomy definitions (4 parts each, real geometry only)

Copy below is the approved wall copy where the wall authored it (ssl); other missions
follow the same register. No em dashes anywhere.

### ssl (mandated set; anchors are real hull positions)
| id | anchor | label | description |
| --- | --- | --- | --- |
| omni | hull base ring of bot_y8 | Omni drive | Four wheels move in any direction without turning first. |
| imu | top plate centre | IMU | Tracks orientation while the controller closes the motion loop. |
| kicker | forward hull behind the dribbler mouth | Kicker bank | A 240 V capacitor bank stores the energy for each shot. |
| dribbler | dribbler face local point (DRIB_OFF) | Dribbler | A 25k rpm roller keeps the ball under control. |

The subject is one real robot (bot_y8, the mission's protagonist); anchors are computed
from its posed group transform. No wheel/kicker meshes are invented; anchors point at
the real hull regions those subsystems occupy, matching the channels the mission logs.

### arm6
| id | anchor | label | description |
| --- | --- | --- | --- |
| j2 | shoulder joint housing | J2 shoulder servo | Lifts the whole arm; the joint that saturates at 12 Nm. |
| gripper | roll group / TCP | Parallel gripper | Grips the part at the tool centre point; grip state is logged 0 or 1. |
| drv3 | drvBay electronics bay | J3 servo driver | The drive electronics whose temperature creeps during the run. |
| base | turret | Base turret | Rotates the arm between the two stations on q0. |

### drone
| id | anchor | label | description |
| --- | --- | --- | --- |
| m3 | motor 3 bell (rear-left) | Motor 3 | One of four brushless motors; each reports rpm and throttle. |
| battery | battery box | Battery | The 4S pack; voltage and current are logged at 25 Hz. |
| camera | gimbal lens | Survey camera | The mapping camera the lawnmower pattern exists to serve. |
| imu | body centre plate | Flight controller | Closes the attitude loop from roll, pitch and yaw. |

### donna
| id | anchor | label | description |
| --- | --- | --- | --- |
| head | donna:head | Stereo head | Two Basler cameras on the head pan-tilt find the ball. |
| imu | donna:torso | Torso IMU | Records the accelerations that tell a fall from a walk. |
| servos | donna:l_knee region (leg chain) | Leg servos | MX-106 servos drive the legs; diagnostics log their temperature and bus voltage. |
| compute | torso (lower) | Onboard compute | Each robot logs its own mission on the computer it carries. |

## 6. Success windows (real, authored, non-overlapping with failure)

| Mission | Window | Why |
| --- | --- | --- |
| arm6 | [26.0, 32.0] | Complete nominal cycle 5 (A to B and back), spans the hero pose at 30 s. Cycles are 6 s; fault cycle 9 starts at 50.0. |
| drone | [18.6, 27.7] | Full survey lane 1, before bearing wear begins at 32 s. |
| ssl | [0.5, 7.5] | First real live-play interval [0, 7.857] from kick-off; before every finding window (vision 22.5, dribbler 26, radio 30, kicker 46.3). |
| donna | [184.0, 190.0] | All three robots present, upright, unpenalized; Donna WALKING with a valid ball estimate; hero 187.6 inside; no fall within 5 s. |

Success screens show only the working mission: no error log, failure card, anomaly
shading, or failure-window chart treatment.

## 7. Failure findings (existing IDs, real windows)

| Mission | findingId | Window | Plotted fields (direct-labeled) |
| --- | --- | --- | --- |
| arm6 | drop | [52, 60] | /joints tau2, tau1, tau3 |
| drone | dip | [58, 66] | /pos alt |
| ssl | kicker-charge | [46.3376, 62.74] | /bot8/kicker kickerLevel, kickerMax |
| donna | jack-falls-foul-line | [145.878, 150.147] | /imu accelMagMps2, pitchDeg, rollDeg |

Failure step: synchronized replay (finding camera/highlight) + chart focused on the
finding window. Removed on this screen: timestamp readouts and the generic
reading/channel summary cards. Every plotted line gets a direct end-of-line pill label
with a short leader tick (chart.js addition), matching the wall.

## 8. Role x mission personalization contract

- Role routing (role.js): hobbyist -> arm6, engineer -> ssl, lead -> ssl,
  marketing -> donna, unknown/default -> arm6. Legacy aliases unchanged.
- The flow itself is identical for all roles; role changes COPY ONLY:
  step intro framing, failure implication line, debug comparison card copy,
  first question phrasing, follow-up phrasing, signup headline/body where the signup
  module already supports it. Mission truth (anatomy, windows, findings, telemetry,
  physics, scenes) is role-invariant.
- `core/flow-copy.js` (SOL-B) holds all 16 mission x role variants:
  `flowCopy[mission][role] -> { missionIntro, failureIntro, debugCards, firstQuestion,
  followUp }` with a `base` fallback per mission. Every variant must exist and be
  non-empty (gated).
- Analyst register stays worker-side (`worker/chat.js` registers, unchanged).
- Banned in all UI copy: meta-output labels ("Plain-language version", "Summary",
  "Analysis" as labels), em dashes.
- Disclosure discipline: ssl and donna card taglines and provenance surfaces keep their
  disclosure copy verbatim. The picker footer count changes truthfully for the 4-card
  roster ("Two synthetic missions, one real match replay with planted fault overlays,
  and one real match replayed from three robots' onboard logs. Runs entirely in your
  browser.") with the frozen-string tests updated to the new exact copy. The chat
  answers keep their claim-ledger-tested numbers; wall placeholder numbers are not
  ported.

## 9. Roster archive

- `robots/index.js` splits `ROBOTS_BY_ID` (all seven + generated) from a new
  `PICKER_ROBOTS = [arm6, drone, ssl, donna]` used by the picker and previews.
- sbr, rescue, battle: no picker card, no role routing, files/data/tests intact,
  direct routes `#/connect|demo/:id` still work through the legacy path.
- Generated g-* demos unchanged: legacy brief + legacy demo layout end to end.

## 10. Lifecycle and teardown contract

- One WebGL viewer context at a time on step/demo screens (picker previews keep their
  one-context rule). Steps robot/mission/failure reuse ONE flow-owned viewer instance
  across steps of the same mission (no context churn per step); it is disposed on
  leaving the connect-flow family or changing mission id.
- Timeline: flow owns a timeline for step screens (loop set to success/failure windows);
  demo route builds its own as today. No timeline leaks across routes (dispose on exit).
- Anatomy overlay: RAF-driven projection runs only while the robot step is live; it is
  removed with the viewer. Route churn leaves zero contexts, RAFs, observers, listeners
  (existing corrupt-meta leak harness extended to the step screens).
- Reduced motion: anatomy renders a static hero pose with labels attached (single
  projection pass, re-projected only on resize); success step renders a posed frame
  with a play affordance instead of auto-looping; step transitions drop animation.
- No WebGL: steps fall back to the SVG line art (existing picker fallback assets) with
  the same copy and CTAs; flow remains completable.

## 11. Verification matrix

New gates (SOL-T), following the browser-fixture pattern:

| Gate | Asserts |
| --- | --- |
| test:flow-roster (node) | PICKER_ROBOTS exactly [arm6, drone, ssl, donna]; ROBOTS_BY_ID retains all seven; role map matches Section 8 |
| test:flow-copy (node) | 16/16 variants exist, non-empty; no meta-output labels; no em dashes in any flow/step/UI copy including experience blocks |
| test:experience (node) | per active mission: exactly 4 anatomy parts whose anchors resolve against the scene anchor map; success window inside [0,duration], non-overlapping the selected failure finding window; failure findingId resolves; plottedFields subset of the finding channel fields; direct labels match plotted fields |
| test:flow-walk (browser) | full walk seat -> missions -> 4 steps -> chat -> proof -> followup at 1440x900 and 390x844; one primary CTA per step (DOM count); role variants via DOM assertions for all 16 combos (localStorage role x mission); success step shows no failure UI (no .evidence-on, no alert shading, no finding banner); failure step has no timestamp/summary cards; proof shares TimelineStore (window.__demo timeline identity); followup Show why returns to proof with loop window set; generated-demo fixture falls back to legacy brief; reduced-motion and no-WebGL walks; no horizontal overflow at 390x844; console clean |
| test:flow-leaks (browser) | step/route churn: WebGL context live count flat, no orphan RAF/observers/listeners (corrupt-meta probe pattern) |
| visual captures (script, not in npm test) | 24 captures: 4 missions x {anatomy, success, failure} x {390x844, 1440x900}; per capture: pixel-variance frame difference across two timestamps (motion proof), timeline window assert, highlight assert, chart domain assert, console clean |

Existing suite: full `npm test` + `facts:fresh` must pass. Known updates required:
`ssl-preview-fallback` (7 -> 4 cards), frozen footer strings in ssl/battle/donna script
tests (new truthful count), `role-registers.test.mjs` (rewritten to assert the
experience/flow-copy contract instead of choreo beats for role missions; choreo
integrity checks retained for defs that still carry choreo), `ssl-chart-absence` (its
`.guide-cta` driver updated to the flow CTA selector). Any other test that fails must be
understood before it is edited; data/claim/deident/eager-size gates must pass unmodified
(experience config for ssl/donna rides the lazy side modules).

Baseline note: on clean main, 1657/1658 checks pass; the single failure is the donna
decode p95 perf gate under heavy parallel machine load; re-verified on a quiet machine
before delivery.

## 12. Assumptions recorded (no pause needed)

1. Wall's seat-fork "Continue" pattern replaces tap-to-advance: radio select + one
   Continue CTA. Escape link ("Just exploring...") is retained beneath as a secondary,
   non-primary affordance, consistent with "one primary action".
2. Wall's signup takeover frame shows a ghosted CTA and no dismissal; that state is a
   mock artifact and is NOT ported. The existing signup module (copy, close X, Escape,
   focus trap, cooldown, endpoint, analytics) is reused as-is; role headline variants
   only where signup.js already supports them.
3. Wall's ssl mission-library tagline ("Six autonomous robots playing a live soccer
   match") would delete a disclosure surface and misstate the replay as live; the card
   keeps its disclosure tagline. Wall titles are adopted ("6-axis pick and place",
   "Survey quadcopter", "SSL soccer fleet", "Donna, Jack & Rory").
4. Wall answer-card voltages (236/179/21 V) are placeholder; production keeps the
   claim-tested script copy.
5. "Choose how to debug" comparison durations ("~1 day", "Hours", "5 min") are adopted
   as approved copy; per-role emphasis handled in flow-copy variants.
6. Old guide.js three-beat flow is retired for the four active missions but left
   functional for defs that still declare choreo and sit in GUIDED_MISSIONS (none after
   the role-map change); fallbackOpener remains the legacy path.
7. Step screens live in one new static container `#screen-flow` (renaming avoided:
   existing four containers keep their ids).
8. `?robot=` continues to honor `alloy_brief_seen_<id>`; a seen brief goes straight to
   `#/demo/:id` (chat mode), matching current behavior.

## 13. Sequencing

1. SOL-A lands the flow skeleton: routes, `#screen-flow`, flow.js state machine, picker
   4-card roster, role remap, redirects, analytics events, with arm6 static
   `experience` stub wired end to end (placeholder anchors OK).
2. In parallel after the skeleton commit: OPUS-V (viewer anchor overlay + camera modes +
   neutral banner), SOL-B (chart direct labels + focusWindow + chat/signup mode
   plumbing), OPUS-M1..M4 (per-mission experience + anchors + side modules).
3. SOL-A integrates, SOL-T writes gates, full suite + browser QA + captures.
4. Adversarial review, fixes, delivery.
