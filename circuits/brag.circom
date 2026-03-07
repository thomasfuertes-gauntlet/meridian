pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";

// Verify Merkle inclusion of a leaf in a Poseidon Merkle tree
template MerkleProof(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal hashes[depth + 1];
    hashes[0] <== leaf;

    component hashers[depth];

    for (var i = 0; i < depth; i++) {
        // pathIndices[i] is 0 or 1
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        hashers[i] = Poseidon(2);

        // If pathIndices[i] == 0: hash(current, sibling)
        // If pathIndices[i] == 1: hash(sibling, current)
        // left = pathIndices[i] == 0 ? hashes[i] : pathElements[i]
        // right = pathIndices[i] == 0 ? pathElements[i] : hashes[i]
        hashers[i].inputs[0] <== hashes[i] + pathIndices[i] * (pathElements[i] - hashes[i]);
        hashers[i].inputs[1] <== pathElements[i] + pathIndices[i] * (hashes[i] - pathElements[i]);

        hashes[i + 1] <== hashers[i].out;
    }

    root <== hashes[depth];
}

template Brag() {
    // Private inputs
    signal input walletHi;
    signal input walletLo;
    signal input wins;
    signal input total;
    signal input pathElements[10];
    signal input pathIndices[10];

    // Public inputs
    signal input root;
    signal input claimedMinWins;

    // 1. Compute leaf = Poseidon(walletHi, walletLo, wins, total)
    component leafHasher = Poseidon(4);
    leafHasher.inputs[0] <== walletHi;
    leafHasher.inputs[1] <== walletLo;
    leafHasher.inputs[2] <== wins;
    leafHasher.inputs[3] <== total;

    // 2. Verify Merkle inclusion
    component merkle = MerkleProof(10);
    merkle.leaf <== leafHasher.out;
    for (var i = 0; i < 10; i++) {
        merkle.pathElements[i] <== pathElements[i];
        merkle.pathIndices[i] <== pathIndices[i];
    }
    merkle.root === root;

    // 3. wins >= claimedMinWins
    component gte = GreaterEqThan(64);
    gte.in[0] <== wins;
    gte.in[1] <== claimedMinWins;
    gte.out === 1;

    // 4. total > 0
    component gt = GreaterThan(64);
    gt.in[0] <== total;
    gt.in[1] <== 0;
    gt.out === 1;
}

component main {public [root, claimedMinWins]} = Brag();
