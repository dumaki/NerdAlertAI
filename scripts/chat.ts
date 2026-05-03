// ============================================================
// scripts/chat.ts
// ============================================================
// The NerdAlert REPL terminal chat client.
//
// What this file does:
//   1. Reads SERVER_AUTH_TOKEN from .env (same method as the server)
//   2. Pings /health to confirm the server is alive before starting
//   3. Prints the session banner with agent name and port
//   4. Opens an interactive readline loop — you type, Sherman responds
//   5. Maintains a conversationHistory array so Sherman remembers
//      what you said earlier in the session
//   6. Handles /clear (reset history) and /exit (quit cleanly)
//   7. Handles Ctrl+C gracefully without an ugly stack trace
//
// How to run it:
//   npx ts-node scripts/chat.ts
//
// You can also add a package.json script so it's just:
//   npm run chat
// ============================================================

import * as readline from 'readline';
import * as fs       from 'fs';
import * as path     from 'path';

import {
  printBanner,
  printCleared,
  printError,
  printConnected,
  printAgentResponse,
  PROMPT_SYMBOL,
  GRAY,
  RESET,
  DIM,
} from './chat-utils';


// ---- CONFIG ----
// The server port and base URL.
// These match the defaults in the NerdAlert server — if you ever
// change the port in config.yaml or .env, update SERVER_PORT here too.
//
// Why hardcode the port here instead of reading config.yaml?
//   The REPL is a standalone script. Reading config.yaml would require
//   importing the config loader, which pulls in more dependencies.
//   The port rarely changes, so a clear constant is the right tradeoff.
//   If you do change ports, this is the only line that needs updating.

const SERVER_PORT = 3773;
const BASE_URL    = `http://localhost:${SERVER_PORT}`;


// ---- LOAD AUTH TOKEN ----
// We need the same token the server uses to authenticate requests.
// It lives in .env as SERVER_AUTH_TOKEN.
//
// Why not use dotenv here?
//   dotenv would work fine. But since we only need one value,
//   reading the file directly and parsing the one line is lighter
//   and has zero dependencies. Same token, simpler approach.
//
// Why resolve from __dirname?
//   __dirname is the absolute path of *this file's directory*
//   (scripts/). The .env file lives at the project root, one level up.
//   path.resolve(__dirname, '..', '.env') always points correctly
//   regardless of where you run the script from in your terminal.

function loadAuthToken(): string {
  const envPath = path.resolve(__dirname, '..', '.env');

  // If .env doesn't exist at all, fail immediately with a clear message.
  if (!fs.existsSync(envPath)) {
    console.error(`\n  ✗ .env not found at: ${envPath}`);
    console.error('  Make sure you\'re in the NerdAlert project directory.\n');
    process.exit(1);
  }

  // Read the whole file and split into lines.
  // Filter to find the SERVER_AUTH_TOKEN line.
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const tokenLine = lines.find(line => line.startsWith('SERVER_AUTH_TOKEN='));

  if (!tokenLine) {
    console.error('\n  ✗ SERVER_AUTH_TOKEN not found in .env\n');
    process.exit(1);
  }

  // Split on the first = sign only.
  // This handles values that contain = characters (though tokens usually don't).
  const token = tokenLine.split('=').slice(1).join('=').trim();

  if (!token) {
    console.error('\n  ✗ SERVER_AUTH_TOKEN is empty in .env\n');
    process.exit(1);
  }

  return token;
}


// ---- CONVERSATION HISTORY ----
// This is the in-memory record of the current session.
// Every turn appends two entries: the user's message and the agent's reply.
// We send this array with every request so the agent has full context.
//
// Shape matches the Anthropic API message format:
//   { role: 'user' | 'assistant', content: string }
//
// When the user types /clear, this array is emptied.
// When the process exits, it's gone — sessions are intentionally not persisted.
// (Memory persistence is the memory engine's job, not the REPL's.)

type ConversationEntry = {
  role: 'user' | 'assistant';
  content: string;
};

let conversationHistory: ConversationEntry[] = [];


// ---- HEALTH CHECK ----
// Before starting the REPL loop, we ping /health to confirm
// the NerdAlert server is running and reachable.
//
// Why check health first?
//   Without this, if the server is down, the user types their first
//   message and waits, then gets a cryptic connection refused error.
//   A health check at startup makes the failure immediate and clear.
//
// fetch() is built into Node.js 18+. No import needed.

async function checkHealth(token: string): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }

    // The health endpoint returns { status, agent, trust_level, timestamp }
    // We just want the agent name for the banner.
    const data = await res.json() as { agent?: string };
    return data.agent ?? 'NerdAlert Agent';

  } catch {
    // fetch throws if the server is unreachable (connection refused, etc.)
    console.error(`\n  ✗ Could not connect to NerdAlert server at ${BASE_URL}`);
    console.error('  Is it running? Try: npm run dev\n');
    process.exit(1);
  }
}


// ---- SEND MESSAGE ----
// Sends one message to /chat and returns the agent's response content.
// Also passes the current conversationHistory so the agent has context.
//
// Return type: Promise<string>
//   We return just the content string, not the full NerdAlertResponse,
//   because the REPL only needs to display the text.
//   Error handling is done here — if anything goes wrong, we return
//   a string error message rather than throwing, so the REPL loop
//   can keep running instead of crashing.

async function sendMessage(token: string, userMessage: string): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        message:             userMessage,
        conversationHistory: conversationHistory,
        // We send the history BEFORE appending the new user message.
        // The agent appends it on its end before sending to Anthropic.
        // This matches how the server's agent.ts processes incoming requests.
      }),
    });

    if (!res.ok) {
      // Server returned a 4xx or 5xx. Try to read the error body.
      const errData = await res.json().catch(() => ({})) as { error?: string };
      return `[Error ${res.status}] ${errData.error ?? 'Server error'}`;
    }

    // Parse the NerdAlertResponse envelope
    const data = await res.json() as { content?: string; error?: string };

    if (data.error) {
      return `[Agent error] ${data.error}`;
    }

    return data.content ?? '[No response content]';

  } catch (err) {
    // Network-level failure — server went down mid-session, etc.
    return `[Connection error] ${(err as Error).message}`;
  }
}


// ---- MAIN REPL LOOP ----
// This is the entry point. Everything above is setup.
// This function runs the actual interactive session.
//
// How readline works:
//   readline.createInterface() wires together an input stream (stdin)
//   and an output stream (stdout). We use rl.question() to display
//   a prompt and wait for the user to press Enter.
//   When they do, the callback fires with the trimmed input string.
//   We then call rl.question() again at the end of the callback
//   to wait for the next input — this is the "loop" part of REPL.

async function main(): Promise<void> {

  // Load the auth token before anything else.
  // If it fails, process.exit(1) is called inside loadAuthToken().
  const token = loadAuthToken();

  // Health check — also gets the agent name for the banner.
  console.log('');
  console.log(`  ${DIM}Connecting...${RESET}`);
  const agentName = await checkHealth(token);

  printConnected();
  printBanner(agentName, SERVER_PORT);

  // Set up the readline interface.
  // process.stdin  = the keyboard input stream
  // process.stdout = the terminal output stream
  // terminal: true = enables line editing (backspace, arrow keys, etc.)
  const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: true,
  });

  // Handle Ctrl+C gracefully.
  // Without this, pressing Ctrl+C prints a raw ^C and exits without cleanup.
  // With this handler, we print a friendly message and call rl.close(),
  // which triggers the 'close' event and exits cleanly.
  rl.on('SIGINT', () => {
    console.log('');
    console.log(`  ${GRAY}Session ended.${RESET}`);
    console.log('');
    rl.close();
  });

  // The 'close' event fires when readline is done — either from rl.close()
  // or when the user types /exit. We use process.exit(0) to cleanly exit
  // (exit code 0 = success, no error).
  rl.on('close', () => {
    process.exit(0);
  });


  // ---- PROMPT FUNCTION ----
  // This is the heart of the REPL loop.
  // We define it as an inner function so it can call itself recursively —
  // after each response, prompt() is called again to wait for the next input.
  //
  // Why recursive instead of a while loop?
  //   rl.question() is async and callback-based. A while loop would need
  //   to be wrapped in a Promise to await each input. The recursive pattern
  //   is cleaner here — each call to prompt() handles exactly one turn,
  //   then kicks off the next turn by calling itself again.

  function prompt(): void {

    // rl.question(displayString, callback)
    // Prints the displayString (the prompt) and waits for Enter.
    // The callback receives whatever the user typed, trimmed of newline.
    rl.question(PROMPT_SYMBOL, async (rawInput: string) => {

      // Trim whitespace from both ends — handles accidental spaces, etc.
      const input = rawInput.trim();

      // Empty input — user just hit Enter with nothing typed.
      // Do nothing, just show the prompt again.
      if (!input) {
        prompt();
        return;
      }

      // ---- COMMAND HANDLING ----
      // Commands start with / and are handled locally — no server call needed.

      if (input === '/exit' || input === '/quit') {
        console.log('');
        console.log(`  ${GRAY}Session ended.${RESET}`);
        console.log('');
        rl.close();
        return; // Don't call prompt() — we're exiting
      }

      if (input === '/clear') {
        conversationHistory = [];
        printCleared();
        prompt();
        return;
      }

      if (input === '/help') {
        console.log('');
        console.log(`  ${GRAY}Commands:${RESET}`);
        console.log(`  ${GRAY}/clear  — start a fresh conversation${RESET}`);
        console.log(`  ${GRAY}/exit   — quit the session${RESET}`);
        console.log(`  ${GRAY}/help   — show this message${RESET}`);
        console.log('');
        prompt();
        return;
      }

      // ---- SEND TO AGENT ----
      // Not a command — treat as a chat message.
      // 1. Append to history as a user turn AFTER sending (see sendMessage comment)
      // 2. Send to the server
      // 3. Append the agent's response to history
      // 4. Display the response
      // 5. Call prompt() again for the next turn

      const agentResponse = await sendMessage(token, input);

      // Check if sendMessage returned an error string.
      // Error strings start with [Error or [Connection — display them differently.
      if (agentResponse.startsWith('[Error') || agentResponse.startsWith('[Connection') || agentResponse.startsWith('[Agent')) {
        printError(agentResponse);
      } else {
        // Success — update history and display
        conversationHistory.push({ role: 'user',      content: input });
        conversationHistory.push({ role: 'assistant', content: agentResponse });
        printAgentResponse(agentName, agentResponse);
      }

      // Start the next turn
      prompt();
    });
  }

  // Kick off the first turn
  prompt();
}


// ---- ENTRY POINT ----
// Calling main() and catching any unhandled promise rejections.
// In practice, main() handles its own errors, but this is a safety net.
// If something truly unexpected goes wrong at the top level, we print it
// clearly instead of letting Node.js dump an UnhandledPromiseRejection warning.

main().catch((err: unknown) => {
  console.error('\n  ✗ Fatal error:', (err as Error).message ?? err);
  process.exit(1);
});
