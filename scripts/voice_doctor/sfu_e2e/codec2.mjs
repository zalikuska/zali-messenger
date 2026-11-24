// SFU e2e (2026-11-22): два headless Chrome for Testing из кеша Playwright с фейковой камерой
// против локального сервера (.claude/launch.json → zali-server-sfu) и web-static :8090.
// Запуск: в каталоге со скриптом `npm i --no-save playwright-core` (ESM не читает NODE_PATH), затем node codec2.mjs [hi: W H FPS]
// Аккаунты sfu1/sfu2 создаются dev-ссылкой; первый прогон может упасть на not_a_contact — повторить.
import { chromium } from 'playwright-core';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'] });
async function open(me, peer) { const ctx = await browser.newContext({ permissions: ['camera','microphone'] }); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:8090/?as=${me}&contact=${peer}&chat=${peer}`); await page.waitForFunction(() => typeof window.__zaliControl === 'function', null, { timeout: 30000 }); await page.waitForTimeout(2500); return page; }
const ctl = (p, cmd, args={}) => p.evaluate(([c,a]) => window.__zaliControl(c, a), [cmd, args]);
const ev = (p, code) => ctl(p, 'eval', { code });
const A = await open('sfu1','sfu2'); const B = await open('sfu2','sfu1');
await ctl(A, 'voice.call', { user: 'sfu2' }); await B.waitForTimeout(2000); await ctl(B, 'voice.accept', {});
await ctl(A, 'wait', { code: "this.voice.videoTransport === 'sfu'", timeout: 15000 });
await A.waitForTimeout(9000); // let codec lists propagate
await ctl(A, 'voice.camera', { on: true });
await A.waitForTimeout(10000);
const q = `const s = this.voice.sfu; const out = {chosen: s?.pub?.codec, caps: this._voiceCodecCaps, lists: this.voice.videoCodecs, pubCodecs: [], subCodecs: [], answerVideoPts: (s?.pub?.pc?.remoteDescription?.sdp.match(/m=video[^\\r\\n]*/)||[''])[0]};
  if (s?.pub?.pc) { const st = await s.pub.pc.getStats(); st.forEach(r => { if (r.type==='outbound-rtp' && r.kind==='video') { const c = st.get(r.codecId); out.pubCodecs.push(r.rid + ':' + (c?.mimeType||'?') + ' ' + r.frameWidth + 'x' + r.frameHeight + ' ' + (r.encoderImplementation||'')); } }); }
  if (s?.sub?.pc) { const st = await s.sub.pc.getStats(); st.forEach(r => { if (r.type==='inbound-rtp' && r.kind==='video') { const c = st.get(r.codecId); out.subCodecs.push((c?.mimeType||'?') + ' ' + r.frameWidth + 'x' + r.frameHeight + ' dec=' + r.framesDecoded + ' ' + (r.decoderImplementation||'')); } }); }
  return out;`;
const short = async (p) => { const r = (await ev(p, q)).result; return { chosen: r.chosen, pub: r.pubCodecs.map(x => x.split(' ')[0]), sub: r.subCodecs }; };
console.log('before: A', JSON.stringify(await short(A)), 'B', JSON.stringify((await short(B)).sub));
await ev(B, "await this.ensureVoiceCodecCaps(); this._voiceCodecCaps.decode = ['H264','VP8']; this.sendVoiceRoomPresence(); return true");
await A.waitForTimeout(8000);
console.log('B без H265: A', JSON.stringify(await short(A)), 'B', JSON.stringify((await short(B)).sub));
await ev(B, "this._voiceCodecCaps.decode = ['AV1','H265','H264','VP8','VP9']; this.sendVoiceRoomPresence(); return true");
await A.waitForTimeout(8000);
console.log('B снова с H265: A', JSON.stringify(await short(A)), 'B', JSON.stringify((await short(B)).sub));
await browser.close();
