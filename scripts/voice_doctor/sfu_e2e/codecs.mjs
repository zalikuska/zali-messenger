// Прогон одного кодека через SFU: node codecs.mjs CODEC W H FPS [SECS] (CODEC = H265|AV1|H264|VP8).
// Кодек принудительно пускается в выбор на обеих сторонах (SFU_CODECS_VERIFIED и caps), остальное — как hi.mjs.
// SFU e2e (2026-11-22): два headless Chrome for Testing из кеша Playwright с фейковой камерой
// против локального сервера (.claude/launch.json → zali-server-sfu) и web-static :8090.
// Запуск: в каталоге со скриптом `npm i --no-save playwright-core` (ESM не читает NODE_PATH), затем node hi.mjs [hi: W H FPS]
// Аккаунты sfu1/sfu2 создаются dev-ссылкой; первый прогон может упасть на not_a_contact — повторить.
import { chromium } from 'playwright-core';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const CODEC = process.argv[2]; const [W, H, FPS, SECS = 40] = process.argv.slice(3).map(Number);
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--disable-gpu-vsync','--disable-frame-rate-limit'] });
async function open(me, peer) {
  const ctx = await browser.newContext({ permissions: ['camera','microphone'] });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (m.type()==='error' && !/404|409/.test(t)) console.log(`[${me}]`, t.slice(0,300)); });
  await page.goto(`http://127.0.0.1:8090/?as=${me}&contact=${peer}&chat=${peer}`);
  await page.waitForFunction(() => typeof window.__zaliControl === 'function', null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  return page;
}
const ctl = (p, cmd, args={}) => p.evaluate(([c,a]) => window.__zaliControl(c, a), [cmd, args]);
const ev = (p, code) => ctl(p, 'eval', { code });
const A = await open('sfu1','sfu2'); const B = await open('sfu2','sfu1');
const force = (p) => ev(p, `const C = this.constructor; Object.defineProperty(C, 'SFU_CODECS_VERIFIED', { configurable: true, get: () => ['${CODEC}', 'H264'] });
  const caps = await this.ensureVoiceCodecCaps(); for (const k of ['send','recv','encode','decode']) if (!caps[k].includes('${CODEC}')) caps[k].push('${CODEC}');
  if (${process.env.SINGLE ? 1 : 0}) { const orig = RTCPeerConnection.prototype.addTransceiver; RTCPeerConnection.prototype.addTransceiver = function (t, init) { if (init?.sendEncodings?.length > 1) throw new Error('test: single layer'); return orig.call(this, t, init); }; }
  if (${process.env.SM ? 1 : 0}) { const orig = RTCPeerConnection.prototype.addTransceiver; RTCPeerConnection.prototype.addTransceiver = function (t, init) { if (init?.sendEncodings?.length > 1) init = { ...init, sendEncodings: init.sendEncodings.map(e => ({ ...e, scalabilityMode: '${process.env.SM}' })) }; return orig.call(this, t, init); }; }
  if (${process.env.NOHEALTH ? 1 : 0}) this.checkVoiceSfuCodecHealth = () => {}; this.sendVoiceRoomPresence?.(); return caps;`);
console.log('caps A', JSON.stringify((await force(A)).result), 'B', JSON.stringify((await force(B)).result));
await ctl(A, 'voice.call', { user: 'sfu2' }); await B.waitForTimeout(2000); await ctl(B, 'voice.accept', {});
console.log('sfu', JSON.stringify(await ctl(A, 'wait', { code: "this.voice.videoTransport === 'sfu' && this.voice.status === 'connected'", timeout: 15000 })));
await A.waitForTimeout(3000);
console.log('start', JSON.stringify(await ev(A, `
  const c = document.createElement('canvas'); c.width = ${W}; c.height = ${H}; const g = c.getContext('2d'); let n = 0;
  const draw = () => { n++; g.fillStyle = 'hsl(' + (n*2%360) + ',50%,35%)'; g.fillRect(0,0,c.width,c.height); g.fillStyle='#fff';
    for (let i=0;i<60;i++){ g.fillRect((i*211 + n*9)%c.width, (i*97 + n*4)%c.height, 80, 80); } g.font='200px sans-serif'; g.fillText(String(n), 200, 400); };
  setInterval(draw, Math.floor(1000/${FPS}));
  navigator.mediaDevices.getDisplayMedia = async () => c.captureStream(${FPS});
  await this.startScreenShare({ surface: 'monitor', height: ${H}, fps: ${FPS}, audio: false });
  const tr = this.voice.sfu?.pub?.transceivers?.screen; return { hint: this.voice.localScreenStream.getVideoTracks()[0].contentHint, enc: tr?.sender.getParameters().encodings.map(e => ({rid:e.rid, scale:e.scaleResolutionDownBy, max:e.maxBitrate, fps:e.maxFramerate, pri:e.priority})), dp: tr?.sender.getParameters().degradationPreference };`)));
const probe = `const sfu = this.voice.sfu; const o = { out: [], inb: [] };
  if (sfu?.pub?.pc) { const st = await sfu.pub.pc.getStats(); o.codec = sfu.pub.codec; st.forEach(r => { if (r.type==='outbound-rtp' && r.kind==='video' && r.rid==='f') o.mime = st.get(r.codecId)?.mimeType; if (r.type==='outbound-rtp' && r.kind==='video') o.out.push(r.rid+':'+r.frameWidth+'x'+r.frameHeight+'@'+Math.round(r.framesPerSecond||0)+' tgt'+Math.round((r.targetBitrate||0)/1e3)+'k lim:'+r.qualityLimitationReason); if (r.type==='candidate-pair' && r.nominated) { o.avail = Math.round((r.availableOutgoingBitrate||0)/1e3); o.via = st.get(r.localCandidateId)?.protocol; } }); }
  if (sfu?.sub?.pc) { const st = await sfu.sub.pc.getStats(); st.forEach(r => { if (r.type==='inbound-rtp' && r.kind==='video') o.inb.push((st.get(r.codecId)?.mimeType||'?')+' '+r.frameWidth+'x'+r.frameHeight+'@'+Math.round(r.framesPerSecond||0)+' dec'+r.framesDecoded+' drop'+(r.framesDropped||0)+' frz'+r.freezeCount+' lost'+r.packetsLost+' '+Math.round(r.bytesReceived/1e6)+'MB '+(r.decoderImplementation||'')); }); }
  return o;`;
for (let i = 0; i < Math.ceil(SECS/8); i++) { await A.waitForTimeout(8000); console.log('t+' + (i+1)*8 + 's A', JSON.stringify((await ev(A, probe)).result), '| B', JSON.stringify((await ev(B, probe)).result.inb)); }
if (process.env.SDPDUMP) console.log(JSON.stringify((await ev(A, `const pc = this.voice.sfu.pub.pc; const st = await pc.getStats(); const o = []; st.forEach(r => { if (r.type==='outbound-rtp' && r.kind==='video') o.push({rid:r.rid, ssrc:r.ssrc, enc:r.encoderImplementation, sent:r.bytesSent, w:r.frameWidth, active:r.active, sm:r.scalabilityMode}); });
  return { params: pc.getSenders().filter(s=>s.track?.kind==='video').map(s=>s.getParameters().encodings), out: o, local: pc.localDescription.sdp.split(/\\r\\n/).filter(l=>/^a=(rid|simulcast|ssrc-group|rtpmap|fmtp)/.test(l)), remote: pc.remoteDescription.sdp.split(/\\r\\n/).filter(l=>/^(m=video|a=(rid|simulcast|rtpmap|fmtp|rtcp-fb|extmap))/.test(l)) };`)).result, null, 1));
await browser.close();
