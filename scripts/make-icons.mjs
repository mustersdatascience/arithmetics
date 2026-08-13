/* Rendert icon.svg naar de PNG-formaten die iOS, Android en de browsertab nodig
   hebben. iOS accepteert geen SVG voor het thuisschermicoon, en de bron bevat
   tekst, dus alleen de uitgerenderde PNG's worden uitgeleverd: die zien er
   overal hetzelfde uit, ongeacht welke letterfamilie een toestel heeft.

   Draaien met: npm run icons
   Vereist Playwright met Chromium. */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'icon.svg'), 'utf8');

const SIZES = [
  [180, 'apple-touch-icon'],
  [192, 'manifest'],
  [512, 'manifest'],
  [32,  'browsertab']
];

const browser = await chromium.launch();
for (const [size, waarvoor] of SIZES) {
  const page = await browser.newPage({
    viewport: { width: size, height: size }, deviceScaleFactor: 1
  });
  await page.setContent(
    `<style>html,body{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>` +
    svg.replace(/width="180" height="180"/, `width="${size}" height="${size}"`),
    { waitUntil: 'load' });
  const buf = await page.screenshot();
  writeFileSync(join(root, `icon-${size}.png`), buf);
  console.log(`icon-${size}.png  ${(buf.length / 1024).toFixed(1)} kB  (${waarvoor})`);
  await page.close();
}
await browser.close();
