// WebKit-зритель SFU (2026-11-22): Chrome показывает экран (canvas + звук), WebKit
// (Playwright, тот же движок WebRTC, что WKWebView в Mac-приложении) смотрит.
// Живой Mac получал байты экрана и не декодировал ни одного кадра — проверяем движок.
// Сервер: launch-конфиг zali-server-sfu-rig (:3001, UDP 3480), web-static :8090.
// Запуск: node webkit_view.mjs [webkit-publisher]  — второй вариант: показывает WebKit.
import { chromium, webkit } from 'playwright-core';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const API = process.env.API || 'http://127.0.0.1:3001';
const swap = process.argv[2] === 'webkit-publisher';
const cr = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const wk = await webkit.launch({ headless: true });
async function open(browser, me, peer, perms) {
  const ctx = await browser.newContext(perms ? { permissions: perms } : {});
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !t.includes('404')) console.log(`[${me} console]`, t.slice(0, 300)); });
  await page.goto(`http://127.0.0.1:8090/?as=${me}&contact=${peer}&chat=${peer}&api=${encodeURIComponent(API)}`);
  await page.waitForFunction(() => typeof window.__zaliControl === 'function', null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  return page;
}
const ctl = (p, cmd, args = {}) => p.evaluate(([c, a]) => window.__zaliControl(c, a), [cmd, args]);
const ev = (p, code) => ctl(p, 'eval', { code });
const P = swap ? await open(wk, 'wkpub1', 'wkview1') : await open(cr, 'crpub1', 'wkview1', ['camera', 'microphone']);
const V = swap ? await open(cr, 'wkview1', 'wkpub1', ['camera', 'microphone']) : await open(wk, 'wkview1', 'crpub1');
const pubName = swap ? 'wkpub1' : 'crpub1';
console.log('call', JSON.stringify(await ctl(P, 'voice.call', { user: 'wkview1' })).slice(0, 200));
await V.waitForTimeout(2500);
console.log('accept', JSON.stringify(await ctl(V, 'voice.accept', {})).slice(0, 200));
console.log('wait', JSON.stringify(await ctl(P, 'wait', { code: "this.voice.status === 'connected' && this.voice.videoTransport === 'sfu'", timeout: 15000 })).slice(0, 200));
const probe = `
  const sfu = this.voice.sfu; const out = { transport: this.voice.videoTransport, sub: sfu?.sub?.pc?.connectionState, inbound: [], mesh: [] };
  if (sfu?.sub?.pc) { const st = await sfu.sub.pc.getStats(); st.forEach(r => { if (r.type==='inbound-rtp') { const c = st.get(r.codecId) || {}; out.inbound.push({kind:r.kind, mid:r.mid, src:(sfu.sub.tracks.get(String(r.mid))||{}).source, codec:c.mimeType, fmtp:c.sdpFmtpLine, pkts:r.packetsReceived, kB:Math.round((r.bytesReceived||0)/1024), recv:r.framesReceived, dec:r.framesDecoded, key:r.keyFramesDecoded, drop:r.framesDropped, w:r.frameWidth, pli:r.pliCount, fir:r.firCount, nack:r.nackCount, impl:r.decoderImplementation}); } }); }
  for (const [peer, e] of this.voice.peerConnections) { (await e.pc.getStats()).forEach(r => { if (r.type==='outbound-rtp' && r.kind==='audio') out.mesh.push({peer, outPkts:r.packetsSent}); if (r.type==='inbound-rtp' && r.kind==='audio') out.mesh.push({peer, inPkts:r.packetsReceived}); }); }
  for (const [u,v] of this.voice.remoteScreens) out['screen:'+u] = { w: v.videoWidth, h: v.videoHeight, tracks: v.srcObject?.getTracks().map(t=>t.kind+':'+t.readyState+':'+(t.muted?'muted':'live')) };
  return out;`;
await P.waitForTimeout(4000);
console.log('mesh P', JSON.stringify(await ev(P, probe)));
console.log('mesh V', JSON.stringify(await ev(V, probe)));
if (process.env.CODEC) await ev(P, `this.voiceSfuChooseCodec = () => '${process.env.CODEC}'; return true`);
await ev(P, `
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d'); let n = 0;
  setInterval(() => { n++; g.fillStyle = 'hsl(' + (n*3%360) + ',60%,40%)'; g.fillRect(0,0,1280,720); g.fillStyle='#fff'; g.font='90px sans-serif'; g.fillText('frame ' + n, 60 + (n*7)%700, 360); }, 33);
  const ac = new AudioContext(); const osc = ac.createOscillator(); const dst = ac.createMediaStreamDestination(); osc.connect(dst); osc.start();
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream([c.captureStream(30).getVideoTracks()[0], dst.stream.getAudioTracks()[0]]);
  await this.startScreenShare({ surface: 'monitor', height: 720, fps: 30, audio: true });
  return this.voice.screenSharing;`);
if (process.env.SDP) { await V.waitForTimeout(6000); const r = await ev(V, `const pc = this.voice.sfu.sub.pc; const pick = sdp => sdp.split('m=').filter(m => m.startsWith('video')).map(m => m.split('\\r\\n').filter(l => /^(video|a=rtpmap|a=fmtp|a=ssrc|a=mid|a=sendonly|a=recvonly|a=rtcp-fb)/.test(l)).join('\\n')).join('\\n----\\n'); return { remote: pick(pc.remoteDescription.sdp), local: pick(pc.localDescription.sdp) };`); console.log('REMOTE (server offer)\n' + r.result.remote + '\nLOCAL (webkit answer)\n' + r.result.local); }
for (let i = 0; i < 3; i++) {
  await V.waitForTimeout(8000);
  console.log(`viewer t+${(i + 1) * 8}s`, JSON.stringify(await ev(V, probe)));
}
console.log('viewer sfu log', JSON.stringify(await ev(V, "return (this.voice.traceLines||[]).filter(l => /sfu|codec|decode/.test(JSON.stringify(l))).slice(-15)")).slice(0, 2500));
await cr.close(); await wk.close();
