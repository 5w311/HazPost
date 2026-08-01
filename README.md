# HazPost

Hazmat tools built for the driver's seat. Companion app to [MilesPost](https://5w311.github.io/milespost) and [FuelPost](https://5w311.github.io/FuelPost).

**Live:** https://5w311.github.io/HazPost

## What it does

HazPost is a verification aid for hazmat drivers. It does not classify materials — the shipper owns classification and supplies placards. HazPost tells you what should be hanging on the trailer so you can check it against your shipping papers, with the CFR cite for every conclusion.

## Modules

| Module | CFR | Status |
|---|---|---|
| Placarding (load builder + UN lookup) | 172.504 | Live |
| Segregation (load check, Class 1 compatibility, reference tables) | 177.848 | Live |
| On the Road | Part 397 | Planned |
| Shipping Papers | 177.817 | Planned |
| Incident Response | 171.15 | Planned |
| Credentials | 172.704 | Planned |

## Architecture

- Static site, no build step, vanilla JS
- `index.html` — app shell and all logic
- `hazmat.json` — the full 172.101 material table, fetched at load
- `segregation.json` — the 177.848 segregation and Class 1 compatibility tables
- `sw.js` — service worker: offline cache for the whole app
- `manifest.json` + `icons/` — installable to the phone home screen
- `tools/build-hazmat.mjs` — regenerates `hazmat.json` from the eCFR API
- `tools/build-segregation.mjs` — regenerates `segregation.json` from the eCFR API
- `tools/build-icons.mjs` — regenerates `icons/`
- `tools/GENERATION-REPORT.md`, `tools/SEGREGATION-REPORT.md` — what each generation run decided, and why
- Deployed via GitHub Pages
- Mobile-first, offline-first

## Offline

Placarding calls happen at docks and in yards with no signal, so the app is
built to answer with none. The service worker caches the shell, both data
files, the icons and the web fonts, and serves every request cache-first while
refreshing in the background. Once the app has been opened online a single
time, it works with the radio off — module grid, load builder, computed
placard set, UN lookup and the segregation check.

The current load is written to `localStorage` on every change and restored on
start, so a load built at the dock survives the phone going in a pocket. The
load comes back; the view does not — the app opens on the module grid every
time, so a driver picks the tool for the job in front of them.
Only the record id, weight and facility are stored: the hazard classification
is re-read from `hazmat.json` each time, so a load saved before a CFR
amendment can never resurrect a stale placard category. Lines whose entry has
left the table are dropped with a notice rather than silently kept.

While offline, a strip under the header says so and shows when the cached
table was generated and when the cache last refreshed. The home view carries a
tappable footer showing the running build; tapping it checks for a new one.

### Paths

HazPost is a GitHub Pages **project** site, served from `/HazPost/` rather
than a domain root. Every install path — the worker registration, the
manifest, the icons, and every URL cached by `sw.js` — is therefore relative,
and `sw.js` resolves its relative URLs against `self.registration.scope`.
A leading slash anywhere would resolve to the domain root, cache the Pages
404 page and serve that to drivers. Verified under both `/HazPost/` and a
domain root.

## Versions and releasing

Three version numbers live in this app. They answer three different questions
and must not be collapsed into one.

| Where | Constant | Answers |
|---|---|---|
| `index.html` | `APP_VERSION` | which build of the code a driver is running |
| `sw.js` | `VERSION` | the cache generation, which forces a fresh install |
| `hazmat.json` | `version` / `cfrDate` | which CFR edition the material table came from |
| `segregation.json` | `version` / `cfrDate` | which CFR edition the segregation tables came from |

The first and third are on screen: `APP_VERSION` in the home footer,
the data edition in the disclaimer line above it. The cache generation is
plumbing and stays off screen.

**Bump `APP_VERSION` and `VERSION` together on every deploy.** There is no
build step joining the two files, so nothing enforces it. A deploy that bumps
only `APP_VERSION` never reaches a phone holding a cached copy — the worker
sees no change and serves the old build forever. A deploy that bumps only
`VERSION` ships the new code but reports the old number, so a driver checking
which build they are on is told the wrong thing. Either way the failure is
silent, which is the exact failure the version footer exists to prevent.

The two data files' `version` fields move on their own schedule, whenever the
generator that writes them changes the record shape or the mapping rules.

### How an update reaches a driver

`sw.js` does **not** call `skipWaiting()` on its own. A new worker installs
and then parks in `waiting` until the page sends it a `"skip"` message, and
the page only sends that when the driver taps the version footer. On
activation `clients.claim()` fires `controllerchange`, and the page turns that
into a reload — guarded so it can only follow a tap.

That gate is what makes background checking safe. HazPost checks for a new
build silently on load and whenever the app returns to the foreground, so a
driver who has been away for a week is told they are stale without having to
go looking. A silent check can surface an update; it can never apply one.
Reloading someone who is halfway through typing a load off a shipping paper
is not acceptable, and load persistence is not a licence to do it.

The registration uses `updateViaCache: "none"` so a check always asks the
server for `sw.js` rather than trusting whatever cache headers Pages sends —
otherwise a driver can tap "check" and be told they are current by a cached
copy of the old worker script.

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

## Segregation data

`segregation.json` holds both tables from 49 CFR 177.848 — the 18 × 18
segregation table in paragraph (d) and the 13 × 13 Class 1 compatibility table
in paragraph (f). Generated, never transcribed:

```sh
node tools/build-segregation.mjs [--date YYYY-MM-DD]
```

The script refuses to write unless both tables are square, every cell is a
legal marker, and — the check that earns its keep — **both tables are
symmetric**. The table means the same thing read down or across, so a dropped
cell or a column that slipped by one shows up immediately as a mismatched pair
rather than as a wrong answer on a trailer. It also asserts the row divisions
and column headers against the expected 18, so a future amendment that
reorders the axes aborts the build instead of silently shifting markers.

### The 18 categories are not the placard categories

They are narrower in three places, so a load line is mapped to a segregation
row from scratch rather than reusing `base`:

- **Division 2.3** splits by inhalation zone. Zone A and Zone B are rows;
  Zones C and D are not and carry no restriction. A 2.3 record with no zone on
  file is treated as Zone A, the stricter row, and the assumption is stated on
  screen.
- **Division 6.1** has one row and it is narrow: poisonous **liquids**, packing
  group I, hazard zone A. Anything short of all three has no row.
- **Class 8** has one row and it is **liquids only**.

A class absent from the 18 — Division 6.2, Class 9, combustible liquid — has
no segregation restriction at all. The module says so rather than leaving a
driver wondering whether the check simply missed it.

A **bare Class 1 subsidiary label** carries no division, so there is nothing to
look up directly. It is read as **1.1/1.2**, the strictest explosives row, and
the assumption is stated on screen. That row is `X` against nearly everything,
so this is deliberately the loud answer. It affects the four organic peroxide
Type B entries — UN3101, UN3102, UN3111, UN3112 — whose column 6 reads
`5.2, 1`.

### Physical state is asked, never guessed

Two rows turn on physical state that `hazmat.json` does not record. 245 of the
303 Class 8 records never say liquid or solid in the proper shipping name, and
another 214 records carry a subsidiary 8. So HazPost asks — per load line,
only where the answer would change a verdict, and only for lines that land on
one of those two rows. The driver has the paper in hand, and an explicit
question makes them look at it in a way a silent default does not.

The answer rides with the load line and dies with the load. It is never
carried across loads or reused for the same ID number later, because n.o.s.
entries genuinely vary between shipments.

**While any state question is unanswered, the module will not show an
all-clear.** It shows the conflicts it can already prove and lists the
outstanding lines. A green result that is only true because a question went
unanswered is the worst thing this module could do.

### Rules that are not in the grid

The table looks complete and is not. Each of these surfaces when relevant:
the Class 8 liquids placement rule in (e)(3), the cyanide-and-acid warning in
(c), Note A in (e)(5), the subsidiary-hazard rule in (e)(6) — including its
second sentence, surfaced as advice rather than automated — and the vessel
carve-out in (b).

### Class 1 compatibility — 177.848(f) to (i)

A pair that resolves to `*` in the segregation table is handed to the
compatibility engine, which applies the (f) table, the numbered rules in
(g)(3), and the division rollups in (h) and (i). The rule wording is parsed
out of the CFR into `segregation.json` alongside the tables and quoted to the
driver verbatim.

| Rule | Treatment |
|---|---|
| `X`, `X(4)` | prohibited pair, named |
| `1` | group L travels only with an identical explosive — prohibited otherwise |
| `2` | C/D/E combination assigned to group **E** |
| `3` | C/D/E with N assigned to group **D** |
| `4` | condition: § 177.835(g) governs if a detonator is involved |
| `5` | 1.4S fireworks with 1.1 or 1.2 — see below |
| `6` | condition: articles only, no substances aboard, G item not fireworks |
| (h) | same group, mixed divisions → whole shipment rides as the lower one |
| (i) | 1.5D with 1.2D → shipment rides as **1.1D**, overriding (h) |

Rules 4 and 6 turn on facts the 172.101 table does not carry — whether a
detonator is involved, and whether an item is an article or a substance — so
they produce a **stated condition, never a green light**.

Rule 5 is resolved where it can be: all five fireworks entries carry the
proper shipping name "Fireworks", so a 1.4S line named that is a definite
prohibition against 1.1 or 1.2. Any other 1.4S line gets the condition
instead, since nothing in the data says whether it is fireworks.

Paragraph (i) is worth knowing about because it rolls a shipment *below* the
division either line carries, which changes the placard as well as the
segregation — the module says so and cites 172.504.

"The shipment travels as" is withheld entirely while any pair is prohibited.
Telling a driver how to label a load that may not be assembled is worse than
saying nothing.

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
