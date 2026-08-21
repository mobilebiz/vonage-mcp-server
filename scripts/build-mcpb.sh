#!/bin/bash

# MCPB Bundle Build Script
# Creates a .mcpb file for one-click installation in Claude Desktop

set -e

# 途中で失敗しても中間物を残さない。build/tmp には本番依存をインストールする
# ため 40MB を超える。set -e で抜けると末尾の後片付けに到達しないので trap で
# 確実に消す。
cleanup() {
  rm -rf build/tmp
}
trap cleanup EXIT

# mcpb CLI は**グローバルに入っている前提**。リリース時にしか使わないツールの
# ために、依存ツリー43パッケージを package-lock.json へ載せるのは重いと判断した。
# 代わりに、無いときは何が必要かを明示して止める（黙って失敗させない）。
MCPB="mcpb"
if [ -x "./node_modules/.bin/mcpb" ]; then
  # ローカルに入っている場合はそちらを優先する
  MCPB="./node_modules/.bin/mcpb"
elif ! command -v mcpb >/dev/null 2>&1; then
  echo "❌ mcpb CLI が見つかりません。次を実行してください:" >&2
  echo "     npm install -g @anthropic-ai/mcpb" >&2
  exit 1
fi

echo "🔨 Building MCPB bundle..."

# Clean previous builds
rm -rf build/tmp
rm -f vonage-mcp-server.mcpb

# Build TypeScript
echo "📦 Building TypeScript..."
npm run build

# Create build directory
echo "📁 Creating bundle directory..."
mkdir -p build/tmp

# Copy necessary files
echo "📋 Copying files..."
cp package.json \
   package-lock.json \
   manifest.json \
   README.md \
   build/tmp/
cp -r dist build/tmp/

# Install production dependencies
echo "📥 Installing production dependencies..."
cd build/tmp
npm ci --production --silent
cd ../..

# Create MCPB using official CLI
echo "🗜️  Creating MCPB bundle..."
"$MCPB" pack build/tmp vonage-mcp-server.mcpb

# 後片付けは trap cleanup が行う
echo "🧹 Cleaning up..."

echo "✅ MCPB bundle created: vonage-mcp-server.mcpb"
echo ""
echo "📦 Installation instructions:"
echo "1. Download vonage-mcp-server.mcpb"
echo "2. Open with Claude Desktop"
echo "3. Configure environment variables:"
echo "   - Vonage Application ID"
echo "   - Private Key Path"
echo "   - Voice Call From Number"
echo "4. Start using!"

