#!/usr/bin/env bash

set -e

echo "==========================================="
echo "   🚀 Installing Agent Stack (Orchestrator)"
echo "==========================================="

# Check dependencies
if ! command -v git &> /dev/null; then
  echo "❌ Error: git is not installed."
  exit 1
fi

if ! command -v node &> /dev/null; then
  echo "❌ Error: node is not installed."
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo "❌ Error: npm is not installed."
  exit 1
fi

# Clone the repository
TARGET_DIR="agent_stack"
if [ -d "$TARGET_DIR" ]; then
  echo "⚠️  Directory $TARGET_DIR already exists."
  echo "Are you updating? (y/N)"
  read -r answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    cd "$TARGET_DIR"
    echo "🔄 Pulling latest changes..."
    git pull origin main
  else
    echo "❌ Installation aborted."
    exit 1
  fi
else
  echo "📦 Cloning repository..."
  git clone https://github.com/Horia73/orchestrator.git "$TARGET_DIR"
  cd "$TARGET_DIR"
fi

# Ask for Google API Key
echo ""
echo "🔑 Please enter your Google Gemini API Key:"
read -r API_KEY

if [ -z "$API_KEY" ]; then
    echo "⚠️  API Key is required. Installation aborted."
    exit 1
fi

# Set up .env
echo "GEMINI_API_KEY=$API_KEY" > .env
echo "✅ Saved API Key to .env"

echo ""
echo "📦 Installing npm dependencies..."
npm install

echo ""
echo "⚙️  Building the project for production..."
npm run prepare:prod

echo ""
echo "==========================================="
echo " 🎉 Installation Complete!"
echo "==========================================="
echo ""
echo "To start the application, run:"
echo "  cd $TARGET_DIR"
echo "  npm run start"
echo ""
echo "Happy coding!"
