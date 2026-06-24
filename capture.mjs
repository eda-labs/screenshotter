#!/usr/bin/env node
// Screenshot capture for the Nokia EDA (Event Driven Automation) web UI.
//
// Logs in through Keycloak, then captures pages in the chosen theme(s).
// See README.md for full usage.
//
//   edascr capture --url https://my-eda.example.ts.net
//   edascr capture --url https://my-eda --page /ui/app/main/interfaces.eda.nokia.com/v1alpha1/interfaces
//   edascr capture --url https://my-eda --nav expanded --resolution 1920x1080
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

function normalizeArgv(argv) {
  const [command, ...rest] = argv;
  if (command === 'capture') return rest;
  if (command === 'help') return ['--help', ...rest];
  return argv;
}

const args = parseArgs(normalizeArgv(process.argv.slice(2)));
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
const WAIT = {
  action: 15000,
  app: 30000,
  busy: 5000,
  login: 30000,
  page: 30000,
  quiet: 5000,
};

if (!URL || args.help) {
  console.log(`Usage:
  edascr capture --url <eda-url> [options]
  eda-screenshotter --url <eda-url> [options]
  node capture.mjs --url <eda-url> [options]

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
  process.exit(args.help ? 0 : 1); // --help is success; missing --url is an error
}

// ---------------------------------------------------------------------------
// browser: prefer a system Chrome/Chromium, else Playwright-managed Chromium
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
  if (found) o.executablePath = found;
  return o;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
// Collapsed-rail y-centers (CSS px) for items reached by position.
const RAIL = { home: 241, alarms: 289, transactions: 433, topologies: 625 };
const BUSY_SELECTOR = [
  '[aria-busy="true"]',
  '[class*="busy" i]',
  '[class*="loading" i]',
  '[class*="skeleton" i]',
  '[class*="spinner" i]',
  '.ant-spin-spinning',
  '.mat-mdc-progress-spinner',
  '.MuiCircularProgress-root',
  '.pf-c-spinner',
  '.pf-v5-c-spinner',
  '.v-progress-circular',
].join(',');

const shot = (page, scheme, name) => page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });

function schemeFor(theme) {
  return theme === 'light' ? 'light' : 'dark';
}

function duration(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

async function timed(label, fn, indent = '  ') {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    console.log(`${indent}${label}: ${duration(performance.now() - start)}`);
  }
}

async function waitForPaint(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })).catch(() => {});
}

async function waitForDocumentReady(page, timeout = WAIT.app) {
  await page.waitForFunction(() => document.readyState !== 'loading', undefined, { timeout }).catch(() => {});
}

async function waitForAssetsReady(page) {
  await page.waitForFunction(() => !document.fonts || document.fonts.status === 'loaded', undefined, { timeout: 2000 }).catch(() => {});
  await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete), undefined, { timeout: 2000 }).catch(() => {});
}

async function waitForBusyGone(page, timeout = WAIT.busy) {
  await page.waitForFunction((selector) => {
    const isVisible = (el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0.01 &&
        box.width > 2 &&
        box.height > 2;
    };
    return !Array.from(document.querySelectorAll(selector)).some(isVisible);
  }, BUSY_SELECTOR, { timeout }).catch(() => {});
}

async function waitForDomQuiet(page, quietMs = 300, timeout = WAIT.quiet) {
  await page.waitForFunction(({ quietMs }) => new Promise((resolve) => {
    const target = document.body;
    if (!target) {
      resolve(true);
      return;
    }

    let timer;
    let observer;
    const done = () => {
      clearTimeout(timer);
      observer?.disconnect();
      resolve(true);
    };
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    };

    observer = new MutationObserver(reset);
    observer.observe(target, { attributes: true, childList: true, characterData: true, subtree: true });
    reset();
  }), { quietMs }, { timeout }).catch(() => {});
}

async function settlePage(page, timeout = WAIT.page) {
  await waitForDocumentReady(page, timeout);
  await waitForBusyGone(page, Math.min(timeout, WAIT.busy));
  await waitForDomQuiet(page, 300, Math.min(timeout, WAIT.quiet));
  await waitForAssetsReady(page);
  await waitForPaint(page);
}

async function waitForAppReady(page) {
  await waitForDocumentReady(page, WAIT.app);
  const loginVisible = await page.locator('#username, #kc-login').first().isVisible().catch(() => false);
  if (loginVisible) throw new Error('Authenticated session was not accepted; login form is still visible');
  await settlePage(page, WAIT.app);
}

async function newCaptureContext(browser, theme, storageState) {
  return browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: SCALE,
    ignoreHTTPSErrors: true,
    colorScheme: schemeFor(theme),
    httpCredentials: { username: USER, password: PASS },
    ...(storageState ? { storageState } : {}),
  });
}

function slug(u) {
  try {
    const segs = new globalThis.URL(u).pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || 'page';
    return last.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'page';
  } catch { return 'page'; }
}

async function login(page, theme, { captureLogin = false } = {}) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const username = page.locator('#username');
  await username.waitFor({ state: 'visible', timeout: WAIT.login });
  await settlePage(page, WAIT.login);

  if (captureLogin) await shot(page, theme, '01-login'); // Keycloak login page

  await username.fill(USER);
  await page.locator('#password').fill(PASS);
  await page.locator('#kc-login').click();
  await page.locator('#username, #kc-login').first().waitFor({ state: 'hidden', timeout: WAIT.login }).catch(() => {});
  await waitForAppReady(page);
}

async function authenticate(browser, theme) {
  const ctx = await newCaptureContext(browser, theme);
  const page = await ctx.newPage();
  try {
    await login(page, theme, { captureLogin: !CUSTOM.length });
    return await ctx.storageState();
  } finally {
    await ctx.close();
  }
}

async function captureLoginPage(browser, theme) {
  const ctx = await newCaptureContext(browser, theme);
  const page = await ctx.newPage();
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#username').waitFor({ state: 'visible', timeout: WAIT.login });
    await settlePage(page, WAIT.login);
    await shot(page, theme, '01-login');
  } finally {
    await ctx.close();
  }
}

// EDA defaults to Dark and does not persist the choice, so set it every run.
async function setAppTheme(page, theme) {
  await page.mouse.click(VIEW.width - 30, 24);
  await page.getByText('Appearance Theme', { exact: true }).first().click({ timeout: WAIT.action });
  await page.getByText(theme === 'light' ? 'Light' : 'Dark', { exact: true }).first().click({ timeout: WAIT.action });
  await page.keyboard.press('Escape');
  await settlePage(page, WAIT.action);
}

// Pin / unpin the left nav via the top-left hamburger. Default state is collapsed.
async function setNav(page) {
  const visible = await page.getByText('Alarms', { exact: true }).first().isVisible().catch(() => false);
  if (NAV_EXPANDED !== visible) {        // toggle only if the current state is wrong
    await page.mouse.click(42, 25);
    await settlePage(page, WAIT.action);
  }
}

// Navigate to a top-level nav item: by label when expanded, by position when collapsed.
async function nav(page, label, y) {
  if (NAV_EXPANDED) {
    await page.getByText(label, { exact: true }).first().click({ timeout: WAIT.action });
  } else {
    await page.mouse.click(20, y);
    await page.mouse.move(VIEW.width / 2, VIEW.height / 2); // let the hover-drawer collapse
  }
  await settlePage(page, WAIT.page);
}

async function openApp(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
}

async function captureBuiltins(page, theme) {
  await timed('02-home', async () => {
    await settlePage(page, WAIT.page);
    await shot(page, theme, '02-home');
  }, '    ');

  // Nodes — via the "View" link on the Home Nodes card
  await timed('03-nodes', async () => {
    await page.getByText('View', { exact: true }).first().click({ timeout: WAIT.action });
    await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
    await settlePage(page, WAIT.page);
    await shot(page, theme, '03-nodes');
  }, '    ');

  await timed('04-alarms', async () => {
    await nav(page, 'Alarms', RAIL.alarms);
    await shot(page, theme, '04-alarms');
  }, '    ');

  await timed('05-transactions', async () => {
    await nav(page, 'Transactions', RAIL.transactions);
    await shot(page, theme, '05-transactions');
  }, '    ');

  await timed('06-topology', async () => {
    await nav(page, 'Topologies', RAIL.topologies);
    await page.getByText('Physical', { exact: true }).first().dblclick({ timeout: WAIT.action });
    await page.locator('canvas, svg').first().waitFor({ state: 'visible', timeout: WAIT.page }).catch(() => {});
    await settlePage(page, WAIT.page);
    await shot(page, theme, '06-topology');
  }, '    ');
}

async function captureCustom(page, theme) {
  for (let i = 0; i < CUSTOM.length; i++) {
    const p = CUSTOM[i];
    const full = p.startsWith('http') ? p : URL + (p.startsWith('/') ? p : '/' + p);
    await timed(`${String(i + 1).padStart(2, '0')}-${slug(full)}`, async () => {
      await page.goto(full, { waitUntil: 'domcontentloaded' });
      await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
      await settlePage(page, WAIT.page);
      await shot(page, theme, `${String(i + 1).padStart(2, '0')}-${slug(full)}`);
    }, '    ');
  }
}

async function captureTheme(browser, theme, storageState) {
  const ctx = await newCaptureContext(browser, theme, storageState);
  const page = await ctx.newPage();
  const start = performance.now();
  try {
    console.log(`  ${theme}:`);
    await timed('open', () => openApp(page), '    ');
    await timed('theme', () => setAppTheme(page, theme), '    ');
    await timed('nav', () => setNav(page), '    ');
    if (CUSTOM.length) await captureCustom(page, theme);
    else await captureBuiltins(page, theme);
    console.log(`  ${theme}: ok (${duration(performance.now() - start)})`);
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
const started = performance.now();
const authTheme = THEMES[0] || 'dark';
const storageState = await timed(`auth ${authTheme}`, () => authenticate(browser, authTheme));
if (!CUSTOM.length) {
  for (const theme of THEMES.slice(1)) {
    try { await timed(`login page ${theme}`, () => captureLoginPage(browser, theme)); }
    catch (e) { failed++; console.error(`  login page ${theme}: FAILED - ${String(e).split('\n')[0]}`); }
  }
}
for (const theme of THEMES) {
  try { await captureTheme(browser, theme, storageState); }
  catch (e) { failed++; console.error(`  ${theme}: FAILED - ${String(e).split('\n')[0]}`); }
}
await browser.close();
console.log((failed ? `Done with ${failed} failed theme(s).` : 'Done.') + ` Total ${duration(performance.now() - started)}.`);
process.exit(failed ? 1 : 0);
