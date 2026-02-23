# Orchestrator (Agent Stack)

A powerful AI agent orchestrator with multi-agent setup, browser control and local environments.

## Quick Install (Linux & macOS)

To install the project directly, run the following one-liner in your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/Horia73/orchestrator/main/install.sh | bash
```

This script will:
1. Check dependencies (git, node, npm)
2. Clone the repository
3. Prompt you for your **Google Gemini API Key**
4. Set up the `.env` file securely
5. Install packages and build the project for production

## Starting the Project

Once installed, simply start the full stack by running:
```bash
cd agent_stack
npm run start
```

## Manual Setup

If you prefer setting it up manually:

```bash
git clone https://github.com/Horia73/orchestrator.git agent_stack
cd agent_stack

# Setup API Key
echo "GEMINI_API_KEY=your_key_here" > .env

# Install & Build
npm install
npm run prepare:prod

# Start
npm run start
```
