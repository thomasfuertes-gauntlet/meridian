/**
 * ZKP proof generation and verification for trading performance claims.
 * Uses Groth16 via snarkjs + Poseidon Merkle trees matching circomlib params.
 */
import { PublicKey } from "@solana/web3.js";
import { poseidon2 } from "poseidon-lite";

const TREE_DEPTH = 10;
const TREE_SIZE = 1 << TREE_DEPTH;

// Lazy-loaded artifacts
let cachedTree: TreeData | null = null;
let cachedVkey: unknown = null;

export interface LeafData {
  hash: string;
  wallet: string;
  wins: number;
  total: number;
}

export interface TreeData {
  root: string;
  timestamp: number;
  marketCount: number;
  leaves: LeafData[];
  depth: number;
}

export interface BragProof {
  proof: unknown;
  publicSignals: string[];
}

export interface ProofUrlData {
  proof: unknown;
  publicSignals: string[];
  metadata: { timestamp: number; marketCount: number };
}

/** Split 32-byte pubkey into two 128-bit halves (big-endian) */
export function splitPubkey(pubkey: PublicKey): { hi: bigint; lo: bigint } {
  const bytes = pubkey.toBytes();
  let hi = 0n;
  for (let i = 0; i < 16; i++) hi = (hi << 8n) | BigInt(bytes[i]);
  let lo = 0n;
  for (let i = 16; i < 32; i++) lo = (lo << 8n) | BigInt(bytes[i]);
  return { hi, lo };
}

/** Fetch and cache tree.json */
export async function loadTree(): Promise<TreeData> {
  if (cachedTree) return cachedTree;
  const res = await fetch("/zkp/tree.json");
  if (!res.ok) throw new Error("Failed to load tree.json - run `make tree` first");
  cachedTree = (await res.json()) as TreeData;
  return cachedTree;
}

/** Find leaf index for a wallet, or -1 if not found */
export function findLeaf(tree: TreeData, wallet: PublicKey): number {
  const walletStr = wallet.toBase58();
  return tree.leaves.findIndex((l) => l.wallet === walletStr);
}

/** Rebuild Poseidon Merkle tree from leaf hashes and extract proof for a leaf */
export function getMerkleProof(
  tree: TreeData,
  leafIndex: number
): { pathElements: bigint[]; pathIndices: number[] } {
  const hashes = tree.leaves.map((l) => BigInt(l.hash));
  // Pad to TREE_SIZE
  while (hashes.length < TREE_SIZE) hashes.push(0n);

  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];

  let currentLayer = hashes;
  let idx = leafIndex;

  for (let d = 0; d < TREE_DEPTH; d++) {
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    pathElements.push(currentLayer[siblingIdx]);
    pathIndices.push(idx % 2);

    const nextLayer: bigint[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      nextLayer.push(poseidon2([currentLayer[i], currentLayer[i + 1]]));
    }
    currentLayer = nextLayer;
    idx = Math.floor(idx / 2);
  }

  return { pathElements, pathIndices };
}

/** Generate Groth16 proof of trading performance */
export async function generateBragProof(
  wallet: PublicKey,
  claimedMinWins: number,
  tree: TreeData
): Promise<BragProof> {
  const leafIdx = findLeaf(tree, wallet);
  if (leafIdx === -1) throw new Error("Wallet not found in tree");

  const leaf = tree.leaves[leafIdx];
  const { hi, lo } = splitPubkey(wallet);
  const { pathElements, pathIndices } = getMerkleProof(tree, leafIdx);

  const input = {
    walletHi: hi.toString(),
    walletLo: lo.toString(),
    wins: leaf.wins,
    total: leaf.total,
    pathElements: pathElements.map((e) => e.toString()),
    pathIndices,
    root: tree.root,
    claimedMinWins,
  };

  // Dynamic import to avoid bundling snarkjs (500KB+)
  const snarkjs = await import("snarkjs");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    "/zkp/brag_wasm/brag.wasm",
    "/zkp/brag.zkey"
  );

  return { proof, publicSignals };
}

/** Verify a Groth16 proof against the verification key */
export async function verifyBragProof(
  proof: unknown,
  publicSignals: string[]
): Promise<boolean> {
  if (!cachedVkey) {
    const res = await fetch("/zkp/vkey.json");
    if (!res.ok) throw new Error("Failed to load vkey.json");
    cachedVkey = await res.json();
  }

  const snarkjs = await import("snarkjs");
  return snarkjs.groth16.verify(cachedVkey, publicSignals, proof);
}

/** Encode proof + metadata as base64url for URL hash fragment */
export function encodeProofUrl(
  proof: unknown,
  publicSignals: string[],
  metadata: { timestamp: number; marketCount: number }
): string {
  const data: ProofUrlData = { proof, publicSignals, metadata };
  const json = JSON.stringify(data);
  // base64url encoding
  const b64 = btoa(json)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return b64;
}

/** Decode base64url hash fragment back to proof data */
export function decodeProofUrl(hash: string): ProofUrlData {
  // Remove leading # if present
  const b64 = hash.replace(/^#/, "");
  // base64url -> base64
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(padded);
  return JSON.parse(json) as ProofUrlData;
}
