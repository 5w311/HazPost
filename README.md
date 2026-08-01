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
- `hazmat.json` — 172.101 material table (fetched at load; planned split from inline data)
- Deployed via GitHub Pages
- Mobile-first; offline support via service worker planned

## Placarding engine rules implemented

- Table 1 materials: placard at any quantity — 172.504(e)
- Table 2 materials: placard when aggregate gross weight of all Table 2 hazmat reaches 1,001 lb — 172.504(c)
- DANGEROUS placard permitted for 2+ Table 2 categories, voided per-class by 2,205+ lb loaded at one facility — 172.504(b)
- Class 9 placard not required for domestic highway transport — 172.504(f)(9)
- Subsidiary hazard flags — 172.505 (advisory note only in prototype)

## Disclaimer

HazPost is not a substitute for the shipping paper or the regulations. Always confirm against your papers and 49 CFR.
