/**
 * Multi-strategy directional trading bots (bot-c through bot-f).
 * Uses bot-b wallet (the frontend dev wallet) so trades show in Portfolio.
 * Taker-only: crosses bot-a's spread to generate fills and visible P&L.
 *
 * Strategies:
 *   bot-c: Momentum sniper (velocity-based, 5+ samples)
 *   bot-d: Bollinger mean reversion (2-sigma bands, 20 samples)
 *   bot-e: Correlation arbitrage (lead/follower pairs)
 *   bot-f: Time decay exploiter (last 30 min, deep OTM/ITM)
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
import { fetchStockPrices } from "./fair-value";

const USDC_PER_PAIR = 1_000_000;
const TICK_MS = 45_000;
const TX_DELAY_MS = Number(process.env.TX_DELAY_MS ?? 1200);
const MAX_TRADES_PER_TICK = 2;
const COOLDOWN_TICKS = 5;
const REPLENISH_THRESHOLD = 500 * USDC_PER_PAIR;
const MAX_PER_SIDE = 32;

// --- Order book parsing (inlined from live-bots) ---
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

function parseBook(data: Buffer) {
  const base = DISC;
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
  return { bids, asks };
}

// --- Types ---

interface MarketInfo {
  pubkey: PublicKey;
  ticker: string;
  strikeDollars: number;
  hoursUntilClose: number;
  bestBid: number | null;
  bestAsk: number | null;
  bidOwner: PublicKey | null;
  askOwner: PublicKey | null;
  // Internal refs for TX building
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  orderBook: PublicKey;
  obUsdcVault: PublicKey;
  obYesVault: PublicKey;
  closeTime: number;
}

interface PriceHistory {
  prices: number[];
  velocity: number;
}

interface TradeSignal {
  market: MarketInfo;
  direction: "yes" | "no";
  qty: number;
  reason: string;
}

interface BotStrategy {
  name: string;
  signal(market: MarketInfo, history: PriceHistory, allHistories: Map<string, PriceHistory>): TradeSignal | null;
}

// --- Strategies ---

const momentumSniper: BotStrategy = {
  name: "bot-c",
  signal(market, history) {
    if (history.prices.length < 5) return null;
    if (market.bestBid === null || market.bestAsk === null) return null;
    const stockPrice = history.prices[history.prices.length - 1];

    if (history.velocity > 0.5 && market.strikeDollars < stockPrice) {
      return { market, direction: "yes", qty: Math.min(3, Math.ceil(Math.abs(history.velocity))), reason: `momentum up, v=+${history.velocity.toFixed(1)}%` };
    }
    if (history.velocity < -0.5 && market.strikeDollars > stockPrice) {
      return { market, direction: "no", qty: Math.min(3, Math.ceil(Math.abs(history.velocity))), reason: `momentum down, v=${history.velocity.toFixed(1)}%` };
    }
    return null;
  },
};

const bollingerReversion: BotStrategy = {
  name: "bot-d",
  signal(market, history) {
    if (history.prices.length < 20) return null;
    if (market.bestBid === null || market.bestAsk === null) return null;
    const stockPrice = history.prices[history.prices.length - 1];

    // Only strikes within 5% of current price
    if (Math.abs(market.strikeDollars - stockPrice) / stockPrice > 0.05) return null;

    const mean = history.prices.reduce((a, b) => a + b, 0) / history.prices.length;
    const variance = history.prices.reduce((a, p) => a + (p - mean) ** 2, 0) / history.prices.length;
    const std = Math.sqrt(variance);
    if (std === 0) return null;

    const upper = mean + 2 * std;
    const lower = mean - 2 * std;

    if (stockPrice >= upper) {
      return { market, direction: "no", qty: 2, reason: `Bollinger upper band (${stockPrice.toFixed(1)} >= ${upper.toFixed(1)})` };
    }
    if (stockPrice <= lower) {
      return { market, direction: "yes", qty: 2, reason: `Bollinger lower band (${stockPrice.toFixed(1)} <= ${lower.toFixed(1)})` };
    }
    return null;
  },
};

const CORRELATION_PAIRS: Record<string, string[]> = {
  NVDA: ["MSFT", "GOOGL"],
  META: ["GOOGL"],
  TSLA: ["NVDA"],
};

const correlationArbitrage: BotStrategy = {
  name: "bot-e",
  signal(market, _history, allHistories) {
    if (market.bestBid === null || market.bestAsk === null) return null;

    // Check if this market's ticker is a follower of any leader
    for (const [leader, followers] of Object.entries(CORRELATION_PAIRS)) {
      if (!followers.includes(market.ticker)) continue;

      const leaderHist = allHistories.get(leader);
      if (!leaderHist || leaderHist.prices.length < 5) continue;

      const followerHist = allHistories.get(market.ticker);
      if (!followerHist || followerHist.prices.length < 5) continue;

      // Leader move over last 5 samples
      const leaderStart = leaderHist.prices[leaderHist.prices.length - 5];
      const leaderNow = leaderHist.prices[leaderHist.prices.length - 1];
      const leaderMove = (leaderNow - leaderStart) / leaderStart;

      if (Math.abs(leaderMove) < 0.01) continue; // need >1% leader move

      // Follower move
      const followerStart = followerHist.prices[followerHist.prices.length - 5];
      const followerNow = followerHist.prices[followerHist.prices.length - 1];
      const followerMove = (followerNow - followerStart) / followerStart;

      // Follower lags if it moved < 30% of leader's move
      if (Math.abs(followerMove) > Math.abs(leaderMove) * 0.3) continue;

      const stockPrice = followerHist.prices[followerHist.prices.length - 1];
      if (leaderMove > 0 && market.strikeDollars < stockPrice) {
        return { market, direction: "yes", qty: 2, reason: `${leader} up ${(leaderMove * 100).toFixed(1)}%, ${market.ticker} lagging` };
      }
      if (leaderMove < 0 && market.strikeDollars > stockPrice) {
        return { market, direction: "no", qty: 2, reason: `${leader} down ${(leaderMove * 100).toFixed(1)}%, ${market.ticker} lagging` };
      }
    }
    return null;
  },
};

const timeDecayExploiter: BotStrategy = {
  name: "bot-f",
  signal(market, history) {
    if (market.hoursUntilClose > 0.5) return null; // last 30 min only
    if (market.bestBid === null || market.bestAsk === null) return null;
    const stockPrice = history.prices[history.prices.length - 1];
    if (!stockPrice) return null;

    const otmPct = (market.strikeDollars - stockPrice) / stockPrice;

    // Deep OTM (strike >6% above price): buy No if bid > $0.15
    if (otmPct > 0.06 && market.bestBid > 150_000) {
      return { market, direction: "no", qty: 3, reason: `time decay OTM ${(otmPct * 100).toFixed(1)}%, bid=$${(market.bestBid / USDC_PER_PAIR).toFixed(2)}` };
    }

    // Deep ITM (strike >6% below price): buy Yes if ask < $0.85
    if (otmPct < -0.06 && market.bestAsk < 850_000) {
      return { market, direction: "yes", qty: 3, reason: `time decay ITM ${(-otmPct * 100).toFixed(1)}%, ask=$${(market.bestAsk / USDC_PER_PAIR).toFixed(2)}` };
    }
    return null;
  },
};

const STRATEGIES: BotStrategy[] = [momentumSniper, bollingerReversion, correlationArbitrage, timeDecayExploiter];

// --- Helpers ---

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function computeVelocity(prices: number[]): number {
  if (prices.length < 5) return 0;
  const recent = prices.slice(-5);
  return ((recent[recent.length - 1] - recent[0]) / recent[0]) * 100;
}

// --- Main ---

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;

  // Load USDC mint
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

  // Strategy bots use bot-b (frontend dev wallet) so trades appear in Portfolio
  const bot = getDevWallet("bot-b");
  const admin = getDevWallet("admin");
  const botUsdcAta = getAssociatedTokenAddressSync(usdcMint, bot.publicKey);

  console.log("Strategy Bots (bot-c/d/e/f) using wallet:", bot.publicKey.toString());
  console.log("USDC Mint:", usdcMint.toString());

  // Discover active markets
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();
  const pid = program.programId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const marketAccounts = allMarkets.filter((m: any) => m.account.outcome?.pending !== undefined);

  interface MarketAccount {
    pubkey: PublicKey;
    ticker: string;
    strikePrice: number;
    closeTime: number;
    yesMint: PublicKey;
    noMint: PublicKey;
    vault: PublicKey;
    orderBook: PublicKey;
    obUsdcVault: PublicKey;
    obYesVault: PublicKey;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markets: MarketAccount[] = marketAccounts.map((m: any) => {
    const pk: PublicKey = m.publicKey;
    return {
      pubkey: pk,
      ticker: m.account.ticker as string,
      strikePrice: m.account.strikePrice.toNumber(),
      closeTime: m.account.closeTime.toNumber(),
      yesMint: PublicKey.findProgramAddressSync([Buffer.from("yes_mint"), pk.toBuffer()], pid)[0],
      noMint: PublicKey.findProgramAddressSync([Buffer.from("no_mint"), pk.toBuffer()], pid)[0],
      vault: PublicKey.findProgramAddressSync([Buffer.from("vault"), pk.toBuffer()], pid)[0],
      orderBook: PublicKey.findProgramAddressSync([Buffer.from("orderbook"), pk.toBuffer()], pid)[0],
      obUsdcVault: PublicKey.findProgramAddressSync([Buffer.from("ob_usdc_vault"), pk.toBuffer()], pid)[0],
      obYesVault: PublicKey.findProgramAddressSync([Buffer.from("ob_yes_vault"), pk.toBuffer()], pid)[0],
    };
  });

  console.log(`Found ${markets.length} active markets`);
  if (markets.length === 0) {
    console.log("No active markets. Exiting.");
    process.exit(0);
  }

  // Ensure ATAs exist for all markets
  const atasInitialized = new Set<string>();
  async function ensureAtas(mkt: MarketAccount) {
    const key = mkt.pubkey.toString();
    if (atasInitialized.has(key)) return;
    const botYesAta = getAssociatedTokenAddressSync(mkt.yesMint, bot.publicKey);
    const botNoAta = getAssociatedTokenAddressSync(mkt.noMint, bot.publicKey);
    const tx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(bot.publicKey, botYesAta, bot.publicKey, mkt.yesMint),
      createAssociatedTokenAccountIdempotentInstruction(bot.publicKey, botNoAta, bot.publicKey, mkt.noMint),
    );
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [bot]);
    atasInitialized.add(key);
  }

  // Initialize ATAs for all markets upfront
  console.log("Initializing token accounts...");
  for (const mkt of markets) {
    try {
      await ensureAtas(mkt);
      await sleep(TX_DELAY_MS);
    } catch {
      // May already exist
    }
  }

  // Price history per ticker
  const priceHistories = new Map<string, number[]>();
  let stockPrices = await fetchStockPrices();
  let lastPriceRefresh = Date.now();

  // Cooldown tracking: market pubkey -> ticks remaining
  const cooldowns = new Map<string, number>();

  let tickCount = 0;

  const priceStrs: string[] = [];
  stockPrices.forEach((p, t) => priceStrs.push(`${t}=$${p.toFixed(0)}`));
  console.log("Stock prices loaded:", priceStrs.length > 0 ? priceStrs.join(", ") : "(none)");
  console.log("Starting strategy loop (Ctrl+C to stop)\n");

  async function checkReplenish() {
    try {
      const info = await connection.getTokenAccountBalance(botUsdcAta);
      const balance = Number(info.value.amount);
      if (balance < REPLENISH_THRESHOLD) {
        await mintTo(connection, admin, usdcMint, botUsdcAta, admin, 5_000 * USDC_PER_PAIR);
        console.log("  [replenish] Minted 5,000 USDC to bot-b");
      }
    } catch {
      // ignore
    }
  }

  // Execute a trade signal
  async function executeTrade(signal: TradeSignal, stratName: string): Promise<boolean> {
    const mkt = signal.market;
    const botYesAta = getAssociatedTokenAddressSync(mkt.yesMint, bot.publicKey);

    if (signal.direction === "yes") {
      // Buy Yes: place bid at bestAsk price. Fill delivers Yes tokens.
      if (mkt.bestAsk === null || mkt.askOwner === null) return false;
      // Self-trade guard
      if (mkt.askOwner.equals(bot.publicKey)) return false;

      const counterpartyUsdcAta = getAssociatedTokenAddressSync(usdcMint, mkt.askOwner);
      await program.methods
        .placeOrder({ bid: {} }, new anchor.BN(mkt.bestAsk), new anchor.BN(signal.qty))
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
          { pubkey: counterpartyUsdcAta, isWritable: true, isSigner: false },
        ])
        .signers([bot])
        .rpc();

      console.log(`  [${stratName}] BUY YES ${mkt.ticker}>$${mkt.strikeDollars} @ $${(mkt.bestAsk / USDC_PER_PAIR).toFixed(2)} x${signal.qty} (${signal.reason})`);
      return true;

    } else {
      // Buy No: mint pairs (need Yes tokens as escrow), then place ask at bestBid.
      if (mkt.bestBid === null || mkt.bidOwner === null) return false;
      // Self-trade guard
      if (mkt.bidOwner.equals(bot.publicKey)) return false;

      const botNoAta = getAssociatedTokenAddressSync(mkt.noMint, bot.publicKey);

      // Mint pairs first
      const mintTx = new anchor.web3.Transaction();
      for (let i = 0; i < signal.qty; i++) {
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
            userNo: botNoAta,
          })
          .instruction();
        mintTx.add(ix);
      }
      await anchor.web3.sendAndConfirmTransaction(connection, mintTx, [bot]);
      await sleep(TX_DELAY_MS);

      // Place ask at bestBid to fill immediately
      const counterpartyYesAta = getAssociatedTokenAddressSync(mkt.yesMint, mkt.bidOwner);
      await program.methods
        .placeOrder({ ask: {} }, new anchor.BN(mkt.bestBid), new anchor.BN(signal.qty))
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
          { pubkey: counterpartyYesAta, isWritable: true, isSigner: false },
        ])
        .signers([bot])
        .rpc();

      console.log(`  [${stratName}] BUY NO  ${mkt.ticker}>$${mkt.strikeDollars} @ $${((USDC_PER_PAIR - mkt.bestBid) / USDC_PER_PAIR).toFixed(2)} x${signal.qty} (${signal.reason})`);
      return true;
    }
  }

  // Main loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    tickCount++;

    // Refresh stock prices every 30s
    if (Date.now() - lastPriceRefresh > 30_000) {
      stockPrices = await fetchStockPrices();
      lastPriceRefresh = Date.now();
    }

    // Update price history
    for (const [ticker, price] of stockPrices) {
      let hist = priceHistories.get(ticker);
      if (!hist) {
        hist = [];
        priceHistories.set(ticker, hist);
      }
      hist.push(price);
      if (hist.length > 20) hist.shift();
    }

    // Batch-read all order books in one RPC call
    const obKeys = markets.map((m) => m.orderBook);
    let obInfos: (anchor.web3.AccountInfo<Buffer> | null)[];
    try {
      obInfos = await connection.getMultipleAccountsInfo(obKeys);
    } catch {
      console.log("  [err] Failed to fetch order books, skipping tick");
      await sleep(TICK_MS);
      continue;
    }

    // Build MarketInfo for each market
    const marketInfos: MarketInfo[] = [];
    for (let i = 0; i < markets.length; i++) {
      const mkt = markets[i];
      const obData = obInfos[i];
      if (!obData) continue;

      const book = parseBook(obData.data as Buffer);

      // Filter out bot-b's own orders (self-trade guard)
      const otherBids = book.bids.filter((o) => !o.owner.equals(bot.publicKey));
      const otherAsks = book.asks.filter((o) => !o.owner.equals(bot.publicKey));

      marketInfos.push({
        pubkey: mkt.pubkey,
        ticker: mkt.ticker,
        strikeDollars: mkt.strikePrice / USDC_PER_PAIR,
        hoursUntilClose: (mkt.closeTime - Date.now() / 1000) / 3600,
        bestBid: otherBids[0]?.price ?? null,
        bestAsk: otherAsks[0]?.price ?? null,
        bidOwner: otherBids[0]?.owner ?? null,
        askOwner: otherAsks[0]?.owner ?? null,
        yesMint: mkt.yesMint,
        noMint: mkt.noMint,
        vault: mkt.vault,
        orderBook: mkt.orderBook,
        obUsdcVault: mkt.obUsdcVault,
        obYesVault: mkt.obYesVault,
        closeTime: mkt.closeTime,
      });
    }

    // Build PriceHistory map for strategies
    const histMap = new Map<string, PriceHistory>();
    for (const [ticker, prices] of priceHistories) {
      histMap.set(ticker, { prices: [...prices], velocity: computeVelocity(prices) });
    }

    // Decrement cooldowns
    for (const [key, ticks] of cooldowns) {
      if (ticks <= 1) cooldowns.delete(key);
      else cooldowns.set(key, ticks - 1);
    }

    // Collect signals from all strategies
    const signals: { signal: TradeSignal; stratName: string }[] = [];
    for (const strategy of STRATEGIES) {
      for (const mi of marketInfos) {
        // Skip cooled-down markets
        const cdKey = `${strategy.name}:${mi.pubkey.toString()}`;
        if (cooldowns.has(cdKey)) continue;

        const hist = histMap.get(mi.ticker);
        if (!hist) continue;

        const sig = strategy.signal(mi, hist, histMap);
        if (sig) signals.push({ signal: sig, stratName: strategy.name });
      }
    }

    // Execute top signals (max MAX_TRADES_PER_TICK)
    const toExecute = signals.slice(0, MAX_TRADES_PER_TICK);
    for (const { signal, stratName } of toExecute) {
      try {
        const ok = await executeTrade(signal, stratName);
        if (ok) {
          cooldowns.set(`${stratName}:${signal.market.pubkey.toString()}`, COOLDOWN_TICKS);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const transient = ["0x1", "0x0", "blockhash", "OrderBookFull", "NotOrderOwner", "debit", "insufficient"];
        if (!transient.some((t) => msg.includes(t))) {
          console.log(`  [${stratName}] err: ${msg.slice(0, 120)}`);
        }
      }
      await sleep(TX_DELAY_MS);
    }

    // Replenish USDC every 50 ticks
    if (tickCount % 50 === 0) {
      await checkReplenish();
    }

    if (signals.length > 0 && toExecute.length > 0) {
      console.log(`[tick ${tickCount}] ${signals.length} signals, executed ${toExecute.length}`);
    }

    await sleep(TICK_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
