import { handleChat } from './chat.js';
const env = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

async function ask(robot, messages, label) {
  const req = new Request('https://alloylogger.com/demo/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://alloylogger.com' },
    body: JSON.stringify({ robot, messages }),
  });
  const res = await handleChat(req, env);
  let out = '';
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const f = buf.slice(0, cut).trim(); buf = buf.slice(cut + 2);
      if (!f.startsWith('data:')) continue;
      const m = JSON.parse(f.slice(5));
      if (m.type === 'delta') out += m.text;
    }
  }
  console.log(`--- ${label}\n${out}\n`);
  if (/—/.test(out)) console.log('  !! em dash present');
  return out;
}

// same robot twice: second call must read the facts pack from cache
const a1 = await ask('sbr', [{ role: 'user', content: 'Why does it fall over?' }], 'sbr #1');
await ask('sbr', [
  { role: 'user', content: 'Why does it fall over?' },
  { role: 'assistant', content: a1 },
  { role: 'user', content: 'so what do I change first?' },
], 'sbr #2 (follow-up, tests history + cache)');
await ask('rescue', [{ role: 'user', content: 'what is the highest current draw and when' }], 'rescue');
await ask('sbr', [{ role: 'user', content: 'what is the airspeed velocity of an unladen swallow' }], 'off-topic');
