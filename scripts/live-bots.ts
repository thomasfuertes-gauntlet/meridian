/**
 * Live trading bot - creates visible order book movement across ALL markets.
 * Each tick: picks an action for EVERY market in parallel, then sleeps.
 *
 * Oracle-anchored: fetches Pyth prices every 30s, computes fair value
 * per market, and drifts orders toward fair value.
 *
 * Actions (weighted random per market):
 *   30% - Cancel a random order and replace at +/-$0.01-0.03 jitter toward fair
 *   20% - Place a new resting order near the spread (qty 1-3)
 *   45% - Cross the spread (depth-aware, creates fills/movement)
 *    5% - Do nothing (natural pause)
 *
 * Run after `make local-bots`. Uses deterministic bot-a wallet.
 */
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  mintTo,
} from "@solana/spl-token";
import { getDevWallet } from "./dev-wallets";
import { fairValue, fetchStockPrices } from "./fair-value";
import { MarketCtx, loadUsdcMint, sleep, USDC_PER_PAIR, MAX_PER_SIDE, defaultTxDelay, getBlockhashCached } from "./bot-utils";
import { createWsCache } from "./ws-cache";

const MIN_PRICE = 50_000;   // $0.05 floor
const MAX_PRICE = 950_000;  // $0.95 ceiling
const MIN_ORDERS_PER_SIDE = 3;
const TICK_MS_MIN = 2_000;
const TICK_MS_MAX = 5_000;
const PRICE_REFRESH_MS = 30_000;
const TX_DELAY_MS = defaultTxDelay();
const REPLENISH_THRESHOLD = 100_000 * USDC_PER_PAIR;
const REPLENISH_AMOUNT = 1_000_000 * USDC_PER_PAIR;

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Walk one side of the book and return fillable qty + worst price to sweep it. */
function walkDepth(
  orders: { price: number; quantity: number }[],
  maxQty: number,
): { fillable: number; worstPrice: number } {
  let fillable = 0;
  let worstPrice = 0;
  for (const o of orders) {
    fillable += o.quantity;
    worstPrice = o.price;
    if (fillable >= maxQty) break;
  }
  return { fillable: Math.min(fillable, maxQty), worstPrice };
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;

  // KEY-DECISION 2026-03-14: Monkey-patch provider for credit efficiency.
  // Cached blockhash + skipPreflight + no WS confirm = ~1 credit/tx vs ~3.
  // Saves ~106k Helius credits/day for long-running bot processes.
  (provider as any).sendAndConfirm = async (tx: Transaction, signers?: anchor.web3.Signer[]) => {
    const bh = await getBlockhashCached(connection);
    tx.recentBlockhash = bh.blockhash;
    tx.lastValidBlockHeight = bh.lastValidBlockHeight;
    tx.feePayer = provider.wallet.publicKey;
    if (signers?.length) tx.partialSign(...signers);
    tx = await provider.wallet.signTransaction(tx);
    return connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 2,
    });
  };

  const usdcMint = loadUsdcMint();
  const bot = getDevWallet("bot-a");
  const admin = getDevWallet("admin");
  const botUsdcAta = getAssociatedTokenAddressSync(usdcMint, bot.publicKey);

  console.log("Bot:", bot.publicKey.toString());
  console.log("USDC Mint:", usdcMint.toString());
  console.log("Ticker: NVDA");

  const cache = createWsCache(connection, program);
  await cache.ready;

  console.log(`Found ${cache.markets.size} active markets`);

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
        await mintTo(connection, admin, usdcMint, botUsdcAta, admin, REPLENISH_AMOUNT);
        console.log(`  [replenish] Minted ${(REPLENISH_AMOUNT / USDC_PER_PAIR).toLocaleString()} USDC to bot`);
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
    // Skip markets past close time (frozen or settling - on-chain rejects with MarketFrozen)
    if (mkt.closeTime <= Date.now() / 1000) return;

    const botYesAta = getAssociatedTokenAddressSync(mkt.yesMint, bot.publicKey);
    await ensureAtas(mkt, botYesAta);
    const fair = getFairForMarket(mkt);
    const fairPrice = Math.round(fair * USDC_PER_PAIR);

    const book = cache.books.get(mkt.orderBook.toBase58());
    if (!book) return;

    const botBids = book.bids.filter((o) => o.owner.equals(bot.publicKey));
    const botAsks = book.asks.filter((o) => o.owner.equals(bot.publicKey));

    const roll = Math.random();

    if (roll < 0.05) {
      return; // natural pause
    }

    if (roll < 0.35 && (botBids.length > MIN_ORDERS_PER_SIDE || botAsks.length > MIN_ORDERS_PER_SIDE)) {
      // 30% - Cancel + replace with drift toward fair value
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

      const refreshedBook = cache.books.get(mkt.orderBook.toBase58());
      if (!refreshedBook) return;
      const refreshedBestAsk = refreshedBook.asks[0]?.price ?? MAX_PRICE;
      const refreshedBestBid = refreshedBook.bids[0]?.price ?? MIN_PRICE;
      const refreshedSafePrice = side === "bid"
        ? Math.min(safePrice, refreshedBestAsk - 1)
        : Math.max(safePrice, refreshedBestBid + 1);

      if (side === "bid" && refreshedSafePrice >= refreshedBestAsk) return;
      if (side === "ask" && refreshedSafePrice <= refreshedBestBid) return;
      if (refreshedSafePrice <= MIN_PRICE || refreshedSafePrice >= MAX_PRICE) return;

      await program.methods
        .placeOrder(
          side === "bid" ? { bid: {} } : { ask: {} },
          new BN(refreshedSafePrice),
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
      console.log(`[${mkt.ticker}] ${arrow} ${side} $${(order.price / USDC_PER_PAIR).toFixed(2)}->${(refreshedSafePrice / USDC_PER_PAIR).toFixed(2)} qty=${order.quantity}  [${txCount}]`);

    } else if (roll < 0.55) {
      // 20% - Place a new resting order near the spread, anchored to fair
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

      const refreshedBook = cache.books.get(mkt.orderBook.toBase58());
      if (!refreshedBook) return;
      const refreshedBestBid = refreshedBook.bids[0]?.price ?? Math.round(fair * USDC_PER_PAIR * 0.8);
      const refreshedBestAsk = refreshedBook.asks[0]?.price ?? Math.round(fair * USDC_PER_PAIR * 1.2);
      const refreshedMid = Math.floor((refreshedBestBid + refreshedBestAsk) / 2);
      const refreshedPrice = clamp(
        side === "bid" ? refreshedMid - offset : refreshedMid + offset,
        MIN_PRICE,
        MAX_PRICE,
      );
      if (side === "bid" && refreshedPrice >= refreshedBestAsk) return;
      if (side === "ask" && refreshedPrice <= refreshedBestBid) return;

      await program.methods
        .placeOrder(
          side === "bid" ? { bid: {} } : { ask: {} },
          new BN(refreshedPrice),
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

      console.log(`[${mkt.ticker}] + ${side} ${qty} @ $${(refreshedPrice / USDC_PER_PAIR).toFixed(2)}  [${txCount}]`);

    } else if (book.bids.length > 0 && book.asks.length > 0) {
      // 45% - Cross the spread (depth-aware fill) + post remainder as liquidity
      const side = Math.random() < 0.5 ? "bid" : "ask";
      const oppositeOrders = side === "bid" ? book.asks : book.bids;

      // Walk the book to find fillable depth
      const desiredQty = randInt(1, 10);
      const { fillable } = walkDepth(oppositeOrders, desiredQty);

      // Mint full desired qty (cross portion + remainder for resting order)
      await program.methods
        .mintPair(new BN(desiredQty))
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

      // Re-check depth after mint (book may have changed)
      const refreshedBook = cache.books.get(mkt.orderBook.toBase58());
      if (!refreshedBook) return;
      const freshOrders = side === "bid" ? refreshedBook.asks : refreshedBook.bids;
      const { fillable: freshFillable, worstPrice: freshWorstPrice } = walkDepth(freshOrders, fillable || desiredQty);

      // Cross what's available
      if (freshFillable > 0) {
        const submitQty = freshFillable;
        if (side === "bid") {
          await program.methods
            .buyYes(new BN(submitQty), new BN(freshWorstPrice))
            .accountsPartial({
              user: bot.publicKey,
              market: mkt.pubkey,
              yesMint: mkt.yesMint,
              orderBook: mkt.orderBook,
              obUsdcVault: mkt.obUsdcVault,
              obYesVault: mkt.obYesVault,
              userUsdc: botUsdcAta,
              userYes: botYesAta,
            })
            .signers([bot])
            .rpc();
          txCount++;
          console.log(`[${mkt.ticker}] * BUY ${submitQty} @ $${(freshWorstPrice / USDC_PER_PAIR).toFixed(2)}  [${txCount}]`);
        } else {
          await program.methods
            .sellYes(new BN(submitQty), new BN(freshWorstPrice))
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
          console.log(`[${mkt.ticker}] * SELL ${submitQty} @ $${(freshWorstPrice / USDC_PER_PAIR).toFixed(2)}  [${txCount}]`);
        }
        await sleep(TX_DELAY_MS);
      }

      // Post remainder (or full qty if nothing was fillable) as resting liquidity
      const restQty = freshFillable > 0 ? (desiredQty - freshFillable) : desiredQty;
      if (restQty > 0) {
        const postBook = cache.books.get(mkt.orderBook.toBase58());
        if (!postBook) return;
        const bestBid = postBook.bids[0]?.price ?? MIN_PRICE;
        const bestAsk = postBook.asks[0]?.price ?? MAX_PRICE;

        // Post on the same side as the cross direction, 1-3 ticks behind the spread
        const ticks = randInt(1, 3);
        const restPrice = clamp(
          side === "bid" ? bestBid + ticks * 10_000 : bestAsk - ticks * 10_000,
          MIN_PRICE, MAX_PRICE,
        );
        // Don't cross the book with the resting order
        if (side === "bid" && restPrice >= bestAsk) return;
        if (side === "ask" && restPrice <= bestBid) return;

        if (postBook.bids.length >= MAX_PER_SIDE - 1 && side === "bid") return;
        if (postBook.asks.length >= MAX_PER_SIDE - 1 && side === "ask") return;

        await program.methods
          .placeOrder(
            side === "bid" ? { bid: {} } : { ask: {} },
            new BN(restPrice),
            new BN(restQty),
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
        console.log(`[${mkt.ticker}] + ${side} ${restQty} @ $${(restPrice / USDC_PER_PAIR).toFixed(2)} (remainder)  [${txCount}]`);
      }
    }
  }

  let replenishCounter = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Refresh stock prices periodically
    if (Date.now() - lastPriceRefresh > PRICE_REFRESH_MS) {
      stockPrices = await fetchStockPrices();
      lastPriceRefresh = Date.now();
    }

    // Check USDC balance every 50 ticks
    if (++replenishCounter % 50 === 0) {
      await checkReplenish();
    }

    // Pick 1-2 markets uniformly at random
    const markets = [...cache.markets.values()];
    if (markets.length === 0) {
      console.log("[done] All markets settled. Exiting gracefully.");
      process.exit(0);
    }
    const batch = randInt(1, Math.min(2, markets.length));
    const selected = [...markets].sort(() => Math.random() - 0.5).slice(0, batch);

    for (const mkt of selected) {
      try {
        await tradeOnMarket(mkt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const transient = ["0x1", "0x0", "blockhash", "OrderBookFull", "NotOrderOwner", "debit", "CrossingOrdersUseDedicatedPath", "NoMatchingOrders"];
        if (msg.includes("AtomicTradeIncomplete")) {
          console.log(`  [fill-miss] ${msg.slice(0, 120)}`);
        } else if (!transient.some((t) => msg.includes(t))) {
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
