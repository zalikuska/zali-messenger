// Нативная отправка экрана на SFU (core/src/sfu_publisher.rs) — сквозной прогон без оболочки
// (2026-11-22). Страница A в звонке через SFU играет роль оболочки: ретранслирует сигналинг
// настоящим кодом voice_sfu.js (startVoiceNativeSfuScreen → voice_sfu_publish slot native →
// ответ → sfu_answer), а «оболочка» — пример ядра sfu_pub_file, который шлёт заранее
// закодированные VideoToolbox слои. Страница B — зритель: смотрим, что доходит.
// Запуск: сервер zali-server-sfu (:3000) и web-static (:8090) подняты, в каталоге скрипта
// `npm i --no-save playwright-core`, слои — LAYERS_DIR (q.h264, h.h264, f.h264, см. пример),
// затем node native_pub.mjs [SECS]. SETLOSS=<cmd> — команда, которую позвать на середине.
import { chromium, webkit } from 'playwright-core';
import { spawn, execSync } from 'node:child_process';
import readline from 'node:readline';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const SECS = Number(process.argv[2]) || 32;
const dir = process.env.LAYERS_DIR;
const root = new URL('../../../', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
// VIEWER=webkit — зритель B в WebKit (движок WKWebView Mac-приложения).
const wkBrowser = process.env.VIEWER === 'webkit' ? await webkit.launch({ headless: true }) : null;
async function open(me, peer, engine = browser) {
  const ctx = engine === browser ? await engine.newContext({ permissions: ['camera', 'microphone'] }) : await engine.newContext();
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/404|409/.test(t)) console.log(`[${me}]`, t.slice(0, 300)); });
  await page.goto(`http://127.0.0.1:8090/?as=${me}&contact=${peer}&chat=${peer}${process.env.API ? '&api=' + encodeURIComponent(process.env.API) : ''}`);
  await page.waitForFunction(() => typeof window.__zaliControl === 'function', null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  return page;
}
const ctl = (p, cmd, args = {}) => p.evaluate(([c, a]) => window.__zaliControl(c, a), [cmd, args]);
const ev = async (p, code) => (await ctl(p, 'eval', { code }));
const A = await open('np1', 'np2'); const B = await open('np2', 'np1', wkBrowser || browser);
await ctl(A, 'voice.call', { user: 'np2' }); await B.waitForTimeout(2000); await ctl(B, 'voice.accept', {});
console.log('sfu', JSON.stringify(await ctl(A, 'wait', { code: "this.voice.videoTransport === 'sfu' && this.voice.status === 'connected'", timeout: 15000 })));
// Какие кодеки страница предложила бы оболочке для нативной демонстрации (и что декодирует для превью).
await A.waitForTimeout(1500);
console.log('native-codecs', JSON.stringify((await ev(A, `const s = this.voiceNativeSfuScreenSpec(60); return { codecs: s.codecs, preview: s.previewDecode, peers: this.voice.videoCodecs };`)).result));

// TOP — файл верхнего слоя (по умолчанию f.h264); его битрейт должен помещаться в бюджет:
// настоящая оболочка кодирует слой под бюджет, а готовый файл переполняет очередь отправки.
const layers = process.env.ONLY_TOP ? [[process.env.TOP || 'f', '1920x1080@60:8000000']]
  : process.env.REAL_CAPS
    // Потолки и минимумы как у страницы для экрана (q 150k–400k, h 1M–12M, f 2.5M–40M).
    ? [['q', '480x270@30:400000:150000'], ['h', '960x540@60:12000000:1000000'], [process.env.TOP || 'f', '1920x1080@60:40000000:2500000']]
    : [['q', '480x270@30:400000'], ['h', '960x540@60:2500000'], [process.env.TOP || 'f', '1920x1080@60:8000000']];
const pageLayers = process.env.ONLY_TOP ? [{ rid: 'q', width: 1920, height: 1080, fps: 60 }]
  : [{ rid: 'q', width: 480, height: 270, fps: 30 }, { rid: 'h', width: 960, height: 540, fps: 60 }, { rid: 'f', width: 1920, height: 1080, fps: 60 }];
// PUB_BIN — другой бинарник примера (сравнение «до/после» правки издателя).
// CODEC=H265 | AV1 — слои q.h265… / q.ivf… (издатель берёт CODEC из окружения).
const ext = { H265: 'h265', AV1: 'ivf' }[String(process.env.CODEC || '').toUpperCase()] || 'h264';
const child = spawn(process.env.PUB_BIN || root + 'core/target/release/examples/sfu_pub_file', layers.map(([r, s]) => `${dir}/${r}.${ext}:${s}`), { stdio: ['pipe', 'pipe', 'inherit'] });
await A.exposeFunction('__nativePubAnswer', (sdp) => { child.stdin.write(JSON.stringify({ answer: sdp }) + '\n'); return true; });
const counts = {};
let offer = null; let offerResolve; const offerP = new Promise(r => { offerResolve = r; });
readline.createInterface({ input: child.stdout }).on('line', async (line) => {
  let msg; try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.offer) { offer = msg.offer; offerResolve(); return; }
  counts[msg.event] = (counts[msg.event] || 0) + 1;
  // Статистика — сжато: оценка, раздача, видео по слоям и всё, что ушло в сеть (wire больше
  // суммы видео — паддинг).
  if (msg.event === 'stats') console.log('pub est', msg.estimate_kbps, 'alloc', JSON.stringify(msg.alloc_kbps), 'video', JSON.stringify(msg.sent_kbps), 'wire', msg.wire_kbps, 'loss', JSON.stringify(msg.loss_pct), 'rtt', msg.rtt_ms, 'fps', JSON.stringify(msg.fps));
  else console.log('pub', line.slice(0, 240));
  try { await A.evaluate(([e]) => window.__ZALI_INTERFACE.onNativeSfuEvent(777, e), [msg]); } catch (e) {}
});
await offerP;
console.log('relay', JSON.stringify(await ev(A, `
  const orig = this.nativeMediaRequest.bind(this);
  this.nativeMediaRequest = async (op, fields, t) => {
    if (op === 'sfu_answer') { await window.__nativePubAnswer(fields.options.sdp); return { event: 'sfu_answer_ok' }; }
    return orig(op, fields, t);
  };
  // Как после startScreenShare: показывает экран (voice_state.screen — иначе зритель снимет
  // плитку через 6 с, pruneStaleRemoteScreens).
  this.voice.screenSharing = true; this.syncVoiceMemberState({ force: true });
  const ok = this.startVoiceNativeSfuScreen(777, ${JSON.stringify({ ...offer, layers: pageLayers })});
  return { ok, state: this.voice.sfu?.nativeScreen?.state };`)));
const probe = `const sfu = this.voice.sfu; const o = [];
  if (sfu?.sub?.pc) { const st = await sfu.sub.pc.getStats(); st.forEach(r => { if (r.type==='inbound-rtp' && r.kind==='video') {
    // Дельты за окно между пробами: сколько кадров пришло/собрано/показано и с какой скоростью.
    const p = window.__probePrev || {}; const dt = (r.timestamp - (p.ts || r.timestamp)) / 1000 || 1;
    const d = (k) => Math.round(((r[k] || 0) - (p[k] || 0)) / dt);
    o.push((st.get(r.codecId)?.mimeType || '?').replace('video/','')+' '+r.frameWidth+'x'+r.frameHeight+' recv/s'+d('framesReceived')+' asm/s'+d('framesAssembledFromMultiplePackets')+' dec/s'+d('framesDecoded')+' drop'+(r.framesDropped||0)+' frz'+r.freezeCount+' lost'+r.packetsLost+' nack'+r.nackCount+' kbps'+Math.round(d('bytesReceived')*8/1000)+' jb'+Math.round((r.jitterBufferDelay/(r.jitterBufferEmittedCount||1))*1000)+'ms'
      // jbw — задержка буфера за окно (а не за весь звонок): растущая очередь где-то по пути
      // видна здесь как сотни мс и секунды.
      +' jbw'+Math.round(((r.jitterBufferDelay||0)-(p.jitterBufferDelay||0))/(((r.jitterBufferEmittedCount||0)-(p.jitterBufferEmittedCount||0))||1)*1000)+'ms');
    window.__probePrev = { ts: r.timestamp, framesReceived: r.framesReceived, framesAssembledFromMultiplePackets: r.framesAssembledFromMultiplePackets, framesDecoded: r.framesDecoded, bytesReceived: r.bytesReceived, jitterBufferDelay: r.jitterBufferDelay, jitterBufferEmittedCount: r.jitterBufferEmittedCount };
  } }); }
  return { inb: o, tiles: this.voice.remoteScreens?.size || 0 };`;
const steps = Math.ceil(SECS / 8);
for (let i = 0; i < steps; i++) {
  await B.waitForTimeout(8000);
  if (process.env.SETLOSS && i === Math.floor(steps / 2) - 1) { console.log('setloss', execSync(process.env.SETLOSS).toString().trim()); }
  console.log('t+' + (i + 1) * 8 + 's B', JSON.stringify((await ev(B, probe)).result), '| A', JSON.stringify((await ev(A, 'return this.voice.sfu?.nativeScreen?.state')).result));
}
console.log('stop', JSON.stringify(await ev(A, `this.stopVoiceNativeSfuScreen(); return { ns: !!this.voice.sfu?.nativeScreen };`)));
await B.waitForTimeout(3000);
console.log('after-stop B', JSON.stringify((await ev(B, probe)).result), 'events', JSON.stringify(counts));
child.stdin.write(JSON.stringify({ quit: true }) + '\n');
await browser.close(); if (wkBrowser) await wkBrowser.close();
