#!/usr/bin/env bash
# Vendor MystenLabs/confidential-transfers into web/vendor/ for the OTC flow.
#
# Why vendoring (and not npm install): the SDK is not published. It is a pnpm
# workspace whose ts-sdk depends on a sibling Rust→WASM crate
# (utils/bulletproofs-wasm) and a sibling TS workspace (utils/ts-utils). A bare
# `npm i github:...` cannot resolve those file-deps. We clone, build the WASM
# for both targets, then point `web/package.json` at the three local dirs via
# `file:` deps.
#
# Re-runnable. If the vendor dir exists, this script pulls the latest main and
# re-builds the WASM artifacts.

set -euo pipefail

REPO_URL="https://github.com/MystenLabs/confidential-transfers.git"
REPO_REF="${REPO_REF:-main}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/web/vendor/confidential-transfers"

command -v wasm-pack >/dev/null 2>&1 || {
  echo "error: wasm-pack not found in PATH. Install with: cargo install wasm-pack" >&2
  exit 1
}
command -v cargo >/dev/null 2>&1 || {
  echo "error: cargo not found in PATH. Install Rust: https://rustup.rs/" >&2
  exit 1
}

if [ -d "$VENDOR_DIR/.git" ]; then
  echo "==> Updating existing vendor clone at $VENDOR_DIR"
  git -C "$VENDOR_DIR" fetch --depth=1 origin "$REPO_REF"
  git -C "$VENDOR_DIR" checkout FETCH_HEAD
else
  echo "==> Cloning $REPO_URL @ $REPO_REF -> $VENDOR_DIR"
  mkdir -p "$(dirname "$VENDOR_DIR")"
  git clone --depth=1 --branch "$REPO_REF" "$REPO_URL" "$VENDOR_DIR"
fi

echo "==> Building bulletproofs-wasm (--target web)"
( cd "$VENDOR_DIR/utils/bulletproofs-wasm" && wasm-pack build --target web --release --out-dir web --no-pack )

echo "==> Building bulletproofs-wasm (--target nodejs)"
( cd "$VENDOR_DIR/utils/bulletproofs-wasm" && wasm-pack build --target nodejs --release --out-dir nodejs --no-pack )

# Drop wasm-pack's .gitignore so file: install doesn't filter the artifact
rm -f "$VENDOR_DIR/utils/bulletproofs-wasm/web/.gitignore"
rm -f "$VENDOR_DIR/utils/bulletproofs-wasm/nodejs/.gitignore"

echo
echo "==> Vendor ready."
echo "    web/vendor/confidential-transfers/"
echo "    Add to web/package.json (already done if you ran this from m1n3 setup):"
echo '      "@mysten/confidential-transfers": "file:./vendor/confidential-transfers/ts-sdk",'
echo '      "@contra/bulletproofs-wasm":      "file:./vendor/confidential-transfers/utils/bulletproofs-wasm",'
echo '      "contra-utils":                    "file:./vendor/confidential-transfers/utils/ts-utils"'
