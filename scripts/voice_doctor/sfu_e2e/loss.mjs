// SFU e2e: битрейт и устойчивость к потерям. Сервер с SFU_TEST_LOSS_IN/OUT (проценты).
// Запуск: в каталоге со скриптом `npm i --no-save playwright-core`, затем [CODEC=H265|AV1|VP8] node loss.mjs [W H FPS SECONDS]
// CODEC пускает кодек в выбор на обеих сторонах в обход SFU_CODECS_VERIFIED и mediaCapabilities.
import { chromium } from 'playwright-core';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const [W, H, FPS, SECS] = [...process.argv.slice(2).map(Number), 1920, 1080, 60, 40].slice(0, 4).map((v, i) => v || [1920, 1080, 60, 40][i]);
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
async function open(me, peer) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:8090/?as=${me}&contact=${peer}&chat=${peer}`);
  await page.waitForFunction(() => typeof window.__zaliControl === 'function', null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  return page;
}
const ctl = (p, cmd, args = {}) => p.evaluate(([c, a]) => window.__zaliControl(c, a), [cmd, args]);
const ev = async (p, code) => (await ctl(p, 'eval', { code })).result;
const A = await open('sfu1', 'sfu2'); const B = await open('sfu2', 'sfu1');
const CODEC = process.env.CODEC;
if (CODEC) for (const p of [A, B]) await ev(p, `const C = this.constructor; Object.defineProperty(C, 'SFU_CODECS_VERIFIED', { configurable: true, get: () => ['${CODEC}', 'H264'] });
  const caps = await this.ensureVoiceCodecCaps(); for (const k of ['send','recv','encode','decode']) if (!caps[k].includes('${CODEC}')) caps[k].push('${CODEC}'); if (${process.env.NOHEALTH ? 1 : 0}) this.checkVoiceSfuCodecHealth = () => {}; return true;`);
await ctl(A, 'voice.call', { user: 'sfu2' }); await B.waitForTimeout(2000); await ctl(B, 'voice.accept', {});
const ok = await ctl(A, 'wait', { code: "this.voice.videoTransport === 'sfu' && this.voice.status === 'connected'", timeout: 15000 });
if (!ok.ok) { console.log('room not in SFU', ok); process.exit(1); }
await ev(A, `const c = document.createElement('canvas'); c.width = ${W}; c.height = ${H}; const g = c.getContext('2d'); let n = 0;
  setInterval(() => { n++; g.fillStyle = 'hsl(' + (n*2%360) + ',50%,35%)'; g.fillRect(0,0,c.width,c.height); g.fillStyle = '#fff';
    for (let i = 0; i < 60; i++) g.fillRect((i*211 + n*9) % c.width, (i*97 + n*4) % c.height, 80, 80); g.font = '160px sans-serif'; g.fillText(String(n), 200, 400); }, Math.floor(1000/${FPS}));
  navigator.mediaDevices.getDisplayMedia = async () => c.captureStream(${FPS});
  await this.startScreenShare({ surface: 'monitor', height: ${H}, fps: ${FPS}, audio: false }); return true;`);
const pubQ = `const pc = this.voice.sfu?.pub?.pc; const o = { t: Date.now(), layers: {}, avail: 0, codec: this.voice.sfu?.pub?.codec }; if (!pc) return o;
  (await pc.getStats()).forEach(r => { if (r.type === 'candidate-pair' && r.nominated) o.avail = r.availableOutgoingBitrate || 0;
    if (r.type === 'outbound-rtp' && r.kind === 'video') o.layers[r.rid || '-'] = { w: r.frameWidth || 0, h: r.frameHeight || 0, fps: r.framesPerSecond || 0, bytes: r.bytesSent || 0, rtx: r.retransmittedBytesSent || 0, nack: r.nackCount || 0, pli: r.pliCount || 0, lim: r.qualityLimitationReason || '' }; });
  return o;`;
const subQ = `const pc = this.voice.sfu?.sub?.pc; const o = { t: Date.now() }; if (!pc) return o;
  (await pc.getStats()).forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') Object.assign(o, { w: r.frameWidth || 0, h: r.frameHeight || 0, fps: r.framesPerSecond || 0, bytes: r.bytesReceived || 0,
    lost: r.packetsLost || 0, recvPk: r.packetsReceived || 0, nack: r.nackCount || 0, pli: r.pliCount || 0, frz: r.freezeCount || 0, frzDur: r.totalFreezesDuration || 0,
    dropped: r.framesDropped || 0, decoded: r.framesDecoded || 0, kf: r.keyFramesDecoded || 0, jb: r.jitterBufferDelay || 0, jbN: r.jitterBufferEmittedCount || 0 }); });
  return o;`;
await A.waitForTimeout(5000);
let p0 = await ev(A, pubQ), s0 = await ev(B, subQ);
const rows = [];
for (let t = 5; t <= SECS; t += 5) {
  await A.waitForTimeout(5000);
  const p1 = await ev(A, pubQ), s1 = await ev(B, subQ);
  const dt = (p1.t - p0.t) / 1000, dts = (s1.t - s0.t) / 1000;
  const lay = Object.entries(p1.layers).sort().map(([rid, l]) => { const pl = p0.layers[rid] || { bytes: 0, rtx: 0, nack: 0, pli: 0 };
    return `${rid}:${l.w}x${l.h}@${Math.round(l.fps)} ${Math.round((l.bytes - pl.bytes) * 8 / dt / 1000)}k rtx${Math.round((l.rtx - pl.rtx) * 8 / dt / 1000)}k nack${l.nack - pl.nack} pli${l.pli - pl.pli}${l.lim && l.lim !== 'none' ? ' ' + l.lim : ''}`; }).join(' | ');
  const pk = (s1.recvPk - s0.recvPk) + (s1.lost - s0.lost);
  const row = { t, avail: Math.round(p1.avail / 1000), view: `${s1.w}x${s1.h}@${Math.round(s1.fps)}`, viewKbps: Math.round((s1.bytes - s0.bytes) * 8 / dts / 1000),
    lostPct: pk > 0 ? +(100 * (s1.lost - s0.lost) / pk).toFixed(1) : 0, nack: s1.nack - s0.nack, pli: s1.pli - s0.pli, kf: s1.kf - s0.kf, frz: s1.frz - s0.frz,
    frzMs: Math.round((s1.frzDur - s0.frzDur) * 1000), dropped: s1.dropped - s0.dropped, decFps: +((s1.decoded - s0.decoded) / dts).toFixed(1),
    jbMs: s1.jbN > s0.jbN ? Math.round(1000 * (s1.jb - s0.jb) / (s1.jbN - s0.jbN)) : 0 };
  rows.push(row);
  console.log(`t+${t}s pub ${p1.codec} avail ${row.avail}k [${lay}]`);
  console.log(`      view ${row.view} ${row.viewKbps}k decFps ${row.decFps} lost ${row.lostPct}% nack ${row.nack} pli ${row.pli} kf ${row.kf} frz ${row.frz} (${row.frzMs}ms) drop ${row.dropped} jb ${row.jbMs}ms`);
  p0 = p1; s0 = s1;
}
const tail = rows.slice(2); const avg = k => Math.round(tail.reduce((a, r) => a + r[k], 0) / Math.max(1, tail.length) * 10) / 10;
console.log(`SUMMARY (после ${rows[1]?.t || 0}s): view ${avg('viewKbps')}k decFps ${avg('decFps')} lost ${avg('lostPct')}% frz/5s ${avg('frz')} frzMs/5s ${avg('frzMs')} kf/5s ${avg('kf')} pli/5s ${avg('pli')} jb ${avg('jbMs')}ms`);
await browser.close();
