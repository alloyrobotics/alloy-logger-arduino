// robots/index.js - the registry. Each robot directory's script.js is its entry point and
// default-exports the full RobotDefinition.
import sbr from './sbr/script.js';
import arm6 from './arm6/script.js';
import drone from './drone/script.js';
import rescue from './rescue/script.js';
// ssl registers like any other robot, but its 3D replay is the one payload that does NOT ride this
// static graph: `ssl/script.js` pulls channel metadata and a small preview slice, and the match
// module itself arrives through `def.loadSceneData()` on the demo route only.
import ssl from './ssl/script.js';
// battle is the second lazy-payload mission: script.js ships metadata and a 6 s preview slice,
// and the full-round module arrives through `def.loadSceneData()` on the demo route only.
import battle from './battle/script.js';
// donna is the third lazy-payload mission: script.js ships metadata and a 6 s preview slice, and
// the full recorded match module arrives through `def.loadSceneData()` on the demo route only.
import donna from './donna/script.js';

/** Ordered registry. Picker card order === this order. */
export const ROBOTS = [sbr, arm6, drone, rescue, ssl, battle, donna];

/** id -> RobotDefinition */
export const ROBOTS_BY_ID = new Map(ROBOTS.map((r) => [r.id, r]));

/** @param {string} id @returns {object|null} */
export function getRobot(id) {
  return ROBOTS_BY_ID.get(id) || null;
}

/**
 * Add a robot that was not compiled in: a generated demo, fetched as one def.json at route time
 * and composed by robots/generated.js. Lookup only. ROBOTS is deliberately untouched, so the
 * picker stays the canned cards in ROBOTS and a personalized demo never leaks into a shared link.
 *
 * @param {object} def a full RobotDefinition
 * @returns {object} the same def, for chaining
 */
export function registerRobot(def) {
  ROBOTS_BY_ID.set(def.id, def);
  return def;
}

// Line-art schematics for the picker cards. Owned by the scaffold agent, keyed by robot id, so
// robot agents never touch markup outside their own directory. Each is a viewBox="0 0 96 64"
// fragment: stroke inherits currentColor (--tx-mute), `.acc` strokes the robot accent.
export const ROBOT_ICONS = {
  sbr: `<rect x="34" y="10" width="28" height="30" rx="2"/><path d="M38 16h20M38 22h20M38 28h13" class="acc"/><circle cx="26" cy="46" r="12"/><circle cx="70" cy="46" r="12"/><path d="M26 46h44"/><path d="M48 6v-4" class="acc"/>`,

  // pedestal, three jointed links, a parallel gripper actually holding the payload, two pads.
  // The earlier version read as a stick with a detached V floating beside it.
  arm6: `<rect x="14" y="52" width="22" height="7" rx="1.5"/><path d="M25 52V40"/><circle cx="25" cy="36" r="4" class="acc"/><path d="M27.8 33.2L44.6 24.6"/><circle cx="47" cy="23" r="3.4" class="acc"/><path d="M50.2 24.1L65.2 29.4"/><circle cx="68" cy="31" r="3"/><path d="M71 31h3M74 26v10M74 27.6h5M74 34.4h5"/><rect x="77.5" y="26.5" width="9" height="9" rx="1.2" class="acc"/><rect x="42" y="55" width="13" height="4" rx="1"/><rect x="61" y="55" width="13" height="4" rx="1"/>`,

  drone: `<path d="M22 22l52 24M74 22L22 46"/><ellipse cx="22" cy="22" rx="13" ry="4" class="acc"/><ellipse cx="74" cy="22" rx="13" ry="4" class="acc"/><ellipse cx="22" cy="46" rx="13" ry="4" class="acc"/><ellipse cx="74" cy="46" rx="13" ry="4" class="acc"/><rect x="40" y="28" width="16" height="12" rx="3"/>`,

  // track loop with road wheels and a ground run, hull, sensor mast with a camera head, and the
  // front flipper arm. The earlier version read as a bathtub.
  // SSL robot from above: the Ø180 mm hull with its flat dribbler face on the right, the roller
  // behind it, the four id dots of a vision pattern around the centre dot, and the golf ball on
  // the face. Schematic line art in the house grammar, not a rendering of any team's pattern.
  ssl: `<path d="M63.3 17.8A24 24 0 1 0 63.3 46.2Z"/><path d="M60 21.5v21"/><circle cx="55.8" cy="23.7" r="2.7"/><circle cx="55.8" cy="40.3" r="2.7"/><circle cx="32.2" cy="23.7" r="2.7"/><circle cx="32.2" cy="40.3" r="2.7"/><circle cx="44" cy="32" r="3.6" class="acc"/><circle cx="76" cy="32" r="3"/>`,

  rescue: `<rect x="15" y="33" width="50" height="19" rx="9.5"/><circle cx="25" cy="42.5" r="4.5"/><circle cx="55" cy="42.5" r="4.5"/><path d="M21 51.5h38" class="acc"/><rect x="23" y="20" width="34" height="13" rx="2"/><path d="M33 20v-6"/><rect x="27" y="6" width="13" height="8" rx="1.5" class="acc"/><path d="M62 38l15 9" class="acc"/><circle cx="78.5" cy="48" r="3.6" class="acc"/><path d="M6 59h84"/><rect x="68" y="54" width="9" height="5" rx="1"/>`,

  // Battle arena from above: the 8 x 5 walled field, one vertical and one horizontal obstacle,
  // three robots as turreted squares, and the accent robot mid-shot with a tracer ending on the
  // vertical obstacle, which is the mission's story in one line.
  battle: `<rect x="8" y="8" width="80" height="48" rx="2"/><rect x="24" y="40" width="16" height="5"/><rect x="56" y="20" width="5" height="16"/><rect x="16" y="12" width="9" height="7" rx="1"/><rect x="72" y="44" width="9" height="7" rx="1"/><rect x="36" y="24" width="9" height="7" rx="1" class="acc"/><path d="M45 27.5h8" class="acc"/><circle cx="54.5" cy="27.5" r="1.8" class="acc"/>`,

  // Three front-view Wolfgang figures, one per onboard log, with the match ball by Donna.
  donna: `<g data-figure="donna" class="acc"><rect x="8" y="7" width="14" height="9" rx="1.5"/><path d="M11 11.5h8M15 16v4M8 20h14l2 15H6zM9 35l-3 13M21 35l3 13M6 48h6M18 48h6"/></g><g data-figure="jack"><rect x="41" y="4" width="14" height="9" rx="1.5"/><path d="M44 8.5h8M48 13v4M41 17h14l2 16H39zM42 33l-4 16M54 33l4 16M35 49h7M54 49h7"/></g><g data-figure="rory"><rect x="74" y="8" width="14" height="9" rx="1.5"/><path d="M77 12.5h8M81 17v4M74 21h14l2 14H72zM75 35l-3 13M87 35l3 13M69 48h6M87 48h6"/></g><circle cx="27" cy="54" r="4.5" class="acc"/><path d="M4 59h88"/>`,
};
