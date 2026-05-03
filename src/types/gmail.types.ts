// ============================================================
// src/types/gmail.types.ts  — Phase 4: Gmail + Calendar Types
// ============================================================
// All type definitions for the Gmail and Calendar modules.
// Every other file in src/gmail/ imports from here.
//
// Same rule as memory.types.ts:
//   Change a field here → compile error everywhere it's used.
//   That's intentional. It forces conscious updates.
// ============================================================

// ── Email address shape ───────────────────────────────────────────────────────
export interface EmailAddress {
  name:    string   // display name — may be empty
  address: string   // the actual email address
}

// ── A message as returned from the IMAP server ────────────────────────────────
// This is the summary shape — fields needed for triage and listing.
// Full body content is only fetched when explicitly requested (fetchMessage).
export interface GmailMessage {
  uid:        number          // IMAP UID — used for all subsequent operations
  messageId:  string | null   // RFC 2822 Message-ID header — used for threading
  subject:    string
  from:       EmailAddress[]
  to:         EmailAddress[]
  date:       Date | null
  flags:      string[]        // IMAP flags: ['\\Seen'], ['\\Flagged'], etc.
}

// ── Full message — returned by fetchMessage() ─────────────────────────────────
export interface GmailFullMessage {
  summary:     GmailMessage
  raw: {
    from:          EmailAddress[]
    to:            EmailAddress[]
    cc:            EmailAddress[]
    replyTo:       EmailAddress[]
    fromHeader:    string          // formatted "Name <email>" for reply headers
    replyToHeader: string
  }
  text:        string             // plain-text body
  html:        string | null      // HTML body, truncated to 20KB
  attachments: GmailAttachment[]
}

// ── Attachment metadata ───────────────────────────────────────────────────────
export interface GmailAttachment {
  filename:    string | undefined
  contentType: string
  size:        number
}

// ── Triage classification result ─────────────────────────────────────────────
// Produced by classifyMessage(). Drives both triage output and cleanup routing.
export type MessageCategory =
  | 'inbox'           // stays in inbox — personal, security, bills, orders
  | 'vinyl-preorders' // vinyl order / tracking → Vinyl Preorders folder
  | 'coupons'         // promotional mail → Coupons folder + mark read
  | 'review'          // non-urgent, non-promo → Review folder

export type MessageSubtype =
  | 'security'
  | 'bill'
  | 'personal'
  | 'amazon-order'
  | 'amazon-return'
  | 'vinyl-order'
  | 'vinyl-tracking'
  | 'transactional-other'
  | 'newsletter'
  | 'promotion'
  | 'general-other'

export interface ClassificationResult {
  category: MessageCategory
  subtype:  MessageSubtype
  action:   string           // human-readable description of what to do
}

// ── A triaged message — original message plus its classification ──────────────
export interface TriagedMessage extends GmailMessage {
  triage: ClassificationResult
}

// ── Triage groups — result of triageMessages() ───────────────────────────────
export interface TriageGroups {
  urgent:        TriagedMessage[]  // security + billing items
  inbox:         TriagedMessage[]
  vinylPreorders: TriagedMessage[]
  coupons:       TriagedMessage[]
  review:        TriagedMessage[]
}

export interface TriageSummary {
  total:          number
  urgent:         number
  inbox:          number
  vinylPreorders: number
  coupons:        number
  review:         number
}

export interface TriageResult {
  summary:            TriageSummary
  grouped:            TriageGroups
  humanSummary:       string   // full formatted text block for the agent
  compactSummary:     string   // one-liner version
  cleanupSuggestions: CleanupSuggestion[]
}

// ── Cleanup suggestion ────────────────────────────────────────────────────────
export interface CleanupSuggestion {
  type:   'cleanup' | 'review'
  text:   string
  target: string
}

// ── Draft shape ───────────────────────────────────────────────────────────────
// Returned by createDraft() and createReplyDraft() before approval.
// The rawDraft contains unredacted addresses for actual sending.
// The draft field is redacted for display to the agent.
export interface DraftResult {
  ok:              boolean
  approvalRequired: true
  draft: {
    to:          string
    cc:          string
    bcc:         string
    subject:     string
    body:        string
    inReplyTo:   string
    references:  string
  }
  rawDraft: {
    to:          string
    cc:          string
    bcc:         string
    subject:     string
    body:        string
    inReplyTo:   string
    references:  string
  }
  replyContext?: ReplyContext
}

export interface ReplyContext {
  mailbox:           string
  originalUid:       number
  originalMessageId: string | null
  originalSubject:   string
  replyTo:           EmailAddress[]
}

// ── Move / mark-read operation results ───────────────────────────────────────
export interface MoveResult {
  ok:          boolean
  fromMailbox: string
  destination: string
  messageId:   number
  verification: MoveVerification
}

export interface MoveVerification {
  sourceMessageId:        string | null
  sourceSubject:          string
  sourceDate:             Date | null
  sourceStillHasUid:      boolean
  destinationUidMatches:  number[]
}

// ── Snooze entry ──────────────────────────────────────────────────────────────
export interface SnoozeEntry {
  uid:          number
  messageId:    string | null
  subject:      string
  from:         EmailAddress[]
  subtype:      MessageSubtype
  mailbox:      string
  snoozedAt:    string     // ISO 8601
  surfaceAfter: string | null  // null = surface on every digest until cleared
  cleared:      boolean
  clearedAt?:   string
}

// ── Calendar event ────────────────────────────────────────────────────────────
export interface CalendarEvent {
  id:               string
  title:            string
  location:         string
  start:            string    // ISO 8601
  attendeeEmails:   string[]
  attendeeDomains:  string[]
}

// ── Calendar match result ─────────────────────────────────────────────────────
export interface CalendarMatch {
  eventTitle: string
  eventStart: string
  reason:     string
}

// ── Gmail config — loaded from the secrets file ───────────────────────────────
// This shape lives in .env-referenced JSON, never in the repo.
// See references/gmail-setup.md for the full documented structure.
export interface GmailConfig {
  accountId: string
  provider:  string
  email:     string
  imap: {
    host: string
    port: number
    tls:  boolean
  }
  smtp: {
    host:   string
    port:   number
    secure: boolean
  }
  auth: {
    user:        string
    appPassword: string  // Google App Password — 16 chars, never a real password
  }
  defaults?: {
    mailbox:      string
    maxListLimit: number
  }
  logging?: {
    path:         string
    metadataOnly: boolean
  }
  signature?: {
    text: string   // appended to drafts and outgoing mail
  }
  snooze?: {
    statePath: string
  }
}

// ── Calendar config — loaded from a separate secrets file ─────────────────────
export interface CalendarConfig {
  clientId:      string
  clientSecret:  string
  refreshToken:  string
  calendarId:    string   // 'primary' or a specific calendar ID
  lookAheadDays: number
}
