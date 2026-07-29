// ssl/in-play.js - ONE definition of "the ball is in play", shared by everything that needs it.
//
// This existed three times and disagreed with itself: data.js opened live play the instant a
// restart command appeared, scene.js waited for the real ball to move, and the self-test carried a
// fourth copy of data.js's regex. The synthesized telemetry was armed for seconds the renderer was
// still drawing a free-kick standoff over, and the prose quoted the difference as fact.
//
// THE RULE (2026 SSL rulebook). A restart command does NOT put the ball in play. After a free kick
// or the NORMAL_START half of a kick-off handshake the ball is in play once it has moved
// IN_PLAY_MOVE_M from where the restart was awarded, or when that restart's own ceiling expires -
// ten seconds for a kick-off, five for a Division A free kick. FORCE_START is in play immediately.
// The moment is MEASURED off the real ball track, never assumed; in this window the ball always
// moves before its ceiling, so every in-play time the site quotes is real ball movement.
//
// The first command may be `heldFromBeforeWindow`: it was already in force when the window was
// cropped, so its restart happened before t = 0 and the crop boundary is NOT its anchor. Measuring
// 0.05 m from wherever the ball sat at t = 0 fabricates a restart the match never had. The
// pre-window state is read off the stage clock instead, which counts PLAYING time and freezes
// during stoppages; a held command whose state that cannot establish is left UNKNOWN - no in-play
// time, so no ring, no countdown and no "RUNNING" claim.

/** Commands under which the ball can be in play at all. */
export const LIVE_COMMAND = /^(NORMAL_START|FORCE_START|DIRECT_FREE_|INDIRECT_FREE_)/;
/** Commands whose ball comes into play only after movement or the ceiling. */
export const RESTART_COMMAND = /^(DIRECT_FREE_|INDIRECT_FREE_|NORMAL_START)/;
/** Metres of real ball travel from the restart point that put the ball in play. */
export const IN_PLAY_MOVE_M = 0.05;
/** Ceilings, seconds. Kick-off: 10. Division A free kick: 5. */
export const KICKOFF_CEILING_S = 10;
export const FREE_KICK_CEILING_S = 5;

/**
 * Last index whose time is <= t, clamped to the ends. Shared so scene.js and this module cannot
 * bracket the ball track differently.
 */
export function bracket(times, t) {
  const n = times.length;
  if (n === 0) return 0;
  if (t <= times[0]) return 0;
  if (t >= times[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The in-play ceiling for a restart command, in seconds. */
export function restartCeilingS(command) {
  return command === 'NORMAL_START' ? KICKOFF_CEILING_S : FREE_KICK_CEILING_S;
}

/**
 * Was the ball already in play when the window was cropped? True when the stage clock is running
 * across the window's opening samples: it counts PLAYING time and freezes during a stoppage, so a
 * strictly falling `leftUs` over the first samples is playing time being spent.
 *
 * Returns null when the export carries too little stage clock to tell, which is the honest answer
 * and is treated as "unknown" by every caller.
 *
 * @param {object} referee decoded `META.referee`
 * @param {number} [spanS] how far into the window to look for a second sample
 * @returns {boolean|null}
 */
export function playingAtWindowStart(referee, spanS = 2.5) {
  const sc = (referee && referee.stageClock) || [];
  if (sc.length < 2) return null;
  const first = sc[0];
  if (!first || typeof first.leftUs !== 'number') return null;
  for (let i = 1; i < sc.length; i++) {
    const s = sc[i];
    if (s.t > spanS) break;
    if (typeof s.leftUs !== 'number') continue;
    // A countdown of playing time: it falls while the ball is in play and holds while it is not.
    if (s.leftUs < first.leftUs) return true;
    if (s.leftUs === first.leftUs) return false;
  }
  return null;
}

/**
 * When the ball came into play after each referee command.
 *
 * Parallel to `referee.commands`. An entry is:
 *   - a number: the second the ball came into play under that command;
 *   - null: the command is not one the ball can be in play under, or it is a held pre-window
 *     restart whose state cannot be established (UNKNOWN - callers must not render a restart
 *     affordance or a running clock for it).
 *
 * @param {object} referee decoded `META.referee`
 * @param {{x:ArrayLike<number>,y:ArrayLike<number>,present:ArrayLike<number>}} ball decoded ball
 * @param {ArrayLike<number>} tBall ball time axis
 * @returns {Array<number|null>}
 */
export function inPlayTimes(referee, ball, tBall) {
  const cmds = (referee && referee.commands) || [];
  const held = playingAtWindowStart(referee);
  return cmds.map((c) => {
    if (!LIVE_COMMAND.test(c.command)) return null;
    // Already in force at the crop boundary: its restart is outside the export.
    if (c.heldFromBeforeWindow) return held === true ? 0 : null;
    // FORCE_START needs no ball movement; the ball is in play the moment it is given.
    if (!RESTART_COMMAND.test(c.command)) return c.t;
    if (!tBall || !tBall.length) return c.t + restartCeilingS(c.command);
    const deadline = c.t + restartCeilingS(c.command);
    let k = bracket(tBall, c.t);
    const x0 = ball.x[k];
    const y0 = ball.y[k];
    for (; k < tBall.length && tBall[k] <= deadline; k++) {
      if (ball.present[k] !== 1) continue;
      if (Math.hypot(ball.x[k] - x0, ball.y[k] - y0) > IN_PLAY_MOVE_M) return tBall[k];
    }
    return deadline;
  });
}

/**
 * Stretches of the window where the ball is actually IN PLAY, as `[start, end]` seconds.
 *
 * A stretch opens at the in-play moment of a live command - not at the command - and closes at the
 * next command the ball cannot be in play under (HALT, STOP, a ball placement, a preparation, the
 * goal confirmation). A live command whose in-play time is unknown, or whose stoppage arrives
 * before the ball ever came into play, opens nothing.
 *
 * @param {object} referee decoded `META.referee`
 * @param {object} ball decoded ball
 * @param {ArrayLike<number>} tBall ball time axis
 * @param {number} endS end of the window, seconds
 * @param {Array<number|null>} [times] precomputed `inPlayTimes`, if the caller already has them
 * @returns {Array<[number, number]>}
 */
export function livePlayIntervals(referee, ball, tBall, endS, times) {
  const cmds = (referee && referee.commands) || [];
  const inPlay = times || inPlayTimes(referee, ball, tBall);
  const out = [];
  let openAt = null;
  for (let i = 0; i < cmds.length; i++) {
    const live = LIVE_COMMAND.test(cmds[i].command);
    if (live) {
      // A second live command while one is open (a free kick re-awarded without a stoppage) keeps
      // the open stretch: the earlier in-play moment is the one that stands.
      if (openAt === null && inPlay[i] != null) openAt = inPlay[i];
    } else if (openAt !== null) {
      if (cmds[i].t > openAt) out.push([openAt, cmds[i].t]);
      openAt = null;
    }
  }
  if (openAt !== null && endS > openAt) out.push([openAt, endS]);
  return out;
}

/**
 * Commands under which every robot must come to a stop, so nothing on a robot is spinning.
 * HALT is "stop within 2 seconds"; a timeout is the same. Everything else - STOP, a ball
 * placement, a kick-off preparation - lets the robots drive, and a placement is literally
 * performed by dribbling the ball to the designated point.
 */
export const HALTED_COMMAND = /^(HALT|TIMEOUT_)/;

/**
 * Stretches where the referee has halted the robots, as `[start, end]` seconds. Not the inverse of
 * `livePlayIntervals`: a stopped ball is not a stopped robot.
 */
export function haltedIntervals(referee, endS) {
  const cmds = (referee && referee.commands) || [];
  const out = [];
  let openAt = null;
  for (let i = 0; i < cmds.length; i++) {
    const halted = HALTED_COMMAND.test(cmds[i].command);
    if (halted && openAt === null) openAt = cmds[i].t;
    else if (!halted && openAt !== null) {
      out.push([openAt, cmds[i].t]);
      openAt = null;
    }
  }
  if (openAt !== null && endS > openAt) out.push([openAt, endS]);
  return out;
}

/** Membership test over a sorted, disjoint interval list. */
export function inIntervals(intervals, s) {
  for (let i = 0; i < intervals.length; i++) {
    if (s >= intervals[i][0] && s <= intervals[i][1]) return true;
  }
  return false;
}
