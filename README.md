# HazPost

Hazmat tools built for the driver's seat. Companion app to [MilesPost](https://5w311.github.io/milespost) and [FuelPost](https://5w311.github.io/FuelPost).

**Live:** https://hazpost.figari.dev

## What it does

All six modules are live; the build order laid out at the start of the project
is complete.

HazPost is a verification aid for hazmat drivers. It does not classify materials — the shipper owns classification and supplies placards. HazPost tells you what should be hanging on the trailer so you can check it against your shipping papers, with the CFR cite for every conclusion.

## Modules

HazPost is organised by what a driver is doing rather than by CFR part, in four
tabs: **Load**, **Look Up**, **Carry** and **Emergency**. The six modules live
inside them.

| Module | Where it lives | CFR |
|---|---|---|
| Placarding | Load — the placards on top, and the Placards screen | 172.504 |
| Segregation | Load → Segregation; the reference tables under Look Up | 177.848 |
| On the Road | Load → On the road | Part 397 Subpart A |
| Shipping Papers | Load → Shipping papers | 172 Subpart C, 177.817 |
| Incident Response | Emergency — who to call, then Do I report? and Written report | 171.15, 171.16 |
| What You Carry | Carry — what expires, at a stop, training rules | 383.93, 383.141, 172.704 |
| UN lookup | Look Up | 172.101 |

## Layout, type and colour

**Load is the front door.** The lines come off the shipping paper once, and
everything reads from them: the placards to hang sit on top, then one summary
row per check — Placards, Segregation, Shipping papers, On the road — each
opening its detail screen. Three levels and no more: summary, detail, then the
regulation behind a fold.

**A summary row never says less than the screen behind it.** Each value is
built from the same functions its detail screen uses, and shows counts and
states, never a check mark. Segregation shows *Not allowed* (an X, or a
Class 1 ban) on its own. Otherwise it shows the strongest thing already
proven — *Keep apart* (an O), *Explosives check* (a Class 1 pair or
condition), or *Check N rules* (an advisory that bites with no table cell
behind it, such as cyanides with acids) — followed by any open
physical-state question, as *N questions*. *No conflicts* appears only when
there is none of that and nothing left to answer. A row whose data file
failed to load says *Unavailable* and calls nothing. `tools/test-load.mjs`
holds this.

**Emergency is one tap from every screen**, including the loading and error
screens before `hazmat.json` arrives, and tapping it always lands on the phone
numbers with 911 first — whatever was left open in it.

**Three typefaces, each with one job.** Instrument Sans for the interface.
Atkinson Hyperlegible Mono for identifiers a driver compares character by
character against the paper — ID numbers, the basic description, the
segregation markers. Source Serif 4 for the regulation text itself, so the law
never looks like the app's own words. CFR cites, weights, dates and phone
numbers use Instrument Sans with tabular figures. Placard words use Instrument
Sans's condensed width (`font-stretch: 75%`) so the longest ones fit. The
stylesheet URL in `index.html` and `FONT_CSS` in `sw.js` must match character
for character — that string is the cache key the worker stores the fonts
under, and if the two differ the fonts silently go missing offline.

**Light and dark follow the phone** through `prefers-color-scheme`, in CSS
only. Every interface colour is a token in `:root`, redefined for dark mode.
What stays literal on purpose: the placard colours, which are regulatory;
white glyphs on solid tiles; and the Carry cards and segregation-table keys,
which keep one identity colour in both modes. The light tint is HazPost's
amber darkened to pass contrast; green is an icon-tile colour and never means
a status.

## Architecture

- Static site, no build step, vanilla JS
- `index.html` — app shell and all logic
- `hazmat.json` — the full 172.101 material table, fetched at load
- `segregation.json` — the 177.848 segregation and Class 1 compatibility tables
- `ops.json` — 49 CFR Part 397 Subpart A, verbatim
- `papers.json` — 172 Subparts C and G, and 177.817, verbatim
- `incident.json` — 171.15 and 171.16, verbatim
- `carry.json` — 172.602, 172.704, 383.93, 383.141, 383.153, 391.41, 391.43, 391.45, 397.19 and 1572.13, verbatim
- `sw.js` — service worker: offline cache for the whole app
- `manifest.json` + `icons/` — installable to the phone home screen
- `tools/build-hazmat.mjs` — regenerates `hazmat.json` from the eCFR API
- `tools/build-segregation.mjs` — regenerates `segregation.json` from the eCFR API
- `tools/build-ops.mjs` — regenerates `ops.json` from the eCFR API
- `tools/build-papers.mjs` — regenerates `papers.json` from the eCFR API
- `tools/build-incident.mjs` — regenerates `incident.json` from the eCFR API
- `tools/build-carry.mjs` — regenerates `carry.json` from the eCFR API
- `tools/icon-source/*.png` — the committed source art `build-icons.mjs` derives `icons/` from
- `tools/build-icons.mjs` — regenerates `icons/` from `tools/icon-source/`
- `tools/test-harness.mjs` — the shared vm harness the tests run on
- `tools/test.mjs` — the test suite; runs every `tools/test-*.mjs`
- `tools/GENERATION-REPORT.md`, `tools/SEGREGATION-REPORT.md`, `tools/OPS-REPORT.md`, `tools/PAPERS-REPORT.md`, `tools/INCIDENT-REPORT.md`, `tools/CARRY-REPORT.md`, `tools/ICONS-REPORT.md` — what each generation run decided, and why
- Deployed via GitHub Pages
- Mobile-first, offline-first

### The fold rule

Every module pairs a plain-language rule with the verbatim CFR paragraph it
was written from. The plain language is ours and renders open; the verbatim
text renders behind a **closed fold** — a `details.verbfold` element whose
summary reads the section number — uniformly, in every module, with no
exceptions for blocks that seem short or important. A driver learns once that
regulatory text lives behind the grey line and never has to wonder which state
they are looking at: folds are closed on every render and remember nothing.

The CFR cite on every verdict and rule stays visible and unfolded — the cite
is what lets a driver verify a verdict against a printed table. The
honest-limit statements stay open too.

One code path produces this: `cfrFold(cite, text)` for a single paragraph,
`cfrFolds(label, pairs)` for a group, both built on `cfrVerb`, which is never
called anywhere else. A verbatim block that renders any other way is a bug.

## Offline

Placarding calls happen at docks and in yards with no signal, so the app is
built to answer with none. The service worker caches the shell, every data
file, the icons and the web fonts, and serves every request cache-first while
refreshing in the background. Once the app has been opened online a single
time, it works with the radio off — the Load screen and its placard set,
Look Up, the segregation check, the Part 397 decision, the shipping paper
comparison, the incident reporting rules and the credential reference, all in
the app's own typefaces.

**Every new data file must be added to `SHELL` in `sw.js`**, or it is fetched
from the network on every launch and simply is not there offline.

The current load is written to `localStorage` on every change and restored on
start, so a load built at the dock survives the phone going in a pocket. The
load comes back; the screen does not — the app opens on Load every time, with
the placards for that load on top and every check one tap below.
Only what the driver read off the paper is stored: the record id, weight and
facility, plus the packing group and packages where they were entered. The
hazard classification is re-read from `hazmat.json` each time, so a load saved
before a CFR amendment can never resurrect a stale placard category. Lines
whose entry has left the table are dropped with a notice rather than silently
kept, and a saved packing group or package entry that does not fit its line is
dropped on its own, leaving the line.

### Packing group and packages, from the paper

353 entries in the 172.101 table allow more than one packing group ("I, II,
III"), and only the paper says which one a shipment is. **HazPost asks for it
then, and only then:** Add a line shows a PG choice for those entries and
won't add the line without one. An entry with a single packing group answers
for itself, and one with none (explosives, Division 5.2) has nothing to ask.
HazPost never picks a group from a range. A line saved before the question
existed shows *PG ?* and asks on its line screen. Where one ID number has a
separate table entry per packing group (UN1197, for one), the suggestion list
shows each entry's group, so picking the entry picks the group.

The answer fills the packing group into the expected basic description in
Shipping Papers, in place of the range's gap, with a note that it came from the
paper. It also feeds the Division 6.1 segregation row, which only PG I reaches.
An unanswered range that includes PG I stays on that row, the stricter answer.

**Packages** are the number and type 172.202(a)(7) puts on the paper, such as
*12 DR*: drums (DR), cases (CS), cartons (CT), bags (BG) or pallets (PL). None
is bulk packaging: the first four are non-bulk packagings, and a pallet of them
strapped or wrapped together is an overpack (171.8). They are optional, so a
line packed in anything else can still go on the load. They show on the line
and in the Shipping Papers packages card, to hold against the paper. Bulk
packaging is still not modelled.

While offline, a strip under the title says so and shows when the cached
table was generated and when the cache last refreshed. The foot of the Load
screen carries a tappable line showing the running build; tapping it checks
for a new one.

### Paths

HazPost is served on GitHub Pages via the custom domain `hazpost.figari.dev`
(`CNAME`), at the domain root. It was originally a GitHub Pages **project**
site at `5w311.github.io/HazPost` — that URL now 301s to the custom domain —
and every install path is written relative for that reason: the worker
registration, the manifest, the icons, and every URL cached by `sw.js`, with
`sw.js` resolving its relative URLs against `self.registration.scope`. A
leading slash anywhere would have resolved to the domain root under the old
project-page setup, caching the Pages 404 page and serving that to drivers.
The relative-path design means the app needs no change to run at either a
subpath or a root, and both have been verified working.

**A driver who installed HazPost from the old `5w311.github.io/HazPost`
address is stranded on whatever build they have.** A service worker cannot be
updated through a redirect, so that install can never receive a new version —
it keeps serving its cached build offline indefinitely, and the version
footer correctly reports it cannot check rather than falsely claiming it is
current. Their saved data (load, carrier number, credential dates) lives
under the old origin and does not carry over. The only fix is to open
`hazpost.figari.dev` directly, reinstall, and re-enter anything that was
saved — in particular the carrier safety desk number in Incident Response.

## Versions and releasing

Several version stamps live in this app. They answer different questions and
must not be collapsed into one.

| Where | Constant | Answers |
|---|---|---|
| `index.html` | `APP_VERSION` | which build of the code a driver is running |
| `version.txt` | the whole file | which build is live — what the update check asks for |
| `sw.js` | `APP_BUILD` | the build this worker ships with; what makes `sw.js` change on every release |
| `sw.js` | `VERSION` | the cache generation, which forces a fresh install |
| `hazmat.json` | `version` / `cfrDate` | which CFR edition the material table came from |
| `segregation.json` | `version` / `cfrDate` | which CFR edition the segregation tables came from |
| `ops.json` | `version` / `cfrDate` | which CFR edition the Part 397 text came from |
| `papers.json` | `version` / `cfrDate` | which CFR edition the shipping-paper text came from |
| `incident.json` | `version` / `cfrDate` | which CFR edition the reporting text came from |
| `carry.json` | `version` / `cfrDate` | which CFR edition the credential text came from |

Two of them are on screen: `APP_VERSION` at the foot of the Load screen, and
the data edition in the disclaimer line above it. `version.txt`, `APP_BUILD`
and `VERSION` are plumbing and stay off screen.

**Releasing:** bump `APP_VERSION`, `version.txt` and `APP_BUILD` in `sw.js` to
the same number, and bump `VERSION` in `sw.js` alongside. The first three are
one number and `tools/test-update.mjs` fails the build if they drift:

- a `version.txt` behind `APP_VERSION` tells a driver they are on the latest
  when they are not; one ahead offers an update that does not exist;
- an `APP_BUILD` left behind means `sw.js` did not change, and a `sw.js` that
  did not change is never installed — the release would never reach a phone
  holding a cached copy.

`VERSION` is checked for shape only, because nothing in one snapshot of the
repo can tell whether it moved. Bump it every time: it names the cache, and
the old cache is only deleted when a new name activates.

Version numbers only go up. A release that undoes another still gets a new,
higher number: the install tap reloads onto a worker only when its build is
newer than the page, so a number that went backwards would never be installed
by a window another one had already updated.

Each data file's `version` field moves on its own schedule, whenever the
generator that writes it changes the record shape or the mapping rules.

### The update check

The same standard as FuelPost's update checker, adapted to an app that works
offline.

**What it asks.** `checkForUpdate` fetches `version.txt` — seven bytes —
rather than the whole app.

- Resolved against the page (`new URL("version.txt", location.href)`), never
  rooted at `/`.
- `?_cb=` and `cache: "no-store"`, because this is the one request that must
  never be answered from anything but the live server. `sw.js` passes it, and
  any other request carrying `_cb`, straight through to the network: never
  answered from the offline cache, never written into it. A navigation
  carrying `_cb` goes to the network too and is never stored; offline it falls
  back to the cached app like any other. `version.txt` is not in `SHELL`.
- `parseVersionFile` is **strict**: only a bare dotted number. A 404 page, a
  captive-portal login or `index.html` served by mistake are all "text that
  came back 200", and a loose parse would report one of them as a version.
- **The HTML fallback is kept on purpose.** If `version.txt` is missing or
  unreadable, `extractVersion` reads `APP_VERSION` out of the live
  `index.html`, anchored to the start of a line so a comment that mentions the
  declaration cannot shadow it. Losing the check entirely is worse than paying
  for the big fetch once.
- Each fetch gets 8 seconds. A dock with one bar can hold a request open for a
  minute; a check that gets no answer says it couldn't check.

**When it runs.** Silently on load and every time the app returns to the
foreground: no "Checking…", no note, whatever it finds. Out loud when the
driver taps the version footer: *Checking for updates…*, then *You're on the
latest (v…)* or *Couldn't check for updates*. It never says "on the latest"
for a check that did not reach the server. One check runs at a time; a tap
that lands on a silent check already in flight joins it out loud. Once an
update is on offer the server is not asked again — FuelPost stops at the same
point — but the worker check carries on, so the new build keeps downloading.

**What it shows.** A newer version is offered on the footer and on a banner
at the top of Load — *Update available (v0.12.1) — tap to install* — and the
offer persists until it is acted on. The footer is a polite live region, so a
screen reader hears the outcome of a check and the offer; its accessible name
is its text, and only the plain version gets *tap to check for updates* added,
so a tap that installs is never announced as a check.

**How it installs — never by itself.** The tap that checks only checks.
Installing takes the next tap, which goes through at once even with a silent
check still waiting on the network. `sw.js` does **not** call `skipWaiting()`
on its own: a new worker parks in `waiting` until the page sends it `"skip"`,
which only that tap does. On activation `clients.claim()` fires
`controllerchange`, and the page turns that into a reload — guarded so it can
only follow the tap. Every path ends on the new build or on a note that says
why not, and no wait is unbounded:

| State when the driver taps | What the tap does |
|---|---|
| a new worker is waiting | sends it `"skip"`; the reload follows `controllerchange` (and a reload after 6 s if the handover never lands) |
| another window already installed it — the worker in control serves a newer build | a plain reload, onto the build that worker cached; never onto an older one |
| a new worker is still installing | waits for it, up to 30 s, and hands over the moment it is waiting |
| nothing downloaded yet | asks for it (`update()`, given 10 s), then as above |
| the server has no new worker yet — a deploy the CDN has not finished serving | *Update isn't ready yet — tap to retry*, at once |
| no connection | *Couldn't connect — tap to retry*, at once |
| a new worker failed to install, or took longer than 30 s | *Update didn't finish — tap to retry* |
| no worker in control — unsupported, registration failed, a first visit not yet claimed | a cache-busted navigation, as FuelPost's tap is |

A registration that is still pending — `register()` queues behind any install
already running — is asked for with `getRegistration()` rather than taken to
mean there is no worker. A worker says which build it serves when the page
posts it `"version"` on a message port; workers from v1.9.0 and older do not,
and the tap carries on without the answer after a second.

A takeover the driver did not ask for — another window installing an update —
never reloads this one; if the worker that took over serves a newer build,
the update is offered, and the tap is a plain reload. Reloading someone
halfway through typing a load off a shipping paper is not acceptable, and load
persistence is not a licence to do it.

**What the worker caches.** GitHub Pages sends `max-age=600` on everything, so
for ten minutes after any fetch the browser's HTTP cache answers a plain
request with the copy it already holds. A worker installed in that window that
precached with plain requests would store the build it is replacing, and the
install tap would reload the driver straight back into it. So the install
fetches every file with `cache: "no-cache"` and a `?v=APP_BUILD` stamp — a key
no CDN edge has an older copy under — and stores each under the plain URL the
app asks for. Before writing anything it reads `APP_VERSION` out of the page it
fetched, under both `./` and `index.html`; a page from any other build fails
the install, and the old worker stays in charge until the next check.

Between installs a worker serves its own build and nothing else. Its
background refresh asks the server (`no-cache`) rather than the HTTP cache, and
a page of another build is never written into its cache: a newer page reaches
the screen only with its own worker, on the driver's tap.

The registration uses `updateViaCache: "none"` so the browser's own check asks
the server for `sw.js` rather than trusting whatever cache headers Pages sends.

### Things not to undo

- **`version.txt`, `APP_VERSION` and `APP_BUILD` are one number**, and
  `parseVersionFile` stays strict. Both are tested.
- **The update check bypasses the worker.** A cached `version.txt` would tell
  every driver they are on the latest, forever. A cache-busted navigation is
  never stored either.
- **A check offers; only a tap installs.** No background path may reload.
- **The worker caches past the HTTP cache.** Without `cache: "no-cache"` and
  the `?v=` stamp, a worker installed within ten minutes of the last fetch
  caches the build it is replacing, and the install tap lands back on it.
- **A worker serves its own build and nothing else.** The install refuses a
  page of any other build, and the background refresh never stores one.
- **Every wait in the install tap has a bound**, and an install tap is never
  swallowed by a check in flight. A tap that cannot install says why.
- **CI runs the whole suite on every pull request** (`.github/workflows/tests.yml`).
  `tools/test-update.mjs` fails if it is narrowed to one file, to pushes only,
  or given an install step.

## Icons

```sh
node tools/build-icons.mjs
```

The mark used to be procedurally generated — a signed distance field with no
source art at all. It is now supplied artwork, committed under
`tools/icon-source/` at the three sizes this app's "any" icons need (512,
192, 180) and derived from there. Still pure Node, no dependencies: the
script carries its own PNG decoder (chunk walk, CRC-32 verification, zlib
inflate, all five PNG filter types) alongside the encoder the old version
already had. Re-run it rather than editing `icons/*.png` by hand — and
replace the source PNGs and re-run rather than hand-editing those either.

`icon-maskable-192.png` and `icon-maskable-512.png` are byte-identical to
`icon-192.png` and `icon-512.png`. That's a measured result, not a shortcut:
the build decodes the 512 source and checks how far the diamond's farthest
pixel sits from centre against the 40%-radius safe zone a maskable icon must
survive being cropped to, and aborts if a future re-export ever fails that
check rather than shipping an icon a launcher would clip. `favicon-32.png`
has no supplied source at that size, so it's the one output actually
computed — an exact 16:1 box average of the 512 source, chosen because it
divides evenly, not a general resampling filter with a ratio to get subtly
wrong. Every icon stays full-bleed and fully opaque, same reason as before:
iOS composites a transparent `apple-touch-icon` onto white, which would put
the diamond on a white tile instead of the app's dark one. Full provenance,
checks and the safe-zone measurement are in `tools/ICONS-REPORT.md`.

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
| `psn` | proper shipping name alone, where column 2 also carries italic qualifier text |
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

Paragraph (i) rolls a shipment *below* the division either line carries, so it
changes the placard as well as the segregation. Both modules read it from a
single `rule848i()` helper rather than each deciding for itself — the
placarding engine promotes the trailer to EXPLOSIVES 1.1, and the segregation
module says so. Two modules disagreeing about the same trailer is the failure
worth designing against here.

"The shipment travels as" is withheld entirely while any pair is prohibited.
Telling a driver how to label a load that may not be assembled is worse than
saying nothing.

## Placarding engine rules implemented

- Table 1 materials: placard at any quantity — 172.504(e)
- Table 2 materials: placard when aggregate gross weight of all Table 2 hazmat reaches 1,001 lb — 172.504(c)
- DANGEROUS placard permitted for 2+ Table 2 categories, voided per-class by 2,205+ lb loaded at one facility — 172.504(b)
- Only the lowest Class 1 division on board is placarded — 172.504(f)(1)
- Division 1.5D riding with Division 1.2D re-divisions the shipment to 1.1D, so the trailer takes EXPLOSIVES 1.1 — 177.848(i)
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

## On the Road — Part 397 Subpart A

Part 397 is prose, and the obvious thing to build is a reg reader. A driver can
already read the reg. What the app knows and the paper does not is what is on
the trailer — and the part turns on exactly one question about that.

```sh
node tools/build-ops.mjs [--date YYYY-MM-DD]
```

`ops.json` holds all 11 Subpart A sections **verbatim**, paragraph by
paragraph, with the nesting rebuilt: the CFR prints only the innermost
designator, so 397.5(b)(1) appears as "(1)" and would be ambiguous four ways
in that section alone.

### The one question

**Tier 1** is a load containing Division 1.1, 1.2 or 1.3. **Tier 2** is a
placarded load without any. The tier comes from the load already in the load
builder; the driver is asked only where the truck is stopping — public road,
private property, carrier/shipper/consignee property, or an approved safe
haven. Tier crossed with location is the whole decision.

The answer worth surfacing is Tier 1 at a truck stop, where three rules
compound: attendance is required and the sleeper berth does not count, the lot
is a place where people work and congregate so the 300-foot rule bites, and
parking there needs consent from someone who knows what is on the trailer. The
module says that as one conclusion rather than leaving it to be assembled from
three cards.

If the load needs no placards, the module says most of Part 397 does not apply
rather than listing rules that are not reaching the driver — 397.1 hangs the
whole part off the vehicle having to be marked or placarded.

### Verbatim, always

Every plain-language line in the module is ours, and the CFR paragraph it was
written from sits behind a fold beside it. This is the module where a loose
paraphrase does the most damage, so the summary never stands in for the rule. The build
asserts anchor phrases in every operative section — prose is the dangerous
case, because a paragraph that lost half its sentence still reads like a
regulation.

The section set is asserted too. A section appearing or disappearing aborts
the build, since the entire decision tree hangs off 397.5 and 397.7.

### What it will not do

HazPost has no map and no knowledge of what surrounds the truck. It cannot
measure 300 feet to a dwelling, recognise a place where people assemble, or
tell a driver whether a lot is an approved safe haven. The module states that
limit rather than implying a completeness it does not have — the same posture
as the placarding module being a verification aid rather than a classifier.

No geolocation, mapping or proximity estimation, here or anywhere else.
Routing was excluded from this app from the start, and Part 397 Subparts C and
D — routing and the national route registry — are noted as existing and not
implemented.

## Shipping Papers — 172 Subpart C, 177.817

Not a checklist of what a shipping paper contains; a driver can read that
anywhere. What HazPost has that the paper does not is the load, so it builds
the basic description each line should carry and lets the driver hold it
against the paper in their hand.

```sh
node tools/build-papers.mjs [--date YYYY-MM-DD]
```

Nine sections, each fetched on its own — § 172.101 makes a whole-part fetch of
Part 172 nearly three megabytes.

### Compare, do not copy

If the app and the paper disagree, **the paper and the shipper win**. The
driver calls the shipper; they do not correct the paper themselves and do not
copy HazPost's version onto it. The module says so at the top of the view, and
it does not produce anything that looks like a document an inspector could be
handed.

### The basic description

172.202(a)(1) to (a)(4) in sequence, nothing interspersed — identification
number, proper shipping name, hazard class, packing group.

`cls` is used **verbatim** for the hazard class rather than rebuilt from
`base`. Column 3 already carries the compatibility group letter on explosives
(1.1D, not 1.1) and any subsidiary in parentheses (3 (6.1)); rebuilding drops
the letter on every Class 1 line.

Packing group is omitted, with a note saying the absence is correct, for Class
1, self-reactive substances, Division 5.2 and entries with none assigned. A
collapsed packing group range renders as a visible gap rather than inline,
so its commas cannot be mistaken for extra elements, until the driver enters
the group from the paper. Then the group fills the gap.

### False mismatches are the failure mode

A comparison tool that flags a correct paper as wrong is worse than no tool.
Three places that bites, all handled:

- **Italic text in column 2 is not part of the proper shipping name**
  (172.101(c)(10)), and 610 records carry some. `hazmat.json` gained a `psn`
  field holding the roman-only name, so UN1203 compares as `Gasoline`, not
  `Gasoline includes gasoline mixed with ethyl alcohol…`.
- **An italic "or" marks a choice of names**, so those are preserved and the
  module says the paper will carry one of them.
- **The technical name behind a symbol-G entry has more than one permitted
  punctuation.** 172.202(d) attaches it to the name with no comma; 172.203(k)
  shows a comma form and also allows it after the whole basic description. The
  module renders one and names the others.

### Where the paper lives

177.817(e), under Where they live. A correct paper in the wrong place is still a
citation, and this rule is enforced on its own. At the controls it is two
conditions joined by "and", the second of which is itself an either/or — the
module makes that structure explicit. Away from the controls there are exactly
two permitted places.

## Incident Response — 171.15, 171.16

Somebody may open this module in the worst hour of their working life, possibly
hurt, possibly with a product still leaking. It is built around three
invariants that outrank layout, elegance and consistency with the rest of the
app. All three are asserted mechanically by `tools/test-incident.mjs`.

```sh
node tools/build-incident.mjs [--date YYYY-MM-DD]
node tools/test.mjs
```

### One — the landing view is who to call

No question, no load check, no decision tree, nothing to dismiss. **911 is the
first element rendered and it is a `tel:` link.** Under it: the emergency
response number on the shipping paper, which HazPost does not have and says so
(172.604); then the driver's own carrier safety desk number, stored on the
phone under `hazpost.carrier.v1` and one tap from then on.

Two consequences elsewhere in the app fall out of this:

- `incident.json` loads **first and outside the hazmat.json chain**. Everything
  else in HazPost is an aid a driver can do without for a day; the phone
  numbers are not, and a failed 172.101 fetch must not shut the door on them.
- Emergency renders even while `dataState` is `error` — the tab bar is always
  drawn — and the material-data error screen carries a button into it.

### Two — no code path may say a report is unnecessary

171.15(b)(5) makes the last word a judgment about the scene by the person in
possession of the material. HazPost cannot see the scene. So an empty checklist
is not an answer, it is an unanswered question, and `incidentVerdict()` is
total: every one of the 512 checklists returns a verdict whose action is a
phone call. There is no "not reportable" branch to reach.

The test asserts this the blunt way — a list of forbidden phrasings scanned
across every view and every subset of the checklist, with no attempt to tell an
assertion from its denial. If the words are on the screen at all, a driver
reading in a hurry can come away with them, so the copy is written to avoid the
shapes rather than to argue with the matcher.

### Three — the NRC is not an emergency number

800-424-8802 is a regulatory notification. Nobody is dispatched because you
called it, and the rule allows as soon as practical but no later than 12 hours.
The landing view says all three things, in our words with 171.15(a) verbatim
beside them, and deliberately does **not** make the NRC number tappable there —
911 is the only `tel:` link on that view. It becomes tappable on the Do I
report? screen, where the question is actually being answered — as a plain call
row, never dressed as the red emergency button only 911 wears.

### What it will not do

- No isolation distances, protective action distances, or product handling.
  That is the emergency number on the paper and the official PHMSA ERG, which
  the module links to and does not reproduce.
- No Form 5800.1. It is not generated, prefilled or reproduced, and nothing the
  module renders could be mistaken for a submitted report.
- 171.16(d)'s exceptions are quoted in full and **not applied**. They turn on
  package capacity, the amount actually released, and the packing group as
  shipped — three things the app does not know and must not guess.
- The checklist omits 171.15(b)(6), which is expressly "during transportation by
  aircraft" and cannot fire on a highway load. It is called out in the reference
  card so the list does not look short one.

## Tests

```sh
node tools/test.mjs
```

914 checks across ten files, in a few seconds. No framework and
nothing to install — the app has no dependencies and neither does its suite,
because a suite that needs a package install is a suite that stops being run.
`tools/test.mjs` runs every `tools/test-*.mjs`, prints each file's count and
fails if any of them does. GitHub Actions runs it on every pull request and
every push to `main` (`.github/workflows/tests.yml`, Node 22, no install step).

| File | Covers |
|---|---|
| `test-placards.mjs` | `compute()` — the 1,001 lb aggregate, the 2,205 lb single-loading-point rule, Table 1, Class 9, 172.505(a), and 177.848(i) |
| `test-segregation.mjs` | `segCheck()` and `segCatFor()` — the subsidiary path, the physical-state gate, category mapping, and the shipped tables |
| `test-ops.mjs` | `hasTier1`, `opsCheck`, `opsRules`, `opsHeadline` — all eight combinations of tier and location |
| `test-papers.mjs` | `basicDescription()` — the 172.202(b) sequence, five regression guards, and a sweep of all 2,479 entries |
| `test-incident.mjs` | the three Incident Response invariants, including no-all-clear over every subset of the checklist |
| `test-carry.mjs` | date arithmetic across month, year and leap boundaries; the 397.19 conditional; the absence of any image capture |
| `test-data.mjs` | all six JSON files — provenance, counts, one CFR date across the set, and precaching |
| `test-load.mjs` | the Load screen's summary rows against the engines, the tab bar, Emergency on every path including with no data, the line and Look Up screens against 172.505(a), and a corrupted saved load |
| `test-pg-packages.mjs` | the packing-group question and packages: asked only for a range, never guessed, refused without an answer, saved and restored with bad values dropped, and read by Shipping Papers and the 6.1 segregation row |
| `test-update.mjs` | the update check and the install: the strict `version.txt` parse and the anchored fallback, one number in `version.txt`, `APP_VERSION` and `sw.js`, the worker caching the live build past the HTTP cache and serving only its own, the check and `_cb` navigations passing through it, silent checks on load and foreground, fetch timeouts, every install path, the live region, and the CI workflow |

### How they run

`tools/test-harness.mjs` extracts the `<script>` from `index.html` and evaluates
it in a `vm` context against stub globals, so the functions under test are the
ones that ship rather than copies. Nothing in this repo re-implements an engine
for the benefit of a test.

Top-level `let` and `const` bindings are lexical and never become properties of
a `vm` context — only function declarations do. So `HM`, `SEG`, `OPS`,
`PAPERS`, `CAR`, `load` and `opsPlace` are unreachable from a test, and
everything goes through the app's own seams instead: `loadData()` populates the
data through a stub `fetch`, `restoreLoad()` rebuilds the load from
`localStorage`, and `setOpsPlace`, `setLineState` and `setDate` answer the
questions a driver would answer. Driving a load in means seeding
`hazpost.load.v1` and letting the app restore it, which exercises the real
persistence path as a side effect and means no test can conjure a material the
172.101 table does not have.

Values that exist only in the source text are read out of the source, so a case
added to the app turns up in the tests without anyone remembering to come and
add it.

The update tests bring their own stand-ins: a fake `navigator.serviceWorker`
handed to the page through `appWith({serviceWorker})`, and `sw.js` itself run
in a `vm` against a fake server and Cache Storage. The app's timers run on a
clock the test turns by hand, so a 30-second bound is tested as a 30-second
bound without anyone waiting for it.

### What is not tested

No rendering, layout, styling or snapshot tests. This suite exists for
regulatory logic. A test that fails when a heading is reworded gets deleted or
ignored within a month and takes the real assertions with it. Where a test does
look at rendered output it is at structure that carries meaning — the `segv
clear` verdict class, the presence of a `tel:` link — never at wording.

Cites are asserted, because a conclusion that arrives without its paragraph is
a conclusion this app is not allowed to give.

### Mutation discipline

A suite nobody has seen fail is a suite nobody should trust. Every engine has
been deliberately broken to confirm the tests catch it — inverting the 1,001 lb
comparison, turning 177.848(i) into an OR, ignoring subsidiary hazards, adding
Division 1.4 to the strict tier, rebuilding the hazard class from `base`,
dropping a file from `SHELL`. Run one yourself before trusting a green result
after a large change.

The update check and the worker have been through the same: the precache
without `no-cache`, a page of another build installed, the install tap behind
the in-flight guard, an `update()` awaited without a bound, a reload onto an
older worker, a navigation refresh rebuilt from its URL — 33 breaks, each
caught.

That exercise is worth repeating rather than treating as done: it is how the
one real gap in this suite was found. Dropping the PG I condition from the
Division 6.1 segregation row changed no answer on any load that can be built,
because every Zone A Division 6.1 entry in the shipped table is also PG I. That
arm is now asserted by calling `segCatFor()` directly.
