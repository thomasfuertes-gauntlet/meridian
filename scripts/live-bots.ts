/**
 * Live trading bot - creates visible order book movement across ALL markets.
 * Each tick: picks an action for EVERY market in parallel, then sleeps.
 *
 * Oracle-anchored: fetches Pyth prices every 30s, computes fair value
 * per market, and drifts orders toward fair value.
 *
 * Actions (weighted random per market):
 *   50% - Cancel a random order and replace at +/-$0.01-0.03 jitter toward fair
 *   25% - Place a new resting order near the spread (qty 1-3)
 *   20% - Cross the spread with qty 1 (creates fills/movement)
 *    5% - Do nothing (natural pause)
 *
 * Run after `make bots`. Uses deterministic bot-a wallet.
 */
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  mintTo,
} from "@solana/spl-token";
import { getDevWallet } from "./dev-wallets";
import { fairValue, fetchStockPrices } from "./fair-value";
import { parseBook, MarketCtx, discoverMarkets, loadUsdcMint, sleep, USDC_PER_PAIR, MAX_PER_SIDE, weightedMarketSelect } from "./bot-utils";

const MIN_PRICE = 50_000;   // $0.05 floor
const MAX_PRICE = 950_000;  // $0.95 ceiling
const MIN_ORDERS_PER_SIDE = 3;
const TICK_MS_MIN = 150;
const TICK_MS_MAX = 400;
const PRICE_REFRESH_MS = 30_000;
const TX_DELAY_MS = Number(process.env.TX_DELAY_MS ?? 1000); // 1s global throttle between RPCs
const MARKET_REFRESH_TICKS = 100; // re-check which markets are still active every ~100 ticks
const REPLENISH_THRESHOLD = 500 * USDC_PER_PAIR; // auto-replenish below 500 USDC

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;

  const usdcMint = loadUsdcMint();
  const bot = getDevWallet("bot-a");
  const admin = getDevWallet("admin");
  const botUsdcAta = getAssociatedTokenAddressSync(usdcMint, bot.publicKey);

  console.log("Bot:", bot.publicKey.toString());
  console.log("USDC Mint:", usdcMint.toString());

  let markets = await discoverMarkets(program);

  console.log(`Found ${markets.length} active markets`);

  // Fetch initial stock prices
  let stockPrices = await fetchStockPrices();
  let lastPriceRefresh = Date.now();
  const priceStrs: string[] = [];
  stockPrices.forEach((p, t) => priceStrs.push(`${t}=$${p.toFixed(0)}`));
  console.log("Stock prices loaded:", priceStrs.length > 0 ? priceStrs.join(", ") : "(none - using $0.50 default)");
  console.log("Starting live trading loop (Ctrl+C to stop)\n");

  let txCount = 0;

  // Auto-replenish USDC when balance gets low
  async function checkReplenish() {
    try {
      const info = await connection.getTokenAccountBalance(botUsdcAta);
      const balance = Number(info.value.amount);
      if (balance < REPLENISH_THRESHOLD) {
        await mintTo(connection, admin, usdcMint, botUsdcAta, admin, 5_000 * USDC_PER_PAIR);
        console.log("  [replenish] Minted 5,000 USDC to bot");
      }
    } catch {
      // ignore - ATA might not exist yet
    }
  }

  function getFairForMarket(mkt: MarketCtx): number {
    const stockPrice = stockPrices.get(mkt.ticker);
    const strikeDollars = mkt.strikePrice / USDC_PER_PAIR;
    const hoursUntilClose = (mkt.closeTime - Date.now() / 1000) / 3600;
    // fetchStockPrices() now always returns all tickers (synthetic fallback)
    return stockPrice ? fairValue(stockPrice, strikeDollars, hoursUntilClose) : 0.50;
  }

  // Track which markets have had ATAs initialized this session
  const atasInitialized = new Set<string>();

  async function ensureAtas(mkt: MarketCtx, botYesAta: PublicKey) {
    const key = mkt.pubkey.toString();
    if (atasInitialized.has(key)) return;
    const botNoAta = getAssociatedTokenAddressSync(mkt.noMint, bot.publicKey);
    const tx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(bot.publicKey, botYesAta, bot.publicKey, mkt.yesMint),
      createAssociatedTokenAccountIdempotentInstruction(bot.publicKey, botNoAta, bot.publicKey, mkt.noMint),
    );
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [bot]);
    atasInitialized.add(key);
  }

  async function tradeOnMarket(mkt: MarketCtx): Promise<void> {
    const botYesAta = getAssociatedTokenAddressSync(mkt.yesMint, bot.publicKey);
    await ensureAtas(mkt, botYesAta);
    const fair = getFairForMarket(mkt);
    const fairPrice = Math.round(fair * USDC_PER_PAIR);

    const obInfo = await connection.getAccountInfo(mkt.orderBook);
    if (!obInfo) return;
    const book = parseBook(obInfo.data as Buffer);

    const botBids = book.bids.filter((o) => o.owner.equals(bot.publicKey));
    const botAsks = book.asks.filter((o) => o.owner.equals(bot.publicKey));

    const roll = Math.random();

    if (roll < 0.05) {
      return; // natural pause
    }

    if (roll < 0.55 && (botBids.length > MIN_ORDERS_PER_SIDE || botAsks.length > MIN_ORDERS_PER_SIDE)) {
      // 50% - Cancel + replace with drift toward fair value
      const side = botBids.length > MIN_ORDERS_PER_SIDE && (Math.random() < 0.5 || botAsks.length <= MIN_ORDERS_PER_SIDE)
        ? "bid" : "ask";
      const orders = side === "bid" ? botBids : botAsks;
      if (orders.length <= MIN_ORDERS_PER_SIDE) return;

      const order = pick(orders);
      const ticks = randInt(1, 3);
      // Drift toward fair value instead of pure random
      const towardFair = side === "bid"
        ? (order.price < fairPrice ? 1 : -1)
        : (order.price > fairPrice ? -1 : 1);
      const drift = towardFair * ticks * 10_000;
      const newPrice = clamp(order.price + drift, MIN_PRICE, MAX_PRICE);

      const bestAsk = book.asks[0]?.price ?? MAX_PRICE;
      const bestBid = book.bids[0]?.price ?? MIN_PRICE;
      const safePrice = side === "bid"
        ? Math.min(newPrice, bestAsk - 10_000)
        : Math.max(newPrice, bestBid + 10_000);

      if (safePrice <= MIN_PRICE || safePrice >= MAX_PRICE) return;

      const refundDest = side === "bid" ? botUsdcAta : botYesAta;
      await program.methods
        .cancelOrder(new BN(order.orderId))
        .accountsPartial({
          user: bot.publicKey,
          market: mkt.pubkey,
          orderBook: mkt.orderBook,
          obUsdcVault: mkt.obUsdcVault,
          obYesVault: mkt.obYesVault,
          refundDestination: refundDest,
        })
        .signers([bot])
        .rpc();
      txCount++;
      await sleep(TX_DELAY_MS);

      await program.methods
        .placeOrder(
          side === "bid" ? { bid: {} } : { ask: {} },
          new BN(safePrice),
          new BN(order.quantity),
        )
        .accountsPartial({
          user: bot.publicKey,
          market: mkt.pubkey,
          orderBook: mkt.orderBook,
          obUsdcVault: mkt.obUsdcVault,
          obYesVault: mkt.obYesVault,
          userUsdc: botUsdcAta,
          userYes: botYesAta,
        })
        .signers([bot])
        .rpc();
      txCount++;

      const arrow = drift > 0 ? "↑" : "↓";
      console.log(`[${mkt.ticker}] ${arrow} ${side} $${(order.price / USDC_PER_PAIR).toFixed(2)}->${(safePrice / USDC_PER_PAIR).toFixed(2)} qty=${order.quantity}  [${txCount}]`);

    } else if (roll < 0.80) {
      // 25% - Place a new resting order near the spread, anchored to fair
      const bestBid = book.bids[0]?.price ?? Math.round(fair * USDC_PER_PAIR * 0.8);
      const bestAsk = book.asks[0]?.price ?? Math.round(fair * USDC_PER_PAIR * 1.2);
      const mid = Math.floor((bestBid + bestAsk) / 2);
      const side = Math.random() < 0.5 ? "bid" : "ask";

      if (side === "bid" && book.bids.length >= MAX_PER_SIDE - 1) return;
      if (side === "ask" && book.asks.length >= MAX_PER_SIDE - 1) return;

      const offset = randInt(10_000, 50_000);
      const price = clamp(
        side === "bid" ? mid - offset : mid + offset,
        MIN_PRICE, MAX_PRICE,
      );
      if (side === "bid" && price >= bestAsk) return;
      if (side === "ask" && price <= bestBid) return;

      const qty = randInt(1, 3);

      // Mint pairs for token supply
      await program.methods
        .mintPair(new BN(qty))
        .accountsPartial({
          user: bot.publicKey,
          market: mkt.pubkey,
          yesMint: mkt.yesMint,
          noMint: mkt.noMint,
          vault: mkt.vault,
          userUsdc: botUsdcAta,
          userYes: botYesAta,
          userNo: getAssociatedTokenAddressSync(mkt.noMint, bot.publicKey),
        })
        .signers([bot])
        .rpc();
      txCount++;
      await sleep(TX_DELAY_MS);

      await program.methods
        .placeOrder(
          side === "bid" ? { bid: {} } : { ask: {} },
          new BN(price),
          new BN(qty),
        )
        .accountsPartial({
          user: bot.publicKey,
          market: mkt.pubkey,
          orderBook: mkt.orderBook,
          obUsdcVault: mkt.obUsdcVault,
          obYesVault: mkt.obYesVault,
          userUsdc: botUsdcAta,
          userYes: botYesAta,
        })
        .signers([bot])
        .rpc();
      txCount++;

      console.log(`[${mkt.ticker}] + ${side} ${qty} @ $${(price / USDC_PER_PAIR).toFixed(2)}  [${txCount}]`);

    } else if (book.bids.length > MIN_ORDERS_PER_SIDE && book.asks.length > MIN_ORDERS_PER_SIDE) {
      // 20% - Cross the spread with qty 1 (visible fill)
      await program.methods
        .mintPair(new BN(1))
        .accountsPartial({
          user: bot.publicKey,
          market: mkt.pubkey,
          yesMint: mkt.yesMint,
          noMint: mkt.noMint,
          vault: mkt.vault,
          userUsdc: botUsdcAta,
          userYes: botYesAta,
          userNo: getAssociatedTokenAddressSync(mkt.noMint, bot.publicKey),
        })
        .signers([bot])
        .rpc();
      txCount++;
      await sleep(TX_DELAY_MS);

      const side = Math.random() < 0.5 ? "bid" : "ask";

      if (side === "bid") {
        const hitPrice = book.asks[0].price;
        await program.methods
          .placeOrder({ bid: {} }, new BN(hitPrice), new BN(1))
          .accountsPartial({
            user: bot.publicKey,
            market: mkt.pubkey,
            orderBook: mkt.orderBook,
            obUsdcVault: mkt.obUsdcVault,
            obYesVault: mkt.obYesVault,
            userUsdc: botUsdcAta,
            userYes: botYesAta,
          })
          .remainingAccounts([
            { pubkey: getAssociatedTokenAddressSync(usdcMint, book.asks[0].owner), isWritable: true, isSigner: false },
          ])
          .signers([bot])
          .rpc();
        txCount++;

        console.log(`[${mkt.ticker}] * BUY 1 @ $${(hitPrice / USDC_PER_PAIR).toFixed(2)}  [${txCount}]`);
      } else {
        const hitPrice = book.bids[0].price;
        await program.methods
          .placeOrder({ ask: {} }, new BN(hitPrice), new BN(1))
          .accountsPartial({
            user: bot.publicKey,
            market: mkt.pubkey,
            orderBook: mkt.orderBook,
            obUsdcVault: mkt.obUsdcVault,
            obYesVault: mkt.obYesVault,
            userUsdc: botUsdcAta,
            userYes: botYesAta,
          })
          .remainingAccounts([
            { pubkey: getAssociatedTokenAddressSync(mkt.yesMint, book.bids[0].owner), isWritable: true, isSigner: false },
          ])
          .signers([bot])
          .rpc();
        txCount++;

        console.log(`[${mkt.ticker}] * SELL 1 @ $${(hitPrice / USDC_PER_PAIR).toFixed(2)}  [${txCount}]`);
      }
    }
  }

  let replenishCounter = 0;
  let tickCounter = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Periodically drop settled markets from the active list
    if (++tickCounter % MARKET_REFRESH_TICKS === 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const refreshed = await (program.account as any).strikeMarket.all();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const activePubkeys = new Set(refreshed.filter((m: any) => m.account.outcome?.pending !== undefined).map((m: any) => m.publicKey.toString()));
        const before = markets.length;
        markets = markets.filter((m) => activePubkeys.has(m.pubkey.toString()));
        if (markets.length < before) {
          console.log(`[refresh] ${before - markets.length} markets settled, ${markets.length} remaining`);
        }
        if (markets.length === 0) {
          console.log("[done] All markets settled. Exiting gracefully.");
          process.exit(0);
        }
      } catch {
        // RPC failure - keep going with current list
      }
    }

    // Refresh stock prices periodically
    if (Date.now() - lastPriceRefresh > PRICE_REFRESH_MS) {
      stockPrices = await fetchStockPrices();
      lastPriceRefresh = Date.now();
    }

    // Check USDC balance every 50 ticks
    if (++replenishCounter % 50 === 0) {
      await checkReplenish();
    }

    // Pick 1-2 markets weighted toward active frontend ticker
    const batch = randInt(1, Math.min(2, markets.length));
    const selected = weightedMarketSelect(markets, batch);

    for (const mkt of selected) {
      try {
        await tradeOnMarket(mkt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const transient = ["0x1", "0x0", "blockhash", "OrderBookFull", "NotOrderOwner", "debit"];
        if (!transient.some((t) => msg.includes(t))) {
          console.log(`  [err] ${msg.slice(0, 120)}`);
        }
      }
      await sleep(TX_DELAY_MS);
    }

    await sleep(randInt(TICK_MS_MIN, TICK_MS_MAX));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
