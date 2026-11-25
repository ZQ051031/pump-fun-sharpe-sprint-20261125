[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ZQ051031/pump-fun-sharpe-sprint-20261125/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ZQ051031/pump-fun-sharpe-sprint-20261125/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Pump.fun Sharpe Sprint — Runner-Chaser Paper Bot

A paper-trading bot for the make.fun competition
[Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).
One strategy program, `main.ts`, running on Node 22 against the house
`pumpfun-replay/v2` harness (`agent-fun/replay/v2`). It trades paper money
on a 6-hour pump.fun forward replay; places go by **hourly Sharpe ratio**,
not by biggest PnL, and a prize needs net PnL above zero after all fees.

## Strategy

Buy a small, fixed slice of a bonding curve only after it has already
proved itself — a big established gain, still rising, deep real reserves,
buy-led flow — then exit on a wide take-profit, a tight stop-loss, a
trailing give-back, or a time cap, whichever comes first. Many small
round trips across many mints; no concentration, no chasing, no holding
a dying coin.

- **Entry (all must hold):** at least 4 trades observed and no more than
  50; price up at least **+25%** from the mint's first-seen price; price
  still rising at least **+3%** over the last few trades; at least
  **20 SOL** of real reserves in the curve; crowd buy volume at least
  25% ahead of crowd sell volume; the 0.02 SOL order fits the per-mint
  size cap (`max_order_bps_of_real_reserve` of real SOL reserves); cash
  covers the buy plus tx fees for the buy and the future sell.
- **Size:** fixed **0.02 SOL** (20,000,000 lamports) per trade — above
  the 0.01 SOL round-trip bar, small enough that any single rug costs
  little. At most **2 new buys per batch** and **5 open positions**.
- **Exits (first trigger wins):** take-profit **+25%**, stop-loss
  **−5%**, trailing exit after giving back **15%** from the post-entry
  peak (only while in profit), time cap after **14,400 slots** held. A
  mint is traded at most once: after a round trip it is never re-entered.
- **Slippage:** buys tolerate **3%** (never chase a pump); sells
  tolerate **10%** — on a fast dump a sell rejected at 3% is retried
  only after a 300-slot cooldown, by which time the curve has usually
  rugged to the floor, so the exit has to fill near its trigger.
- **Fees accounted for:** ~95 bps protocol + ~30 bps creator per side,
  plus 5,000 + 100,000 lamports of tx fees per order — roughly 3.5% of
  a 0.02 SOL stake per round trip. The 25% take-profit clears that
  hurdle; the 5% stop keeps the losing tail short.

## Why these numbers

Every number was picked by replaying the kit's 24-hour dev window with
a local backtester that mirrors the house fill math (constant-product
on virtual reserves, exact-in split, 95+30 bps fees, 2-slot latency,
slippage vs decision-time reserves) and comparing variants on net PnL
and hourly Sharpe — then verified with the house `grade-local` itself.
Loose entries (buy at +4%…+15%, or past 50 trades, or on shallow
reserves) all lose money; the strong-runner bucket is the only entry
with positive expected value. The two parameters that make the bot
net-positive are the tight −5% stop (stops still hit ~1.9x as often as
take-profits, but each costs ~−3.5M lamports instead of ~−5.8M) and the
wider 10% sell slippage. A larger 0.05 SOL stake was tested and is
worse (price impact scales with size); re-entering winners and holding
graduated curves longer were both tested and are worse.

## Bug fix: the client_id that broke every exit

The first version recorded the buy's `client_id` from
`state.clientId()` but sent the order without it, so the shim assigned
a different fresh id on the wire and the fill arrived under an id the
bot never saw. Entries were therefore never recorded, TP / SL /
trailing never fired, and every position was held to the time cap —
the house grade for that version was −341,304,869 lamports (−3.41%),
hourly Sharpe −0.551, 48 round trips, median hold 14,403 slots. The
buy order now carries its `client_id` through, so fills match and
exits fire as designed.

## Local grade (house `grade-local`, dev window, `--driver process`)

Final version, graded from the worktree and then committed unchanged
as `275b080` (the graded files are byte-identical to the commit; the
repeat run below was on the same worktree):

- **Net PnL: +34,866,343 lamports (+0.00349 SOL, +0.35%)**
- **Hourly Sharpe: +0.0815** (Sortino 0.139)
- **Win rate: 42.3%**, 71 round trips, 71 distinct mints, 142 fills
- **Max drawdown: 0.81%** (limit 50%)
- Fees: 36,142,445 lamports curve + 15,435,000 lamports tx
- 27 rejected orders, 5 failed txs
- `action_log_sha256`: `5c4c117692a3a4373edd8507e7003ec0cffedcf75fb6acf473142daff318f7ac`
- A repeat `grade-local` run reproduced the same PnL and the same
  `action_log_sha256` — byte-identical, deterministic.

## Open risks (read before submitting)

- **Distinct-mint bar:** the bot makes 71 round trips over the 24-hour
  dev window, so a 6-hour final window is expected to yield ~18 on a
  straight pro-rata — just under the 20-mint bar. Looser entry rules
  that would clear it (more trips, later entries) all lose money
  locally, so the bar was not chased with filler trades. The final
  window's mint density is a different slice and may differ.
- **Concentrated gains:** 3 coins made 47% of the gains; without them
  net PnL is −0.06 SOL, and the 90% bootstrap interval is
  −0.078…+0.174 SOL. The positive dev result is real but thin.
- **Node version:** local grading ran on Node v24.22.1; the server
  harness runs v26.13.1, so `result_sha256` cannot equal the server's.

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
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process --worktree
```

## Files

- `main.ts` — the whole strategy (entry, exits, sizing, determinism).
- `vendor/makefun-bot.ts` — the house TypeScript SDK shim, copied
  unchanged; it owns the stdin/stdout wire protocol.
- `LICENSE` — MIT.

## License

MIT — see `LICENSE`.
