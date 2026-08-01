# HazPost

Hazmat tools built for the driver's seat. Companion app to [MilesPost](https://5w311.github.io/milespost) and [FuelPost](https://5w311.github.io/FuelPost).

**Live:** https://5w311.github.io/HazPost

## What it does

HazPost is a verification aid for hazmat drivers. It does not classify materials — the shipper owns classification and supplies placards. HazPost tells you what should be hanging on the trailer so you can check it against your shipping papers, with the CFR cite for every conclusion.

## Modules

| Module | CFR | Status |
|---|---|---|
| Placarding (load builder + UN lookup) | 172.504 | Live |
| Segregation | 177.848 | Planned |
| On the Road | Part 397 | Planned |
| Shipping Papers | 177.817 | Planned |
| Incident Response | 171.15 | Planned |
| Credentials | 172.704 | Planned |

## Architecture

- Static site, no build step, vanilla JS
- `index.html` — app shell and all logic
- `hazmat.json` — the full 172.101 material table, fetched at load
- `sw.js` — service worker: offline cache for the whole app
- `manifest.json` + `icons/` — installable to the phone home screen
- `tools/build-hazmat.mjs` — regenerates `hazmat.json` from the eCFR API
- `tools/build-icons.mjs` — regenerates `icons/`
- `tools/GENERATION-REPORT.md` — what the last generation run decided, and why
- Deployed via GitHub Pages
- Mobile-first, offline-first

## Offline

Placarding calls happen at docks and in yards with no signal, so the app is
built to answer with none. The service worker caches the shell, `hazmat.json`,
the icons and the web fonts, and serves every request cache-first while
refreshing in the background. Once the app has been opened online a single
time, it works with the radio off — module grid, load builder, computed
placard set and UN lookup.

The current load is written to `localStorage` on every change and restored on
start, so a load built at the dock survives the phone going in a pocket.
Only the record id, weight and facility are stored: the hazard classification
is re-read from `hazmat.json` each time, so a load saved before a CFR
amendment can never resurrect a stale placard category. Lines whose entry has
left the table are dropped with a notice rather than silently kept.

While offline, a strip under the header says so and shows when the cached
table was generated and when the cache last refreshed.

### Paths

HazPost is a GitHub Pages **project** site, served from `/HazPost/` rather
than a domain root. Every install path — the worker registration, the
manifest, the icons, and every URL cached by `sw.js` — is therefore relative,
and `sw.js` resolves its relative URLs against `self.registration.scope`.
A leading slash anywhere would resolve to the domain root, cache the Pages
404 page and serve that to drivers. Verified under both `/HazPost/` and a
domain root.

### Releasing

Bump `VERSION` in `sw.js` on every release. The cache name carries it, so a
new worker installs into a fresh cache and drops the old ones on activate.
Without a bump, drivers keep the cached copy they already have.

## Icons

```sh
node tools/build-icons.mjs
```

Pure Node, no dependencies: the mark is a signed distance field and the PNGs
are encoded against `node:zlib`. Re-run it rather than editing the binaries.
Every icon is drawn full-bleed and fully opaque — iOS composites a transparent
`apple-touch-icon` onto white, which would put the yellow diamond on a white
tile instead of the app's dark one.

## Material data

`hazmat.json` holds every placardable entry in the 49 CFR 172.101 Hazardous
Materials Table — 2,479 records, about 368 KB. It is generated, not hand-edited:

```sh
node tools/build-hazmat.mjs                  # latest published eCFR text
node tools/build-hazmat.mjs --date 2026-07-22
```

The script fetches the section from the eCFR versioner API, maps each entry to
a placard category via the 172.504(e) tables, runs four verification scenarios,
and refuses to write anything if one fails. Every entry it drops or has to judge
is listed by name in the generation report.

Each record:

Alongside the records, the file carries `version` (the record shape and
mapping build, bumped by hand in the generator), `cfrDate` (which eCFR text it
was built from) and `generated` (when). The offline indicator shows these, so
a driver can see how old the answer is.

| Field | |
|---|---|
| `id` | unique key; suffixed when several shipping names share one ID number |
| `un` / `pfx` | the number, and whether it is a UN, NA or ID number |
| `name` | proper shipping name, column 2 |
| `cls` | hazard class or division, with any subsidiary in parentheses |
| `base` | HazPost placard category — what the 1,001 lb aggregate groups by |
| `pg` | packing group, or a range where the table splits one entry across several |
| `plc` | placard design key, defined in `index.html` |
| `t1` | present when the material placards at any quantity |
| `sym` | column 1 symbols (+, A, D, G, I, W) |
| `pih` | inhalation hazard zone, from special provisions 1-4 and 6 |
| `subs` | subsidiary hazard label codes |
| `cond` | condition attached to the Table 1 requirement (Class 7) |

## Placarding engine rules implemented

- Table 1 materials: placard at any quantity — 172.504(e)
- Table 2 materials: placard when aggregate gross weight of all Table 2 hazmat reaches 1,001 lb — 172.504(c)
- DANGEROUS placard permitted for 2+ Table 2 categories, voided per-class by 2,205+ lb loaded at one facility — 172.504(b)
- Only the lowest Class 1 division on board is placarded — 172.504(f)(1)
- Class 9 placard not required for domestic highway transport — 172.504(f)(9)
- Division 6.2 and unlabelled 1.4S count toward the aggregate but hang no placard — 172.504(e) Table 2, 172.504(f)(6)
- Materials poisonous by inhalation carry POISON INHALATION HAZARD on top of their class placard — 172.505(a)
- Other subsidiary hazards — 172.505 (advisory note only)

Not yet implemented, and noted where they would apply: the NON-FLAMMABLE GAS
and OXIDIZER exceptions in 172.504(f)(3), (f)(4) and (f)(5), and the OXYGEN
substitution in (f)(7) — HazPost treats OXYGEN as its own category rather than
as an alternative to NON-FLAMMABLE GAS.

## Disclaimer

HazPost is not a substitute for the shipping paper or the regulations. Always confirm against your papers and 49 CFR.
