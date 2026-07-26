// stub/data.js - dev-only placeholder telemetry. Two channels, one finding.
// Exists to prove the whole loop (picker -> ingest -> chat -> evidence -> viewer + chart) end to
// end before the four real robots land. Registry-excluded once they do.

import { mulberry32, gaussian, fbm1D, clamp, smoothstep } from '../../core/prng.js';

export const duration = 20.0;
export const rate = 50;

export const channels = [
  {
    path: '/drive',
    fields: [
      { key: 'cmd', label: 'cmd', unit: 'm/s' },
      { key: 'vel', label: 'vel', unit: 'm/s' },
      { key: 'current', label: 'current', unit: 'A' },
      { key: 'x', label: 'x', unit: 'm' },
    ],
  },
  {
    path: '/sys',
    fields: [
      { key: 'temp', label: 'temp', unit: 'C' },
      { key: 'batt_v', label: 'batt_v', unit: 'V' },
    ],
  },
];

export const findings = [
  {
    id: 'stall',
    title: 'Stall at 10.0 s',
    window: [8.0, 13.0],
    t: 10.0,
    severity: 'alert',
    focus: { channel: '/drive', fields: ['cmd', 'vel', 'current'] },
    highlight: 'body',
    slowmo: true,
  },
  {
    id: 'thermal',
    title: 'Driver heating over the run',
    window: [0, 20],
    t: 16.0,
    severity: 'warn',
    focus: { channel: '/sys', fields: ['temp'] },
    highlight: null,
    slowmo: false,
  },
];

const STALL_T = 10.0;
const STALL_END = 12.6;

/**
 * @param {() => number} prng seeded mulberry32 stream from app.js
 */
export function buildData(prng) {
  const rnd = prng || mulberry32(0x51ab);
  const wobble = fbm1D(mulberry32(7), 3, 0.55);

  const n = Math.round(duration * rate) + 1;
  const t = new Float64Array(n);
  const cmd = new Float64Array(n);
  const vel = new Float64Array(n);
  const current = new Float64Array(n);
  const x = new Float64Array(n);

  let pos = 0;
  for (let i = 0; i < n; i++) {
    const s = i / rate;
    t[i] = s;

    // commanded speed: ramp up, cruise, ramp down at the end
    let c = 0.62;
    if (s < 1.5) c = 0.62 * smoothstep(s / 1.5);
    if (s > 18.0) c = 0.62 * (1 - smoothstep((s - 18.0) / 2.0));
    cmd[i] = c;

    // the stall: wheels command speed but the rover stops dead against an obstacle
    let slip = 0;
    if (s >= STALL_T && s < STALL_END) {
      slip = smoothstep((s - STALL_T) / 0.28) * (1 - smoothstep((s - (STALL_END - 0.45)) / 0.45));
    }
    const v = c * (1 - slip) + gaussian(rnd, 0, 0.008) + (wobble(s * 2.4) - 0.5) * 0.02;
    vel[i] = clamp(v, -0.1, 1.2);

    pos += vel[i] / rate;
    x[i] = pos;

    // current tracks load: nominal draw plus a big stall spike
    const base = 2.4 + c * 1.6 + (wobble(s * 5.1) - 0.5) * 0.35;
    current[i] = clamp(base + slip * 15.4 + gaussian(rnd, 0, 0.06), 0, 24);
  }

  // /sys at 10 Hz
  const sysRate = 10;
  const m = Math.round(duration * sysRate) + 1;
  const st = new Float64Array(m);
  const temp = new Float64Array(m);
  const battV = new Float64Array(m);
  let temperature = 31.0;
  for (let j = 0; j < m; j++) {
    const s = j / sysRate;
    st[j] = s;
    const iAt = Math.min(Math.round(s * rate), n - 1);
    // first-order thermal lag driven by current squared
    const drive = (current[iAt] * current[iAt]) / 40;
    temperature += (drive - (temperature - 31.0) * 0.06) / sysRate;
    temp[j] = temperature + gaussian(rnd, 0, 0.09);
    battV[j] = 12.42 - s * 0.031 - current[iAt] * 0.041 + gaussian(rnd, 0, 0.012);
  }

  return {
    '/drive': { t, cmd, vel, current, x },
    '/sys': { t: st, temp, batt_v: battV },
  };
}
