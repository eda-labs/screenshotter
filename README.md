# screenshotter

Capture themed (dark/light) screenshots of the Nokia **EDA** (Event Driven
Automation) web UI. It logs in through Keycloak and drives a headless
Chrome/Chromium via [Playwright](https://playwright.dev/), so the shots are
pixel-accurate and reproducible — handy for docs, release notes, and UI review.

## What it captures

By default, for each theme, it writes `<name>-<theme>.png`:

| File              | Page                                                          |
| ----------------- | ------------------------------------------------------------- |
| `01-login`        | Keycloak login screen                                         |
| `02-home`         | Home / Summary dashboard (nodes, deviations, traffic, alarms) |
| `03-nodes`        | Nodes list (fabric nodes, sync status, addresses)             |
| `04-alarms`       | Alarms — severity donut + active-alarms table                 |
| `05-transactions` | Transactions log                                              |
| `06-topology`     | Physical topology graph                                       |

So a default run produces 12 PNGs (`*-dark.png` and `*-light.png`). Pass
`--page` to capture your own page(s) instead (see below).

## Install

Requires **Node 18+** and **[pnpm](https://pnpm.io/)**.

```bash
git clone https://github.com/eda-labs/screenshotter.git
cd screenshotter
pnpm install
```

You also need a **Chrome/Chromium** binary. The tool auto-detects a system
Chrome (`google-chrome`, `chromium`, the macOS/Windows install paths, or
`$CHROME_PATH`). If you don't have one, let Playwright fetch it:

```bash
pnpm run install-browser   # downloads a Chromium for playwright-core
```

### Global registration

From a local clone, register the command globally:

```bash
pnpm link --global
edascr capture --url https://my-eda.example.ts.net
```

If pnpm has not configured a global binary directory yet, run `pnpm setup`
first and restart your shell.

## Usage

```bash
# simplest — URL only, both themes, output to the current directory
edascr capture --url https://my-eda.example.ts.net

# custom credentials and output directory
edascr capture --url https://my-eda --user admin --pass secret --out ./shots

# capture one specific page, nav expanded, at 1080p, dark only
edascr capture --url https://my-eda \
  --page /ui/app/main/interfaces.eda.nokia.com/v1alpha1/interfaces \
  --nav expanded --resolution 1920x1080 --themes dark

# several specific pages at a 16:9 ratio
edascr capture --url https://my-eda --aspect 16:9 \
  --page /ui/app/main/interfaces.eda.nokia.com/v1alpha1/interfaces,/ui/app/main/core.eda.nokia.com/v1/toponodes
```

In a clone you can equivalently run `node capture.mjs ...`. Installed as a
package (`pnpm add -g @eda-labs/screenshotter`, or via `npx`/`pnpm dlx`), it
exposes `edascr` and `eda-screenshotter` commands.

### Options

| Flag           | Env        | Default     | Description                                              |
| -------------- | ---------- | ----------- | -------------------------------------------------------- |
| `--url`        | `EDA_URL`  | —           | EDA base URL (also positional arg)                       |
| `--user`       | `EDA_USER` | `admin`     | login username                                           |
| `--pass`       | `EDA_PASS` | `admin`     | login password                                           |
| `--out`        | `EDA_OUT`  | `.`         | output directory (created if needed)                     |
| `--themes`     |            | `dark,light`| comma-separated: `dark`, `light`                         |
| `--nav`        |            | `collapsed` | left navbar: `collapsed` or `expanded`                   |
| `--page`       |            | —           | specific page(s) to capture; replaces built-ins          |
| `--resolution` |            | `1480x920`  | viewport size, e.g. `1920x1080`                          |
| `--aspect`     |            | —           | aspect ratio, e.g. `16:9` (height derived from width)    |
| `--width` / `--height` |    | `1480x920`  | explicit viewport dimensions                             |
| `--scale`      |            | `2`         | device scale factor / DPI (final PNG = viewport × scale) |

Other env vars: `CHROME_PATH` (browser binary).

### Capturing a specific page (`--page`)

Pass one or more deep links, comma-separated. Each may be a full URL or a path
relative to `--url`, e.g.:

```
--page /ui/app/main/interfaces.eda.nokia.com/v1alpha1/interfaces
```

Each page is saved as `NN-<slug>-<theme>.png`, where `NN` is the position and
`<slug>` is derived from the last path segment (e.g. `01-interfaces-dark.png`).
The theme and navbar settings still apply.

### Navbar (`--nav`)

- `collapsed` (default) — the icon-only rail.
- `expanded` — the script pins the sidebar open (top-left hamburger) so the
  full labelled menu shows in every screenshot. In this mode nav items are
  clicked by their label, which is more robust than the collapsed mode.

### Resolution & aspect ratio

Resolution sets the **viewport** (logical CSS pixels). The final PNG is
`viewport × --scale`, so `--resolution 1920x1080 --scale 2` yields a
3840×2160 image. Precedence:

1. `--resolution WxH` (wins if given)
2. `--aspect W:H` — derives height from the width (`--width` or the 1480 default)
3. `--width` / `--height` — used directly
4. defaults: `1480x920`

## How theming works

Two independent things control color:

1. **The Keycloak login page** follows the browser `prefers-color-scheme`, which
   the script sets per run (`colorScheme: light|dark`).
2. **The EDA app itself** has its own theme, chosen from the user menu
   (top-right → *Appearance Theme* → Follow System / Light / Dark / Enhanced
   Dark). It defaults to **Dark** and is **not** persisted to local storage, so
   the script opens that menu and selects the theme explicitly on every run.

## Notes & limitations

- Tuned for the current EDA UI. In **collapsed** nav mode the rail icons have no
  accessible labels, so Alarms / Transactions / Topologies are clicked by a
  fixed pixel position (the `RAIL` y-coordinates near the top of `capture.mjs`).
  If a future EDA release changes the rail, update those, or just use
  `--nav expanded` (label-based, more robust). Very short viewports (height
  below ~650) can push the lower rail icons off-screen in collapsed mode.
- Login assumes the standard Keycloak form (`#username`, `#password`,
  `#kc-login`).
- `ignoreHTTPSErrors` is always on, so self-signed / internal certs are fine.

## License

[Apache-2.0](./LICENSE)
