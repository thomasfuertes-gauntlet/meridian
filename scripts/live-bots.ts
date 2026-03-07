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
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { getDevWallet } from "./dev-wallets";
import { fairValue, fetchStockPrices } from "./fair-value";

const USDC_PER_PAIR = 1_000_000;
const MIN_PRICE = 50_000;   // $0.05 floor
const MAX_PRICE = 950_000;  // $0.95 ceiling
const MIN_ORDERS_PER_SIDE = 3;
const MAX_PER_SIDE = 32;
const TICK_MS_MIN = 150;
const TICK_MS_MAX = 400;
const PRICE_REFRESH_MS = 30_000;
const REPLENISH_THRESHOLD = 500 * USDC_PER_PAIR; // auto-replenish below 500 USDC

// --- Order book parsing ---
const DISC = 8;
const HEADER = 112;
const ORDER_SZ = 72;

interface Order {
  owner: PublicKey;
  price: number;
  quantity: number;
  orderId: number;
  isActive: boolean;
}

interface Book {
  bidCount: number;
  askCount: number;
  bids: Order[];
  asks: Order[];
}

function parseBook(data: Buffer): Book {
  const base = DISC;
  const bidCount = data.readUInt16LE(base + 104);
  const askCount = data.readUInt16LE(base + 106);
  const bidsOff = base + HEADER;
  const asksOff = bidsOff + MAX_PER_SIDE * ORDER_SZ;

  const readOrder = (off: number): Order => ({
    owner: new PublicKey(data.subarray(off, off + 32)),
    price: Number(data.readBigUInt64LE(off + 32)),
    quantity: Number(data.readBigUInt64LE(off + 40)),
    orderId: Number(data.readBigUInt64LE(off + 56)),
    isActive: data[off + 64] === 1,
  });

  const bids: Order[] = [];
  for (let i = 0; i < MAX_PER_SIDE; i++) {
    const o = readOrder(bidsOff + i * ORDER_SZ);
    if (o.isActive) bids.push(o);
  }
  const asks: Order[] = [];
  for (let i = 0; i < MAX_PER_SIDE; i++) {
    const o = readOrder(asksOff + i * ORDER_SZ);
    if (o.isActive) asks.push(o);
  }
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  return { bidCount, askCount, bids, asks };
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface MarketCtx {
  pubkey: PublicKey;
  ticker: string;
  strikePrice: number; // USDC base units
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  orderBook: PublicKey;
  obUsdcVault: PublicKey;
  obYesVault: PublicKey;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;

  // Load USDC mint from env var or local-config.json
  let usdcMintStr = process.env.USDC_MINT;
  if (!usdcMintStr) {
    const configPath = path.join(__dirname, "../app/src/lib/local-config.json");
    if (!fs.existsSync(configPath)) {
      console.error("USDC mint not found. Set USDC_MINT env var or run `make setup`.");
      process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    usdcMintStr = config.usdcMint;
  }
  const usdcMint = new PublicKey(usdcMintStr!);
  const bot = getDevWallet("bot-a");
  const admin = getDevWallet("admin");
  const botUsdcAta = getAssociatedTokenAddressSync(usdcMint, bot.publicKey);

  console.log("Bot:", bot.publicKey.toString());
  console.log("USDC Mint:", usdcMint.toString());

  // Discover markets
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();
  const markets: MarketCtx[] = allMarkets
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((m: any) => m.account.outcome?.pending !== undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((m: any) => {
      const pk: PublicKey = m.publicKey;
      const pid = program.programId;
      return {
        pubkey: pk,
        ticker: m.account.ticker as string,
        strikePrice: m.account.strikePrice.toNumber(),
        yesMint: PublicKey.findProgramAddressSync([Buffer.from("yes_mint"), pk.toBuffer()], pid)[0],
        noMint: PublicKey.findProgramAddressSync([Buffer.from("no_mint"), pk.toBuffer()], pid)[0],
        vault: PublicKey.findProgramAddressSync([Buffer.from("vault"), pk.toBuffer()], pid)[0],
        orderBook: PublicKey.findProgramAddressSync([Buffer.from("orderbook"), pk.toBuffer()], pid)[0],
        obUsdcVault: PublicKey.findProgramAddressSync([Buffer.from("ob_usdc_vault"), pk.toBuffer()], pid)[0],
        obYesVault: PublicKey.findProgramAddressSync([Buffer.from("ob_yes_vault"), pk.toBuffer()], pid)[0],
      };
    });

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
    // fetchStockPrices() now always returns all tickers (synthetic fallback)
    return stockPrice ? fairValue(stockPrice, strikeDollars) : 0.50;
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
        .cancelOrder(new anchor.BN(order.orderId))
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

      await program.methods
        .placeOrder(
          side === "bid" ? { bid: {} } : { ask: {} },
          new anchor.BN(safePrice),
          new anchor.BN(order.quantity),
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

      txCount += 2;
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
      const tx = new anchor.web3.Transaction();
      for (let i = 0; i < qty; i++) {
        const ix = await program.methods
          .mintPair()
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
          .instruction();
        tx.add(ix);
      }
      await anchor.web3.sendAndConfirmTransaction(connection, tx, [bot]);

      await program.methods
        .placeOrder(
          side === "bid" ? { bid: {} } : { ask: {} },
          new anchor.BN(price),
          new anchor.BN(qty),
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

      txCount += 2;
      console.log(`[${mkt.ticker}] + ${side} ${qty} @ $${(price / USDC_PER_PAIR).toFixed(2)}  [${txCount}]`);

    } else if (book.bids.length > MIN_ORDERS_PER_SIDE && book.asks.length > MIN_ORDERS_PER_SIDE) {
      // 20% - Cross the spread with qty 1 (visible fill)
      await program.methods
        .mintPair()
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

      const side = Math.random() < 0.5 ? "bid" : "ask";

      if (side === "bid") {
        const hitPrice = book.asks[0].price;
        await program.methods
          .placeOrder({ bid: {} }, new anchor.BN(hitPrice), new anchor.BN(1))
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

        txCount += 2;
        console.log(`[${mkt.ticker}] * BUY 1 @ $${(hitPrice / USDC_PER_PAIR).toFixed(2)}  [${txCount}]`);
      } else {
        const hitPrice = book.bids[0].price;
        await program.methods
          .placeOrder({ ask: {} }, new anchor.BN(hitPrice), new anchor.BN(1))
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

        txCount += 2;
        console.log(`[${mkt.ticker}] * SELL 1 @ $${(hitPrice / USDC_PER_PAIR).toFixed(2)}  [${txCount}]`);
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

    // Pick 2-4 random markets to trade on this tick (parallel)
    const batch = randInt(2, Math.min(4, markets.length));
    const shuffled = [...markets].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, batch);

    const results = await Promise.allSettled(
      selected.map((mkt) => tradeOnMarket(mkt))
    );

    for (const r of results) {
      if (r.status === "rejected") {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        const transient = ["0x1", "0x0", "blockhash", "OrderBookFull", "NotOrderOwner", "debit"];
        if (!transient.some((t) => msg.includes(t))) {
          console.log(`  [err] ${msg.slice(0, 120)}`);
        }
      }
    }

    await sleep(randInt(TICK_MS_MIN, TICK_MS_MAX));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
