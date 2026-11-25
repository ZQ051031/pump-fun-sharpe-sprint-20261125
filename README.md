[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ZQ051031/pump-fun-sharpe-sprint-20261125/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ZQ051031/pump-fun-sharpe-sprint-20261125/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Pump.fun Sharpe Sprint — Steady Small Wins

A paper-trading bot for the make.fun competition
[Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).
One strategy program, `main.ts`, running on Node 22 against the house
`pumpfun-replay/v2` harness (`agent-fun/replay/v2`). It trades paper money
on a 6-hour pump.fun forward replay; places go by **hourly Sharpe ratio**,
not by biggest PnL, and a prize needs net PnL above zero after all fees.

## Strategy

Buy a small, fixed slice of a young bonding curve only after it has shown
real, buy-led momentum, then exit on a tight take-profit, a tight
stop-loss, a trailing give-back, or a time cap — whichever comes first.
Many small round trips across many mints; no concentration, no chasing,
no holding a dying coin.

- **Entry (all must hold):** at least 4 trades observed; price up at
  least +4% from the mint's first-seen price but no more than +25%
  (don't chase a runaway top); price still rising at least +3% over the
  last few trades; crowd buy volume ahead of crowd sell volume; the
  0.02 SOL order fits the per-mint size cap
  (`max_order_bps_of_real_reserve` of real SOL reserves); cash covers
  the buy plus tx fees for the buy and the future sell.
- **Size:** fixed **0.02 SOL** (20,000,000 lamports) per trade — above
  the 0.01 SOL round-trip bar, small enough that any single rug costs
  little. At most **2 new buys per batch** and **5 open positions**.
- **Exits (first trigger wins):** take-profit **+10%**, stop-loss
  **−5%**, trailing exit after giving back **6%** from the post-entry
  peak (only while in profit), time cap after **3,600 slots** held
  (~24 minutes). A mint is traded at most once: after a round trip it
  is never re-entered, which pushes the distinct-mints count up.
- **Fees accounted for:** ~95 bps protocol + ~30 bps creator per side,
  plus 5,000 + 100,000 lamports of tx fees per order — roughly 3–4% of
  a 0.02 SOL stake per round trip. The 10% take-profit clears that
  hurdle; the 5% stop keeps the losing tail short.

## Guardrails

- Capital 10 SOL. Max 5 open positions, max 16 orders per batch.
  No shorts, no leverage.
- At least 20 distinct mints with round trips of at least 0.01 SOL
  each; max drawdown 50%.
- **Determinism:** no clock, no environment, no `Math.random`. All
  state comes from harness messages and every scan follows first-seen
  (Map insertion) order, so the two house executions produce
  byte-identical action logs.

## How to run / test

```sh
# typecheck (Node 22 strips types; no build step, no dependencies)
node --check main.ts

# local grade on the kit's dev window (from the unpacked kit directory)
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## Files

- `main.ts` — the whole strategy (entry, exits, sizing, determinism).
- `vendor/makefun-bot.ts` — the house TypeScript SDK shim, copied
  unchanged; it owns the stdin/stdout wire protocol.
- `LICENSE` — MIT.

## License

MIT — see `LICENSE`.
