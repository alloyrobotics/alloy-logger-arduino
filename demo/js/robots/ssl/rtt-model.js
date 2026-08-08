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
 * runs per frame and nothing here owns a clock.
 *
 * @param {object} THREE the three.js module the viewer built the scene with
 * @param {import('three').Group} mount the viewer's robot root
 * @param {{bot: string}} opts `bot` is the name of the subject robot's group, e.g. `bot_y8`
 * @returns {Promise<{setSubject: (id: string|null) => void, dispose: () => void}|null>}
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
  const mkFill = (weight) =>
    keep(
      new THREE.MeshBasicMaterial({
        color: FILL_COLOR,
        transparent: true,
        opacity: weight,
        depthWrite: false,
        side: THREE.FrontSide,
      }),
    );
  const mkLine = (weight) =>
    keep(
      new THREE.LineBasicMaterial({
        color: LINE_COLOR,
        transparent: true,
        opacity: weight,
        depthWrite: false,
      }),
    );
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
        // 0.42, down from the 0.55 the first render used. The beat's halo is additive and lands on the
        // same part, so the two sum: at 0.55 the middle of the live part blew out to white and the
        // machining on it - the dribbler's mouth, the wheel frames - stopped reading at exactly the
        // moment a card asked a visitor to look at it. Lower emissive, same pop, surface intact.
        emissiveIntensity: 0.42,
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
  }

  // The procedural robot steps aside for as long as the wireframe is up - all of it, including the
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

  let live = null;

  /**
   * Draw one group solid, or none. Called by the viewer on the frame a tour beat changes, off the
   * same `setSubject` channel the highlight uses, so the card, the leader line, the halo and this
   * all change together on one frame.
   */
  function setSubject(id) {
    if (id === live) return;
    const prev = built.get(live);
    if (prev) {
      prev.fill.material = prev.faint ? mat.hullFill : mat.partFill;
      prev.edge.material = prev.faint ? mat.hullLine : mat.partLine;
      prev.fill.renderOrder = 3;
    }
    live = built.has(id) ? id : null;
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

  function dispose() {
    if (root.parent) root.parent.remove(root);
    hidden.forEach((c) => {
      c.visible = true;
    });
    owned.forEach((o) => o && typeof o.dispose === 'function' && o.dispose());
    owned.length = 0;
    built.clear();
  }

  return { setSubject, dispose, header };
}
