# HazPost

Hazmat tools built for the driver's seat. Companion app to [MilesPost](https://5w311.github.io/milespost) and [FuelPost](https://5w311.github.io/FuelPost).

**Live:** https://5w311.github.io/HazPost

## What it does

All six modules are live; the build order laid out at the start of the project
is complete.

HazPost is a verification aid for hazmat drivers. It does not classify materials — the shipper owns classification and supplies placards. HazPost tells you what should be hanging on the trailer so you can check it against your shipping papers, with the CFR cite for every conclusion.

## Modules

| Module | CFR | Status |
|---|---|---|
| Placarding (load builder + UN lookup) | 172.504 | Live |
| Segregation (load check, Class 1 compatibility, reference tables) | 177.848 | Live |
| On the Road (attendance, parking, always-on rules) | Part 397 Subpart A | Live |
| Shipping Papers (basic description check + placement) | 172 Subpart C, 177.817 | Live |
| Incident Response (who to call, notice, written report) | 171.15, 171.16 | Live |
| What You Carry (at a stop, what expires, training rules) | 383.93, 383.141, 172.704 | Live |

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
- `tools/build-icons.mjs` — regenerates `icons/`
- `tools/test-harness.mjs` — the shared vm harness the tests run on
- `tools/test.mjs` — the test suite; runs every `tools/test-*.mjs`
- `tools/GENERATION-REPORT.md`, `tools/SEGREGATION-REPORT.md`, `tools/OPS-REPORT.md`, `tools/PAPERS-REPORT.md`, `tools/INCIDENT-REPORT.md`, `tools/CARRY-REPORT.md` — what each generation run decided, and why
- Deployed via GitHub Pages
- Mobile-first, offline-first

## Offline

Placarding calls happen at docks and in yards with no signal, so the app is
built to answer with none. The service worker caches the shell, every data
file, the icons and the web fonts, and serves every request cache-first while
refreshing in the background. Once the app has been opened online a single
time, it works with the radio off — module grid, load builder, computed
placard set, UN lookup, the segregation check, the Part 397 decision, the
shipping paper comparison, the incident reporting rules and the credential
reference.

**Every new data file must be added to `SHELL` in `sw.js`**, or it is fetched
from the network on every launch and simply is not there offline.

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
| `ops.json` | `version` / `cfrDate` | which CFR edition the Part 397 text came from |
| `papers.json` | `version` / `cfrDate` | which CFR edition the shipping-paper text came from |
| `incident.json` | `version` / `cfrDate` | which CFR edition the reporting text came from |
| `carry.json` | `version` / `cfrDate` | which CFR edition the credential text came from |

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

Each data file's `version` field moves on its own schedule, whenever the
generator that writes it changes the record shape or the mapping rules.

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
written from sits beside it. This is the module where a loose paraphrase does
the most damage, so the summary never stands in for the rule. The build
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
so its commas cannot be mistaken for extra elements.

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

177.817(e), on its own tab. A correct paper in the wrong place is still a
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
- The module renders even while `dataState` is `error`, and the material-data
  error screen carries a button into it.

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
911 is the only `tel:` link on that view. It becomes tappable on the notice tab,
where the question is actually being answered.

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

624 checks across seven files, in about a second and a half. No framework and
nothing to install — the app has no dependencies and neither does its suite,
because a suite that needs a package install is a suite that stops being run.
`tools/test.mjs` runs every `tools/test-*.mjs`, prints each file's count and
fails if any of them does.

| File | Covers |
|---|---|
| `test-placards.mjs` | `compute()` — the 1,001 lb aggregate, the 2,205 lb single-loading-point rule, Table 1, Class 9, 172.505(a), and 177.848(i) |
| `test-segregation.mjs` | `segCheck()` and `segCatFor()` — the subsidiary path, the physical-state gate, category mapping, and the shipped tables |
| `test-ops.mjs` | `hasTier1`, `opsCheck`, `opsRules`, `opsHeadline` — all eight combinations of tier and location |
| `test-papers.mjs` | `basicDescription()` — the 172.202(b) sequence, five regression guards, and a sweep of all 2,479 entries |
| `test-incident.mjs` | the three Incident Response invariants, including no-all-clear over every subset of the checklist |
| `test-carry.mjs` | date arithmetic across month, year and leap boundaries; the 397.19 conditional; the absence of any image capture |
| `test-data.mjs` | all six JSON files — provenance, counts, one CFR date across the set, and precaching |

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

That exercise is worth repeating rather than treating as done: it is how the
one real gap in this suite was found. Dropping the PG I condition from the
Division 6.1 segregation row changed no answer on any load that can be built,
because every Zone A Division 6.1 entry in the shipped table is also PG I. That
arm is now asserted by calling `segCatFor()` directly.
