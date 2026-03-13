/**
 * Multi-strategy directional trading bots.
 * All strategies share the bot-b wallet (frontend dev wallet) so trades
 * appear in the Portfolio page. bot-c/d/e/f are strategy labels, not wallets.
 * Taker-only: crosses bot-a's spread to generate fills and visible P&L.
 *
 * Strategies:
 *   bot-c: Momentum sniper (velocity-based, 5+ samples)
 *   bot-d: Bollinger mean reversion (2-sigma bands, 20 samples)
 *   bot-e: Correlation arbitrage (lead/follower pairs)
 *   bot-f: Time decay exploiter (last 30 min, deep OTM/ITM)
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
import { fetchStockPrices } from "./fair-value";
import { MarketCtx, loadUsdcMint, sleep, USDC_PER_PAIR, getActiveMarket, getBotTickerFilter, defaultTxDelay, discoverMarkets, type Order } from "./bot-utils";
import { loadSharedBooks } from "./ws-cache";

const TICK_MS = 45_000;
const TX_DELAY_MS = defaultTxDelay();
const MAX_TRADES_PER_TICK = 2;
const COOLDOWN_TICKS = 5;

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
  // Full sorted book sides (self-trade filtered) for multi-fill remaining_accounts
  otherBids: Order[];
  otherAsks: Order[];
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
  signal(market, history, allHistories) {
    if (market.bestBid === null || market.bestAsk === null) return null;
    if (history.prices.length < 5) return null;

    // Check if this market's ticker is a follower of any leader
    for (const [leader, followers] of Object.entries(CORRELATION_PAIRS)) {
      if (!followers.includes(market.ticker)) continue;

      const leaderHist = allHistories.get(leader);
      if (!leaderHist || leaderHist.prices.length < 5) continue;

      // Leader move over last 5 samples
      const leaderStart = leaderHist.prices[leaderHist.prices.length - 5];
      const leaderNow = leaderHist.prices[leaderHist.prices.length - 1];
      const leaderMove = (leaderNow - leaderStart) / leaderStart;

      if (Math.abs(leaderMove) < 0.01) continue; // need >1% leader move

      // Follower move (history is this market's ticker)
      const followerStart = history.prices[history.prices.length - 5];
      const followerNow = history.prices[history.prices.length - 1];
      const followerMove = (followerNow - followerStart) / followerStart;

      // Follower lags if it moved < 30% of leader's move
      if (Math.abs(followerMove) > Math.abs(leaderMove) * 0.3) continue;

      const stockPrice = history.prices[history.prices.length - 1];
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

  const usdcMint = loadUsdcMint();

  // Strategy bots use bot-b (frontend dev wallet) so trades appear in Portfolio
  const bot = getDevWallet("bot-b");
  const admin = getDevWallet("admin");
  const botUsdcAta = getAssociatedTokenAddressSync(usdcMint, bot.publicKey);

  console.log("Strategy Bots (bot-c/d/e/f) using wallet:", bot.publicKey.toString());
  console.log("USDC Mint:", usdcMint.toString());
  const demoTicker = getBotTickerFilter();
  if (demoTicker) {
    console.log("Demo ticker focus:", demoTicker);
  }

  // Discover markets via RPC (one-time). Book state comes from shared tmpfile
  // written by live-bots' ws-cache (no WS subs in this process).
  const discoveredMarkets = await discoverMarkets(program);
  const marketsByKey = new Map(discoveredMarkets.map((m) => [m.pubkey.toBase58(), m]));

  console.log(`Found ${marketsByKey.size} active markets`);
  if (marketsByKey.size === 0) {
    console.log("No active markets. Exiting.");
    process.exit(0);
  }

  // Ensure ATAs exist for all markets
  const atasInitialized = new Set<string>();
  async function ensureAtas(mkt: MarketCtx) {
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
  for (const mkt of marketsByKey.values()) {
    try {
      await ensureAtas(mkt);
      await sleep(TX_DELAY_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [warn] ATA init failed for ${mkt.ticker}: ${msg.slice(0, 120)}`);
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

  const REPLENISH_THRESHOLD = 2_000 * USDC_PER_PAIR;
  const REPLENISH_AMOUNT = 10_000 * USDC_PER_PAIR;

  async function checkReplenish() {
    try {
      const info = await connection.getTokenAccountBalance(botUsdcAta);
      const balance = Number(info.value.amount);
      if (balance < REPLENISH_THRESHOLD) {
        await mintTo(connection, admin, usdcMint, botUsdcAta, admin, REPLENISH_AMOUNT);
        console.log(`  [replenish] Minted ${(REPLENISH_AMOUNT / USDC_PER_PAIR).toLocaleString()} USDC to bot-b`);
      }
      // SOL check: airdrop on localhost if low (devnet faucets rate-limit, skip there)
      const solBal = await connection.getBalance(bot.publicKey);
      if (solBal < 1_000_000_000) { // < 1 SOL
        const rpc = connection.rpcEndpoint;
        if (rpc.includes("localhost") || rpc.includes("127.0.0.1")) {
          const sig = await connection.requestAirdrop(bot.publicKey, 2_000_000_000);
          await connection.confirmTransaction(sig);
          console.log("  [replenish] Airdropped 2 SOL to bot-b");
        } else {
          console.warn("  [replenish] bot-b SOL low (<1), fund manually on devnet");
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [replenish] FAILED: ${msg.slice(0, 150)}`);
    }
  }

  // Execute a trade signal
  async function executeTrade(signal: TradeSignal, stratName: string): Promise<boolean> {
    const mkt = signal.market;
    const botYesAta = getAssociatedTokenAddressSync(mkt.yesMint, bot.publicKey);

    if (signal.direction === "yes") {
      // Buy Yes taker flow: crosses resting asks on the book.
      if (mkt.bestAsk === null || mkt.askOwner === null) return false;
      // Self-trade guard
      if (mkt.askOwner.equals(bot.publicKey)) return false;

      await program.methods
        .buyYes(new BN(signal.qty), new BN(mkt.bestAsk))
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

      console.log(`  [${stratName}] BUY YES ${mkt.ticker}>$${mkt.strikeDollars} @ $${(mkt.bestAsk / USDC_PER_PAIR).toFixed(2)} x${signal.qty} (${signal.reason})`);
      return true;

    } else {
      // Buy No: mint_pair + sell_yes sent atomically in one transaction.
      // If mintPair succeeds but sellYes fails separately, bot holds stranded tokens.
      if (mkt.bestBid === null || mkt.bidOwner === null) return false;
      // Self-trade guard
      if (mkt.bidOwner.equals(bot.publicKey)) return false;

      const botNoAta = getAssociatedTokenAddressSync(mkt.noMint, bot.publicKey);

      const mintIx = await program.methods
        .mintPair(new BN(signal.qty))
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

      const sellIx = await program.methods
        .sellYes(new BN(signal.qty), new BN(mkt.bestBid))
        .accountsPartial({
          user: bot.publicKey,
          market: mkt.pubkey,
          orderBook: mkt.orderBook,
          obUsdcVault: mkt.obUsdcVault,
          obYesVault: mkt.obYesVault,
          userUsdc: botUsdcAta,
          userYes: botYesAta,
        })
        .instruction();

      const tx = new anchor.web3.Transaction().add(mintIx, sellIx);
      await anchor.web3.sendAndConfirmTransaction(connection, tx, [bot]);

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

    // Build MarketInfo using shared book state from live-bots ws-cache
    const sharedBooks = loadSharedBooks();
    const marketInfos: MarketInfo[] = [];
    const currentMarkets = [...marketsByKey.values()];
    if (currentMarkets.length === 0) {
      console.log("[done] All markets settled. Exiting.");
      process.exit(0);
    }
    for (const mkt of currentMarkets) {
      const book = sharedBooks.get(mkt.orderBook.toBase58());
      if (!book) continue;

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
        otherBids,
        otherAsks,
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

    // Collect signals from all strategies, prioritizing active market signal
    const activeMarket = getActiveMarket();
    const activeTicker = activeMarket?.ticker ?? null;
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

    // Sort active ticker signals first
    if (activeTicker) {
      signals.sort((a, b) => {
        const aActive = a.signal.market.ticker === activeTicker ? 0 : 1;
        const bActive = b.signal.market.ticker === activeTicker ? 0 : 1;
        return aActive - bActive;
      });
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
        // Match on Anchor error names/full hex codes, not broad substrings
        const transient = ["blockhash", "OrderBookFull", "NotOrderOwner", "NoMatchingOrders", "OrderNotFound", "CrossingOrdersUseDedicatedPath"];
        if (transient.some((t) => msg.includes(t))) {
          // Expected during normal operation - suppress
        } else if (msg.includes("insufficient") || msg.includes("debit")) {
          console.warn(`  [${stratName}] resource: ${msg.slice(0, 120)}`);
        } else {
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
