// timeline.js - the single clock. Chat evidence, the 3D viewer and the charts all read from here.
// rAF-driven. onTick(t) fires every frame while playing and once on every seek.

/**
 * @param {number} duration seconds
 * @returns {{
 *   t:number, playing:boolean, speed:number, loopWindow:[number,number]|null, duration:number,
 *   play:()=>void, pause:()=>void, toggle:()=>void, seek:(t:number)=>void,
 *   setSpeed:(s:number)=>void, setLoop:(w:[number,number]|null, opts?:{speed?:number})=>void,
 *   onTick:(cb:(t:number)=>void)=>()=>void, onChange:(cb:(state:object)=>void)=>()=>void,
 *   dispose:()=>void
 * }}
 */
export function createTimeline(duration) {
  const tickCbs = new Set();
  const changeCbs = new Set();
  let raf = 0;
  let last = 0;

  const api = {
    t: 0,
    playing: false,
    speed: 1,
    loopWindow: null,
    duration,

    play() {
      if (api.playing) return;
      api.playing = true;
      last = performance.now();
      loop(last);
      emitChange();
    },

    pause() {
      if (!api.playing) return;
      api.playing = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      emitChange();
    },

    toggle() {
      if (api.playing) api.pause();
      else api.play();
    },

    /**
     * Seeking is always honoured across the whole mission. A seek that lands outside an active
     * evidence loop ENDS the loop rather than being silently clamped to its edge: otherwise the
     * scrubber, its finding markers and chart clicks are all dead while a loop is running.
     * app.js listens for the cleared loopWindow and tears down the rest of the evidence state.
     */
    seek(t) {
      const next = Math.min(Math.max(t, 0), duration);
      const w = api.loopWindow;
      if (w && (next < w[0] - 1e-6 || next > w[1] + 1e-6)) api.loopWindow = null;
      api.t = next;
      emitTick();
      emitChange();
    },

    setSpeed(s) {
      api.speed = s;
      emitChange();
    },

    setLoop(w, opts = {}) {
      api.loopWindow = w ? [w[0], w[1]] : null;
      if (typeof opts.speed === 'number') api.speed = opts.speed;
      if (api.loopWindow) {
        if (api.t < api.loopWindow[0] || api.t > api.loopWindow[1]) {
          api.t = api.loopWindow[0];
          emitTick();
        }
      }
      emitChange();
    },

    onTick(cb) {
      tickCbs.add(cb);
      return () => tickCbs.delete(cb);
    },

    onChange(cb) {
      changeCbs.add(cb);
      return () => changeCbs.delete(cb);
    },

    dispose() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      api.playing = false;
      tickCbs.clear();
      changeCbs.clear();
    },
  };

  function emitTick() {
    tickCbs.forEach((cb) => cb(api.t));
  }

  function emitChange() {
    const snap = {
      t: api.t,
      playing: api.playing,
      speed: api.speed,
      loopWindow: api.loopWindow,
      duration,
    };
    changeCbs.forEach((cb) => cb(snap));
  }

  function loop(now) {
    if (!api.playing) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const lo = api.loopWindow ? api.loopWindow[0] : 0;
    const hi = api.loopWindow ? api.loopWindow[1] : duration;
    api.t += dt * api.speed;
    if (api.t >= hi) api.t = lo + ((api.t - lo) % Math.max(hi - lo, 0.001));
    if (api.t < lo) api.t = lo;
    emitTick();
    raf = requestAnimationFrame(loop);
  }

  return api;
}
