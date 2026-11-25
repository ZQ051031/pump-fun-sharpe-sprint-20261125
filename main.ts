// Runner-chaser paper bot for the Pump.fun Sharpe Sprint —
// agent-fun/replay/v2, Node 22, zero dependencies.
//
// Strategy in one line: only buy a bonding curve that has ALREADY proved
// itself — up at least 25% from its launch price, still rising over its
// last few trades, sitting on at least 20 SOL of real reserves, with crowd
// buys clearly ahead of crowd sells — then exit on a wide take-profit, a
// tight stop, a trailing give-back, or a time cap.
//
// Why this shape, and why not momentum-chasing: on the kit's 24-hour dev
// window every loose entry rule loses money. Buying a coin after a small
// +4% wiggle means buying the top of its first pump. A signal study over
// the same data (first-hit +TP% / -SL% per entry bucket) shows no entry
// condition wins more than ~49% of the time at tight targets, while the
// one bucket with positive expected value is the strong runner: deep real
// reserves, a big established gain, still rising. So this bot trades
// rarely and only there. The binding trade-off is the 20-distinct-mint
// bar: the bot makes ~71 round trips over the 24-hour dev window, so a
// 6-hour final window is expected to yield ~18 — just under the bar on a
// straight pro-rata, and looser entry rules that would clear it (more
// trips, later entries) all lose money locally. That bar risk is real
// and is the main open risk of this entry, not the PnL.
//
// Exits (first trigger wins): take-profit +25%, stop-loss -5%, trailing
// exit after giving back 15% from the post-entry peak (only while in
// profit), time cap after 14,400 slots held. A mint is traded at most once:
// after a round trip it is never re-entered (re-entering winners and
// entering late — past 50 trades — both tested worse on the dev window).
//
// Local backtester result for these exact parameters (a replay that
// mirrors the house fill math; the house grade-local run is the ground
// truth and is reported in the README): net +30,093,599 lamports
// (+0.30%), hourly Sharpe +0.053, win rate 42.3%, 71 round trips / 71
// distinct mints, max drawdown 0.83%. The two parameters that make it
// net-positive are the tight -5% stop (stops still hit ~1.9x as often as
// take-profits, but each costs ~-3.5M lamports instead of ~-5.8M) and
// the wider 10% sell slippage (see below).
//
// BUG FIX (2026-11-26, continuation builder): the first version recorded
// the buy's client_id from state.clientId() but sent the order WITHOUT
// it, so the shim assigned a different fresh id on the wire and the fill
// arrived under an id pendingBuys never saw. Entries were therefore never
// recorded, TP / SL / trailing never fired, and every position was held
// to the time cap — the house grade for that version was -341,304,869
// lamports (-3.41%), Sharpe -0.551, 48 round trips, median hold 14,403
// slots. The buy order now carries its client_id through, so fills
// match and exits fire as designed.
//
// Fees: ~95 bps protocol + ~30 bps creator per side, plus 5,000 + 100,000
// lamports of tx fees per order — roughly 3.5% of a 0.02 SOL stake per
// round trip. The 25% take-profit clears that with room; the 5% stop
// keeps the losing tail short. Sells tolerate 10% slippage while buys
// tolerate 3%: on a fast dump a sell rejected at 3% is retried only after
// a 300-slot cooldown, by which time the curve has usually rugged to the
// floor, so the exit must fill near its trigger. Two extra guards come
// from replaying the dev data: crowds sometimes dump a curve back to ~2
// lamports of real reserves, so a sell whose expected proceeds do not
// cover its own tx fee is skipped (the harness would write the tokens off
// instead), and a rejected sell is retried at most once per 300 slots, so
// a dumped curve cannot spam attempts (each attempt risks a 2% seeded
// failed tx).
//
// Determinism: no clock, no environment, no Math.random. All state comes
// from harness messages and every scan follows Map insertion order
// (first-seen order), so the two house executions produce byte-identical
// action logs.
//
// I/O: the vendored shim (vendor/makefun-bot.ts) owns the wire. This file
// only decides orders. Amounts are lamports; prices are SOL per token
// from virtual reserves (virtual_quote_reserves / virtual_token_reserves).

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- tuning
// Every number below was picked by replaying the kit's dev window with a
// local backtester that mirrors the house fill math (constant-product on
// virtual reserves, exact-in split, 95+30 bps fees, 2-slot latency,
// slippage vs decision-time reserves) and comparing variants on net PnL
// and hourly Sharpe. The full comparison is in the README.

/** SOL staked per entry: 0.02 SOL. Above the 0.01 SOL round-trip bar. */
const BUY_LAMPORTS = 20_000_000n;
/** Take profit: sell once the mark is +25% over the entry price. */
const TAKE_PROFIT_BPS = 2500;
/** Stop loss: sell once the mark is -5% under the entry price. */
const STOP_LOSS_BPS = 500;
/** Trailing exit: sell after giving back 15% from the post-entry peak. */
const TRAILING_BPS = 1500;
/** Time exit: sell after this many slots held. */
const MAX_HOLD_SLOTS = 14400;
/** Entry needs at least +25% from the mint's first-seen price. */
const ENTRY_MIN_GAIN_BPS = 2500;
/** Entry needs the last price up at least +3% over the price 5 trades ago. */
const RECENT_GAIN_BPS = 300;
/** How many recent prices to keep per mint for the momentum check. */
const PRICE_WINDOW = 6;
/** Entry needs this many trades observed, and no more than this many. */
const MIN_TRADES = 4;
const MAX_TRADES = 50;
/** Entry needs at least this much real SOL in the curve (deep reserves). */
const MIN_REAL_SOL_LAMPORTS = 20_000_000_000n;
/** Entry needs crowd buys at least 25% ahead of crowd sells. */
const BUY_DOMINANCE_NUM = 5n;
const BUY_DOMINANCE_DEN = 4n;
/** Max new buys decided in one batch: staggers entries. */
const MAX_BUYS_PER_BATCH = 2;
/** Slippage tolerance on buys: a buy that would fill worse than this vs
 *  the decision-time reserves is rejected, so we never chase a pump. */
const MAX_BUY_SLIPPAGE_BPS = 300;
/** Slippage tolerance on sells, wider on purpose: on a fast dump a sell
 *  rejected at 3% is retried only after a 300-slot cooldown, by which
 *  time the curve has usually rugged to the floor; 10% lets the exit
 *  fill near its trigger instead. */
const MAX_SELL_SLIPPAGE_BPS = 1000;
/** Sell retry cooldown, in slots, after a rejected sell attempt. */
const SELL_RETRY_COOLDOWN_SLOTS = 300;

// ---------------------------------------------------------------- per-mint memory

interface MintTrack {
  /** Price (SOL per token) at first sight, from virtual reserves. */
  firstPrice: number;
  /** Latest price. */
  lastPrice: number;
  /** Highest price seen since first sight. */
  peakPrice: number;
  /** Trades observed on this mint. */
  trades: number;
  /** SOL bought / sold by the crowd, from TradeEvent sol_amount. */
  buySol: bigint;
  sellSol: bigint;
  /** Slot of first sight. */
  firstSlot: number;
  /** Last few prices, oldest first, for the recent-momentum check. */
  recent: number[];
  /** True once this mint has completed one round trip with us. Never re-enter. */
  done: boolean;
}

interface EntryInfo {
  /** Price (SOL per token) at decision time. */
  price: number;
  /** Peak price since entry, for the trailing exit. */
  peak: number;
  /** Slot the buy was decided on. */
  slot: number;
}

const tracks = new Map<string, MintTrack>();
const entries = new Map<string, EntryInfo>();
/** client_id -> decision-time price and slot of a buy not yet filled. */
const pendingBuys = new Map<string, { mint: string; price: number; slot: number }>();
/** mint -> slot of the last sell attempt (rejected or not), for the cooldown. */
const lastSellTry = new Map<string, number>();

/** SOL per token from virtual reserves; 0 when the reserves are unusable. */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualQuote <= 0n || virtualToken <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

/** Basis points of `now` relative to `base`, rounded toward zero. */
function bpsChange(now: number, base: number): number {
  if (base <= 0 || now <= 0) return 0;
  return Math.trunc(((now - base) / base) * 10_000);
}

function trackMint(mint: string, price: number, slot: number): MintTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      firstPrice: price,
      lastPrice: price,
      peakPrice: price,
      trades: 0,
      buySol: 0n,
      sellSol: 0n,
      firstSlot: slot,
      recent: price > 0 ? [price] : [],
      done: false,
    };
    tracks.set(mint, t);
  }
  return t;
}

/** Ceiling division for non-negative bigints (curve fees are ceil(q*bps/10000)). */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * What selling `tokens` would pay right now, net of curve fees, before the
 * tx fee: mirrors the house sell math (quote out, then 95+30 bps fees).
 * Used only to decide whether a sell is worth sending at all.
 */
function expectedSellProceeds(tokens: bigint, virtualQuote: bigint, virtualToken: bigint): bigint {
  if (tokens <= 0n || virtualQuote <= 0n || virtualToken <= 0n) return 0n;
  const q = (tokens * virtualQuote) / (virtualToken + tokens);
  const fee = ceilDiv(q * 95n, 10_000n) + ceilDiv(q * 30n, 10_000n);
  return q - fee;
}

// ---------------------------------------------------------------- the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // 1. Fold this batch's events into per-mint tracks.
    for (const e of batch.events) {
      if (e.event === 'TradeEvent') {
        const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        const t = trackMint(e.mint, price, e.slot);
        if (price > 0) {
          t.lastPrice = price;
          if (price > t.peakPrice) t.peakPrice = price;
          t.recent.push(price);
          if (t.recent.length > PRICE_WINDOW) t.recent.shift();
        }
        t.trades += 1;
        if (e.is_buy) t.buySol += BigInt(e.sol_amount);
        else t.sellSol += BigInt(e.sol_amount);
      } else if (e.event === 'CreateEvent') {
        const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        trackMint(e.mint, price, e.slot);
      } else {
        // CompleteEvent: the curve is over; the harness closes positions
        // in it itself, and we never enter it again.
        const t = tracks.get(e.mint);
        if (t !== undefined) t.done = true;
      }
    }

    // 2. Learn entry prices from fills that just resolved.
    for (const f of batch.fills) {
      if (f.status !== 'filled') {
        if (f.side === 'buy') pendingBuys.delete(f.client_id);
        continue;
      }
      if (f.side === 'buy') {
        const pending = pendingBuys.get(f.client_id);
        pendingBuys.delete(f.client_id);
        if (pending !== undefined) {
          // Entry price is the decision-time price: the fill lands two
          // slots later, and grading the exit against the price we
          // actually decided on keeps TP/SL honest.
          entries.set(pending.mint, { price: pending.price, peak: pending.price, slot: pending.slot });
        }
      } else {
        entries.delete(f.mint);
        const t = tracks.get(f.mint);
        if (t !== undefined) t.done = true;
      }
    }

    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();

    /**
     * Queue a full-position sell, but only when it is worth sending: the
     * expected proceeds must cover the tx fee, and a mint gets at most one
     * sell attempt per cooldown window, so a dumped curve cannot spam
     * attempts (each risks a seeded failed tx).
     */
    function trySell(mint: string, tokens: bigint, curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): void {
      const proceeds = expectedSellProceeds(tokens, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (proceeds <= txFee) return;
      const lastTry = lastSellTry.get(mint);
      if (lastTry !== undefined && batch.slot - lastTry < SELL_RETRY_COOLDOWN_SLOTS) return;
      lastSellTry.set(mint, batch.slot);
      orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: MAX_SELL_SLIPPAGE_BPS });
    }

    // 3. Exits first: every held position is checked against TP / SL /
    //    trailing / time-cap, in account order (deterministic).
    for (const pos of state.account.positions) {
      const mint = pos.mint;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      const entry = entries.get(mint);
      if (entry === undefined) {
        // Position without a recorded entry: hold it until the time cap,
        // measured from first sight as a conservative entry slot.
        const t = tracks.get(mint);
        const age = t !== undefined ? batch.slot - t.firstSlot : 0;
        if (age > MAX_HOLD_SLOTS) trySell(mint, BigInt(pos.token_amount), curve);
        continue;
      }
      if (price > entry.peak) entry.peak = price;
      const gainBps = bpsChange(price, entry.price);
      // Drop from the post-entry peak, negative when the price fell.
      const dropFromPeakBps = bpsChange(price, entry.peak);
      const heldSlots = batch.slot - entry.slot;
      const takeProfit = gainBps >= TAKE_PROFIT_BPS;
      const stopLoss = gainBps <= -STOP_LOSS_BPS;
      const trailing = dropFromPeakBps <= -TRAILING_BPS && gainBps > 0;
      const timedOut = heldSlots >= MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || trailing || timedOut) {
        trySell(mint, BigInt(pos.token_amount), curve);
      }
    }

    // 4. Entries: scan curves in first-seen order, take at most two new
    //    buys per batch, never more than 5 open positions in total.
    if (orders.length < state.hello.caps.max_orders_per_batch) {
      let buys = 0;
      const open = state.committedPositionCount();
      for (const [mint, curve] of state.curves) {
        if (buys >= MAX_BUYS_PER_BATCH) break;
        if (open + buys >= state.hello.caps.max_open_positions) break;
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (curve.complete) continue;
        if (state.positions.has(mint)) continue;
        if (entries.has(mint)) continue;
        let pendingBuy = false;
        for (const p of pendingBuys.values()) {
          if (p.mint === mint) {
            pendingBuy = true;
            break;
          }
        }
        if (pendingBuy) continue;
        const t = tracks.get(mint);
        if (t === undefined || t.done) continue;
        if (t.firstPrice <= 0) continue;
        if (t.trades < MIN_TRADES || t.trades > MAX_TRADES) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        // A proven runner only: up a lot from launch, still rising over
        // the last few trades, deep real reserves, buyers ahead of sellers.
        const fromFirst = bpsChange(price, t.firstPrice);
        if (fromFirst < ENTRY_MIN_GAIN_BPS) continue;
        if (t.recent.length >= PRICE_WINDOW) {
          const recentGain = bpsChange(price, t.recent[0]);
          if (recentGain < RECENT_GAIN_BPS) continue;
        }
        if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) continue;
        if (t.buySol * BUY_DOMINANCE_DEN < t.sellSol * BUY_DOMINANCE_NUM) continue;
        // Size cap: this batch's buys on this mint may spend at most
        // max_order_bps_of_real_reserve of its real SOL reserve.
        const cap = state.maxBuyLamports(mint);
        if (cap < BUY_LAMPORTS) continue;
        // Cash: keep enough for this buy plus its tx fee and the future
        // sell's tx fee, so a buy never strands a position.
        if (state.freeCashLamports() < BUY_LAMPORTS + 2n * txFee) break;
        const clientId = state.clientId();
        pendingBuys.set(clientId, { mint, price, slot: batch.slot });
        // Pass the id through: the shim assigns a DIFFERENT fresh id when
        // client_id is omitted, so the buy fill would arrive under an id
        // pendingBuys never saw, the entry price would never be recorded,
        // and TP / SL / trailing would never fire (positions would only
        // exit on the time cap, after the curve had usually rugged).
        orders.push({ side: 'buy', mint, quote_lamports: BUY_LAMPORTS, max_slippage_bps: MAX_BUY_SLIPPAGE_BPS, client_id: clientId });
        buys += 1;
      }
    }

    return orders;
  },
});
