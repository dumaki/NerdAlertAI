// ============================================================
// src/gmail/classifier.ts  — Phase 4: Email Classifier
// ============================================================
// Classifies incoming messages into actionable categories.
// Ported from Sherman's mail_client.js — the most valuable
// piece of the original build. Tuning history preserved.
//
// Philosophy (from CLASSIFICATION.md):
//   - False positives on transactional mail are WORSE than
//     leaving a promo in the inbox. When in doubt, don't move.
//   - Uses score-based logic, NOT first-match cascade.
//     This makes it safer to tune one signal at a time.
//   - Promo score vs. transactional score compete.
//     Promos only win when promo score is high AND
//     transactional score is low.
//
// Ben-specific rules preserved:
//   - Vinyl orders/tracking → Vinyl Preorders folder
//   - Retail promo mail → Coupons folder + mark read
//   - Non-promo general mail → Review folder
//   - Orders, bills, security, personal → stay in Inbox
//   - Shopify mail: only transactional when subject clearly says so
//
// To tune safely: change ONE list at a time. Test on known
// real messages. Document edge cases in CLASSIFICATION.md.
// ============================================================

import {
  GmailMessage,
  ClassificationResult,
  TriagedMessage,
  TriageResult,
  TriageGroups,
  TriageSummary,
  CleanupSuggestion,
} from '../types/gmail.types'

// ── Stop words — excluded from keyword matching ───────────────────────────────
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'in', 'on', 'at', 'to', 'of',
  'is', 'are', 'your', 'our', 'with', 'from', 'has', 'have', 'this',
  'that', 'will', 'be', 'it', 'we', 're', 'new', 'was', 'not', 'you',
])

// ── Helpers ───────────────────────────────────────────────────────────────────

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
}

function senderAddress(message: GmailMessage): string {
  return ((message.from[0])?.address ?? '').toLowerCase()
}

function senderName(message: GmailMessage): string {
  return ((message.from[0])?.name ?? '').trim().toLowerCase()
}

function senderDomain(message: GmailMessage): string {
  const address = senderAddress(message)
  return address.includes('@') ? address.split('@')[1] : address
}

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some(p => text.includes(p))
}

function includesPhrase(text: string, phrases: string[]): boolean {
  return phrases.some(phrase => {
    const escaped    = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const normalized = escaped.replace(/\\ /g, '\\s+')
    const regex      = new RegExp(`(^|[^a-z0-9])${normalized}([^a-z0-9]|$)`)
    return regex.test(text)
  })
}

// ── Keyword lists ─────────────────────────────────────────────────────────────
// Kept separate from logic so they can be tuned without touching rules.

const SECURITY_KEYWORDS    = ['security alert', 'verify', 'password', '2-step', 'signin', 'sign-in', 'login', 'access to your']
const ORDER_KEYWORDS       = ['delivered', 'shipped', 'out for delivery', 'arriving', 'your order', 'order confirmed', 'tracking', 'has been delivered', 'shipment', 'package', 'delivery update']
const VINYL_KEYWORDS       = ['vinyl', 'lp', 'record', 'records', 'turntable lab', 'waxwork', 'iam8bit', 'enjoy the ride', 'pre-order', 'preorder']
const AMAZON_KEYWORDS      = ['amazon', 'amazon.com', 'amazon orders', 'amazon returns', 'return request', 'return received', 'refund issued']
const BILL_KEYWORDS        = ['invoice', 'receipt', 'bill', 'payment due', 'charged', 'renewal', 'payment received', 'subscription renewal']

const PROMO_KEYWORDS = [
  '% off', 'sale', 'save', 'discount', 'deal', 'offer', 'special', 'final hours',
  'last day', 'ends today', 'ends tomorrow', 'weekly ad', 'daily pick', 'spring sale',
  'semi-annual sale', 'exclusive', 'giveaway', 'new arrivals', 'shop now', 'shop new',
  'today only', 'one day only', 'starts at midnight', 'in-stock event', 'march madness sale',
  'up to ', 'all markdowns', 'last chance', 'now available', 'pre-orders now open',
  'preorders now open', 'is here', 'newsletter', 'for you', 'new skills',
  'career opportunities', 'spring newsletter', 'wishlist', 'on sale', 'fresh deals',
  'members', 'dream team',
]

const PROMO_REVIEW_KEYWORDS = [
  'sign up today', 'meals delivered', 'limited time', 'shop', 'shop now', 'try',
  'discover', 'order now', 'huge savings', 'savings inside', 'available now', 'no joke',
  'real savings', 'equip your business', 'monthly:', 'monthly newsletter', 'fares',
  'you inspired these picks', 'near you', 'concert lineup', 'lineup:', 'pre-owned',
  're-loved', 'new opportunity to apply',
]

const NEWSLETTER_KEYWORDS      = ['breaking news', 'daily digest', 'morning briefing', 'newsletter', 'news briefing', 'top stories', 'morning newsletter']
const MARKETING_SENDER_KEYWORDS = ['marketing', 'promo', 'offers', 'newsletter', 'news', 'deals', 'sale']

// ── Domain lists ──────────────────────────────────────────────────────────────

const RETAIL_DOMAINS = [
  'express.com', 'waves-audio.com', 'homechef.com', 'guitarcenter.com',
  'bananarepublicfactory.com', 'vessi.com', 'seatgeek.com', 'target.com',
  'crateandbarrel.com', 'chewy.com', 'uber.com', 'cabelas.com', 'allbirds.com',
  'tovala.com', 'donatos.com', 'nafnafgrill.com', 'longhornsteakhouse.com',
  'bedbathandbeyond.com', 'surlatable.com', 'discogs.com', 'goldbelly.com',
  'enjoytheriderecords.com', 'iam8bit.com', 'udemymail.com', 'pstr.studio',
  'edx.org', 'afterpay.com', 'upgrade.com', 'drinkolipop.com', 'linkedin.com',
  'steampowered.com', 'malwarebytes.com', 'patagonia.com',
]

const PERSONAL_DOMAINS      = ['gmail.com', 'icloud.com', 'yahoo.com', 'outlook.com']
const NEWSLETTER_DOMAINS    = ['nytimes.com']
const TRANSACTIONAL_DOMAINS = ['amazon.com', 'paypal.com', 'stripe.com']

// ── Main classifier ───────────────────────────────────────────────────────────
// Returns a ClassificationResult for a single message.
// This function is the core of everything — triage, cleanup, and digest
// all depend on it. Keep it correct before keeping it fast.
export function classifyMessage(message: GmailMessage): ClassificationResult {
  const subject = (message.subject ?? '').toLowerCase()
  const from    = senderAddress(message)
  const name    = senderName(message)
  const domain  = senderDomain(message)

  // ── Strong direct categories — short-circuit before scoring ──────────────

  // Security: these must surface regardless of anything else
  if (
    includesAny(subject, SECURITY_KEYWORDS) ||
    includesAny(from, ['accounts.google.com', 'no-reply@accounts.google.com'])
  ) {
    return { category: 'inbox', subtype: 'security', action: 'review promptly' }
  }

  // Bills: payment domains short-circuit too
  if (
    includesPhrase(subject, BILL_KEYWORDS) ||
    includesAny(domain, ['paypal.com', 'stripe.com'])
  ) {
    return { category: 'inbox', subtype: 'bill', action: 'review transaction or file' }
  }

  // Personal: common personal email providers stay in inbox
  if (includesAny(domain, PERSONAL_DOMAINS)) {
    return { category: 'inbox', subtype: 'personal', action: 'read normally' }
  }

  // Amazon transactional: orders and returns stay visible
  const isAmazon =
    includesAny(domain, ['amazon.com', 'amazonpayments.com']) ||
    includesAny(from, AMAZON_KEYWORDS) ||
    includesAny(subject, AMAZON_KEYWORDS)

  if (isAmazon && (
    includesAny(subject, ORDER_KEYWORDS) ||
    includesAny(subject, ['return', 'refund']) ||
    includesAny(from, ['auto-confirm@amazon.com', 'shipment-tracking@amazon.com'])
  )) {
    const subtype = (subject.includes('return') || subject.includes('refund'))
      ? 'amazon-return'
      : 'amazon-order'
    return { category: 'inbox', subtype, action: 'keep in inbox until resolved' }
  }

  // Vinyl transactional: order/tracking mail → Vinyl Preorders folder
  const isVinylSender =
    includesAny(domain, ['shopifyemail.com', 'enjoytheriderecords.com', 'iam8bit.com', 'merchnow.com', 'bandcamp.com', 'vinylmeplease.com']) ||
    includesAny(name, ['enjoy the ride', 'iam8bit', 'vinyl', 'records'])
  const isVinylSubject  = includesAny(subject, VINYL_KEYWORDS)
  const isVinylTransactional = (isVinylSender || isVinylSubject) &&
    includesAny(subject, [...ORDER_KEYWORDS, 'order #', 'receipt', 'confirmation', 'confirmed'])

  if (isVinylTransactional) {
    const subtype = (subject.includes('tracking') || subject.includes('shipped') || subject.includes('delivered'))
      ? 'vinyl-tracking'
      : 'vinyl-order'
    return { category: 'vinyl-preorders', subtype, action: 'move to Vinyl Preorders' }
  }

  // Shopify refinement: only transactional when subject clearly says so
  // (Shopify sends both storefront marketing AND real order events)
  if (domain === 'shopifyemail.com') {
    if (includesAny(subject, [...ORDER_KEYWORDS, 'pre-order', 'preorder', 'order #', 'receipt', 'confirmation'])) {
      if (isVinylSubject) {
        return { category: 'vinyl-preorders', subtype: 'vinyl-order', action: 'move to Vinyl Preorders' }
      }
      return { category: 'review', subtype: 'transactional-other', action: 'move to Review' }
    }
  }

  // ── Score-based classification for everything else ────────────────────────
  // Promo and transactional scores compete.
  // Promos only win when promoScore >= 2 AND transactionalScore < 3.

  let promoScore        = 0
  let transactionalScore = 0

  if (includesAny(subject, PROMO_KEYWORDS)) promoScore += 2
  if (includesAny(domain, RETAIL_DOMAINS))  promoScore += 2
  if (includesAny(name, [
    'express', 'waves audio', 'guitar center', 'banana republic factory',
    'home chef', 'seatgeek', 'bed bath & beyond', 'sur la table', 'target',
    'crate & barrel', 'chewy', 'allbirds', "cabela's", 'longhorn steakhouse',
    'naf naf grill', 'goldbelly', 'enjoy the ride records store', 'iam8bit',
    'udemy instructor', 'edx team', 'afterpay', 'upgrade', 'olipop', 'linkedin',
  ])) promoScore += 1
  if (includesAny(from, MARKETING_SENDER_KEYWORDS) || includesAny(name, MARKETING_SENDER_KEYWORDS)) promoScore += 1

  if (includesAny(subject, ORDER_KEYWORDS))  transactionalScore += 3
  if (includesAny(subject, BILL_KEYWORDS))   transactionalScore += 3
  if (includesAny(subject, ['account', 'verification', 'reset', 'statement', 'due'])) transactionalScore += 2
  if (includesAny(domain, TRANSACTIONAL_DOMAINS)) transactionalScore += 2

  // Newsletters: move to Review (not Coupons — these are readable)
  if (includesAny(subject, NEWSLETTER_KEYWORDS) || includesAny(domain, NEWSLETTER_DOMAINS)) {
    return { category: 'review', subtype: 'newsletter', action: 'move to Review' }
  }

  // Strong promo-review signals → Coupons
  if (
    includesAny(subject, PROMO_REVIEW_KEYWORDS) ||
    includesAny(from, ['promo.', 'marketing.', 'newsletter.', 'updates.', 'offers.'])
  ) {
    return { category: 'coupons', subtype: 'promotion', action: 'move to Coupons and mark read' }
  }

  // Score decision: promos win only when clearly promotional AND not transactional
  if (promoScore >= 2 && transactionalScore < 3) {
    return { category: 'coupons', subtype: 'promotion', action: 'move to Coupons and mark read' }
  }

  return { category: 'review', subtype: 'general-other', action: 'move to Review' }
}

// ── Triage a list of messages ─────────────────────────────────────────────────
// Groups classified messages into buckets and generates summaries.
export function triageMessages(messages: GmailMessage[]): TriageResult {
  const grouped: TriageGroups = {
    urgent:         [],
    inbox:          [],
    vinylPreorders: [],
    coupons:        [],
    review:         [],
  }

  for (const message of messages) {
    const triage = classifyMessage(message)
    const item: TriagedMessage = { ...message, triage }

    switch (triage.category) {
      case 'inbox':           grouped.inbox.push(item);          break
      case 'vinyl-preorders': grouped.vinylPreorders.push(item); break
      case 'coupons':         grouped.coupons.push(item);        break
      default:                grouped.review.push(item);         break
    }

    if (triage.subtype === 'security' || triage.subtype === 'bill') {
      grouped.urgent.push(item)
    }
  }

  const summary: TriageSummary = {
    total:          messages.length,
    urgent:         grouped.urgent.length,
    inbox:          grouped.inbox.length,
    vinylPreorders: grouped.vinylPreorders.length,
    coupons:        grouped.coupons.length,
    review:         grouped.review.length,
  }

  return {
    summary,
    grouped,
    humanSummary:       buildHumanTriageSummary(summary, grouped),
    compactSummary:     buildCompactSummary(summary),
    cleanupSuggestions: buildCleanupSuggestions(grouped),
  }
}

// ── Summary formatters ────────────────────────────────────────────────────────

function formatSummaryLine(label: string, items: TriagedMessage[], maxExamples = 2): string | null {
  if (!items.length) return null
  const examples = items.slice(0, maxExamples).map(item => {
    const from = item.from[0]?.name || item.from[0]?.address || 'Unknown'
    return `${from} — ${item.subject}`
  })
  return `- ${label} (${items.length}): ${examples.join(' | ')}`
}

function buildCleanupSuggestions(grouped: TriageGroups): CleanupSuggestion[] {
  const suggestions: CleanupSuggestion[] = []
  if (grouped.coupons.length >= 1)
    suggestions.push({ type: 'cleanup', text: `Move ${grouped.coupons.length} promo message${grouped.coupons.length === 1 ? '' : 's'} to Coupons and mark read.`, target: 'Coupons' })
  if (grouped.vinylPreorders.length > 0)
    suggestions.push({ type: 'cleanup', text: `Move ${grouped.vinylPreorders.length} vinyl order/tracking message${grouped.vinylPreorders.length === 1 ? '' : 's'} to Vinyl Preorders.`, target: 'Vinyl Preorders' })
  if (grouped.review.length > 0)
    suggestions.push({ type: 'cleanup', text: `Move ${grouped.review.length} non-promo message${grouped.review.length === 1 ? '' : 's'} to Review after you skim them.`, target: 'Review' })
  if (grouped.urgent.length > 0)
    suggestions.push({ type: 'review', text: 'Security/billing items are worth a quick glance before filing anything.', target: 'inbox-review' })
  return suggestions
}

function buildHumanTriageSummary(summary: TriageSummary, grouped: TriageGroups): string {
  const lines: string[] = []
  lines.push(`Inbox triage: ${summary.total} message${summary.total === 1 ? '' : 's'} reviewed.`)

  if (summary.urgent > 0) {
    lines.push(`${summary.urgent} urgent item${summary.urgent === 1 ? '' : 's'} need attention.`)
  } else {
    lines.push('No urgent items jumped out. Miracles happen.')
  }

  const sections = [
    formatSummaryLine('Keep in Inbox', grouped.inbox),
    formatSummaryLine('Vinyl Preorders', grouped.vinylPreorders),
    formatSummaryLine('Coupons', grouped.coupons),
    formatSummaryLine('Review', grouped.review),
  ].filter(Boolean) as string[]

  if (sections.length) {
    lines.push('')
    lines.push(...sections)
  }

  const suggestions = buildCleanupSuggestions(grouped)
  if (suggestions.length) {
    lines.push('')
    lines.push('Suggested actions:')
    for (const s of suggestions) lines.push(`- ${s.text}`)
  }

  return lines.join('\n')
}

function buildCompactSummary(summary: TriageSummary): string {
  const chunks: string[] = []
  if (summary.inbox)          chunks.push(`${summary.inbox} inbox`)
  if (summary.vinylPreorders) chunks.push(`${summary.vinylPreorders} vinyl`)
  if (summary.coupons)        chunks.push(`${summary.coupons} coupon${summary.coupons === 1 ? '' : 's'}`)
  if (summary.review)         chunks.push(`${summary.review} review`)
  if (summary.urgent)         chunks.push(`${summary.urgent} urgent`)

  const lead = `${summary.total} messages reviewed`
  if (!chunks.length) return `${lead}. Nothing interesting surfaced.`
  return `${lead} — ${chunks.join(', ')}.`
}
