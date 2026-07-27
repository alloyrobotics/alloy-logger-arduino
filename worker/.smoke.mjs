import { handleChat } from './chat.js';

const env = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

async function ask(robot, messages) {
  const req = new Request('https://alloylogger.com/demo/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://alloylogger.com' },
    body: JSON.stringify({ robot, messages }),
  });
  const res = await handleChat(req, env);
  if (res.headers.get('content-type')?.includes('json')) {
    console.log('HTTP', res.status, await res.text());
    return null;
  }
  let out = '';
  let meta = null;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, cut).trim();
      buf = buf.slice(cut + 2);
      if (!frame.startsWith('data:')) continue;
      const m = JSON.parse(frame.slice(5));
      if (m.type === 'delta') out += m.text;
      else meta = m;
    }
  }
  console.log(out);
  console.log('  >> meta:', JSON.stringify(meta));
  return out;
}

const qs = [
  ['sbr', 'How bad is the heap leak, and when would it actually reboot?'],
  ['drone', 'Was the battery the problem?'],
  ['arm6', 'What was joint 2 torque doing right before the drop?'],
];
for (const [robot, q] of qs) {
  console.log(`\n================ ${robot}: ${q}\n`);
  await ask(robot, [{ role: 'user', content: q }]);
}

console.log('\n================ guard rails\n');
await ask('nope', [{ role: 'user', content: 'hi' }]);
await ask('sbr', [{ role: 'user', content: 'x'.repeat(900) }]);
await ask('sbr', []);
