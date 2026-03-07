#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_DIR="build"
OUTPUT_DIR="../app/public/zkp"

mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

# Install circuit deps if needed
if [ ! -d "node_modules" ]; then
  echo "Installing circuit dependencies..."
  npm install
fi

# 1. Compile circuit
echo "Compiling brag.circom..."
circom brag.circom --r1cs --wasm --sym -o "$BUILD_DIR/"

# 2. Download Powers of Tau if not cached
PTAU="$BUILD_DIR/pot14.ptau"
if [ ! -f "$PTAU" ]; then
  echo "Downloading Hermez pot14.ptau (~54MB)..."
  curl -L -o "$PTAU" "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau"
fi

# 3. Groth16 setup
echo "Running Groth16 setup..."
npx snarkjs groth16 setup "$BUILD_DIR/brag.r1cs" "$PTAU" "$BUILD_DIR/brag_0.zkey"

# 4. Contribute to ceremony (deterministic entropy for dev)
echo "Contributing to ceremony..."
echo "meridian-dev-entropy" | npx snarkjs zkey contribute "$BUILD_DIR/brag_0.zkey" "$BUILD_DIR/brag.zkey" --name="meridian-dev"

# 5. Export verification key
echo "Exporting verification key..."
npx snarkjs zkey export verificationkey "$BUILD_DIR/brag.zkey" "$BUILD_DIR/vkey.json"

# 6. Copy artifacts to app/public/zkp/
echo "Copying artifacts to $OUTPUT_DIR..."
cp "$BUILD_DIR/brag.zkey" "$OUTPUT_DIR/"
cp -r "$BUILD_DIR/brag_js/" "$OUTPUT_DIR/brag_wasm/"
cp "$BUILD_DIR/vkey.json" "$OUTPUT_DIR/"

echo "Done! Artifacts in $OUTPUT_DIR"
