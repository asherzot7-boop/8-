#!/usr/bin/env node
// Собирает вертикальный ролик 1080×1920 из сценария (JSON) и твоей озвучки.
//
//   node src/render.mjs scripts/demo.json --voice voice/demo.m4a [--words voice/demo.words.json] [--out out/demo.mp4]
//
// Без --voice ролик рендерится без звука, с примерной раскадровкой (удобно для черновика).
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = parseArgs(process.argv.slice(2));
if (!args._[0]) {
  console.error('Использование: node src/render.mjs <сценарий.json> [--voice файл] [--words файл] [--out файл] [--fps 30] [--preview секунд]');
  process.exit(1);
}
const scriptPath = path.resolve(args._[0]);
const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const hero = JSON.parse(fs.readFileSync(path.resolve(args.hero || path.join(ROOT, 'hero.json')), 'utf8'));
const fps = Number(args.fps || 30);
const name = path.basename(scriptPath, '.json');
const out = path.resolve(args.out || path.join(ROOT, 'out', `${name}.mp4`));
const voice = args.voice ? path.resolve(args.voice) : null;
const wordsFile = args.words ? path.resolve(args.words) : voice && guessWords(voice);

// ── слова сценария (звёздочки *так* = акцентные, оранжевые) ──
const words = [];
script.scenes.forEach((scene, si) => {
  let on = false;
  for (const raw of (scene.say || '').split(/\s+/).filter(Boolean)) {
    if (raw.startsWith('*')) on = true;
    words.push({ text: raw.replace(/\*/g, ''), accent: on, scene: si });
    if (raw.endsWith('*')) on = false;
  }
});

// ── громкость голоса по кадрам (для анимации рта) ──
let levels = null, duration;
if (voice) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', voice, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
  duration = s.length / 16000;
  const per = Math.floor(16000 / fps);
  const raw = [];
  for (let i = 0; i * per < s.length; i++) {
    let sum = 0;
    for (let j = i * per; j < Math.min(s.length, (i + 1) * per); j++) sum += s[j] * s[j];
    raw.push(Math.sqrt(sum / per));
  }
  const p95 = [...raw].sort((a, b) => a - b)[Math.floor(raw.length * 0.95)] || 1;
  levels = raw.map((v) => Math.min(1, v / p95));
}

// ── тайминг слов ──
if (wordsFile && fs.existsSync(wordsFile)) {
  // точные таймкоды из tools/align.py (Whisper): раскладываем слова сценария по ним
  const ww = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
  words.forEach((w, k) => {
    const a = ww[Math.min(ww.length - 1, Math.floor((k * ww.length) / words.length))];
    w.start = a.start;
  });
  console.log(`Тайминг: ${path.relative(process.cwd(), wordsFile)}`);
} else if (levels) {
  // нет таймкодов — делим речь пропорционально длине слов
  const loud = levels.map((v) => v > 0.12);
  const first = loud.indexOf(true), last = loud.lastIndexOf(true);
  const t0 = Math.max(0, first / fps - 0.05), t1 = (last + 1) / fps;
  spread(words, t0, t1);
  console.log('Тайминг: по длине слов (для точных субтитров запусти tools/align.py)');
} else {
  const weight = words.reduce((s, w) => s + weightOf(w), 0);
  duration = 0.4 + weight * 0.065 + 0.8;
  spread(words, 0.4, duration - 0.8);
  console.log('Тайминг: черновой, без озвучки');
}
duration = Math.max(duration, (words.at(-1)?.start || 0) + 0.6);

const scenes = script.scenes.map((sc, si) => ({ ...sc, start: si === 0 ? 0 : words.find((w) => w.scene === si)?.start ?? 0 }));
scenes.forEach((sc) => {
  if (sc.card?.src) sc.card.src = pathToFileURL(path.resolve(path.dirname(scriptPath), sc.card.src)).href;
});

// субтитры кусками по 1–2 слова, внутри одной сцены
const chunks = [];
for (let k = 0; k < words.length;) {
  const a = words[k], b = words[k + 1];
  const two = b && b.scene === a.scene && (a.text + b.text).length <= 14 && !/[.,!?—:]$/.test(a.text);
  const ws = two ? [a, b] : [a];
  chunks.push({ start: a.start, words: ws.map(({ text, accent }) => ({ text, accent })) });
  k += ws.length;
}
chunks.forEach((ch, k) => (ch.end = chunks[k + 1] ? chunks[k + 1].start : duration));

if (args.preview) duration = Math.min(duration, Number(args.preview));
const total = Math.ceil(duration * fps);

// ── рендер кадров в браузере и склейка в mp4 ──
fs.mkdirSync(path.dirname(out), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
await page.goto(pathToFileURL(path.join(ROOT, 'src', 'scene.html')).href);
await page.evaluate((d) => window.setup(d), { fps, duration, scenes, chunks, levels, hero });

const ff = spawn('ffmpeg', [
  '-y', '-v', 'error',
  '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
  ...(voice ? ['-i', voice] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']),
  '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-t', String(duration),
  '-movflags', '+faststart', out,
], { stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((res, rej) => ff.on('close', (code) => (code ? rej(new Error(`ffmpeg: код ${code}`)) : res())));

for (let i = 0; i < total; i++) {
  const url = await page.evaluate((n) => window.frame(n), i);
  const buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % fps === 0) process.stdout.write(`\rКадр ${i}/${total}`);
}
ff.stdin.end();
await done;
await browser.close();
console.log(`\rГотово: ${path.relative(process.cwd(), out)} (${duration.toFixed(1)} с, ${total} кадров)`);

function weightOf(w) {
  return w.text.length + 3 + (/[.!?]$/.test(w.text) ? 6 : /[,—:]$/.test(w.text) ? 3 : 0);
}

function spread(ws, t0, t1) {
  const total = ws.reduce((s, w) => s + weightOf(w), 0);
  let acc = 0;
  for (const w of ws) {
    w.start = t0 + ((t1 - t0) * acc) / total;
    acc += weightOf(w);
  }
}

function guessWords(v) {
  const f = v.replace(/\.[^.]+$/, '.words.json');
  return fs.existsSync(f) ? f : null;
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}
