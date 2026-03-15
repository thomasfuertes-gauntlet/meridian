import { useState } from "react";
import idl from "../idl/meridian.json";
import { PROGRAM_ID, RPC_URL } from "../lib/constants";

// IDL types
interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  pda?: unknown;
}
interface IdlArg {
  name: string;
  type: string | { defined?: { name: string }; option?: unknown; vec?: unknown };
}
interface IdlInstruction {
  name: string;
  accounts: IdlAccount[];
  args: IdlArg[];
}

function formatType(t: IdlArg["type"]): string {
  if (typeof t === "string") return t;
  if (typeof t === "object") {
    if (t.defined) return t.defined.name;
    if (t.option) return `Option<${formatType(t.option as IdlArg["type"])}>`;
    if (t.vec) return `Vec<${formatType(t.vec as IdlArg["type"])}>`;
  }
  return JSON.stringify(t);
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

const INSTRUCTIONS = (idl.instructions as IdlInstruction[]).sort((a, b) =>
  a.name.localeCompare(b.name)
);

const CATEGORIES: Record<string, string[]> = {
  "Market Lifecycle": [
    "initialize_config", "update_config", "create_strike_market",
    "add_strike", "freeze_market", "close_market", "pause", "unpause",
  ],
  "Minting & Redemption": ["mint_pair", "redeem"],
  "Settlement": ["settle_market", "admin_settle"],
  "Order Book": [
    "place_order", "cancel_order", "buy_yes", "sell_yes",
    "claim_fills", "unwind_order",
  ],
};

const HELLO_WORLD = `import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
// import idl from "@meridian/sdk/idl.json";  // TODO: npm package
import idl from "./meridian.json";

const PROGRAM_ID = new PublicKey("${PROGRAM_ID.toBase58()}");
const connection = new Connection("${RPC_URL}");
const wallet = Keypair.fromSecretKey(/* your key */);
const provider = new AnchorProvider(connection, wallet, {});
const program = new Program(idl, provider);

// 1. Discover markets
const markets = await program.account.strikeMarket.all();
const nvda = markets.filter(m => m.account.ticker === "NVDA");
console.log(\`Found \${nvda.length} NVDA markets\`);

// 2. Place a bid (limit order)
const market = nvda[0];
const orderBook = market.account.orderBook;
const userUsdc = getAssociatedTokenAddressSync(market.account.usdcMint, wallet.publicKey);
const userYes = getAssociatedTokenAddressSync(market.account.yesMint, wallet.publicKey);

await program.methods
  .placeOrder(
    { bid: {} },           // OrderSide::Bid
    new BN(650_000),       // price: $0.65
    new BN(100),           // quantity: 100 contracts
  )
  .accountsPartial({
    user: wallet.publicKey,
    market: market.publicKey,
    orderBook,
  })
  .rpc();

// 3. Check fills & claim
const ob = await program.account.orderBook.fetch(orderBook);
const myCredits = ob.credits.find(
  c => c.owner.equals(wallet.publicKey) && (c.usdcClaimable > 0 || c.yesClaimable > 0)
);
if (myCredits) {
  await program.methods.claimFills()
    .accountsPartial({ user: wallet.publicKey, market: market.publicKey, orderBook })
    .rpc();
  console.log("Claimed fills!");
}`;

export function Docs() {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <>
      <section>
        <h1>Meridian SDK</h1>
        <dl>
          <dt>Program</dt>
          <dd>{PROGRAM_ID.toBase58()}</dd>
          <dt>Version</dt>
          <dd>{idl.metadata.version}</dd>
          <dt>Instructions</dt>
          <dd>{INSTRUCTIONS.length}</dd>
          <dt>Install</dt>
          <dd><kbd>npm i @meridian/sdk</kbd> <small><mark data-tone="muted">coming soon</mark></small></dd>
        </dl>
      </section>

      <section>
        <h2>Quick Start - Bot Hello World</h2>
        <p>Discover markets, place a limit order, claim fills. Three calls.</p>
        <pre style={{
          background: "var(--bg-input)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          padding: "var(--space-md)",
          overflow: "auto",
          fontSize: 12,
          lineHeight: 1.6,
          fontFamily: "var(--mono)",
          color: "var(--text-dim)",
        }}>
          <code>{HELLO_WORLD}</code>
        </pre>
      </section>

      {Object.entries(CATEGORIES).map(([category, names]) => {
        const instructions = names
          .map((n) => INSTRUCTIONS.find((ix) => ix.name === n))
          .filter(Boolean) as IdlInstruction[];

        return (
          <section key={category}>
            <h2>{category}</h2>
            {instructions.map((ix) => {
              const isOpen = expanded === ix.name;
              const camel = snakeToCamel(ix.name);
              const signers = ix.accounts.filter((a) => a.signer);
              const writable = ix.accounts.filter((a) => a.writable && !a.signer);
              const readonly = ix.accounts.filter((a) => !a.writable && !a.signer);

              return (
                <article
                  key={ix.name}
                  onClick={() => setExpanded(isOpen ? null : ix.name)}
                  style={{ cursor: "pointer" }}
                >
                  <h3 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>
                      <kbd>{camel}</kbd>
                      {ix.args.length > 0 && (
                        <small style={{ marginLeft: "var(--space-sm)" }}>
                          ({ix.args.map((a) => `${snakeToCamel(a.name)}: ${formatType(a.type)}`).join(", ")})
                        </small>
                      )}
                    </span>
                    <small>{isOpen ? "▾" : "▸"}</small>
                  </h3>

                  {isOpen && (
                    <div style={{ marginTop: "var(--space-sm)" }}>
                      <dl>
                        {signers.length > 0 && (
                          <>
                            <dt>Signers</dt>
                            <dd>{signers.map((a) => snakeToCamel(a.name)).join(", ")}</dd>
                          </>
                        )}
                        {writable.length > 0 && (
                          <>
                            <dt>Writable</dt>
                            <dd>{writable.map((a) => snakeToCamel(a.name)).join(", ")}</dd>
                          </>
                        )}
                        {readonly.length > 0 && (
                          <>
                            <dt>Read-only</dt>
                            <dd>{readonly.map((a) => snakeToCamel(a.name)).join(", ")}</dd>
                          </>
                        )}
                        <dt>Accounts</dt>
                        <dd>{ix.accounts.length} total</dd>
                      </dl>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        );
      })}

      <section>
        <h2>Full IDL</h2>
        <p>
          <small>
            The complete Anchor IDL is bundled at build time.
            Download: <a href={`data:application/json,${encodeURIComponent(JSON.stringify(idl, null, 2))}`} download="meridian.json">meridian.json</a>
          </small>
        </p>
      </section>
    </>
  );
}
