/**
 * Build Poseidon Merkle tree of wallet trading performance.
 * Scans settled markets, counts wins per wallet, outputs tree.json.
 * Run: ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=.wallets/admin.json npx tsx scripts/build-tree.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey } from "@solana/web3.js";
import { poseidon2, poseidon4 } from "poseidon-lite";
import * as fs from "fs";
import * as path from "path";

const TREE_DEPTH = 10;
const TREE_SIZE = 1 << TREE_DEPTH; // 1024

interface WalletStats {
  wins: number;
  total: number;
}

interface LeafData {
  hash: string;
  wallet: string;
  wins: number;
  total: number;
}

/** Split 32-byte pubkey into two 128-bit halves (big-endian) */
function splitPubkey(pubkey: PublicKey): { hi: bigint; lo: bigint } {
  const bytes = pubkey.toBytes();
  let hi = 0n;
  for (let i = 0; i < 16; i++) hi = (hi << 8n) | BigInt(bytes[i]);
  let lo = 0n;
  for (let i = 16; i < 32; i++) lo = (lo << 8n) | BigInt(bytes[i]);
  return { hi, lo };
}

/** Hash a leaf: Poseidon(walletHi, walletLo, wins, total) */
function hashLeaf(wallet: PublicKey, wins: number, total: number): bigint {
  const { hi, lo } = splitPubkey(wallet);
  return poseidon4([hi, lo, BigInt(wins), BigInt(total)]);
}

/** Build Poseidon Merkle tree, return root and layers */
function buildMerkleTree(leaves: bigint[]): { root: bigint; layers: bigint[][] } {
  // Pad to TREE_SIZE with zero leaves
  const paddedLeaves = [...leaves];
  while (paddedLeaves.length < TREE_SIZE) paddedLeaves.push(0n);

  const layers: bigint[][] = [paddedLeaves];
  let current = paddedLeaves;

  for (let d = 0; d < TREE_DEPTH; d++) {
    const next: bigint[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(poseidon2([current[i], current[i + 1]]));
    }
    layers.push(next);
    current = next;
  }

  return { root: current[0], layers };
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;

  console.log("Fetching settled markets...");
  const allMarkets = await program.account.strikeMarket.all();
  // outcome: 0 = Pending, 1 = YesWins, 2 = NoWins
  const settledMarkets = allMarkets.filter(
    (m) => m.account.outcome !== 0 && m.account.outcome !== undefined
  );

  console.log(`Found ${settledMarkets.length} settled markets out of ${allMarkets.length} total`);

  if (settledMarkets.length === 0) {
    console.log("No settled markets found. Settle markets first (admin_settle or settle_market).");
    process.exit(0);
  }

  // Track per-wallet per-market token holdings for dedup
  const walletMarkets = new Map<string, Map<string, { heldYes: boolean; heldNo: boolean }>>();

  for (const market of settledMarkets) {
    const marketKey = market.publicKey.toString();
    const yesMint = market.account.yesMint;
    const noMint = market.account.noMint;

    const [yesHolders, noHolders] = await Promise.all([
      connection.getTokenLargestAccounts(yesMint),
      connection.getTokenLargestAccounts(noMint),
    ]);

    for (const holder of yesHolders.value) {
      if (holder.uiAmount === 0) continue;
      const acctInfo = await connection.getParsedAccountInfo(holder.address);
      const parsed = (acctInfo.value?.data as any)?.parsed;
      if (!parsed) continue;
      const owner = parsed.info.owner as string;

      if (!walletMarkets.has(owner)) walletMarkets.set(owner, new Map());
      const wm = walletMarkets.get(owner)!;
      if (!wm.has(marketKey)) wm.set(marketKey, { heldYes: false, heldNo: false });
      wm.get(marketKey)!.heldYes = true;
    }

    for (const holder of noHolders.value) {
      if (holder.uiAmount === 0) continue;
      const acctInfo = await connection.getParsedAccountInfo(holder.address);
      const parsed = (acctInfo.value?.data as any)?.parsed;
      if (!parsed) continue;
      const owner = parsed.info.owner as string;

      if (!walletMarkets.has(owner)) walletMarkets.set(owner, new Map());
      const wm = walletMarkets.get(owner)!;
      if (!wm.has(marketKey)) wm.set(marketKey, { heldYes: false, heldNo: false });
      wm.get(marketKey)!.heldNo = true;
    }
  }

  // Compute final stats: win = held winning token for that market
  const finalStats = new Map<string, WalletStats>();
  const settledMarketMap = new Map(settledMarkets.map((m) => [m.publicKey.toString(), m]));

  for (const [wallet, markets] of walletMarkets) {
    let wins = 0;
    let total = 0;
    for (const [marketKey, held] of markets) {
      total++;
      const market = settledMarketMap.get(marketKey)!;
      const yesWins = market.account.outcome === 1;
      if ((yesWins && held.heldYes) || (!yesWins && held.heldNo)) {
        wins++;
      }
    }
    if (total > 0) finalStats.set(wallet, { wins, total });
  }

  // Build leaves
  const leafEntries: LeafData[] = [];
  const leafHashes: bigint[] = [];

  for (const [wallet, { wins, total }] of finalStats) {
    const pubkey = new PublicKey(wallet);
    const hash = hashLeaf(pubkey, wins, total);
    leafHashes.push(hash);
    leafEntries.push({ hash: hash.toString(), wallet, wins, total });
  }

  console.log(`Building Merkle tree with ${leafEntries.length} leaves (depth ${TREE_DEPTH})...`);

  const { root } = buildMerkleTree(leafHashes);

  // Write output
  const outputDir = path.join(__dirname, "..", "app", "public", "zkp");
  fs.mkdirSync(outputDir, { recursive: true });

  const treeData = {
    root: root.toString(),
    timestamp: Date.now(),
    marketCount: settledMarkets.length,
    leaves: leafEntries,
    depth: TREE_DEPTH,
  };

  const outputPath = path.join(outputDir, "tree.json");
  fs.writeFileSync(outputPath, JSON.stringify(treeData, null, 2));
  console.log(`Tree written to ${outputPath}`);
  console.log(`Root: ${root.toString()}`);
  console.log(`Leaves: ${leafEntries.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
