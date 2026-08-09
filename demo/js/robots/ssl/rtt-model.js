// ssl/rtt-model.js - the anatomy step's transparent-wireframe robot, read out of RoboTeam Twente's
// published CAD.
//
// WHY THIS FILE EXISTS. Round 7 modelled the robot procedurally: a 180 mm hull with four omni wheels,
// a dribbler mouth and an IMU board on the top plate, built from league convention because a tracker
// log carries a pose, a radius and a height and never a wheel. That is still what nineteen robots on
// a pitch are drawn as, everywhere in this mission. But on ONE screen the visitor is asked to look at
// the machine itself, and on that screen a convention-shaped stand-in is the weakest thing on the
// page. So the anatomy step draws the real thing: RoboTeam Twente's own Full Assembly, MIT licensed,
// converted by `assets-src/rtt/` in this repository into `rtt-model.mesh`. The geometry is theirs;
// see RTT-MODEL-NOTICE.md, which ships beside the asset because MIT requires the notice to travel
// with the redistribution.
//
// WHY A WIREFRAME, which is the round 8 note and not a style choice. The four cards name a wheel, a
// board, a capacitor bank and a roller. Three of those four are INSIDE the machine: on a solid robot
// the card about a capacitor bank points at a curved band of bodywork, which is the failure round 7
// solved with an anchored halo and could not solve properly, because no camera can see inside a
// solid. A transparent wireframe can. The whole robot reads at once - the wheels, the solenoid, the
// dribbler shaft, the boards - and the part the live card names is the one thing drawn SOLID, so it
// pops out of the drawing rather than being pointed at from outside it. This is the grammar an
// exploded CAD view has always used, and it is why the camera can hold one wide shot for the whole
// tour.
//
// WHY IT STARTS SOLID, which is the round 9 note. A visitor who lands on this step and is shown a
// transparent drawing has nothing to have made transparent. The wireframe is a claim about a machine,
// and round 8 asked the visitor to take the machine on faith: the step opened on a ghost, and the
// first solid thing they ever saw of this robot was one lit part inside it. So the step now opens on
// the object. Phase A holds the CAD as a normal solid machine for 1500 ms - dark anodised hull, black
// omni rollers, bare machined steel in the kicker bay, a board on the top plate - which is also the
// frame where the CAD earns its download against the procedural hull it replaces. Phase B dissolves
// that skin over 900 ms while the two wireframe registers come up underneath it. Phase C is the
// drawing round 8 shipped, and only then does the live card's part light up, because a part cannot
// pop out of a drawing that is itself still arriving.
//
// HOW THE DISSOLVE IS DONE, and it is the one interesting mechanical choice here. Fading an opaque
// mesh by setting `transparent` on it is the obvious move and it is wrong for this model: the moment
// the hull is transparent it stops writing depth, its own back faces sort against its front faces,
// and a machine whose insides are the whole point turns inside out for half a second. So the solid
// register dissolves with `alphaHash` instead - hashed stochastic alpha, which discards fragments in
// the OPAQUE pass and therefore keeps depth writes exact all the way to zero. That buys two things at
// once: no sorting artifacts and no z-fighting, and the wireframe underneath is revealed THROUGH the
// holes as they open, so the x-ray emerges out of the machine instead of cutting to it. At opacity 0
// every fragment is discarded, so hiding the meshes on the settle frame is not a visible event.
// `alphaHash` landed in three r152 and this page vendors r169; it is feature-detected anyway, and the
// fallback is the honest transparent fade with depth writes off, artifacts and all.
//
// WHOSE CLOCK. The viewer's, and only the viewer's: it calls `step(nowMs)` every rendered frame while
// this step is open, that first call is t0, and this module owns no rAF, no timer and no `Date.now`.
// One clock means the intro cannot drift against the tour's beats, the camera drift or the halo, and
// leaving the step mid-intro is just a dispose - there is nothing to cancel. The viewer also asks
// `settled()` before it shows its own halo, and a `setSubject` that arrives during the intro (the
// first beat is live well before the fade is done) is REMEMBERED and applied on the settle frame
// rather than lighting a part inside a robot that is still solid. The two timings are duplicated,
// deliberately, in the core module that gives the other three missions the same intro: importing them
// across the ssl/core boundary would put bytes for this step in front of the lazy boundary below.
//
// WHY IT IS LOADED LIKE THIS. Everything here is behind the lazy boundary: `experience.js` imports
// this module dynamically, and `experience.js` is itself only reached through `role-openers.js`'s
// dynamic import, so not one byte of it is in the eager graph `ssl-eager-size.test.mjs` holds under
// 60 KB - and the 865 KB asset is fetched only on the step that draws it. While that fetch is in
// flight, and on ANY failure - a 404, an offline visitor, a truncated file, a payload whose robot is
// not in the roster - this module returns null and the round 7 procedural hull is simply left alone.
// The step is fully functional without the asset; the asset only makes it better. Verified by parking
// the asset and reloading the step: the procedural robot, the tour, the leader lines and the anchored
// halo all still run, and the only trace is the 404 in the network log.
//
// ONE KNOWN WRINKLE ON THAT FALLBACK PATH, recorded rather than papered over. The attribution sentence
// in `script.js`'s `context.provenance` ("Robot model: RoboTeam Twente's published CAD, MIT licensed")
// is EAGER copy, so on the rare path where the asset does not load, a credit is shown for a model the
// visitor cannot see. It is a credit rather than a claim about the robot or the data, so it fails safe
// in the direction that matters: it over-attributes instead of under-attributing, which is the right
// side to err on for a licence notice. Making it conditional would mean re-rendering that strip from
// this module's resolution, which means a channel through `core/flow.js` and more eager bytes on a
// graph with 96 of them left. Worth doing when the budget next moves, not worth a flow rewrite now.

/** "RTT1", as the little-endian uint32 the first four bytes read back as. */
const MAGIC = 0x31545452;

/**
 * How faint each layer is. Two registers, and the split is the point: the four ANATOMY groups are
 * the things the cards name, so they carry the drawing, and the chassis is the context they hang on.
 * A hull drawn at the same weight as the parts inside it is a box with a smudge in it.
 *
 * The fill does not write depth, so the model does not occlude itself and every layer shows through
 * every other layer - which is the whole reason a wireframe answers a card about a part inside a
 * hull. It does still depth TEST, so the pitch and the other eighteen robots occlude it correctly:
 * this is a transparent robot standing on a real field, not an overlay floating over one.
 */
const LOOK = {
  hull: { fill: 0.045, line: 0.3 },
  part: { fill: 0.075, line: 0.46 },
};
const LINE_COLOR = 0x9dc0e6; // the demo's line grammar: a cool near-white, not a saturated accent
const FILL_COLOR = 0x86aacd;
// The live part. Instrument blue, the same channel and the same colour the anatomy tour's halo uses
// (`viewer.js`, "part highlight"), because a visitor should read the halo and the solid part as one
// statement rather than as two things that happen to have lit up together. NOT the alert red every
// scene paints a FAULT highlight: nothing is wrong with this robot on this step.
const LIVE_EMISSIVE = 0x8ec6ff;
const LIVE_BODY = 0x1c2734;
/**
 * The dihedral angle above which a facet boundary becomes a drawn line.
 *
 * 26 degrees, and it is a measured compromise rather than a default. The tessellation is deliberately
 * coarse (a 0.5 mm chord error, angular deflection 1 rad), so a cylinder in this asset is a six or
 * eight sided prism and its facet boundaries sit at 45 to 60 degrees. A threshold under about 20
 * degrees therefore draws every facet boundary on every curved surface and the model turns into a
 * grey mesh; a threshold over about 35 degrees drops the roller and shaft outlines that are the whole
 * reason a wheel reads as an omni wheel. At 26 the real edges of the machine - plate outlines, the
 * solenoid body, the dribbler bar, the wheel frames - are drawn, and the faceting of a smooth curve
 * mostly is not.
 */
const EDGE_ANGLE = 26;

/**
 * The intro, in milliseconds off the viewer's frame clock. 1500 ms of solid is long enough to read a
 * machine and short enough that nobody waiting for the first card notices they waited; 900 ms of
 * dissolve is long enough to see the skin go rather than blink.
 */
const SOLID_HOLD_MS = 1500;
const FADE_MS = 900;

/**
 * Phase A's palette, one entry per group in the asset.
 *
 * A neutral ENGINEERING palette rather than the team colours the scene paints on its nineteen
 * robots, for the same reason the printed top plate is hidden here: on this one step the robot's
 * identity is carried by four labelled leader lines, so a hull painted in a division's blue is
 * decoration competing with the cards. What the palette does have to do is separate the four things
 * the cards name from the chassis they hang on, before a single word of a card has been read. Dark
 * anodised aluminium for the hull, black polyurethane for the wheel group (the rollers are most of
 * what a wheel shows from this camera), bare machined steel for the kicker bay because it is the one
 * thing a visitor should be able to find INSIDE the machine while it is still solid, a warm silicone
 * roller so the dribbler does not read as a fifth wheel, and board green on the top plate. Values are
 * in the same roughness/metalness range as `scene.js`'s robot factory, because both are lit by the
 * one rig in `core/stage3d.js`.
 */
const SOLID = {
  hull: { color: 0x343b43, rough: 0.46, metal: 0.5 },
  omni: { color: 0x16181c, rough: 0.82, metal: 0.1 },
  kicker: { color: 0xb9c0c8, rough: 0.32, metal: 0.72 },
  dribbler: { color: 0x4a3a2c, rough: 0.9, metal: 0.06 },
  imu: { color: 0x1f4a3f, rough: 0.6, metal: 0.15 },
};

/** Smoothstep, so the dissolve leaves and arrives without a corner on it. */
const ease = (u) => u * u * (3 - 2 * u);

/**
 * A visitor who has asked for less motion gets round 8's step: the wireframe, immediately, with the
 * live part lit as soon as a beat says so. The intro is the thing that is skipped, not the content -
 * nothing in it carries information a card does not also say.
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
 * Read the asset. See `assets-src/rtt/pack.py` for the writer; the format is four bytes of magic, a
 * uint32 JSON header length, the header, then one int16 position block and one uint16 index block per
 * group, each 4-byte aligned.
 *
 * @returns {{header: object, groups: Array<{id: string, position: Float32Array, index: Uint16Array}>}}
 */
function readAsset(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 12 || dv.getUint32(0, true) !== MAGIC) throw new Error('not an RTT1 asset');
  const headLen = dv.getUint32(4, true);
  if (headLen <= 0 || 8 + headLen > buf.byteLength) throw new Error('bad header length');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headLen)));
  const groups = (header.groups || []).map((g) => {
    const q = new Int16Array(buf, g.pos.byteOffset, g.verts * 3);
    const position = new Float32Array(q.length);
    const [ox, oy, oz] = g.offset;
    const [sx, sy, sz] = g.scale;
    for (let i = 0; i < q.length; i += 3) {
      position[i] = ox + q[i] * sx;
      position[i + 1] = oy + q[i + 1] * sy;
      position[i + 2] = oz + q[i + 2] * sz;
    }
    return { id: g.id, position, index: new Uint16Array(buf, g.idx.byteOffset, g.tris * 3) };
  });
  if (!groups.length) throw new Error('asset carries no groups');
  return { header, groups };
}

/**
 * Fetch, build, and hang the wireframe on the robot the anatomy overlay is about.
 *
 * The model is parented INTO that robot's own group, which is what makes this cheap: the group is
 * already posed, turned and hidden every frame by `scene.js`'s `update()` against the tracker, so the
 * wireframe drives itself, the four anatomy anchors keep resolving to the same points in the same
 * frame, and the leader lines and the tour's wide framing carry on working untouched. Nothing here
 * owns a clock: the only per-frame work is `step()`, and the viewer drives that off its own.
 *
 * @param {object} THREE the three.js module the viewer built the scene with
 * @param {import('three').Group} mount the viewer's robot root
 * @param {{bot: string}} opts `bot` is the name of the subject robot's group, e.g. `bot_y8`
 * @returns {Promise<{
 *   setSubject: (id: string|null) => void,
 *   step: (nowMs: number) => void,
 *   settled: () => boolean,
 *   dispose: () => void,
 * }|null>}
 */
export async function installAnatomyModel(THREE, mount, opts) {
  const bot = mount && opts && opts.bot ? mount.getObjectByName(opts.bot) : null;
  // No robot to hang it on: the scene has not been built yet, or this payload's roster does not
  // carry the subject. Either way the procedural hull is what the visitor keeps.
  if (!bot) return null;

  const url = new URL('./rtt-model.mesh', import.meta.url);
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`rtt-model.mesh: HTTP ${res.status}`);
  const { header, groups } = readAsset(await res.arrayBuffer());

  const owned = []; // every GPU object this handle created, for dispose()
  const keep = (o) => {
    owned.push(o);
    return o;
  };

  // Does this visitor get the round 9 intro at all, and can the solid register dissolve properly?
  // The probe is one material that is built, asked one question and disposed before it can ever be
  // put in front of a compiler, which is cheaper than reading a three revision string that a future
  // vendored build is free to reformat.
  const intro = !prefersReducedMotion();
  let hashedFade = false;
  if (intro) {
    const probe = new THREE.MeshStandardMaterial();
    hashedFade = 'alphaHash' in probe;
    probe.dispose();
  }

  // Every wireframe weight the intro has to bring up, as [material, its settled opacity]. The live
  // materials are deliberately not in here: they are not part of the cross-fade, they land whole on
  // the settle frame.
  const fades = [];
  const mkFill = (weight) => {
    const m = new THREE.MeshBasicMaterial({
      color: FILL_COLOR,
      transparent: true,
      opacity: intro ? 0 : weight,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    fades.push([m, weight]);
    return keep(m);
  };
  const mkLine = (weight) => {
    const m = new THREE.LineBasicMaterial({
      color: LINE_COLOR,
      transparent: true,
      opacity: intro ? 0 : weight,
      depthWrite: false,
    });
    fades.push([m, weight]);
    return keep(m);
  };
  // Four materials, shared by every group, because a group is only ever in one of two states and at
  // most one group is live at a time.
  const mat = {
    hullFill: mkFill(LOOK.hull.fill),
    hullLine: mkLine(LOOK.hull.line),
    partFill: mkFill(LOOK.part.fill),
    partLine: mkLine(LOOK.part.line),
    liveFill: keep(
      new THREE.MeshStandardMaterial({
        color: LIVE_BODY,
        emissive: LIVE_EMISSIVE,
        // 0.3, down from 0.55 (first render) via 0.42 (round 8). The beat's halo is additive and
        // lands on the same part, so the two sum: too high and the middle of the live part blows out
        // to white and the machining on it - the dribbler's mouth, the wheel frames - stops reading
        // at exactly the moment a card asks a visitor to look at it. Round 9 feedback pulled the
        // pairing down again, in step with the halo's locator weights in viewer.js.
        emissiveIntensity: 0.3,
        roughness: 0.44,
        metalness: 0.25,
      }),
    ),
    liveLine: keep(
      new THREE.LineBasicMaterial({ color: 0xe4f0ff, transparent: true, opacity: 0.95, depthWrite: false }),
    ),
  };

  const root = new THREE.Group();
  root.name = 'rtt-wireframe';
  const built = new Map(); // partId -> { fill, edge, faint }
  const solid = []; // Phase A's meshes, one per group; empty when the intro is skipped

  for (const g of groups) {
    const geo = keep(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
    geo.setIndex(new THREE.BufferAttribute(g.index, 1));
    geo.computeVertexNormals(); // the live part is lit by the scene's rig, so it needs normals
    const faint = g.id === 'hull';
    const fill = new THREE.Mesh(geo, faint ? mat.hullFill : mat.partFill);
    fill.castShadow = false;
    fill.receiveShadow = false;
    fill.renderOrder = 3;
    // The pitch is 12 m wide and this robot is 180 mm: a group whose bounding sphere is off screen
    // for a frame is not worth a culling test that can pop a layer out of a drawing.
    fill.frustumCulled = false;
    const edge = new THREE.LineSegments(
      keep(new THREE.EdgesGeometry(geo, EDGE_ANGLE)),
      faint ? mat.hullLine : mat.partLine,
    );
    edge.renderOrder = 4;
    edge.frustumCulled = false;
    root.add(fill, edge);
    built.set(g.id, { fill, edge, faint });

    if (intro) {
      // The same geometry once more, drawn as a real surface. A second mesh rather than a material
      // swap on `fill`, because a cross-fade needs both registers on screen in the same frame, and
      // because it keeps Phase C's drawing identical to round 8's: at settle these meshes go
      // invisible and nothing they touched is left behind.
      //
      // Default FrontSide, which is a checked assumption rather than a hopeful one: every group in
      // the asset has a POSITIVE signed volume and (bar six directed edges on the hull, out of
      // sixty-four thousand) pairs its edges, so these are closed shells wound outwards and the
      // outside of the machine is what an opaque front-face pass draws. Normals are the smoothed
      // ones `computeVertexNormals` already put on the geometry for the live part, so Phase A and
      // Phase C shade the same surface the same way instead of two subtly different ones.
      const spec = SOLID[g.id] || SOLID.hull;
      const smat = keep(
        new THREE.MeshStandardMaterial({
          color: spec.color,
          roughness: spec.rough,
          metalness: spec.metal,
          // Opaque-pass dissolve. `transparent` stays false the whole way down: with alphaHash the
          // fade is a discard, so this mesh keeps writing depth and keeps occluding the wireframe
          // inside it until its own holes open. See the header note.
          alphaHash: hashedFade,
          opacity: 1,
        }),
      );
      const smesh = new THREE.Mesh(geo, smat);
      smesh.castShadow = false;
      smesh.receiveShadow = false;
      smesh.renderOrder = 2; // under both wireframe registers, so the fade has a defined order
      smesh.frustumCulled = false;
      root.add(smesh);
      solid.push({ mesh: smesh, mat: smat });
    }
  }

  // The procedural robot steps aside for as long as this model is up - from the FIRST frame, round 9
  // included, because the thing that replaces it is now a solid machine off real CAD rather than a
  // drawing, so there is no moment where hiding it costs the visitor a robot. All of it, including the
  // printed top plate, because this camera looks 30 degrees DOWN and an opaque plate over the top of
  // the machine hides the boards, the solenoid and the wheel bay, which is everything the four cards
  // are about. The robot's identity is carried by the four labelled leader lines on this step, not by
  // its vision pattern. Visibility is restored verbatim on dispose(), so every other surface in this
  // mission - the picker, the mission goal loop, the failure step, the chat replays - is untouched.
  const hidden = bot.children.filter((c) => c.visible);
  hidden.forEach((c) => {
    c.visible = false;
  });
  bot.add(root);

  let live = null; // the group currently drawn solid and lit, or null
  let wanted = null; // the latest part the viewer has asked for, whether or not it is drawn yet
  let isSettled = !intro; // reduced motion: the wireframe is already the drawing, from frame one
  let t0 = null;
  let fading = false;

  /** Move the cross-fade to `u`: 0 is the solid machine, 1 is round 8's wireframe. */
  function paint(u) {
    const e = ease(u);
    for (let i = 0; i < fades.length; i++) fades[i][0].opacity = fades[i][1] * e;
    for (let i = 0; i < solid.length; i++) solid[i].mat.opacity = 1 - e;
  }

  /**
   * Phase C, in one frame. `paint(1)` has already taken the solid register to zero alpha - with
   * alphaHash that discards every fragment, so the meshes going invisible on the same frame is
   * bookkeeping rather than a visible event - and the part the viewer asked for during the intro
   * lights up here, which is the whole reason the wait was worth anything.
   */
  function settle() {
    if (isSettled) return;
    isSettled = true;
    paint(1);
    for (let i = 0; i < solid.length; i++) solid[i].mesh.visible = false;
    applySubject();
  }

  /**
   * The intro's only clock, called by the viewer every rendered frame while this step is open. The
   * first call is t0: not install time, because an 865 KB asset can land a long way into the step and
   * a visitor should get their 1500 ms of solid robot from the frame they first SEE it.
   */
  function step(now) {
    if (isSettled || !Number.isFinite(now)) return;
    if (t0 === null) t0 = now;
    const t = now - t0;
    if (t < SOLID_HOLD_MS) return; // Phase A holds; there is nothing per frame to do in it
    const u = (t - SOLID_HOLD_MS) / FADE_MS;
    if (u >= 1) {
      settle();
      return;
    }
    if (!fading) {
      fading = true;
      // The fallback path only. Flipped once, at the top of the fade rather than at build time,
      // because a depth-writing opaque hull is exactly what Phase A wants.
      if (!hashedFade) {
        for (let i = 0; i < solid.length; i++) {
          solid[i].mat.transparent = true;
          solid[i].mat.depthWrite = false;
          solid[i].mat.needsUpdate = true;
        }
      }
    }
    paint(u);
  }

  function settled() {
    return isSettled;
  }

  /**
   * Draw one group solid, or none. Called by the viewer on the frame a tour beat changes, off the
   * same `setSubject` channel the highlight uses, so the card, the leader line, the halo and this
   * all change together on one frame.
   *
   * During the intro the part is REMEMBERED and not drawn: the first beat is usually live before the
   * dissolve is over, and a part lit inside a machine that is still solid is a bright patch of
   * bodywork, which is precisely the round 7 failure the wireframe exists to fix.
   */
  function setSubject(id) {
    const next = built.has(id) ? id : null;
    if (next === wanted) return;
    wanted = next;
    if (!isSettled) return;
    applySubject();
  }

  /** The round 8 treatment, unchanged, applied whenever the drawing is allowed to change. */
  function applySubject() {
    if (wanted === live) return;
    const prev = built.get(live);
    if (prev) {
      prev.fill.material = prev.faint ? mat.hullFill : mat.partFill;
      prev.edge.material = prev.faint ? mat.hullLine : mat.partLine;
      prev.fill.renderOrder = 3;
    }
    live = wanted;
    const next = built.get(live);
    if (next) {
      // Opaque and depth-writing, unlike everything else here: the live part occludes the wireframe
      // in front of it, which is what makes it read as a solid object inside a drawing rather than as
      // one more transparent layer that happens to be brighter.
      next.fill.material = mat.liveFill;
      next.edge.material = mat.liveLine;
      next.fill.renderOrder = 5;
    }
  }

  /**
   * Leaving the step, at any point in the intro. Nothing here is conditional on how far the fade got,
   * which is the property that makes a mid-intro exit safe: the whole model is one detachable group,
   * the solid register's materials are in `owned` like everything else, and the only state outside
   * this module is the procedural robot's visibility, restored verbatim. There is no timer to cancel
   * because there was never a timer.
   */
  function dispose() {
    if (root.parent) root.parent.remove(root);
    hidden.forEach((c) => {
      c.visible = true;
    });
    owned.forEach((o) => o && typeof o.dispose === 'function' && o.dispose());
    owned.length = 0;
    built.clear();
    solid.length = 0;
  }

  return { setSubject, step, settled, dispose, header };
}
