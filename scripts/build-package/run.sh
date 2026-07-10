#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXT_DIR="$REPO_DIR/apps/extension"
BUNDLED_DIR="$EXT_DIR/bundled"
OUT_DIR="$EXT_DIR/out"

echo "Building shared..."
pnpm --filter @ungate/shared run build

echo "Building api..."
pnpm --filter @ungate/api run build:bundle

echo "Building web..."
pnpm --filter @ungate/web run build

echo "Building extension..."
cd "$EXT_DIR"
pnpm run build

echo "Copying project files..."
cp "$REPO_DIR/LICENSE" "$EXT_DIR/LICENSE"
cp "$REPO_DIR/README.md" "$EXT_DIR/README.md"

echo "Assembling bundle..."
rm -rf "$BUNDLED_DIR" "$OUT_DIR"
mkdir -p "$BUNDLED_DIR/api/bundle" "$BUNDLED_DIR/api/node_modules" "$BUNDLED_DIR/web" "$OUT_DIR"

# api: tsup bundle (single file) + drizzle migrations
cp -r "$REPO_DIR/apps/api/bundle/." "$BUNDLED_DIR/api/bundle/"
cp -r "$REPO_DIR/apps/api/drizzle" "$BUNDLED_DIR/api/drizzle"

# web: static build
cp -r "$REPO_DIR/apps/web/dist/." "$BUNDLED_DIR/web/dist/"

# better-sqlite3 runtime deps:
# - better-sqlite3: native addon wrapper
# - bindings + file-uri-to-path: required by better-sqlite3 at runtime
# Resolve each package's real directory via Node so this works regardless of the
# pnpm node-linker layout (hoisted, isolated, etc). cp -rL dereferences symlinks.
resolve_pkg_dir() {
	# $1 = package name, $2 = directory to resolve from
	node -e "const p=require('path');process.stdout.write(p.dirname(require.resolve('$1/package.json',{paths:['$2']})))"
}

BS_DIR="$(resolve_pkg_dir better-sqlite3 "$REPO_DIR/apps/api")"
BINDINGS_DIR="$(resolve_pkg_dir bindings "$BS_DIR")"
FURI_DIR="$(resolve_pkg_dir file-uri-to-path "$BINDINGS_DIR")"

cp -rL "$BS_DIR" "$BUNDLED_DIR/api/node_modules/better-sqlite3"
cp -rL "$BINDINGS_DIR" "$BUNDLED_DIR/api/node_modules/bindings"
cp -rL "$FURI_DIR" "$BUNDLED_DIR/api/node_modules/file-uri-to-path"

# Remove build artifacts not needed at runtime
# build/ — dev-machine native binary; extension downloads the correct one at first launch
# deps/ — SQLite C sources, only needed for compilation
echo "Trimming better-sqlite3..."
rm -rf "$BUNDLED_DIR/api/node_modules/better-sqlite3/build"
rm -rf "$BUNDLED_DIR/api/node_modules/better-sqlite3/deps"

echo "Packaging vsix..."
cd "$EXT_DIR"
pnpm exec vsce package --no-dependencies --out "out/ungate.vsix"

rm -rf "$BUNDLED_DIR"

echo "Done. Package ready at: $EXT_DIR/out/ungate.vsix"
