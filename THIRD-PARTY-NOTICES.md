# Third-party notices

OSINT Workbench itself is MIT-licensed (see `LICENSE`). It drives and bundles the following
third-party software and data. Licenses are listed to the best of the author's knowledge;
check each project for the authoritative, current terms before redistributing.

## External tools (NOT bundled; you install them yourself)

The workbench runs these as separate processes. They are not shipped in this repository or in
the installer, and keep their own licenses. Using the workbench does not change those terms.

| Tool | Used by adapter | License (as published upstream) |
|---|---|---|
| [Maigret](https://github.com/soxoj/maigret) | `maigret` | MIT |
| [Sherlock](https://github.com/sherlock-project/sherlock) | `sherlock` | MIT |
| [Blackbird](https://github.com/p1ngul1n0/blackbird) | `blackbird` | MIT |
| [holehe](https://github.com/megadose/holehe) | `holehe` | GPL-3.0 |
| [theHarvester](https://github.com/laramies/theHarvester) | `theharvester` | GPL-2.0 |
| [subfinder](https://github.com/projectdiscovery/subfinder) | `subfinder` | MIT |
| [ExifTool](https://exiftool.org/) | `exiftool`, Scrub view | Perl Artistic License / GPL |
| [gallery-dl](https://github.com/mikf/gallery-dl) | `gallery-dl` | GPL-2.0 |
| [WhatsMyName data](https://github.com/WebBreacher/WhatsMyName) | site-matcher dataset (`wmn-data.json`) | CC BY-SA 4.0 |
| [Playwright](https://playwright.dev/) | `reverse-image` (optional) | Apache-2.0 |
| opsec-kit (separate checkout, optional) | Scrub view | see its own repository |

Because several of these are GPL, they are deliberately invoked as external programs rather
than linked or copied into this project.

## Bundled in this repository

| Component | Where | License |
|---|---|---|
| [Geist and Geist Mono](https://github.com/vercel/geist-font) fonts | `src/renderer/src/assets/fonts/` | SIL Open Font License 1.1 (text in `LICENSE.txt` beside the fonts) |
| Natural Earth 110m admin-0 boundaries, via [world-atlas](https://github.com/topojson/world-atlas) 2.0.2 | `resources/geoint/basemap.json` | Public domain |
| Street-level image references (Panoramax) | `resources/geoint/index.*.json`, `curated.json` | Imagery CC BY-SA 4.0, credit: Panoramax contributors. Only URLs and coordinates are stored; images are fetched at run time |
| Map-signal data (OpenStreetMap) | `resources/geoint/index.*.json` | ODbL 1.0, credit: OpenStreetMap contributors |

## npm dependencies

Runtime and build dependencies (Electron, React, better-sqlite3, electron-vite, Vite,
TypeScript, electron-builder, and their transitive dependencies) are installed from the npm
registry and are licensed under their own terms, which are predominantly MIT, ISC, BSD and
Apache-2.0. `package-lock.json` pins the exact versions; run a tool such as
`npx license-checker --production` to produce a full report for a release build.

## Trademarks

All product names, site names and logos mentioned are the property of their respective
owners. The workbench is not affiliated with or endorsed by any of them.
