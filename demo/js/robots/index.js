// robots/index.js - the registry. Each robot directory's script.js is its entry point and
// default-exports the full RobotDefinition.
import sbr from './sbr/script.js';
import arm6 from './arm6/script.js';
import drone from './drone/script.js';
import rescue from './rescue/script.js';

/** Ordered registry. Picker card order === this order. */
export const ROBOTS = [sbr, arm6, drone, rescue];

/** id -> RobotDefinition */
export const ROBOTS_BY_ID = new Map(ROBOTS.map((r) => [r.id, r]));

/** @param {string} id @returns {object|null} */
export function getRobot(id) {
  return ROBOTS_BY_ID.get(id) || null;
}

/**
 * Add a robot that was not compiled in: a generated demo, fetched as one def.json at route time
 * and composed by robots/generated.js. Lookup only. ROBOTS is deliberately untouched, so the
 * picker stays the four canned cards and a personalized demo never leaks into a shared link.
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
  rescue: `<rect x="15" y="33" width="50" height="19" rx="9.5"/><circle cx="25" cy="42.5" r="4.5"/><circle cx="55" cy="42.5" r="4.5"/><path d="M21 51.5h38" class="acc"/><rect x="23" y="20" width="34" height="13" rx="2"/><path d="M33 20v-6"/><rect x="27" y="6" width="13" height="8" rx="1.5" class="acc"/><path d="M62 38l15 9" class="acc"/><circle cx="78.5" cy="48" r="3.6" class="acc"/><path d="M6 59h84"/><rect x="68" y="54" width="9" height="5" rx="1"/>`,
};
