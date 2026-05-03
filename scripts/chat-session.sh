#!/usr/bin/env bash
# ============================================================
# scripts/chat-session.sh
# ============================================================
# Optional shell launcher for the NerdAlert REPL.
#
# What it does:
#   1. Checks that the NerdAlert server is running (port 3773 open)
#   2. If not running, offers to start it in the background
#   3. Launches the TypeScript REPL via ts-node
#
# Why use this instead of just npm run chat?
#   This script adds a pre-flight check in shell — it's faster
#   to check a port with nc than to wait for ts-node to spin up
#   and fail. It also offers a recovery path if the server is down.
#
# How to make it executable (run once after dropping it in):
#   chmod +x scripts/chat-session.sh
#
# Then add to ~/.zshrc if you want it as a global command:
#   alias nerd="~/documents/claude/nerdalert/scripts/chat-session.sh"
#   Then just type: nerd
# ============================================================

set -euo pipefail

# ---- CONFIG ----
# Where the project root is relative to this script's location.
# $( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )  is the
# canonical way to get the absolute path of this script's directory
# in bash — it works no matter where you call the script from.

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
PORT=3773


# ---- COLORS ----
# Same role as in chat-utils.ts — just bash versions.
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
GRAY='\033[0;90m'
RESET='\033[0m'
BOLD='\033[1m'


echo ""
echo -e "  ${BOLD}${CYAN}NERDALERT${RESET} ${GRAY}/// Terminal Launcher${RESET}"
echo ""


# ---- PORT CHECK ----
# nc (netcat) with -z checks if a port is open without sending data.
# -w 1 gives it a 1-second timeout before deciding the port is closed.
# 2>/dev/null suppresses nc's own error output.
# If nc exits 0 = port is open = server is running.
# If nc exits 1 = port is closed = server is not running.

if nc -z -w 1 localhost $PORT 2>/dev/null; then
  echo -e "  ${GREEN}✓ Server is running on port ${PORT}${RESET}"
else
  echo -e "  ${YELLOW}⚠  NerdAlert server not detected on port ${PORT}${RESET}"
  echo ""
  echo -e "  ${GRAY}Start it now? (Runs in background, logs to /tmp/nerdalert.log)${RESET}"
  echo -n "  [y/N] "
  read -r answer

  if [[ "$answer" =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "  ${GRAY}Starting server...${RESET}"

    # cd to project root first so ts-node finds the right tsconfig
    cd "$PROJECT_ROOT"

    # nohup + & runs the server in the background, detached from this terminal
    # stdout and stderr both go to /tmp/nerdalert.log
    nohup npx ts-node src/server/index.ts > /tmp/nerdalert.log 2>&1 &

    # Store the PID so we can reference it in messages
    SERVER_PID=$!
    echo -e "  ${GRAY}Server PID: ${SERVER_PID}${RESET}"

    # Give the server 3 seconds to bind the port before we try to connect
    echo -e "  ${GRAY}Waiting for server to come up...${RESET}"
    sleep 3

    # Verify it actually started
    if ! nc -z -w 1 localhost $PORT 2>/dev/null; then
      echo ""
      echo -e "  ${RED}✗ Server did not start. Check /tmp/nerdalert.log for errors.${RESET}"
      echo ""
      exit 1
    fi

    echo -e "  ${GREEN}✓ Server started${RESET}"
  else
    echo ""
    echo -e "  ${GRAY}Start the server manually with:${RESET}"
    echo -e "  ${YELLOW}npm run dev${RESET}"
    echo ""
    exit 0
  fi
fi

echo ""
echo -e "  ${GRAY}Launching REPL...${RESET}"
echo ""

# ---- LAUNCH REPL ----
# cd to project root so ts-node finds tsconfig.json correctly.
# exec replaces the shell process with ts-node — cleaner than
# running as a child process, and means Ctrl+C in the REPL
# exits directly without leaving a zombie shell behind.

cd "$PROJECT_ROOT"
exec npx ts-node scripts/chat.ts
