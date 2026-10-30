#!/usr/bin/env node
// Печатает текст для озвучки: читай его в микрофон по порядку.
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Использование: node tools/teleprompter.mjs scripts/demo.json');
  process.exit(1);
}
const script = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(`\n${script.title || file}\n`);
script.scenes.forEach((s, i) => console.log(`${i + 1}. ${s.say.replace(/\*/g, '')}`));
console.log('');
