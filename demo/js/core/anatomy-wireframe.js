// core/anatomy-wireframe.js - the anatomy step's solid-to-wireframe treatment, for a robot this page
// builds procedurally rather than reads out of CAD.
//
// WHY THIS EXISTS. Round 8 gave the SSL mission a transparent feature-edge drawing of its robot on the
// one screen that asks a visitor to look AT the machine, and the reason it worked is not that the
// geometry was real CAD. It is the grammar: three of four cards on that step name something INSIDE the
// hull, and no camera can see inside a solid, so the whole machine is drawn faint and the part the live
// card names is the one thing drawn solid. That grammar is not specific to a wheel base. The arm's
// driver bay, the quad's flight controller and pack, Donna's IMU and onboard computer are all parts
// under bodywork with a card pointing at them from outside, which is the same failure with three more
// machines on it. So round 9 extends the treatment to all four missions, and this module is the half
// that is not mission-specific: build a wireframe replica of a robot that is already in the scene, run
// the intro, light the live part, and put everything back on the way out.
//
// WHY IT STARTS SOLID. Hugh's round 9 note, and it is a note about what a visitor has been shown. Open
// the step on a transparent drawing and the machine was never established: the first solid thing anyone
// sees of the robot is one lit part floating inside a ghost of it. So the step opens on the OBJECT.
// Phase A holds the scene's own solid robot for SOLID_HOLD_MS, which is the machine as every other step
// in the mission draws it. Phase B brings the drawing up over that solid across FADE_MS, and the solid
// steps aside on the frame the drawing is fully there. Phase C is the round 8 picture, and only then
// does the live part light - the viewer holds its own halo back until `settled()` for the same reason.
//
// WHOSE MOTION IT IS, which is the hard constraint this file is shaped by. The solid robot is the
// SCENE's: its materials are shared with the picker preview, the mission loop, the failure step and
// the chat replays, and fading them here would be this step reaching into four others. So the motion
// is entirely the replica's - the wireframe fades IN over a solid nobody touched, and the only thing
// ever done to the scene's own meshes is one `visible = false` on the settle frame, restored verbatim
// on dispose. Everything that animates is a material this module made and disposes.
//
// The fade draws with depth testing OFF and turns it back on at the settle. That is not a cosmetic
// choice: with depth testing on, a drawing fading in UNDERNEATH the solid it is a drawing of is hidden
// by that solid at every pixel, so the whole transition is invisible and the settle frame reads as a
// cut. Off, the drawing comes up over the machine and the machine dissolves out from under it, which is
// the x-ray reveal the note asked for. On at the settle, so the finished drawing is a transparent robot
// standing in a real scene - occluded by the pitch, the pads, the field - rather than an overlay
// floating over one.
//
// WHOSE CLOCK. The viewer's, and only the viewer's. It calls `step(nowMs)` once per rendered frame
// while the step is open, the first call is t0, and this module owns no rAF, no timer and no
// `Date.now()`: one clock means the intro cannot drift against the tour's beats, the camera drift or
// the halo, and leaving the step mid-intro is a dispose with nothing to cancel. A `setSubject` that
// arrives during the intro - the first beat is live long before the fade is done - is REMEMBERED and
// applied on the settle frame.
//
// THE TWO TIMINGS ARE DUPLICATED in `robots/ssl/rtt-model.js`, deliberately. That module is behind the
// SSL mission's lazy boundary, which `ssl-eager-size.test.mjs` holds under 60 KB with 96 bytes spare;
// importing constants across the two would either pull this file into that graph or that file into
// this one. Two numbers stated twice is the cheaper honesty.
//
// WHAT A DEF HAS TO TELL IT. This module knows nothing about any mission, so `installWireframe` is
// handed the little a def does know:
//
//     opts = { robot: string | string[], edgeAngle?: number }
//
//   robot      the NAME of the object under `mount` whose subtree is the machine, or several. Only
//              that subtree is drawn: a wireframe of the floor, the pads, the pitch, the payload or
//              the flown track is a drawing of a room, not of a robot.
//   edgeAngle  the dihedral angle above which a facet boundary becomes a drawn line, in degrees.
//
// and two things the scene marks on its own objects, because they are facts about that scene's graph
// rather than about this step:
//
//   obj.userData.anatomyPart = partId   this mesh belongs to the part a tour card names, so it is
//                                       drawn in the brighter register and is what `setSubject()`
//                                       lights. Stamped where each scene already builds its
//                                       `partMeshes()` map, so the two cannot disagree.
//   obj.userData.anatomySkip = true      leave this subtree exactly as the scene draws it: neither
//                                       replicated nor hidden. For the things that are readouts
//                                       rather than machine - a prop's blur disc, whose opacity and
//                                       scale are written every frame from logged rpm.
//
// THE VIEWER'S OWN GLOW SHELLS, and what happens to them, because it is a real consequence and not an
// oversight. The viewer sleeves a lit part in an additive copy of its meshes, parented TO those meshes
// (`viewer.js`, `glowFor()`), and those copies are marked `userData.viewerGlowShell` so this module
// neither draws them nor hides them - a shell drawn as edges would double every line on the live part.
// A shell does ride its part, though, so once the part is hidden the shell is hidden with it, and from
// the settle frame on the highlight is carried by the two layers that are visible: the part drawn solid
// and emissive in here, and the viewer's anchored halo. That is exactly the highlight the SSL mission
// has shipped since round 8, where the scene offers no mesh handles and there are no shells at all.
//
// FAILURE COSTS NOTHING, which is the same contract round 8 shipped. A missing robot name resolves to
// null and the step keeps the solid robot it already had, with its tour, its cards, its leader lines
// and its halo all working. The viewer swallows a rejection for the same reason.

/**
 * A visitor who has asked for less motion gets round 8's step: the drawing, immediately, with the live
 * part lit as soon as a beat says so. The intro is the thing that is skipped, not the content - nothing
 * in it carries information a card does not also say.
 *
 * Asked here rather than imported from `stage3d.js`, which is where every other stage on this page
 * reads it, and the reason is that this module has no other dependency: nothing in it needs the
 * viewer, the flow, a mission or three.js itself as an import, so it stays a file that can be reasoned
 * about and exercised on its own. `robots/ssl/rtt-model.js` answers the query the same way for the same
 * reason, one lazy boundary over.
 */
function prefersReducedMotion() {
  try {
    return !!(
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

/**
 * How faint each layer is. Two registers, and the split is the point: the meshes a tour card names
 * carry the drawing, and the rest of the machine is the context they hang on. A hull drawn at the same
 * weight as the parts inside it is a box with a smudge in it.
 *
 * The exact weights, colours and grammar of `robots/ssl/rtt-model.js`, because these are two halves of
 * one treatment: a visitor who sees the arm's drawing and then the SSL robot's should be looking at the
 * same page, not at two people's idea of a wireframe.
 *
 * The fill does not write depth, so the model does not occlude itself and every layer shows through
 * every other layer - which is the whole reason a wireframe answers a card about a part inside a hull.
 */
const LOOK = {
  hull: { fill: 0.045, line: 0.3 },
  part: { fill: 0.075, line: 0.46 },
};
/**
 * How far every NON-live register drops while a card has a part live, as a factor on the settled
 * weights above. Round 9.2, and the reason is hue rather than brightness. The live part is instrument
 * blue and the drawing it sits in is a cool blue-white, so a visitor is being asked to find a highlight
 * that is the same hue as its context at nearly the same weight - which is not a thing an eye does,
 * least of all on a busy drawing. The only channel left is VALUE, and the cheap half of a value gap is
 * at the bottom of it: so a beat dims the drawing rather than shouting over it, and the part is the
 * brightest thing on screen because everything else stepped back. 0.45 puts the hull at 0.020 fill and
 * 0.135 line and the named parts at 0.034 and 0.207: the machine still reads as a machine, which is the
 * entire reason it is drawn, but it now reads as the drawing the part sits in.
 *
 * A factor rather than a second table, because a factor composes. The intro's ramp owns these opacities
 * all the way up through Phase B; this only ever multiplies the SETTLED ones, from the settle frame on.
 * Same name and same value in `robots/ssl/rtt-model.js`.
 */
const CONTEXT_DIM = 0.55;
const LINE_COLOR = 0x9dc0e6; // the demo's line grammar: a cool near-white, not a saturated accent
const FILL_COLOR = 0x86aacd;
// The live part. Instrument blue, the same channel and the same colour the anatomy tour's halo uses
// (`viewer.js`, "part highlight"), so the halo and the solid part read as one statement rather than as
// two things that happened to light up together. NOT the alert red a scene paints a FAULT highlight:
// nothing is wrong with any of these robots on this step.
const LIVE_EMISSIVE = 0x8ec6ff;
// One value step up from round 9's 0x1c2734, at the SAME hue (210 degrees) and the same saturation
// (0.31), which is the point: the part separates by being lighter than its context, not by a second
// colour walking into the picture. Still a dark body, because the emissive above it and the beat's
// additive halo both have to land on this surface without taking the surface detail off it.
const LIVE_BODY = 0x263548;
/**
 * The dihedral angle above which a facet boundary becomes a drawn line, in degrees.
 *
 * 24, and the reason it is lower than the 26 the CAD reader uses is that these robots are cleaner
 * geometry. A procedural machine is boxes, cylinders and tori at 12 to 36 segments: its real edges -
 * plate outlines, a bell's rim, a bay's fins, a knee bracket - are 90 degree corners, and the facet
 * boundaries on its curved surfaces sit at 10 to 30 degrees, where a tessellated CAD import's sit at
 * 45 to 60. Judged on the fill-to-line balance at the tour's stand-off: under about 18 the cylinders
 * turn into drawn prisms and the machine reads as mesh, over about 30 the smaller cylinders lose their
 * end caps and a motor bell stops reading as round at all. 24 draws the corners and leaves most of the
 * faceting of a smooth curve alone. A def may override it for geometry that wants otherwise.
 */
const EDGE_ANGLE = 24;

/** Phase A: the robot reads as a normal solid machine for this long. */
const SOLID_HOLD_MS = 1500;
/** Phase B: and the drawing comes up over it across this. */
const FADE_MS = 900;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Smoothstep, so the drawing arrives without a visible start or stop to the ramp. */
const ease = (k) => k * k * (3 - 2 * k);

/**
 * The named subtrees this drawing is of.
 *
 * @param {import('three').Object3D} mount the viewer's robot root
 * @param {string|string[]} want one name, or several
 * @returns {import('three').Object3D[]}
 */
function resolveRoots(mount, want) {
  if (!mount || !want) return [];
  const names = Array.isArray(want) ? want : [want];
  const out = [];
  for (const n of names) {
    const found = typeof n === 'string' && n ? mount.getObjectByName(n) : null;
    if (found && out.indexOf(found) < 0) out.push(found);
  }
  return out;
}

/**
 * Build a feature-edge wireframe of a robot that is already in the scene, hold it back for the intro,
 * and hand the viewer the frozen display-model handle.
 *
 * @param {object} THREE the three.js module the viewer built the scene with
 * @param {import('three').Group} mount the viewer's robot root
 * @param {{robot: string|string[], edgeAngle?: number}} opts see the header
 * @returns {Promise<{
 *   setSubject: (partId: string|null) => void,
 *   step: (nowMs: number) => void,
 *   settled: () => boolean,
 *   dispose: () => void,
 * }|null>}
 */
export async function installWireframe(THREE, mount, opts) {
  const roots = resolveRoots(mount, opts && opts.robot);
  // No machine to draw: the scene has not built its robot yet, or the name moved. Either way the solid
  // robot is what the visitor keeps, and the step is fully working with it.
  if (!roots.length) return null;
  const edgeAngle =
    opts && Number.isFinite(opts.edgeAngle) && opts.edgeAngle > 0 ? opts.edgeAngle : EDGE_ANGLE;

  // ---------------------------------------------------------------- the sources
  //
  // The machine as it is DRAWN on the frame this installs on, which is why an invisible mesh is
  // skipped rather than replicated: a quad's alert halo and a robot that is off the pitch are meshes
  // the scene is deliberately not showing, and a wireframe of them would draw hardware that is not
  // there. It also keeps the restore honest - the only visibility flags this module ever writes are
  // ones it found true.
  const sources = [];
  const walk = (obj, inherited) => {
    if (!obj || obj.visible === false) return;
    const ud = obj.userData || null;
    if (ud && (ud.anatomySkip === true || ud.viewerGlowShell === true)) return;
    const part = ud && typeof ud.anatomyPart === 'string' ? ud.anatomyPart : inherited;
    // Plain meshes only. An InstancedMesh or a SkinnedMesh does not pose from its own matrix, and a
    // sprite has no edges: both would draw a wireframe somewhere the machine is not.
    if (obj.isMesh && !obj.isInstancedMesh && !obj.isSkinnedMesh && obj.geometry) {
      sources.push({ obj, part: part || null });
    }
    const kids = obj.children;
    for (let i = 0; i < kids.length; i++) walk(kids[i], part);
  };
  for (const r of roots) walk(r, null);
  if (!sources.length) return null;

  // ------------------------------------------------------------- what we own
  //
  // Materials and edge geometries, and nothing else. The faint fill SHARES the source mesh's own
  // geometry, which is the same trick the viewer's glow shells use: it is the right shape by
  // construction, it already carries the normals the live part needs to be lit by the scene's rig, and
  // it costs no memory. It is also the one thing here that must never be disposed - it belongs to the
  // scene, which will draw it again on every other step of the mission.
  const owned = [];
  const keep = (o) => {
    owned.push(o);
    return o;
  };
  const mkFill = () =>
    keep(
      new THREE.MeshBasicMaterial({
        color: FILL_COLOR,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
        side: THREE.FrontSide,
      }),
    );
  const mkLine = () =>
    keep(
      new THREE.LineBasicMaterial({
        color: LINE_COLOR,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
      }),
    );
  // Four materials for the two registers, shared by every piece, plus two for the live part, because a
  // piece is only ever in one of two states and at most one part is live at a time. All four open at
  // opacity 0 with depth testing off, which is the fade's starting state: Phase A draws none of this,
  // and Phase B has to be visible over the solid it is coming up on top of.
  const mat = {
    hullFill: mkFill(),
    hullLine: mkLine(),
    partFill: mkFill(),
    partLine: mkLine(),
    liveFill: keep(
      new THREE.MeshStandardMaterial({
        color: LIVE_BODY,
        emissive: LIVE_EMISSIVE,
        // 0.36, held identical to rtt-model.js. Round 9 pulled this to 0.3 in step with the halo's
        // locator weights in viewer.js and the part went too quiet to find, so round 9.2 gives a fifth
        // of it back - a nudge, not a reversal, because the legibility this round buys comes mostly
        // from CONTEXT_DIM taking the drawing down and not from the part getting louder. The ceiling is
        // unchanged: the beat's halo is additive and lands on the same part, so the two sum, and higher
        // blows the middle of the live part out to white at exactly the moment a card asks a visitor to
        // look at its surface.
        emissiveIntensity: 0.36,
        roughness: 0.44,
        metalness: 0.25,
      }),
    ),
    liveLine: keep(
      new THREE.LineBasicMaterial({
        color: 0xe4f0ff,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      }),
    ),
  };
  // The four materials the fade ramps, each with the weight it ramps to.
  const FADED = [
    { m: mat.hullFill, w: LOOK.hull.fill },
    { m: mat.hullLine, w: LOOK.hull.line },
    { m: mat.partFill, w: LOOK.part.fill },
    { m: mat.partLine, w: LOOK.part.line },
  ];

  // ------------------------------------------------------------- the replica
  //
  // Each piece is parented under the SAME parent as its source mesh, with the same local transform.
  // That is what makes articulation free: a shoulder swinging, a turret yawing, a prop group turning,
  // Donna's recorded pose and the quad's whole airframe are all transforms on GROUPS above these
  // meshes, so the drawing poses itself off the scene's own `update()` and nothing here runs per frame
  // but the intro.
  //
  // The host is the nearest ancestor that is not ITSELF being replicated, and the piece's transform is
  // the chain down to the source composed into one local matrix. In these three scenes that ancestor is
  // always the source's own parent and the composition is the identity case, but a mesh bolted to
  // another mesh is a perfectly ordinary way to build a machine, and hanging its drawing off a parent
  // this module is about to hide would be a piece that vanishes with it.
  const sourceSet = new Set(sources.map((s) => s.obj));
  const local = new THREE.Matrix4();
  const pieces = [];
  const byPart = new Map(); // partId -> pieces
  for (const src of sources) {
    const obj = src.obj;
    if (!obj.parent) continue;
    obj.updateMatrix();
    local.copy(obj.matrix);
    let host = obj.parent;
    while (host && sourceSet.has(host)) {
      host.updateMatrix();
      local.premultiply(host.matrix);
      host = host.parent;
    }
    if (!host) continue;
    const faint = !src.part;
    const fill = new THREE.Mesh(obj.geometry, faint ? mat.hullFill : mat.partFill);
    const edge = new THREE.LineSegments(
      keep(new THREE.EdgesGeometry(obj.geometry, edgeAngle)),
      faint ? mat.hullLine : mat.partLine,
    );
    for (const o of [fill, edge]) {
      local.decompose(o.position, o.quaternion, o.scale);
      o.castShadow = false;
      o.receiveShadow = false;
      // A part 20 mm across on a machine drawn from 1.6 m: a piece whose bounding sphere grazes the
      // frustum for one frame is not worth a culling test that can pop a layer out of a drawing.
      o.frustumCulled = false;
      o.visible = false; // Phase A draws the scene's solid robot and nothing else
      host.add(o);
    }
    fill.renderOrder = 3;
    edge.renderOrder = 4;
    const piece = { obj, fill, edge, faint, wasVisible: obj.visible };
    pieces.push(piece);
    if (src.part) {
      const list = byPart.get(src.part) || [];
      list.push(piece);
      byPart.set(src.part, list);
    }
  }
  if (!pieces.length) return null;

  // ------------------------------------------------------------------ the intro
  let started = false;
  let t0 = 0;
  let isSettled = false;
  let live = null;
  let pending = null; // a subject handed over during the intro
  let hasPending = false;

  /**
   * Scale the two faint registers against their settled weights. `f` is 0 to 1, and it has two callers
   * with two meanings that happen to want the same arithmetic: the intro ramps it 0 to 1 across Phase B,
   * and from the settle frame on `applySubject` holds it at CONTEXT_DIM or 1 depending on whether a card
   * has a part live.
   */
  function setFade(f) {
    for (const e of FADED) e.m.opacity = e.w * f;
  }

  let shown = false;
  function showReplica(on) {
    if (shown === on) return; // once, on the frame the fade starts, and not on every frame of it
    shown = on;
    for (const p of pieces) {
      p.fill.visible = on;
      p.edge.visible = on;
    }
  }

  /**
   * Draw one part solid, or none, and recede everything that is not it. Off the viewer's `setSubject`
   * channel, so the card, the leader line, the halo and this all change on one frame.
   *
   * Only ever reached from the settle frame on: `settle()` calls it after it has flipped `isSettled` and
   * run `setFade(1)`, and `setSubject()` remembers instead of calling until then. That ordering is what
   * keeps the dim out of Phase B, where the ramp alone owns these opacities.
   */
  function applySubject(id) {
    if (id === live) return;
    const prev = byPart.get(live);
    if (prev) {
      for (const p of prev) {
        p.fill.material = mat.partFill;
        p.edge.material = mat.partLine;
        p.fill.renderOrder = 3;
      }
    }
    live = byPart.has(id) ? id : null;
    const next = byPart.get(live);
    if (next) {
      // Opaque and depth-writing, unlike everything else here: the live part occludes the drawing in
      // front of it, which is what makes it read as a solid object inside a diagram rather than as one
      // more transparent layer that happens to be brighter.
      for (const p of next) {
        p.fill.material = mat.liveFill;
        p.edge.material = mat.liveLine;
        p.fill.renderOrder = 5;
      }
    }
    // And the context steps back for it. The four faint materials are SHARED by every piece that is not
    // live, so one `setFade` recedes the entire drawing in O(1) and cannot touch the part: the live
    // pieces were just swapped onto `liveFill`/`liveLine`, which are deliberately not in `FADED`. A null
    // from the tour restores the settled weights on the same frame.
    setFade(live ? CONTEXT_DIM : 1);
  }

  /**
   * Phase C, in one frame: the drawing at full weight, depth testing back on, the scene's own solid
   * robot out of the picture, and the part the live card names lit at last.
   */
  function settle() {
    if (isSettled) return;
    isSettled = true;
    showReplica(true);
    setFade(1);
    // Depth testing back on: the finished drawing is a transparent robot standing in a real scene, so
    // the pitch, the pads and the field in front of it occlude it correctly. It was off for the fade
    // only, so the drawing could be seen coming up over the solid it is a drawing of.
    for (const e of FADED) e.m.depthTest = true;
    // The one write this module ever makes to the scene's own graph, and the frame it makes it on is
    // the frame the drawing is already fully there, so nothing flickers. Restored verbatim on dispose.
    for (const p of pieces) p.obj.visible = false;
    if (hasPending) {
      hasPending = false;
      applySubject(pending);
    }
  }

  function step(now) {
    if (isSettled || !Number.isFinite(now)) return;
    if (!started) {
      started = true;
      t0 = now;
      return; // the first call IS t0, and t0 is the top of Phase A: there is nothing to draw yet
    }
    const t = now - t0;
    if (t < SOLID_HOLD_MS) return; // Phase A: the machine, exactly as the scene draws it
    const k = clamp01((t - SOLID_HOLD_MS) / FADE_MS);
    if (k >= 1) {
      settle();
      return;
    }
    showReplica(true);
    setFade(ease(k));
  }

  function setSubject(id) {
    // Remembered, not applied: a part drawn solid inside a machine that is still solid is not a
    // highlight, it is a colour change on some bodywork. The settle frame applies it, which is the same
    // frame the viewer's halo comes up.
    if (!isSettled) {
      pending = id || null;
      hasPending = true;
      return;
    }
    applySubject(id || null);
  }

  function dispose() {
    for (const p of pieces) {
      // Verbatim, and unconditional: a piece the settle never reached is written back the value it was
      // found with, so leaving the step mid-intro leaves no visibility change behind at all.
      p.obj.visible = p.wasVisible;
      if (p.fill.parent) p.fill.parent.remove(p.fill);
      if (p.edge.parent) p.edge.parent.remove(p.edge);
    }
    // Every edge geometry and every material this module made. The fills' geometry belongs to the
    // scene and is deliberately not in here.
    owned.forEach((o) => o && typeof o.dispose === 'function' && o.dispose());
    owned.length = 0;
    pieces.length = 0;
    byPart.clear();
  }

  // Under reduced motion there is no intro to run: the step is installed in its settled state and
  // `settled()` is true from the first frame, whether or not `step()` is ever called. That last part is
  // load-bearing rather than tidy - the tour does not start under reduced motion, and a drawing that
  // needed a clock to appear would simply never appear on that path.
  if (prefersReducedMotion()) settle();

  return { setSubject, step, settled: () => isSettled, dispose };
}
