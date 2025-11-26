#!/bin/bash

# MCPB Bundle Build Script
# Creates a .mcpb file for one-click installation in Claude Desktop

set -e

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
mcpb pack build/tmp vonage-mcp-server.mcpb

# Cleanup
echo "🧹 Cleaning up..."
rm -rf build/tmp

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

