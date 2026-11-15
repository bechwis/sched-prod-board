// Records the board in use: open-board, watch-board, ack-incident (Berlin), then a short Auckland view.
// Usage: node scripts/record.mjs <board url> <out dir>
// Writes <out>/video.mp4 and <out>/run.json (ack receipt, its mm:ss in the video, build sha).
// Frames come from Chrome's screencast (CDP) with their own timestamps; the system ffmpeg joins them.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const [url, out] = process.argv.slice(2);
if (!url || !out) throw new Error('usage: record.mjs <board url> <out dir>');
mkdirSync(out, { recursive: true });

const executablePath =
  process.env.CHROMIUM ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1237/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath });
const size = { width: 1100, height: 640 };
const mmss = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

const frames = []; // { file, t } in ms since the video start
let videoStart = null;
let n = 0;

async function segment(name, opts, steps) {
  const ctx = await browser.newContext({ ...opts, viewport: size });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const t = metadata.timestamp * 1000;
    videoStart ??= t;
    const file = `f${String(n++).padStart(5, '0')}.jpg`;
    writeFileSync(`${out}/frames/${file}`, Buffer.from(data, 'base64'));
    frames.push({ file, t: t - videoStart });
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
  await page.goto('about:blank');
  await page.waitForTimeout(300);
  const log = [];
  const at = (what) => {
    const ms = Date.now() - (videoStart ?? Date.now()); // same clock as the frame stamps
    log.push({ what, at: mmss(ms), ms });
  };
  const result = await steps(page, at);
  await cdp.send('Page.stopScreencast');
  await ctx.close();
  return { ...result, log };
}
mkdirSync(`${out}/frames`, { recursive: true });

const berlin = await segment('berlin', { locale: 'de-DE', timezoneId: 'Europe/Berlin' }, async (page, at) => {
  await page.goto(url);
  at('open-board: page opened');
  await page.getByTestId('loader').waitFor({ state: 'hidden' });
  await page.getByTestId('incident-row').first().waitFor();
  at('open-board: incidents on screen, loader gone');
  const sha = await page.locator('meta[name="build"]').getAttribute('content');
  const footer = await page.getByTestId('build-sha').textContent();

  // watch-board: count refresh calls while the board stays open.
  let polls = 0;
  page.on('request', (r) => r.url().includes('/incidents') && polls++);
  await page.waitForTimeout(6500);
  at(`watch-board: ${polls} refreshes in 6.5 s without a reload`);

  // ack-incident: ack the top row, keep the API's receipt.
  const row = page.getByTestId('incident-row').first();
  const id = await row.getAttribute('data-id');
  const ackReply = page.waitForResponse((r) => r.url().includes('/ack'));
  await row.getByTestId('ack').hover();
  await page.waitForTimeout(800);
  await row.getByTestId('ack').click();
  at(`ack-incident: clicked Ack on ${id}`);
  const reply = await (await ackReply).json();
  await page.locator(`[data-testid="incident-row"][data-id="${id}"] [data-testid="acked"]`).waitFor();
  at(`ack-incident: ${id} marked acked`);
  await page.waitForTimeout(4000);
  at('ack-incident: still acked after two refreshes');
  return { sha, footer, id, reply, polls };
});

const auckland = await segment('auckland', { locale: 'en-NZ', timezoneId: 'Pacific/Auckland' }, async (page, at) => {
  await page.goto(url);
  await page.getByTestId('incident-row').first().waitFor();
  const first = await page.locator('[data-testid="incident-row"] time').first().evaluate((t) => [t.textContent, t.dateTime]);
  at(`auckland view: first time shows ${first[0]} (datetime ${first[1]})`);
  await page.waitForTimeout(4000);
  return { first };
});

const videoEnd = Date.now() - videoStart;
await browser.close();
// Join frames with their real durations, so mm:ss in the log matches the video.
frames.sort((a, b) => a.t - b.t);
const list = frames.map((f, i) => `file 'frames/${f.file}'\nduration ${(((frames[i + 1]?.t ?? videoEnd) - f.t) / 1000).toFixed(3)}`).join('\n');
writeFileSync(`${out}/frames.txt`, `${list}\nfile 'frames/${frames.at(-1).file}'\n`);
execFileSync('/usr/local/bin/ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${out}/frames.txt`, '-vf', 'fps=25,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', `${out}/video.mp4`]);
const ackLine = berlin.log.find((l) => l.what.startsWith('ack-incident: clicked'));
const run = { url, sha: berlin.sha, footer: berlin.footer, ack: { id: berlin.id, at: ackLine.at, reply: berlin.reply }, polls: berlin.polls, berlin: berlin.log, auckland: auckland.log };
writeFileSync(`${out}/run.json`, JSON.stringify(run, null, 2));
console.log(JSON.stringify({ sha: run.sha, footer: run.footer, ackId: run.ack.id, ackAt: run.ack.at, polls: run.polls, log: [...run.berlin, ...run.auckland].map((l) => `${l.at} ${l.what}`) }, null, 2));
