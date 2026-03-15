export function Overview() {
  return (
    <>
      <section>
        <h1>Architecture Overview</h1>
        <p>Binary outcome markets for MAG7 stocks on Solana. One question, two tokens, one dollar.</p>
      </section>

      <section>
        <h2>1. The $1 Invariant</h2>
        <pre style={{ background: "var(--bg-input)", padding: "var(--space-md)", borderRadius: "var(--radius-sm)", overflow: "auto", fontSize: 13, lineHeight: 1.6, fontFamily: "var(--mono)", color: "var(--text-dim)" }}>{`
  "Will NVDA close above $140 today?"

  ┌─────────────────────────────────────────┐
  │  Yes @ $0.65      No @ $0.35            │
  │  ██████████████    ████████             │
  │                                         │
  │  Yes + No = $1.00  ← always             │
  └─────────────────────────────────────────┘

  If NVDA closes >= $140 → Yes pays $1.00, No pays $0
  If NVDA closes <  $140 → No pays $1.00, Yes pays $0
`}</pre>
      </section>

      <section>
        <h2>2. Solvency by Construction</h2>
        <pre style={{ background: "var(--bg-input)", padding: "var(--space-md)", borderRadius: "var(--radius-sm)", overflow: "auto", fontSize: 13, lineHeight: 1.6, fontFamily: "var(--mono)", color: "var(--text-dim)" }}>{`
  Mint:   $1 USDC in  →  1 Yes + 1 No out
  Redeem: 1 Winner in →  $1 USDC out

  Vault holds exactly: pairs_minted × $1.00
  All math: u64, checked_mul, checked_add
  No floats. No rounding. Overflow = tx failure.

  ┌──────────────┐    ┌──────────────┐
  │ Market Vault │    │  CLOB Vaults │
  │  (collateral)│    │   (escrow)   │
  │              │    │              │
  │ mint/redeem  │    │ place/fill   │
  └──────────────┘    └──────────────┘
        ↑ separated - CLOB bug can't drain collateral
`}</pre>
      </section>

      <section>
        <h2>3. The CLOB - Credit/Claim Model</h2>
        <pre style={{ background: "var(--bg-input)", padding: "var(--space-md)", borderRadius: "var(--radius-sm)", overflow: "auto", fontSize: 13, lineHeight: 1.6, fontFamily: "var(--mono)", color: "var(--text-dim)" }}>{`
  Problem: Solana needs all accounts declared upfront.
           Book changes between read and execution → tx fails.

  Solution: Credit/claim model.

  ┌─────────────────────────────────────────────────────┐
  │ Taker signs tx with FIXED accounts:                 │
  │   market, order_book, escrow_vaults, own_ATAs       │
  │                                                     │
  │ On-chain:                                           │
  │   1. Walk book in price-time priority               │
  │   2. Transfer tokens to taker (1 CPI)               │
  │   3. Credit maker proceeds in OB memory (no CPI)    │
  │   4. Makers call claim_fills() whenever             │
  └─────────────────────────────────────────────────────┘

  Result: Taker tx is deterministic. No stale-book failures.

  ┌────────────┬──────────┬──────────┬─────────┐
  │            │ Meridian │ Phoenix  │ OpenBook│
  ├────────────┼──────────┼──────────┼─────────┤
  │ Complexity │ ~2k LOC  │ Medium   │ ~10k   │
  │ Maker UX   │ Place +  │ Seat     │ Wait   │
  │            │ claim    │ approval │ crank   │
  │ Per-user   │ None     │ Seat     │ None   │
  │ setup      │          │ required │        │
  └────────────┴──────────┴──────────┴─────────┘
`}</pre>
      </section>

      <section>
        <h2>4. One Book, Four Trades</h2>
        <pre style={{ background: "var(--bg-input)", padding: "var(--space-md)", borderRadius: "var(--radius-sm)", overflow: "auto", fontSize: 13, lineHeight: 1.6, fontFamily: "var(--mono)", color: "var(--text-dim)" }}>{`
  One order book per strike: Yes vs USDC

  ┌──────────────────────────────────────────────┐
  │ BIDS (want Yes)          ASKS (selling Yes)  │
  │                                              │
  │ $0.63 × 500  ←───── Buy Yes ────→  × 500    │
  │ $0.62 × 1000          Sell No      × 1000   │
  │ $0.60 × 2000                       × 2000   │
  │                                              │
  │ ← Sell Yes ──────────────────── Buy No →     │
  └──────────────────────────────────────────────┘

  ┌─────────────┬───────────────────┬────────────┐
  │ User Action │ On-chain Path     │ # Txs      │
  ├─────────────┼───────────────────┼────────────┤
  │ Buy Yes     │ buy_yes           │ 1          │
  │ Sell Yes    │ sell_yes          │ 1          │
  │ Buy No      │ mint_pair +       │ 1 (atomic) │
  │             │ sell_yes          │            │
  │ Sell No     │ buy_yes + redeem  │ 1 (atomic) │
  └─────────────┴───────────────────┴────────────┘

  Key: Buy No = "mint a pair, sell the Yes"
       Cost = $1.00 - Yes sale price
`}</pre>
      </section>

      <section>
        <h2>5. Oracle & Settlement</h2>
        <pre style={{ background: "var(--bg-input)", padding: "var(--space-md)", borderRadius: "var(--radius-sm)", overflow: "auto", fontSize: 13, lineHeight: 1.6, fontFamily: "var(--mono)", color: "var(--text-dim)" }}>{`
  Market lifecycle: Created → Frozen → Settled (one-way)

  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌────────┐
  │ 8:00 AM │───→│ 9:30 AM │───→│ 4:00 PM │───→│ 4:07 PM │───→│ Redeem │
  │ Create  │    │ Trading │    │ Freeze  │    │ Settle  │    │ $1.00  │
  └─────────┘    └─────────┘    └─────────┘    └─────────┘    └────────┘

  Settlement decision tree:
  ┌─ 4:07 PM ET cron fires
  │
  ├─ Hermes VAA available?
  │   ├─ Yes → settle_market (permissionless, anyone can crank)
  │   │        Check: staleness <300s, confidence <1%, feed ID match
  │   │        ├─ Pass → SETTLED ✓
  │   │        └─ Fail → fall through
  │   └─ No → fall through
  │
  └─ Fallback: admin_settle (1hr delay, retries until 5:00 PM)

  Mock Pyth: ~30 LOC native program at real Pyth address.
             Tests run the REAL validation logic, not stubs.
`}</pre>
      </section>

      <section>
        <h2>6. Stack</h2>
        <pre style={{ background: "var(--bg-input)", padding: "var(--space-md)", borderRadius: "var(--radius-sm)", overflow: "auto", fontSize: 13, lineHeight: 1.6, fontFamily: "var(--mono)", color: "var(--text-dim)" }}>{`
  ┌───────────────────────────────────────────────────┐
  │ ON-CHAIN                                          │
  │  Rust / Anchor 0.32.0 - 18 instructions, ~2k LOC │
  │  Pyth pyth-solana-receiver-sdk 1.1.0 (pull-based) │
  │  Standard SPL tokens (0 dec Yes/No, 6 dec USDC)   │
  │  Zero-copy OrderBook (7800 bytes, 32 orders/side) │
  │  118 integration tests + mock Pyth oracle         │
  ├───────────────────────────────────────────────────┤
  │ OFF-CHAIN                                         │
  │  TypeScript cron: market creation + settlement    │
  │  3 bot processes: seed, market-make, strategies   │
  │  Railway: 1 container, 5 processes, wait -n       │
  ├───────────────────────────────────────────────────┤
  │ CLIENT                                            │
  │  Vite + React, semantic HTML + CSS custom props   │
  │  Phantom via Wallet Standard + Dev Wallet         │
  │  RPC polling (no WS for market data)              │
  └───────────────────────────────────────────────────┘
`}</pre>
      </section>

      <section>
        <h2>7. Production vs Demo</h2>
        <pre style={{ background: "var(--bg-input)", padding: "var(--space-md)", borderRadius: "var(--radius-sm)", overflow: "auto", fontSize: 13, lineHeight: 1.6, fontFamily: "var(--mono)", color: "var(--text-dim)" }}>{`
  ✓ Production-grade          → Production path
  ─────────────────────────────────────────────
  ✓ Credit/claim model        → (already correct)
  ✓ $1 payout invariant       → (already correct)
  ✓ State machine (118 tests) → (already correct)
  ✓ Pyth pull-based oracle    → (already correct)

  ⚡ Demo-scale                → Scaling path
  ─────────────────────────────────────────────
  32 orders/side              → bump const → binary search → sharding
  64 credit entries           → increase cap or spill to 2nd account
  Fill-or-kill only           → partial fills + residual resting
  Deterministic dev wallets   → HSM + multisig (Squads)
  Pyth real-time ~4:05 PM     → official NYSE close or multi-oracle
  Frontend position limits    → on-chain per-wallet enforcement
  Full freeze at close        → mint-only freeze (keep CLOB live)
`}</pre>
      </section>

      <section>
        <h2>8. The Bigger Picture - MAG7 as DeFi Primitives</h2>
        <pre style={{ background: "var(--bg-input)", padding: "var(--space-md)", borderRadius: "var(--radius-sm)", overflow: "auto", fontSize: 13, lineHeight: 1.6, fontFamily: "var(--mono)", color: "var(--text-dim)" }}>{`
  Yes/No tokens are standard SPL tokens with known, bounded payoffs.
  They're composable DeFi primitives, not just exchange positions.

  ┌─────────────────────────────────────────────────────────┐
  │ What this unlocks (architecturally, not built today):   │
  │                                                         │
  │ • Equity-linked yield: mint pairs, sell one side, hold  │
  │   the other. Permissionless structured product.         │
  │                                                         │
  │ • Composable collateral: deep ITM Yes tokens are        │
  │   near-cash. Lending protocols accept them trivially.   │
  │                                                         │
  │ • Correlation trades: buy Yes on all 7 MAG7 tickers.   │
  │   Exotic in TradFi, 7 token purchases here.            │
  │                                                         │
  │ • On-chain equity sentiment: Yes price = probability.   │
  │   Readable by any Solana program. No API needed.        │
  └─────────────────────────────────────────────────────────┘

  ┌───────────┬──────────┬─────────────┬──────────────┐
  │ Platform  │ Equities │ Composable  │ Self-custody │
  ├───────────┼──────────┼─────────────┼──────────────┤
  │ Kalshi    │ ✓        │ ✗ (central) │ ✗            │
  │ Polymarket│ ✗ events │ partial     │ ✓            │
  │ Mirror †  │ synth    │ ✓           │ ✓ (peg died) │
  │ Meridian  │ ✓ binary │ ✓ SPL       │ ✓            │
  └───────────┴──────────┴─────────────┴──────────────┘
`}</pre>
      </section>

      <section>
        <h2>9. The Reframe - Issuance Protocol, Not Exchange</h2>
        <pre style={{ background: "var(--bg-input)", padding: "var(--space-md)", borderRadius: "var(--radius-sm)", overflow: "auto", fontSize: 13, lineHeight: 1.6, fontFamily: "var(--mono)", color: "var(--text-dim)" }}>{`
  Meridian isn't an exchange. It's an issuance and settlement protocol.
  The CLOB is one venue. The tokens can trade anywhere.

  ┌──────────────────┬────────────────────────────────┬────────────────────┐
  │ Layer            │ Meridian                       │ TradFi analog      │
  ├──────────────────┼────────────────────────────────┼────────────────────┤
  │ Issuance         │ mint_pair ($1 in, Yes+No out)  │ OCC (clearinghouse)│
  │ Settlement       │ settle_market (oracle, pless)  │ Clearing           │
  │ Primary venue    │ Built-in CLOB                  │ CBOE               │
  │ Secondary venues │ Jupiter, Raydium, any DEX      │ ISE, PHLX, etc.    │
  │ Composability    │ CPI, DeFi collateral           │ Not possible       │
  └──────────────────┴────────────────────────────────┴────────────────────┘

  The last row is the punchline.

  TradFi can't use options as collateral in a lending protocol.
  Meridian tokens can - they're SPL tokens on the same chain.

  The protocol doesn't need to own all the liquidity.
  It mints the assets and guarantees the $1 payout.
  That's the clearing layer.

  Spec hint: position constraints are "frontend-only UX guardrails."
  The tokens are freely transferable by design. The spec knows this.
`}</pre>
      </section>
    </>
  );
}
