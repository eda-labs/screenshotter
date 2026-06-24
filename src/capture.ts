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
// (or `node dist/capture.js ...` / `pnpm capture ...`)
// Requires Node 18+, playwright-core, and a Chrome/Chromium binary.
import { chromium } from 'playwright-core';
import type { Browser, BrowserContextOptions, Page } from 'playwright-core';
import { mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

type ArgValue = string | boolean | string[] | undefined;
type Args = {
  _: string[];
  [key: string]: ArgValue;
};
type LaunchOptions = NonNullable<Parameters<typeof chromium.launch>[0]>;
type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
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

function normalizeArgv(argv: string[]): string[] {
  const [command, ...rest] = argv;
  if (command === 'capture') return rest;
  if (command === 'help') return ['--help', ...rest];
  return argv;
}

function argString(value: ArgValue): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const args = parseArgs(normalizeArgv(process.argv.slice(2)));
const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));

const URL    = (argString(args.url) || args._[0] || process.env.EDA_URL || '').replace(/\/$/, '');
const USER   = argString(args.user) || process.env.EDA_USER || 'admin';
const PASS   = argString(args.pass) || process.env.EDA_PASS || 'admin';
const OUT    = resolve(argString(args.out) || process.env.EDA_OUT || '.');
const THEMES = (argString(args.themes) || 'dark,light').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
const SCALE  = num(argString(args.scale)) || 2;
const NAV_EXPANDED = String(argString(args.nav) || 'collapsed').toLowerCase().startsWith('exp');
// --page / --path: one or more deep links (full URL or path), comma-separated.
const CUSTOM = (argString(args.page) || argString(args.path) || '').split(',').map((s) => s.trim()).filter(Boolean);

// resolution / aspect ratio -> viewport (CSS px). Final PNG = viewport * scale.
let width = num(argString(args.width)), height = num(argString(args.height));
const resolution = argString(args.resolution);
const aspect = argString(args.aspect);
if (resolution) {
  const [w, h] = resolution.toLowerCase().split('x').map(Number);
  if (w && h) { width = w; height = h; }
} else if (aspect) {
  const [aw, ah] = aspect.split(':').map(Number);
  if (aw && ah) {
    const aspectWidth = width || 1480;
    width = aspectWidth;
    height = Math.round((aspectWidth * ah) / aw);
  }
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
  node dist/capture.js --url <eda-url> [options]

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
function launchOptions(): LaunchOptions {
  const options: LaunchOptions = { args: ['--no-sandbox'] };
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  if (found) options.executablePath = found;
  return options;
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

const shot = (page: Page, scheme: string, name: string) => page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });

function schemeFor(theme: string): 'light' | 'dark' {
  return theme === 'light' ? 'light' : 'dark';
}

function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

async function timed<T>(label: string, fn: () => Promise<T>, indent = '  '): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    console.log(`${indent}${label}: ${duration(performance.now() - start)}`);
  }
}

async function waitForPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  })).catch(() => {});
}

async function waitForDocumentReady(page: Page, timeout = WAIT.app): Promise<void> {
  await page.waitForFunction(() => document.readyState !== 'loading', undefined, { timeout }).catch(() => {});
}

async function waitForAssetsReady(page: Page): Promise<void> {
  await page.waitForFunction(() => !document.fonts || document.fonts.status === 'loaded', undefined, { timeout: 2000 }).catch(() => {});
  await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete), undefined, { timeout: 2000 }).catch(() => {});
}

async function waitForBusyGone(page: Page, timeout = WAIT.busy): Promise<void> {
  await page.waitForFunction((selector: string) => {
    const isVisible = (el: Element): boolean => {
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

async function waitForDomQuiet(page: Page, quietMs = 300, timeout = WAIT.quiet): Promise<void> {
  await page.waitForFunction(({ quietMs }: { quietMs: number }) => new Promise<boolean>((resolve) => {
    const target = document.body;
    if (!target) {
      resolve(true);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      observer?.disconnect();
      resolve(true);
    };
    const reset = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    };

    observer = new MutationObserver(reset);
    observer.observe(target, { attributes: true, childList: true, characterData: true, subtree: true });
    reset();
  }), { quietMs }, { timeout }).catch(() => {});
}

async function settlePage(page: Page, timeout = WAIT.page): Promise<void> {
  await waitForDocumentReady(page, timeout);
  await waitForBusyGone(page, Math.min(timeout, WAIT.busy));
  await waitForDomQuiet(page, 300, Math.min(timeout, WAIT.quiet));
  await waitForAssetsReady(page);
  await waitForPaint(page);
}

async function waitForAppShellReady(page: Page, timeout = WAIT.app): Promise<void> {
  await page.waitForFunction(() => {
    const text = (document.body?.innerText || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
    if (!text || text === 'Loading...' || text.endsWith(' Loading...')) return false;
    return text.includes('Event Driven Automation') && text.includes('All Namespaces') && text.includes('Home');
  }, undefined, { timeout }).catch((e: unknown) => {
    throw new Error(`EDA app shell did not become ready within ${timeout}ms: ${String(e).split('\n')[0]}`);
  });
}

async function waitForAppReady(page: Page): Promise<void> {
  await waitForDocumentReady(page, WAIT.app);
  const loginVisible = await page.locator('#username, #kc-login').first().isVisible().catch(() => false);
  if (loginVisible) throw new Error('Authenticated session was not accepted; login form is still visible');
  await waitForAppShellReady(page, WAIT.app);
  await settlePage(page, WAIT.app);
}

async function newCaptureContext(browser: Browser, theme: string, storageState?: StorageState) {
  const options: BrowserContextOptions = {
    viewport: VIEW,
    deviceScaleFactor: SCALE,
    ignoreHTTPSErrors: true,
    colorScheme: schemeFor(theme),
    httpCredentials: { username: USER, password: PASS },
  };
  if (storageState) options.storageState = storageState;
  return browser.newContext(options);
}

function slug(u: string): string {
  try {
    const segs = new globalThis.URL(u).pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || 'page';
    return last.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'page';
  } catch { return 'page'; }
}

async function login(page: Page, theme: string, { captureLogin = false }: { captureLogin?: boolean } = {}): Promise<void> {
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

async function authenticate(browser: Browser, theme: string): Promise<StorageState> {
  const ctx = await newCaptureContext(browser, theme);
  const page = await ctx.newPage();
  try {
    await login(page, theme, { captureLogin: !CUSTOM.length });
    return await ctx.storageState();
  } finally {
    await ctx.close();
  }
}

async function captureLoginPage(browser: Browser, theme: string): Promise<void> {
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
async function setAppTheme(page: Page, theme: string): Promise<void> {
  await page.mouse.click(VIEW.width - 30, 24);
  await page.getByText('Appearance Theme', { exact: true }).first().click({ timeout: WAIT.action });
  await page.getByText(theme === 'light' ? 'Light' : 'Dark', { exact: true }).first().click({ timeout: WAIT.action });
  await page.keyboard.press('Escape');
  await settlePage(page, WAIT.action);
}

// Pin / unpin the left nav via the top-left hamburger. Default state is collapsed.
async function setNav(page: Page): Promise<void> {
  const visible = await page.getByText('Alarms', { exact: true }).first().isVisible().catch(() => false);
  if (NAV_EXPANDED !== visible) {        // toggle only if the current state is wrong
    await page.mouse.click(42, 25);
    await settlePage(page, WAIT.action);
  }
}

// Navigate to a top-level nav item: by label when expanded, by position when collapsed.
async function nav(page: Page, label: string, y: number): Promise<void> {
  if (NAV_EXPANDED) {
    await page.getByText(label, { exact: true }).first().click({ timeout: WAIT.action });
  } else {
    await page.mouse.click(20, y);
    await page.mouse.move(VIEW.width / 2, VIEW.height / 2); // let the hover-drawer collapse
  }
  await settlePage(page, WAIT.page);
}

async function openApp(page: Page): Promise<void> {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
}

async function captureBuiltins(page: Page, theme: string): Promise<void> {
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

async function captureCustom(page: Page, theme: string): Promise<void> {
  for (let i = 0; i < CUSTOM.length; i++) {
    const p = CUSTOM[i];
    const full = p.startsWith('http') ? p : URL + (p.startsWith('/') ? p : '/' + p);
    await timed(`${String(i + 1).padStart(2, '0')}-${slug(full)}`, async () => {
      await page.goto(full, { waitUntil: 'domcontentloaded' });
      await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
      await waitForAppShellReady(page, WAIT.page);
      await settlePage(page, WAIT.page);
      await shot(page, theme, `${String(i + 1).padStart(2, '0')}-${slug(full)}`);
    }, '    ');
  }
}

async function captureTheme(browser: Browser, theme: string, storageState: StorageState): Promise<void> {
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
