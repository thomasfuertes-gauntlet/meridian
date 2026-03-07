/**
 * Live trading bot - creates visible order book movement.
 * Runs continuously at rand(250ms, 750ms). Safe: never drains books below 3/side.
 *
 * Actions (weighted random):
 *   55% - Cancel a random order and replace at +/-$0.01 (small jitter)
 *   25% - Place a new resting order near the spread (qty 1)
 *   15% - Cross the spread with qty 1 (creates fills/movement)
 *    5% - Do nothing (natural pause)
 *
 * Run after `make bots`. Uses saved bot keypair from local-config.json.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { getDevWallet } from "./dev-wallets";

const USDC_PER_PAIR = 1_000_000;
const MIN_PRICE = 50_000;   // $0.05 floor
const MAX_PRICE = 950_000;  // $0.95 ceiling
const MIN_ORDERS_PER_SIDE = 3; // never drain below this
const MAX_PER_SIDE = 32;

// --- Order book parsing (mirrors app/src/lib/orderbook.ts) ---
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

// --- Helpers ---
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

// --- Market info ---
interface MarketCtx {
  pubkey: PublicKey;
  ticker: string;
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

  const configPath = path.join(__dirname, "../app/src/lib/local-config.json");
  if (!fs.existsSync(configPath)) {
    console.error("local-config.json not found. Run `make setup` first.");
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  const usdcMint = new PublicKey(config.usdcMint);
  const bot = getDevWallet("bot-a");
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
        yesMint: PublicKey.findProgramAddressSync([Buffer.from("yes_mint"), pk.toBuffer()], pid)[0],
        noMint: PublicKey.findProgramAddressSync([Buffer.from("no_mint"), pk.toBuffer()], pid)[0],
        vault: PublicKey.findProgramAddressSync([Buffer.from("vault"), pk.toBuffer()], pid)[0],
        orderBook: PublicKey.findProgramAddressSync([Buffer.from("orderbook"), pk.toBuffer()], pid)[0],
        obUsdcVault: PublicKey.findProgramAddressSync([Buffer.from("ob_usdc_vault"), pk.toBuffer()], pid)[0],
        obYesVault: PublicKey.findProgramAddressSync([Buffer.from("ob_yes_vault"), pk.toBuffer()], pid)[0],
      };
    });

  console.log(`Found ${markets.length} active markets`);
  console.log("Starting live trading loop (Ctrl+C to stop)\n");

  let txCount = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const mkt = pick(markets);
      const botYesAta = getAssociatedTokenAddressSync(mkt.yesMint, bot.publicKey);

      // Read current order book
      const obInfo = await connection.getAccountInfo(mkt.orderBook);
      if (!obInfo) { await sleep(randInt(250, 750)); continue; }
      const book = parseBook(obInfo.data as Buffer);

      const botBids = book.bids.filter((o) => o.owner.equals(bot.publicKey));
      const botAsks = book.asks.filter((o) => o.owner.equals(bot.publicKey));

      const roll = Math.random();

      if (roll < 0.05) {
        // 5% - do nothing (natural breathing room)
        await sleep(randInt(250, 750));
        continue;
      }

      if (roll < 0.60 && (botBids.length > MIN_ORDERS_PER_SIDE || botAsks.length > MIN_ORDERS_PER_SIDE)) {
        // 55% - Cancel + replace at +/-$0.01 (small tick jitter)
        const side = botBids.length > MIN_ORDERS_PER_SIDE && (Math.random() < 0.5 || botAsks.length <= MIN_ORDERS_PER_SIDE)
          ? "bid" : "ask";
        const orders = side === "bid" ? botBids : botAsks;
        if (orders.length <= MIN_ORDERS_PER_SIDE) { await sleep(randInt(250, 750)); continue; }

        const order = pick(orders);
        // Small $0.01 ticks - coin flip direction
        const drift = (Math.random() < 0.5 ? 1 : -1) * 10_000;
        const newPrice = clamp(order.price + drift, MIN_PRICE, MAX_PRICE);

        // Ensure bids stay below asks
        const bestAsk = book.asks[0]?.price ?? MAX_PRICE;
        const bestBid = book.bids[0]?.price ?? MIN_PRICE;
        const safePrice = side === "bid"
          ? Math.min(newPrice, bestAsk - 10_000)
          : Math.max(newPrice, bestBid + 10_000);

        if (safePrice <= MIN_PRICE || safePrice >= MAX_PRICE) { await sleep(randInt(250, 750)); continue; }

        // Cancel
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

        // Replace at new price, same qty
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

      } else if (roll < 0.85) {
        // 25% - Place a new resting order near the spread (qty 1)
        const bestBid = book.bids[0]?.price ?? 400_000;
        const bestAsk = book.asks[0]?.price ?? 600_000;
        const mid = Math.floor((bestBid + bestAsk) / 2);
        const side = Math.random() < 0.5 ? "bid" : "ask";

        // Don't overflow the book
        if (side === "bid" && book.bids.length >= MAX_PER_SIDE - 1) { await sleep(randInt(250, 750)); continue; }
        if (side === "ask" && book.asks.length >= MAX_PER_SIDE - 1) { await sleep(randInt(250, 750)); continue; }

        const offset = randInt(10_000, 50_000);
        const price = clamp(
          side === "bid" ? mid - offset : mid + offset,
          MIN_PRICE, MAX_PRICE,
        );
        if (side === "bid" && price >= bestAsk) { await sleep(randInt(250, 750)); continue; }
        if (side === "ask" && price <= bestBid) { await sleep(randInt(250, 750)); continue; }

        // Mint 1 pair for token supply
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

        await program.methods
          .placeOrder(
            side === "bid" ? { bid: {} } : { ask: {} },
            new anchor.BN(price),
            new anchor.BN(1),
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
        console.log(`[${mkt.ticker}] + ${side} 1 @ $${(price / USDC_PER_PAIR).toFixed(2)}  [${txCount}]`);

      } else if (book.bids.length > MIN_ORDERS_PER_SIDE && book.asks.length > MIN_ORDERS_PER_SIDE) {
        // 15% - Cross the spread with qty 1 (visible fill)
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
          console.log(`[${mkt.ticker}] ★ BUY 1 @ $${(hitPrice / USDC_PER_PAIR).toFixed(2)}  [${txCount}]`);
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
          console.log(`[${mkt.ticker}] ★ SELL 1 @ $${(hitPrice / USDC_PER_PAIR).toFixed(2)}  [${txCount}]`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient = ["0x1", "0x0", "blockhash", "OrderBookFull", "NotOrderOwner"];
      if (!transient.some((t) => msg.includes(t))) {
        console.log(`  [err] ${msg.slice(0, 120)}`);
      }
    }

    await sleep(randInt(250, 750));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
