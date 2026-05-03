// ============================================================
// scripts/chat-utils.ts
// ============================================================
// Visual helpers for the NerdAlert REPL terminal client.
//
// Everything in here is purely about how things LOOK.
// No API calls, no business logic, no config loading.
// The main chat.ts file imports from here so it can stay
// focused on the conversation loop itself.
//
// Why a separate file?
//   Separation of concerns. If you ever want to change the
//   color scheme, tweak the banner, or adjust how Sherman's
//   responses display — you do it here, in one place, without
//   touching a single line of conversation logic.
// ============================================================


// ---- ANSI COLOR CODES ----
// Terminals understand "ANSI escape codes" — invisible character
// sequences that tell the terminal to change text color, weight,
// or style. They always start with \x1b[ and end with m.
//
// \x1b   = the ESC character (ASCII 27, hex 1B)
// [      = opening bracket — part of the escape sequence syntax
// 0m     = reset all formatting back to default
// 1m     = bold
// 36m    = cyan (used for Sherman's name)
// 33m    = yellow (used for the user prompt)
// 90m    = bright black = dark gray (used for metadata/separators)
// 32m    = green (used for success messages)
// 31m    = red (used for errors)
//
// How it works in practice:
//   console.log(`${CYAN}hello${RESET}`) prints "hello" in cyan.
//   Without the RESET at the end, everything after also turns cyan.

export const RESET  = '\x1b[0m';
export const BOLD   = '\x1b[1m';
export const CYAN   = '\x1b[36m';
export const YELLOW = '\x1b[33m';
export const GRAY   = '\x1b[90m';
export const GREEN  = '\x1b[32m';
export const RED    = '\x1b[31m';
export const DIM    = '\x1b[2m';


// ---- BANNER ----
// Printed once when the REPL starts up.
// Tells the user what they're connected to and what commands exist.
// Keeps the main file's startup block clean.

export function printBanner(agentName: string, port: number): void {

  // The separator line — 60 dashes, printed in gray so it's visible
  // but doesn't compete with the content.
  const line = `${GRAY}${'─'.repeat(60)}${RESET}`;

  console.log('');
  console.log(line);
  console.log(`  ${BOLD}${CYAN}NERDALERT${RESET} ${GRAY}///${RESET} Terminal Interface`);
  console.log(`  ${GRAY}Agent  :${RESET} ${agentName}`);
  console.log(`  ${GRAY}Port   :${RESET} ${port}`);
  console.log(`  ${GRAY}Session:${RESET} ${new Date().toLocaleTimeString()}`);
  console.log(line);
  console.log(`  ${DIM}Type your message and press Enter. Commands:${RESET}`);
  console.log(`  ${DIM}/clear  — start a fresh conversation${RESET}`);
  console.log(`  ${DIM}/exit   — quit the session${RESET}`);
  console.log(`  ${DIM}Ctrl+C  — force quit${RESET}`);
  console.log(line);
  console.log('');
}


// ---- SESSION CLEARED ----
// Visual feedback when the user types /clear.
// Brief, doesn't clutter the terminal.

export function printCleared(): void {
  console.log('');
  console.log(`  ${GRAY}─── Session cleared ───${RESET}`);
  console.log('');
}


// ---- ERROR MESSAGE ----
// Used when the HTTP request to the server fails, or when
// the server returns a non-200 status. Prints in red so
// it's immediately distinct from normal output.

export function printError(message: string): void {
  console.log('');
  console.log(`  ${RED}✗ ${message}${RESET}`);
  console.log('');
}


// ---- CONNECTION CHECK ----
// Printed before the banner if the health check passes.
// Brief confirmation so the user knows the server is alive.

export function printConnected(): void {
  console.log(`  ${GREEN}✓ Connected${RESET}`);
}


// ---- FORMAT SHERMAN RESPONSE ----
// Takes the raw content string from the API response and
// prints it in a visually distinct block.
//
// Why format it here instead of just console.log(content)?
//   The agent name label, spacing, and color treatment make it
//   immediately clear whose "voice" each line is — especially
//   useful when you're scrolling back through a long session.

export function printAgentResponse(agentName: string, content: string): void {
  console.log('');

  // Agent name label — cyan and bold, followed by a dim colon
  // e.g. "  Sherman  "
  console.log(`  ${BOLD}${CYAN}${agentName}${RESET}`);
  console.log('');

  // The response content itself.
  // We indent each line by two spaces to give it a visual margin
  // that differentiates it from the shell prompt on the left.
  const lines = content.split('\n');
  for (const line of lines) {
    console.log(`  ${line}`);
  }

  console.log('');
}


// ---- USER PROMPT SYMBOL ----
// The string that appears before the user's input cursor.
// e.g.:  "> "
// Keeping it as a named export means if you ever want to change
// the prompt style, one character here updates it everywhere.

export const PROMPT_SYMBOL = `${YELLOW}>${RESET} `;
