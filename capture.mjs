#!/usr/bin/env node
// Screenshot capture for the Nokia EDA (Event Driven Automation) web UI.
//
// Logs in through Keycloak, then captures pages in the chosen theme(s).
// See README.md for full usage.
//
//   eda-screenshotter --url https://my-eda.example.ts.net
//   eda-screenshotter --url https://my-eda --page /ui/app/main/interfaces.eda.nokia.com/v1alpha1/interfaces
//   eda-screenshotter --url https://my-eda --nav expanded --resolution 1920x1080
//
// (or `node capture.mjs ...` / `pnpm capture ...`)
// Requires Node 18+, playwright-core, and a Chrome/Chromium binary.
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const num = (v) => (v === undefined ? undefined : Number(v));

const URL    = (args.url || args._[0] || process.env.EDA_URL || '').replace(/\/$/, '');
const USER   = args.user || process.env.EDA_USER || 'admin';
const PASS   = args.pass || process.env.EDA_PASS || 'admin';
const OUT    = resolve(args.out || process.env.EDA_OUT || '.');
const THEMES = (args.themes || 'dark,light').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
const SCALE  = num(args.scale) || 2;
const NAV_EXPANDED = String(args.nav || 'collapsed').toLowerCase().startsWith('exp');
// --page / --path: one or more deep links (full URL or path), comma-separated.
const CUSTOM = String(args.page || args.path || '').split(',').map((s) => s.trim()).filter(Boolean);

// resolution / aspect ratio -> viewport (CSS px). Final PNG = viewport * scale.
let width = num(args.width), height = num(args.height);
if (args.resolution && typeof args.resolution === 'string') {
  const [w, h] = args.resolution.toLowerCase().split('x').map(Number);
  if (w && h) { width = w; height = h; }
} else if (args.aspect && typeof args.aspect === 'string') {
  const [aw, ah] = args.aspect.split(':').map(Number);
  if (aw && ah) { width = width || 1480; height = Math.round((width * ah) / aw); }
}
const VIEW = { width: width || 1480, height: height || 920 };

if (!URL || args.help) {
  console.log(`Usage: node capture.mjs --url <eda-url> [options]

  --url <url>         EDA base URL (also positional, or $EDA_URL)
  --user <name>       login username (default admin)
  --pass <pw>         login password (default admin)
  --out <dir>         output directory (default .)
  --themes <list>     comma list: dark,light (default dark,light)
  --nav <mode>        navbar: collapsed | expanded (default collapsed)
  --page <url|path>   capture specific page(s), comma-separated; replaces the
                      built-in page set. Full URL or path relative to --url.
  --resolution <WxH>  viewport size, e.g. 1920x1080
  --aspect <W:H>      aspect ratio, e.g. 16:9 (height derived from width)
  --width / --height  explicit viewport dimensions
  --scale <n>         device scale factor / DPI multiplier (default 2)`);
  process.exit(URL ? 0 : 1);
}

// ---------------------------------------------------------------------------
// browser: prefer a system Chrome/Chromium, else a Playwright-managed channel
// ---------------------------------------------------------------------------
function launchOptions() {
  const o = { args: ['--no-sandbox'] };
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (found) o.executablePath = found; else o.channel = 'chrome';
  return o;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
// Collapsed-rail y-centers (CSS px) for items reached by position.
const RAIL = { home: 241, alarms: 289, transactions: 433, topologies: 625 };

const shot = (page, scheme, name) => page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });

function slug(u) {
  try {
    const segs = new globalThis.URL(u).pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || 'page';
    return last.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'page';
  } catch { return 'page'; }
}

async function login(page, theme) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  if (!CUSTOM.length) await shot(page, theme, '01-login'); // Keycloak login page
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await page.click('#kc-login');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(4000);
}

// EDA defaults to Dark and does not persist the choice, so set it every run.
async function setAppTheme(page, theme) {
  await page.mouse.click(VIEW.width - 30, 24);
  await page.waitForTimeout(800);
  await page.getByText('Appearance Theme', { exact: true }).first().click();
  await page.waitForTimeout(800);
  await page.getByText(theme === 'light' ? 'Light' : 'Dark', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
}

// Pin / unpin the left nav via the top-left hamburger. Default state is collapsed.
async function setNav(page) {
  const visible = await page.getByText('Alarms', { exact: true }).first().isVisible().catch(() => false);
  if (NAV_EXPANDED !== visible) {        // toggle only if the current state is wrong
    await page.mouse.click(42, 25);
    await page.waitForTimeout(1000);
  }
}

// Navigate to a top-level nav item: by label when expanded, by position when collapsed.
async function nav(page, label, y) {
  if (NAV_EXPANDED) {
    await page.getByText(label, { exact: true }).first().click({ timeout: 8000 });
    await page.waitForTimeout(3000);
  } else {
    await page.mouse.click(20, y);
    await page.waitForTimeout(3000);
    await page.mouse.move(VIEW.width / 2, VIEW.height / 2); // let the hover-drawer collapse
    await page.waitForTimeout(400);
  }
}

async function captureBuiltins(page, theme) {
  await shot(page, theme, '02-home');
  // Nodes — via the "View" link on the Home Nodes card
  await page.getByText('View', { exact: true }).first().click({ timeout: 8000 });
  await page.waitForTimeout(4000);
  await page.mouse.move(VIEW.width / 2, VIEW.height / 2); await page.waitForTimeout(400);
  await shot(page, theme, '03-nodes');

  await nav(page, 'Alarms', RAIL.alarms);             await shot(page, theme, '04-alarms');
  await nav(page, 'Transactions', RAIL.transactions); await shot(page, theme, '05-transactions');

  await nav(page, 'Topologies', RAIL.topologies);
  await page.getByText('Physical', { exact: true }).first().dblclick({ timeout: 8000 });
  await page.waitForTimeout(7000);
  await shot(page, theme, '06-topology');
}

async function captureCustom(page, theme) {
  for (let i = 0; i < CUSTOM.length; i++) {
    const p = CUSTOM[i];
    const full = p.startsWith('http') ? p : URL + (p.startsWith('/') ? p : '/' + p);
    await page.goto(full, { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000); // let tables / graphs settle
    await page.mouse.move(VIEW.width / 2, VIEW.height / 2); await page.waitForTimeout(400);
    await shot(page, theme, `${String(i + 1).padStart(2, '0')}-${slug(full)}`);
  }
}

async function captureTheme(browser, theme) {
  const scheme = theme === 'light' ? 'light' : 'dark'; // themes Keycloak login + page bg
  const ctx = await browser.newContext({
    viewport: VIEW, deviceScaleFactor: SCALE, ignoreHTTPSErrors: true, colorScheme: scheme,
    httpCredentials: { username: USER, password: PASS },
  });
  const page = await ctx.newPage();
  try {
    await login(page, theme);
    await setAppTheme(page, theme);
    await setNav(page);
    if (CUSTOM.length) await captureCustom(page, theme);
    else await captureBuiltins(page, theme);
    console.log(`  ${theme}: ok`);
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
console.log(`EDA ${URL} -> ${OUT}
  themes=${THEMES.join(',')} nav=${NAV_EXPANDED ? 'expanded' : 'collapsed'} viewport=${VIEW.width}x${VIEW.height}@${SCALE}x` +
  (CUSTOM.length ? `\n  pages=${CUSTOM.join(', ')}` : ''));
const browser = await chromium.launch(launchOptions());
let failed = 0;
for (const theme of THEMES) {
  try { await captureTheme(browser, theme); }
  catch (e) { failed++; console.error(`  ${theme}: FAILED - ${String(e).split('\n')[0]}`); }
}
await browser.close();
console.log(failed ? `Done with ${failed} failed theme(s).` : 'Done.');
process.exit(failed ? 1 : 0);
