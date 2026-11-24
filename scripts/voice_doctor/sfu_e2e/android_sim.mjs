// Эмуляция Android-оболочки для демонстрации экрана по MEDIA_REQUEST (2026-11-22).
// Телефона на стенде нет: страница A получает «оболочку» в JS — она отвечает на MEDIA_REQUEST
// (transport/start/stop/request_keyframe), отдаёт WebMessage-порт сообщением
// "zali-media-port:<nonce>" и шлёт по нему кадры формата native_media.js (32 байта + H.264
// Annex B из VideoEncoder) — как ScreenH264Encoder.kt. Проверяет JS-сторону целиком:
// транспорт, разбор кадров, WebCodecs-декодер, дорожку, публикацию в SFU и приём у B.
// Запуск: в каталоге со скриптом `npm i --no-save playwright-core`, затем node android_sim.mjs [W H FPS SECS]
import { chromium } from 'playwright-core';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const [W, H, FPS, SECS] = [...process.argv.slice(2).map(Number), 1080, 2400, 30, 24].slice(0, 4).map((v, i) => v || [1080, 2400, 30, 24][i]);
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
async function open(me, peer) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/404|409/.test(t)) console.log(`[${me}]`, t.slice(0, 300)); });
  await page.goto(`http://127.0.0.1:8090/?as=${me}&contact=${peer}&chat=${peer}`);
  await page.waitForFunction(() => typeof window.__zaliControl === 'function', null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  return page;
}
const ctl = (p, cmd, args = {}) => p.evaluate(([c, a]) => window.__zaliControl(c, a), [cmd, args]);
const ev = async (p, code) => (await ctl(p, 'eval', { code }));
const A = await open('sfu1', 'sfu2'); const B = await open('sfu2', 'sfu1');
await ctl(A, 'voice.call', { user: 'sfu2' }); await B.waitForTimeout(2000); await ctl(B, 'voice.accept', {});
console.log('sfu', JSON.stringify(await ctl(A, 'wait', { code: "this.voice.videoTransport === 'sfu' && this.voice.status === 'connected'", timeout: 15000 })));

const sim = await ev(A, `
  const self = this;
  window.__ZALI_NATIVE_PLATFORM = 'android';
  window.__ZALI_BRIDGE_NONCE__ = 'test-nonce-' + Math.random().toString(36).slice(2);
  window.__ZALI_MEDIA_BRIDGE = { kind: 'webmessage' };
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined, configurable: true });
  const origSupports = this.nativeSupports.bind(this);
  this.nativeSupports = (cap) => cap === 'nativeScreen' || origSupports(cap);
  const sim = window.__androidSim = { ops: [], port: null, encoder: null, forceKey: true, frames: 0, keyReqs: 0, timer: null };
  const emit = (payload) => self.onNativeMediaEvent(payload);
  const origPost = this.postNativeMessage.bind(this);
  this.postNativeMessage = (msg) => {
    if (msg?.type !== 'MEDIA_REQUEST') return origPost(msg);
    sim.ops.push(msg.op);
    if (msg.op === 'transport') {
      const ch = new MessageChannel(); sim.port = ch.port1;
      // Подделка из «вложенного фрейма» без секрета — должна игнорироваться.
      const fake = new MessageChannel(); window.postMessage('zali-media-port:wrong', '*', [fake.port2]);
      setTimeout(() => window.postMessage('zali-media-port:' + window.__ZALI_BRIDGE_NONCE__, '*', [ch.port2]), 50);
      return true;
    }
    if (msg.op === 'request_keyframe') { sim.keyReqs++; sim.forceKey = true; return true; }
    if (msg.op === 'stop') { clearInterval(sim.timer); try { sim.encoder.close(); } catch (e) {} return true; }
    if (msg.op !== 'start') return true;
    const W = ${W}, H = ${H}, FPS = Math.min(60, msg.options?.fps || ${FPS});
    // «Согласие» пользователя — 1,5 с, как системное окно MediaProjection.
    setTimeout(async () => {
      const c = new OffscreenCanvas(W, H); const g = c.getContext('2d'); let n = 0; let seq = 0;
      const enc = sim.encoder = new VideoEncoder({
        output: (chunk, meta) => {
          if (!sim.started) {
            sim.started = true;
            emit({ event: 'started', requestId: msg.requestId, stream: msg.stream, codec: 'avc1.42E033', label: 'Экран', width: W, height: H, fps: FPS });
          }
          const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
          const bytes = zaliEncodeMediaFrame({ kind: 2, codec: 1, stream: msg.stream, timestamp: chunk.timestamp, width: W, height: H, keyframe: chunk.type === 'key', seq: seq++, payload: data });
          sim.port.postMessage(bytes.buffer, [bytes.buffer]); sim.frames++;
        },
        error: (e) => { sim.error = String(e); },
      });
      enc.configure({ codec: 'avc1.42E033', width: W, height: H, framerate: FPS, bitrate: 8000000, latencyMode: 'realtime', avc: { format: 'annexb' } });
      sim.timer = setInterval(() => {
        n++; g.fillStyle = 'hsl(' + (n * 3 % 360) + ',50%,35%)'; g.fillRect(0, 0, W, H); g.fillStyle = '#fff';
        for (let i = 0; i < 30; i++) g.fillRect((i * 211 + n * 9) % W, (i * 97 + n * 14) % H, 90, 90);
        g.font = '160px sans-serif'; g.fillText(String(n), 100, 400);
        const f = new VideoFrame(c, { timestamp: Math.round(n * 1e6 / FPS) });
        const key = sim.forceKey; sim.forceKey = false;
        if (enc.encodeQueueSize < 4) enc.encode(f, { keyFrame: key }); f.close();
      }, Math.floor(1000 / FPS));
    }, 1500);
    return true;
  };
  return { caps: self.nativeCaptureAvailable('screen'), bridge: self.nativeMediaBridgeInfo()?.kind };`);
console.log('sim', JSON.stringify(sim));
console.log('start', JSON.stringify(await ev(A, `await this.startScreenShare({ fps: 30, height: 1080 });
  const s = this.voice.localScreenStream; const t = s?.getVideoTracks()[0];
  return { sharing: this.voice.screenSharing, native: this.voice.screenCaptureFromNative, track: t?.readyState, ops: window.__androidSim.ops, frames: window.__androidSim.frames, err: window.__androidSim.error || '' };`)));
const probe = `const sfu = this.voice.sfu; const o = { out: [], inb: [] };
  if (sfu?.pub?.pc) { const st = await sfu.pub.pc.getStats(); st.forEach(r => { if (r.type==='outbound-rtp' && r.kind==='video') o.out.push(r.rid+':'+r.frameWidth+'x'+r.frameHeight+'@'+Math.round(r.framesPerSecond||0)+' '+(st.get(r.codecId)?.mimeType||'')); }); }
  if (sfu?.sub?.pc) { const st = await sfu.sub.pc.getStats(); st.forEach(r => { if (r.type==='inbound-rtp' && r.kind==='video') o.inb.push(r.frameWidth+'x'+r.frameHeight+'@'+Math.round(r.framesPerSecond||0)+' dec'+r.framesDecoded+' frz'+r.freezeCount); }); }
  if (window.__androidSim) o.sim = { frames: window.__androidSim.frames, keyReqs: window.__androidSim.keyReqs, err: window.__androidSim.error || '' };
  return o;`;
for (let i = 0; i < Math.ceil(SECS / 8); i++) { await A.waitForTimeout(8000); console.log('t+' + (i + 1) * 8 + 's A', JSON.stringify((await ev(A, probe)).result), '| B', JSON.stringify((await ev(B, probe)).result.inb)); }
console.log('stop', JSON.stringify(await ev(A, `this.stopScreenShare(); await new Promise(r => setTimeout(r, 500)); return { ops: window.__androidSim.ops, sharing: this.voice.screenSharing };`)));
await browser.close();
