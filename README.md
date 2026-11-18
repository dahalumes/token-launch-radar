# Token Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/dahalumes/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/dahalumes/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A radar for protocols whose DefiLlama record shows no token yet. It reads a frozen DefiLlama snapshot, separates
protocols that already trade a token from those still to come, ranks the pre-token ones by an implied
value derived from the snapshot's own figures, and gives every ranked protocol a concrete farm plan
(each step with its cost and time). The output is a static dashboard that works offline: a sortable,
filterable board, a detail view per protocol, a page of valuation comparables and a method page.

An implied value is this radar's estimate of what a token would be worth if the protocol's record
stayed as it is. It is not a prediction that a token will launch, and a protocol that "records no
token" in DefiLlama may still have one.

## Run it

Node.js 22.18 or later, standard library only, nothing to install.

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
# then open out/dashboard/index.html in a browser
```

In the grader's container it reads `/input/snapshot.json` and writes to `/output`. It writes
`board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json`, then re-checks its own output
against the competition's seven published gate rows and exits 1 if any fails.

## Test it

```sh
npm test          # or: node --test tests/*.test.ts
```

The suite covers the model's factors and classification, every gate row (including the negative cases),
the required output files, the dashboard's rendering, accessibility and source budget, and determinism:
two runs, from different working directories, must write identical bytes. It passes on Node 22.18 and 24. It uses a synthetic snapshot, and the real one too when it can find it
(`TOKEN_RADAR_SNAPSHOT=/path/to/snapshot.json`).

## Layout

| Path | What it is |
| --- | --- |
| `main.ts` | Entrypoint: read, model, write, dossier, self-check |
| `lib/snapshot.ts` | Strict snapshot reader |
| `lib/model.ts` | Loads `dashboard/model.js` into Node with types; writes `board.json` and `data.js` |
| `lib/gate.ts` | Local restatement of the seven gate rows |
| `dashboard/model.js` | The model: classification, comparables, valuation, uncertainty, farm plans |
| `dashboard/` | The page: `index.html`, `app.css`, `app.js` (no framework, no network) |
| `screenshots/` | Board, detail, filtered and method captures, 1440x900 (the gate takes 3 to 4) |
| `vendor/makefun-board.ts` | make.fun's dossier library, copied unmodified from the competition kit |
| `tools/screenshots.sh` | Development helper: recaptures the screenshots with headless Chrome |
| `tests/` | `node:test` suites |

## The model (radar-model/1.1)

`implied value = TVL x peer multiple x momentum x runway`, implemented once in `dashboard/model.js`.
`main.ts` runs that file (via `lib/model.ts`) to write `board.json`, and the page runs it again in the
browser as a **consistency check**: it proves the figures are reproducible from the code shown, not that
the valuation is accurate.

- **Peer multiple**: market cap / TVL of the snapshot's protocols whose token trades and has a market cap
  (128 here), clipped to their own 5th-95th percentile. A category's log-median is pooled with its
  sector's (weight n / (n + 15)), and each sector's with the global median (n / (n + 5)).
- **Curators & allocators** are their own sector: their TVL is capital they manage inside other
  protocols' markets (much of it also counted there), and their priced peers trade far below vaults.
- **Momentum**: square root of the 7-day TVL growth factor, the factor clipped to 0.5-2.
- **Runway**: days tracked with no token recorded; rises over 270 days, holds to 900, then fades by up
  to 35%.
- **Indicative range**: +-z robust spreads of the peers' log multiples, with z chosen by leave-one-out so
  half of the 128 held-out peers fall inside (z = 0.79; the textbook 0.674 covered 41%). It is
  calibrated on the same peers, so it is indicative, not a validated forecast, and it leaves out the
  momentum, runway and launch assumptions. Shown to two significant figures.
- **Held-out diagnostics** (Method view): mean |log error| 1.79 for the model, 1.79 for sector alone,
  1.81 for one global multiple. The category structure adds little; ranks mostly follow TVL, momentum
  and runway.
- **Farm plans**: per-category playbooks propose only actions the category supports; features a category
  does not always have, and any points program, are conditional on what step 1 finds. The payoff step is
  an illustration that assumes a launch, and it flags when it would not cover the plan's gas.

No protocol is named anywhere in the model. An implied value is an estimate, not a market price; a
protocol whose DefiLlama record shows no token may still have one.

## License

MIT, see `LICENSE`. `vendor/makefun-board.ts` is make.fun's library, shipped as the competition requires.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
