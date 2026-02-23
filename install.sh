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
while true; do
    echo "🔑 Please enter your Google Gemini API Key:"
    read -r API_KEY < /dev/tty

    if [ -n "$API_KEY" ]; then
        break
    else
        echo "⚠️  API Key cannot be empty. Please provide a valid key (or press Ctrl+C to abort)."
        echo ""
    fi
done

# Set up .env
cat > .env <<EOF
GEMINI_API_KEY="$API_KEY"

# Orchestrator HTTP server
ORCHESTRATOR_HOST=127.0.0.1
ORCHESTRATOR_PORT=3030

# Default models (aligned across agents)
ORCHESTRATOR_MODEL=gemini-3-flash-preview
BROWSER_AGENT_MODEL=gemini-3-flash-preview
CODING_AGENT_MODEL=gemini-3.1-pro-preview
CODING_AGENT_THINKING_LEVEL=high
IMAGE_AGENT_MODEL=gemini-3-pro-image-preview
TTS_AGENT_MODEL=gemini-2.5-flash-preview-tts

# Thinking levels
ORCHESTRATOR_THINKING_LEVEL=minimal
BROWSER_AGENT_THINKING_LEVEL=minimal
ORCHESTRATOR_WEB_RESEARCH=true

# Browser agent control API (orchestrator -> browser agent)
BROWSER_AGENT_ENABLED=true
BROWSER_AGENT_URL=http://127.0.0.1:3020
BROWSER_AGENT_API_KEY=
BROWSER_AGENT_TIMEOUT_MS=90000
BROWSER_AGENT_POLL_INTERVAL_MS=1400

# Browser agent runtime
AGENT_HEADLESS=true
AGENT_CONTROL_ENABLED=true
AGENT_CONTROL_HOST=127.0.0.1
AGENT_CONTROL_PORT=3020
AGENT_CONTROL_API_KEY=

# Runtime files
ORCHESTRATOR_SETTINGS_FILE=runtime-settings.json
ORCHESTRATOR_LOG_DIR=logs

# Media
MEDIA_ENABLED=true
MEDIA_STORAGE_DIR=uploads
MEDIA_MAX_FILE_BYTES=26214400
EOF
echo "✅ Saved full configuration to .env"

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
