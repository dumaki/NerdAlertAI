// ============================================================
// tools/builtin/currency-tool.ts
// ============================================================
// Live currency conversion via the Frankfurter API. Closes Q1
// checklist item q1-units (currency half — unit conversion is
// already covered by the calculator tool's mathjs unit support).
//
// Why this tool exists:
//   The calculator handles unit conversion (km↔mi, kg↔lb,
//   °C↔°F) because those ratios are static. Currency rates
//   move daily and the model has no way to know today's rate
//   from its training data alone. A dedicated tool that hits a
//   live FX source eliminates "what's 100 USD in EUR today?"
//   as a hallucination category, just like the calculator
//   eliminated arithmetic hallucinations.
//
// Trust level: L1.
//   Outbound HTTP only. No auth, no credentials, no write access,
//   no user data leaves the box. Same trust profile as the web,
//   weather, wikipedia, and maps tools.
//
// ─── Why Frankfurter and not exchangerate.host ──────────────
// The Q1 checklist line read "Currency + unit conversion —
// exchangerate.host for FX". Between when that was written and
// when this tool was built, exchangerate.host was acquired by
// APILayer and went freemium: every endpoint now requires an
// access_key from a signup flow. That breaks our keyless L1
// pattern (weather, web, wikipedia, maps are all keyless — no
// signup, no per-user setup step).
//
// Frankfurter (https://api.frankfurter.dev) is the de facto
// successor across the homelab community: same JSON shape as
// the pre-paywall exchangerate.host, open source, ECB reference
// rates as the data source, no key, no signup. ECB publishes
// daily ~16:00 CET so 30+ major currency pairs are accurate to
// the same precision banks use for reference quotes. Crypto
// and exotic pairs are NOT covered — by design.
//
// ─── The Frankfurter seam ───────────────────────────────────
// Future work: a self-hosted Frankfurter instance (their Docker
// image is one container, ECB feed updates nightly) would
// remove the public-API dependency entirely. To make that swap
// painless, ALL Frankfurter calls in this file go through ONE
// function: fetchLatestRate(). The rest of the tool talks only
// to that function.
//
// When self-hosting lands, fetchLatestRate becomes a thin
// router that picks between the public API and the local
// instance based on config.currency.mode. Tool surface stays
// byte-identical. Agent never notices.
//
// Until then: today's chokepoint IS the implementation. YAGNI.
// ============================================================

import { NerdAlertTool, NerdAlertResponse, Source } from '../../types/response.types';

// ── Configuration ─────────────────────────────────────────────

// Frankfurter v1 base. v1 is the stable surface; v2 added a
// direct rate endpoint we don't need (we only ever ask for
// one symbol at a time, which v1 handles cleanly via the
// symbols query parameter).
const FRANKFURTER_BASE   = 'https://api.frankfurter.dev/v1';
const REQUEST_TIMEOUT_MS = 8_000;     // same generous budget as wikipedia

// Frankfurter doesn't publish a hard rate limit and ECB only
// updates daily, so 1 hour of caching is plenty fresh while
// being polite. Same TTL as the wikipedia summary cache.
const CACHE_TTL_MS = 60 * 60 * 1000;

// Descriptive User-Agent — same lesson as CrowdSec from v0.5.5
// and Nominatim from v0.5.20. Anonymous UAs may get throttled
// or rejected with misleading errors.
const NERDALERT_UA = 'NerdAlertAI/0.5.21 (https://github.com/dumaki/NerdAlertAI)';

// In-process rate cache keyed by "FROM>TO". Bidirectional rates
// are NOT linked — USD>EUR and EUR>USD live in separate entries
// because ECB publishes a base-relative quote and we don't want
// to invert manually (rounding drift on 6-decimal rates over a
// large amount produces visible cent-level error).
const RATE_CACHE = new Map<string, { at: number; rate: number; date: string }>();

// ── ISO 4217 + natural-language currency name map ─────────────
// The tool's `from` and `to` params take ISO 4217 three-letter
// codes (USD, EUR, GBP, JPY, etc.). The intent-prefetch extractor
// will pass codes directly when the user types them, but it also
// normalizes common English currency names into codes ahead of
// time so the tool itself only ever sees codes.
//
// Frankfurter v1 covers the ECB's ~30 majors. The map below
// covers the natural-language names users actually say. Codes
// the user types but that aren't in the ECB feed will surface
// as a clean "unsupported currency" message rather than a 404.
//
// Exported for the intent-prefetch group's paramExtractor to
// share the same normalization, avoiding drift between the
// pre-call extraction and the tool's input expectations.

// Known ECB-feed currency codes. Used as the gate for accepting
// 3-letter input as a currency — without this, anything matching
// /^[a-z]{3}$/ (API, CEO, URL, USB...) would be passed through to
// Frankfurter for validation, which wastes a round trip AND lets
// the intent-prefetch extractor (which uses the same normalizer)
// false-positive on every 3-letter acronym in the user's message.
//
// This list is Frankfurter v1's published coverage. Update if
// the upstream feed adds new currencies.
export const KNOWN_CURRENCY_CODES: ReadonlySet<string> = new Set([
  'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP',
  'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR',
  'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD',
  'ZAR',
]);

export const CURRENCY_NAME_TO_CODE: Record<string, string> = {
  // USD
  'usd':              'USD',
  'dollar':           'USD',
  'dollars':          'USD',
  'us dollar':        'USD',
  'us dollars':       'USD',
  'american dollar':  'USD',
  'american dollars': 'USD',
  // EUR
  'eur':   'EUR',
  'euro':  'EUR',
  'euros': 'EUR',
  // GBP
  'gbp':            'GBP',
  'pound':          'GBP',
  'pounds':         'GBP',
  'british pound':  'GBP',
  'british pounds': 'GBP',
  'sterling':       'GBP',
  'quid':           'GBP',
  // JPY
  'jpy':          'JPY',
  'yen':          'JPY',
  'japanese yen': 'JPY',
  // CAD
  'cad':              'CAD',
  'canadian dollar':  'CAD',
  'canadian dollars': 'CAD',
  // AUD
  'aud':                'AUD',
  'australian dollar':  'AUD',
  'australian dollars': 'AUD',
  // CHF
  'chf':         'CHF',
  'franc':       'CHF',
  'francs':      'CHF',
  'swiss franc': 'CHF',
  // CNY
  'cny':       'CNY',
  'yuan':      'CNY',
  'renminbi':  'CNY',
  'rmb':       'CNY',
  // INR
  'inr':    'INR',
  'rupee':  'INR',
  'rupees': 'INR',
  // BRL
  'brl':   'BRL',
  'real':  'BRL',
  'reais': 'BRL',
  // KRW
  'krw': 'KRW',
  'won': 'KRW',
  // ZAR
  'zar':  'ZAR',
  'rand': 'ZAR',
  // SEK
  'sek':   'SEK',
  'krona': 'SEK',
  // NOK
  'nok':   'NOK',
  'krone': 'NOK',
  // MXN — "peso" alone is ambiguous (MXN, ARS, PHP, CLP, COP).
  // We default to MXN because it's the most-asked-about by
  // English-speaking users. If a user means a different peso
  // they'll type the explicit code (ARS, PHP, etc.) and the
  // tool will accept it directly.
  'mxn':           'MXN',
  'peso':          'MXN',
  'pesos':         'MXN',
  'mexican peso':  'MXN',
  'mexican pesos': 'MXN',
};

// ── Frankfurter v1 response shape (only fields we use) ────────

interface FrankfurterLatestResponse {
  amount: number;                    // base amount we asked for (always 1 here)
  base:   string;                    // base currency code (echoed back)
  date:   string;                    // YYYY-MM-DD when ECB published the rate
  rates:  Record<string, number>;    // target code → rate
}

// ── Our internal rate shape ───────────────────────────────────
// Decoupled from the Frankfurter response so a future provider
// swap (self-hosted instance, alternative source) returns this
// shape without contortion. Same separation wikipedia uses.

interface RateLookup {
  rate:         number;   // 1 unit of `from` = `rate` units of `to`
  date:         string;   // YYYY-MM-DD when the rate was published
  fromCurrency: string;
  toCurrency:   string;
}

// ── Fetch helper ──────────────────────────────────────────────
// Same AbortController-with-timeout pattern as wikipedia and
// weather. Throws on non-2xx so callers can pattern-match on
// Error.message and on AbortError for timeout-specific UX.

async function fetchJSON<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': NERDALERT_UA,
        'Accept':     'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // Frankfurter returns 404 with a JSON {message: "not found"}
      // for unknown base currency. We don't parse the body — the
      // execute() handler turns null from fetchLatestRate into a
      // user-friendly "unsupported currency" message either way.
      throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    }
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── Currency code normalizer ──────────────────────────────────
// Accepts either an ISO 4217 three-letter code (case-insensitive)
// or a known English currency name from CURRENCY_NAME_TO_CODE.
// Returns the uppercase ISO code, or null if the input doesn't
// resolve. Used by both the tool's execute() and the intent
// prefetch extractor — sharing this function keeps the two
// surfaces in lockstep.

export function normalizeCurrencyCode(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  // ISO 4217 shape: exactly three letters. Most common case —
  // user typed "USD" or "eur". Validate against the known-good
  // ECB set so non-currency 3-letter strings (API, CEO, USB)
  // don't slip through to Frankfurter for round-trip validation
  // and so the prefetch extractor sharing this function doesn't
  // false-positive on acronyms.
  if (/^[a-z]{3}$/.test(trimmed)) {
    const upper = trimmed.toUpperCase();
    return KNOWN_CURRENCY_CODES.has(upper) ? upper : null;
  }

  // Natural-language name lookup. Multi-word names ("us dollar",
  // "japanese yen") get normalized to single spaces before lookup
  // so "US  Dollar" with extra whitespace still resolves.
  const collapsed = trimmed.replace(/\s+/g, ' ');
  const mapped    = CURRENCY_NAME_TO_CODE[collapsed];
  return mapped ?? null;
}

// ── THE CHOKEPOINT ────────────────────────────────────────────
// Every Frankfurter call in this file routes through this function.
// When self-hosted Frankfurter ships, this is the only function
// that needs to be replaced (or, more accurately, wrapped in a
// router that picks between providers).
//
// Returns null on failure or unsupported pair — the caller
// surfaces that as a clean user-facing message.

async function fetchLatestRate(
  from: string,
  to:   string,
): Promise<RateLookup | null> {

  // Same-currency shortcut. Useful when the user types
  // "USD to USD" (rare but happens with copy-paste); also
  // simplifies the response formatting because we never have
  // to special-case rate=1 in the output.
  if (from === to) {
    return {
      rate:         1,
      date:         new Date().toISOString().slice(0, 10),
      fromCurrency: from,
      toCurrency:   to,
    };
  }

  // Cache check. Bidirectional pairs cached separately — see
  // the comment above RATE_CACHE for why.
  const cacheKey = `${from}>${to}`;
  const cached   = RATE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return {
      rate:         cached.rate,
      date:         cached.date,
      fromCurrency: from,
      toCurrency:   to,
    };
  }

  // Live call. v1 /latest?base=X&symbols=Y returns a single-pair
  // response. We pass the codes already normalized to uppercase.
  const url = `${FRANKFURTER_BASE}/latest` +
    `?base=${encodeURIComponent(from)}` +
    `&symbols=${encodeURIComponent(to)}`;

  const data = await fetchJSON<FrankfurterLatestResponse>(url);
  const rate = data.rates?.[to];

  // Empty rates object means Frankfurter accepted the base but
  // didn't have the target. Defensive null check on rate handles
  // both that case and any unexpected response shape.
  if (typeof rate !== 'number' || !isFinite(rate)) {
    return null;
  }

  RATE_CACHE.set(cacheKey, { at: Date.now(), rate, date: data.date });

  return {
    rate,
    date:         data.date,
    fromCurrency: from,
    toCurrency:   to,
  };
}

// ── Amount formatter ──────────────────────────────────────────
// Two decimal places is the right precision for end-user display
// of converted amounts. Currencies like JPY are conventionally
// quoted without decimals, but the cent-level precision doesn't
// mislead anyone and keeping the formatter simple is worth it.
// Locale defaults to undefined → user's locale (or en-US in
// non-browser contexts). Thousands separators help readability
// for large conversions.

function formatAmount(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ── The tool ──────────────────────────────────────────────────

const currencyTool = {
  name: 'currency',

  description:
    'Converts an amount from one currency to another using live ' +
    'European Central Bank reference rates via the Frankfurter API. ' +
    'USE THIS for any currency conversion or exchange-rate question — ' +
    'live FX data, not static unit ratios.' +
    '\n\n' +
    'WHEN TO USE:\n' +
    '  - "What\'s 100 USD in EUR?" → currency (from=USD, to=EUR, amount=100)\n' +
    '  - "Convert 50 pounds to dollars" → currency (from=GBP, to=USD, amount=50)\n' +
    '  - "What\'s the exchange rate between USD and JPY?" → currency (from=USD, to=JPY, amount=1)\n' +
    '  - "How many euros is 200 Canadian dollars?" → currency (from=CAD, to=EUR, amount=200)\n' +
    '\n' +
    'WHEN NOT TO USE:\n' +
    '  - Static unit conversion (km↔mi, kg↔lb, °C↔°F) → calculate (mathjs unit support)\n' +
    '  - Pure arithmetic with no currency involved → calculate\n' +
    '  - Crypto rates (BTC, ETH, etc.) → not supported, ECB feed does not cover crypto\n' +
    '  - Historical rates ("what was USD/EUR on 2024-01-01") → not supported in v0.5.21\n' +
    '\n' +
    'CURRENCY CODES: ISO 4217 three-letter codes (USD, EUR, GBP, JPY, CAD, AUD, CHF, ' +
    'CNY, INR, etc.). Common English names also accepted (dollars, euros, pounds, yen). ' +
    'The ECB feed covers ~30 major world currencies. Exotic or pegged currencies may ' +
    'return an "unsupported" response.' +
    '\n\n' +
    'OUTPUT: a single-line conversion result with the rate and the date the rate was ' +
    'published by ECB. The Frankfurter API + ECB feed are attached as sources — the ' +
    'sources rail in the UI renders them automatically.' +
    '\n\n' +
    'AUTHORITATIVE FOR FX QUERIES — when this tool returns a valid conversion, DO NOT ' +
    'also call the web tool to corroborate or "double-check the rate". ECB reference ' +
    'rates ARE the authoritative midmarket quote. The only reason to call web after ' +
    'currency is if the tool explicitly returns an unsupported-currency message AND ' +
    'the user needs a rate the ECB doesn\'t publish (crypto, pegged currencies).',

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      from: {
        type: 'string',
        description:
          'Source currency. ISO 4217 three-letter code (USD, EUR, GBP, JPY, ...) ' +
          'or a common English currency name (dollars, euros, pounds, yen).',
      },
      to: {
        type: 'string',
        description:
          'Target currency. Same format as `from` — ISO code or English name.',
      },
      amount: {
        type: 'number',
        description:
          'Amount to convert. Defaults to 1, which gives the raw exchange rate. ' +
          'Pass the actual amount for a "convert X USD to EUR" query.',
      },
    },
    required: ['from', 'to'],
  },

  execute: async (params: Record<string, unknown>): Promise<NerdAlertResponse> => {

    // 1. Validate `from`.
    const rawFrom = params.from;
    if (typeof rawFrom !== 'string' || rawFrom.trim().length === 0) {
      return {
        type:     'text',
        content:  'Currency tool error: `from` is required (ISO 4217 code or currency name).',
        metadata: {},
      };
    }
    const fromCode = normalizeCurrencyCode(rawFrom);
    if (!fromCode) {
      return {
        type:     'text',
        content:  `Currency tool: "${rawFrom}" doesn't look like a currency I recognize. ` +
                  `Try an ISO 4217 three-letter code (USD, EUR, GBP, JPY...) or a ` +
                  `common English currency name (dollars, euros, pounds, yen).`,
        metadata: {},
      };
    }

    // 2. Validate `to`.
    const rawTo = params.to;
    if (typeof rawTo !== 'string' || rawTo.trim().length === 0) {
      return {
        type:     'text',
        content:  'Currency tool error: `to` is required (ISO 4217 code or currency name).',
        metadata: {},
      };
    }
    const toCode = normalizeCurrencyCode(rawTo);
    if (!toCode) {
      return {
        type:     'text',
        content:  `Currency tool: "${rawTo}" doesn't look like a currency I recognize. ` +
                  `Try an ISO 4217 three-letter code or a common English currency name.`,
        metadata: {},
      };
    }

    // 3. Validate `amount`. Default to 1 (raw rate) if omitted.
    //    Reject negative or non-finite amounts up front so we never
    //    pass garbage into formatAmount.
    let amount = 1;
    if (params.amount !== undefined && params.amount !== null) {
      const n = typeof params.amount === 'string'
        ? Number(params.amount)
        : params.amount;
      if (typeof n !== 'number' || !isFinite(n) || n < 0) {
        return {
          type:     'text',
          content:  `Currency tool error: amount must be a non-negative number (got "${params.amount}").`,
          metadata: {},
        };
      }
      amount = n;
    }

    // 4. Hit the chokepoint.
    let lookup: RateLookup | null;
    try {
      lookup = await fetchLatestRate(fromCode, toCode);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          type:     'text',
          content:  `Currency lookup timed out after ${REQUEST_TIMEOUT_MS / 1000}s. ` +
                    `Frankfurter may be unreachable — try again in a moment.`,
          metadata: {},
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      // 404 from Frankfurter means the `from` code isn't in the ECB
      // feed. We surface that as a normal-text response rather than
      // a tool-error so the model can narrate it gracefully.
      if (msg.includes('HTTP 404')) {
        return {
          type:     'text',
          content:  `The ECB reference feed doesn't publish ${fromCode}. ` +
                    `Frankfurter covers ~30 major world currencies — ` +
                    `try a major pair (USD, EUR, GBP, JPY, CAD, AUD, CHF, CNY, INR, ...).`,
          metadata: {},
        };
      }
      return {
        type:     'text',
        content:  `Currency tool error: ${msg}`,
        metadata: {},
      };
    }

    // 5. Unsupported target — Frankfurter accepted the base but
    //    didn't have a rate for the target. Different failure mode
    //    from a 404 on the base.
    if (!lookup) {
      return {
        type:     'text',
        content:  `The ECB reference feed doesn't publish a ${fromCode}→${toCode} rate. ` +
                  `${toCode} may not be covered by Frankfurter's 30 major currencies.`,
        metadata: {},
      };
    }

    // 6. Build the response. Two lines:
    //    - the conversion result (the answer the user asked for)
    //    - the rate + date (so the model has the unit data to cite)
    //
    //    Sources rail gets Frankfurter + ECB attribution. Frankfurter
    //    itself attributes ECB on every response, so citing both is
    //    accurate and matches the maps tool's OSM attribution pattern.
    const converted = amount * lookup.rate;

    const lines = [
      `${formatAmount(amount)} ${fromCode} = ${formatAmount(converted)} ${toCode}`,
      `Rate: 1 ${fromCode} = ${lookup.rate.toFixed(4)} ${toCode}`,
      `Source: ECB reference rate, published ${lookup.date}`,
    ];

    const sources: Source[] = [
      { label: 'Frankfurter',           url: 'https://frankfurter.dev/' },
      { label: 'European Central Bank', url: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html' },
    ];

    return {
      type:    'text',
      content: lines.join('\n'),
      metadata: {
        title: `${fromCode} → ${toCode}`,
        sources,
      },
    };
  },

} satisfies NerdAlertTool;

export default currencyTool;
