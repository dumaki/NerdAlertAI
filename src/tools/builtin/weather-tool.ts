// ============================================================
// src/tools/builtin/weather-tool.ts
// ============================================================
// Current weather + today's high/low + later-today outlook.
//
// Why this design:
//   - Location lives in the memory engine under subject 'user.location'.
//     "Hey Brett, I'm in Chicago" updates memory, weather follows.
//   - First call without a stored location returns a graceful prompt
//     asking the user to state their city. No silent failure.
//   - Open-Meteo: keyless, free for non-commercial use, includes
//     geocoding. Single attribution requirement (CC-BY 4.0) is met
//     via metadata.sources — the new sources rail renders it.
//   - Output is the fixed five-line shape Ben specified. No JSON
//     leaks to the model. §5 output discipline applied.
//
// Trust level: L1 (read external).
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import { recent }                            from '../../memory/engine';

// ── Configuration ─────────────────────────────────────────────

const GEOCODE_URL  = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const REQUEST_TIMEOUT_MS = 8_000;

// In-memory cache for forecast responses, keyed by lat,lon.
// Weather doesn't change second-to-second; 10 min TTL prevents
// the morning brief + a few interactive calls from re-hitting the API.
const FORECAST_CACHE = new Map<string, { at: number; data: ForecastData }>();
const CACHE_TTL_MS   = 10 * 60 * 1000;

// ── Types (only the fields we actually use) ──────────────────

interface GeocodeHit {
  name:       string;       // canonical city name
  admin1?:    string;       // state/region
  country?:   string;
  latitude:   number;
  longitude:  number;
}

interface GeocodeResponse {
  results?: GeocodeHit[];
}

interface ForecastResponse {
  current?: {
    temperature_2m?: number;
    weather_code?:   number;
  };
  hourly?: {
    time?:         string[];
    weather_code?: number[];
  };
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
  };
}

interface ForecastData {
  current:    number;
  high:       number;
  low:        number;
  nowCond:    string;
  laterCond:  string;
}

// ── WMO weather code → short word ─────────────────────────────
// https://open-meteo.com/en/docs#weather_variable_documentation
//
// Compressed to a small enum the agent can narrate naturally.
// Codes not listed map to UNCLEAR — better than guessing.

function codeToWord(code: number | undefined): string {
  if (code === undefined) return 'UNCLEAR';
  if (code === 0)                      return 'SUNNY';
  if (code >= 1  && code <= 3)         return 'PARTLY CLOUDY';
  if (code === 45 || code === 48)      return 'FOGGY';
  if (code >= 51 && code <= 57)        return 'DRIZZLE';
  if (code >= 61 && code <= 67)        return 'RAIN';
  if (code >= 71 && code <= 77)        return 'SNOW';
  if (code >= 80 && code <= 82)        return 'SHOWERS';
  if (code === 85 || code === 86)      return 'SNOW SHOWERS';
  if (code >= 95 && code <= 99)        return 'STORMS';
  return 'UNCLEAR';
}

// ── fetch with timeout ────────────────────────────────────────
// Uses AbortController so a stuck network call doesn't block the
// whole tool loop. 8s is plenty for Open-Meteo's <100ms typical.

async function fetchJSON<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── Memory lookup helpers ─────────────────────────────────────
// Subject convention: 'user.location' for the canonical city string.
// Stored in lowercase by the memory engine, displayed back in
// title case when reported to the user.

const LOCATION_SUBJECT = 'user.location';

// Strip sentence wrappers from memory-stored location strings.
// Memory entries are user-authored, so their format varies:
//   "Chicago"                     → "Chicago"          (already clean)
//   "Chicago, IL"                 → "Chicago, IL"      (already clean)
//   "User lives in Chicago, IL."  → "Chicago, IL"      (sentence prefix)
//   "I'm in Chicago"              → "Chicago"          (colloquial)
//   "Location: Chicago, Illinois" → "Chicago, Illinois" (label prefix)
//
// The cleaned value is what the geocoder sees — the raw string is
// never exposed to the user in an error message after this point.
function sanitizeLocationFromMemory(raw: string): string {
  // Strip trailing sentence punctuation first
  const trimmed = raw.trim().replace(/[.!?]+$/, '');

  // Explicit sentence prefixes — strip them and return what follows
  const prefixes = [
    /^user lives in /i,
    /^i live in /i,
    /^i'm in /i,
    /^i am in /i,
    /^located in /i,
    /^based in /i,
    /^my location is /i,
    /^location:\s*/i,
    /^currently in /i,
    /^lives in /i,
  ];

  for (const prefix of prefixes) {
    if (prefix.test(trimmed)) {
      return trimmed.replace(prefix, '').trim();
    }
  }

  // No known prefix — fall back to extractPlaceName on the city part.
  // Preserves "City, Region" format so geocode can use the region hint.
  const parts = trimmed.split(',');
  if (parts.length > 1) {
    const city   = extractPlaceName(parts[0]);
    const region = parts.slice(1).join(',').trim();
    return region ? `${city}, ${region}` : city;
  }

  return extractPlaceName(trimmed);
}

function readStoredLocation(): string | null {
  try {
    // Use recent() rather than search('') so we get the most recently
    // captured user.location entry deterministically. Memory may contain
    // multiple location entries from different storage moments — the
    // newest one is the most likely to reflect the user's current intent.
    const hits = recent({ subject: LOCATION_SUBJECT, limit: 1 });
    const raw   = hits[0]?.content ?? null;
    return raw ? sanitizeLocationFromMemory(raw) : null;
  } catch {
    return null;
  }
}

// ── Geocoding ─────────────────────────────────────────────────
// Open-Meteo's geocoding endpoint is part of the same service —
// no second key, no second trust boundary. Returns lat/lon plus
// the canonical city name we store back into memory so future
// calls skip this round trip.

async function geocode(rawQuery: string): Promise<GeocodeHit | null> {
  // Open-Meteo's geocoding endpoint does NOT parse "City, State" formats.
  // Sending ?name=Chicago, IL returns zero results because it looks for a
  // place literally named that. The endpoint expects a bare name; you
  // filter results by admin1/country yourself.
  //
  // Strategy: split on commas, geocode the first part, then if a region
  // hint was given use it to disambiguate.
  const cleaned = rawQuery.trim().replace(/[.\s]+$/, '');
  if (!cleaned) return null;

  // "Chicago, IL"     → city="Chicago", region="IL"
  // "Paris, France"   → city="Paris",   region="France"
  // "Chicago"         → city="Chicago", region=""
  const [cityRaw, ...regionParts] = cleaned.split(',').map(s => s.trim());
  const city   = extractPlaceName(cityRaw);
  const region = regionParts.join(', ').trim().toLowerCase();

  if (!city) return null;

  const url = `${GEOCODE_URL}?name=${encodeURIComponent(city)}&count=10&language=en&format=json`;
  const data = await fetchJSON<GeocodeResponse>(url);
  const results = data.results ?? [];
  if (results.length === 0) return null;

  // No region hint — trust Open-Meteo's ranking (population-weighted, so
  // "Chicago" returns Chicago, IL first; "Paris" returns Paris, France).
  if (!region) return results[0];

  // Region hint — prefer matches where admin1 or country starts with it.
  // startsWith handles "IL" matching "Illinois" and short forms generally.
  const matched = results.find(r =>
    r.admin1?.toLowerCase().startsWith(region) ||
    r.country?.toLowerCase().startsWith(region) ||
    r.admin1?.toLowerCase() === region ||
    r.country?.toLowerCase() === region
  );
  return matched ?? results[0];
}

// Pull a place name out of a possibly-sentence-shaped string.
//
// Bridging code for memory entries that aren't stored as clean place
// names. Handles things like:
//   "Chicago"                 → "Chicago"           (already clean, untouched)
//   "Saint Louis"             → "Saint Louis"       (multi-word place, untouched)
//   "User lives in Chicago"   → "Chicago"           (trailing cap word)
//   "I'm in New York"         → "New York"          (trailing cap words)
//   "lives in San Francisco"  → "San Francisco"     (trailing cap words)
//
// If the input is already a clean Title-Case phrase, it's returned as-is.
// Otherwise we walk backwards collecting consecutive capitalized words.
// Falls back to the original input if no cap words are found.
function extractPlaceName(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return trimmed;

  // Already clean: starts with capital, contains only letters/spaces/'-/.
  if (/^[A-Z][a-zA-Z.\s'-]*$/.test(trimmed) && !/\b(in|at|from|of|the|a|an)\b/i.test(trimmed)) {
    return trimmed;
  }

  // Walk backwards collecting consecutive capitalized words.
  const words = trimmed.split(/\s+/);
  const placeWords: string[] = [];
  for (let i = words.length - 1; i >= 0; i--) {
    if (/^[A-Z][a-zA-Z.'-]*$/.test(words[i])) {
      placeWords.unshift(words[i]);
    } else {
      break;
    }
  }
  return placeWords.length > 0 ? placeWords.join(' ') : trimmed;
}

// ── Forecast fetch ────────────────────────────────────────────
// One API call, five fields extracted. Everything else in the
// response is discarded — the model only ever sees the formatted
// five-line string.

async function getForecast(lat: number, lon: number): Promise<ForecastData> {
  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = FORECAST_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }

  const url =
    `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code` +
    `&hourly=weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&temperature_unit=fahrenheit` +
    `&timezone=auto` +
    `&forecast_days=1`;

  const raw = await fetchJSON<ForecastResponse>(url);

  const current = raw.current?.temperature_2m;
  const high    = raw.daily?.temperature_2m_max?.[0];
  const low     = raw.daily?.temperature_2m_min?.[0];
  const nowCode = raw.current?.weather_code;

  // "Later today" = the hourly forecast slot at index 15 (~3pm local
  // when timezone=auto), or the last available slot if we got fewer.
  // Falls back to current code if hourly is missing entirely.
  const hourlyCodes = raw.hourly?.weather_code ?? [];
  const laterIdx    = Math.min(15, Math.max(0, hourlyCodes.length - 1));
  const laterCode   = hourlyCodes[laterIdx] ?? nowCode;

  if (current === undefined || high === undefined || low === undefined) {
    throw new Error('Forecast response missing required fields');
  }

  const data: ForecastData = {
    current:   Math.round(current),
    high:      Math.round(high),
    low:       Math.round(low),
    nowCond:   codeToWord(nowCode),
    laterCond: codeToWord(laterCode),
  };

  FORECAST_CACHE.set(cacheKey, { at: Date.now(), data });
  return data;
}

// ── Display helpers ───────────────────────────────────────────

function titleCase(s: string): string {
  return s.split(/\s+/).map(w =>
    w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()
  ).join(' ');
}

function formatLocationDisplay(hit: GeocodeHit): string {
  // "Chicago, IL" preferred; "Chicago, Illinois" if no abbreviation;
  // bare name as last resort. State/region abbreviation is what
  // people read; Open-Meteo gives admin1 as the full state name.
  if (hit.admin1) return `${hit.name}, ${hit.admin1}`;
  if (hit.country) return `${hit.name}, ${hit.country}`;
  return hit.name;
}

// ── The tool ──────────────────────────────────────────────────

const weatherTool = {
  name: 'weather',

  description:
    'Returns current temperature, today\'s high and low, current conditions, ' +
    'and the conditions expected later today for a given location. ' +
    '\n\n' +
    'INPUT FORMAT: pass a clean place name only — "Chicago", "Chicago, IL", or ' +
    '"Paris, France". Do NOT pass full sentences. If you found the user\'s ' +
    'location in memory and the content is a sentence (e.g. "User lives in ' +
    'Chicago, Illinois."), extract just the place name ("Chicago, IL" or ' +
    '"Chicago") before calling this tool.' +
    '\n\n' +
    'MEMORY CONVENTION: when storing the user\'s location, use subject ' +
    '"user.location" and content equal to just the place name. This lets the ' +
    'tool find it on subsequent calls without you having to look it up.' +
    '\n\n' +
    'If no location is provided AND the user has no "user.location" memory ' +
    'entry, the tool returns a prompt asking the user to state their city. ' +
    'Use this whenever the user asks about weather, temperature, rain, snow, ' +
    'how cold or hot it is, or what to wear. ' +
    'Respond with a concise summary of results. Do not repeat raw data verbatim.',

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description:
          'Optional explicit city or place name to override the user\'s ' +
          'remembered location. Example: "Boston" or "Paris, France".',
      },
    },
    required: [],
  },

  execute: async (params: Record<string, unknown>): Promise<NerdAlertResponse> => {

    const sources = [{ label: 'Open-Meteo', url: 'https://open-meteo.com' }];

    // 1. Resolve which location to use.
    //    Explicit override → param. Otherwise → memory.
    const overrideLocation = (params.location as string | undefined)?.trim();
    const storedLocation   = overrideLocation ? null : readStoredLocation();
    const queryLocation    = overrideLocation ?? storedLocation;

    // 2. No location anywhere — graceful prompt, no API call.
    if (!queryLocation) {
      return {
        type: 'text',
        content:
          'I don\'t know your location yet. Tell me your city ' +
          '(e.g. "I\'m in Chicago") and I\'ll remember it for next time.',
        metadata: { title: 'Weather — location needed' },
      };
    }

    // 3. Geocode → lat/lon + canonical name.
    let hit: GeocodeHit | null;
    try {
      hit = await geocode(queryLocation);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        type: 'text',
        content: `Couldn't reach the geocoding service (${msg}). Try again in a moment.`,
        metadata: { title: 'Weather — service unavailable', sources },
      };
    }

    if (!hit) {
      return {
        type: 'text',
        content: `Couldn't find a place called "${queryLocation}". ` +
                 'Try just the city name like "Chicago" — the tool will pick the ' +
                 'right one. If multiple matches are possible, add the country: ' +
                 '"Paris, France".',
        metadata: { title: 'Weather — location not found' },
      };
    }

    // 4. Forecast → the five fields we actually use.
    let forecast: ForecastData;
    try {
      forecast = await getForecast(hit.latitude, hit.longitude);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        type: 'text',
        content: `Couldn't reach the weather service (${msg}). Try again in a moment.`,
        metadata: { title: 'Weather — service unavailable', sources },
      };
    }

    // 5. Build the response. The weather tool deliberately does not
    //    write to memory — location capture happens via the agent
    //    calling the memory tool when the user says "I'm in X". The
    //    weather tool only reads.
    const cityDisplay = titleCase(formatLocationDisplay(hit)).toUpperCase();

    const content =
      `Right now in ${cityDisplay} it's ${forecast.current}°\n` +
      `The HIGH today is ${forecast.high}°\n` +
      `The LOW today is ${forecast.low}°\n` +
      `Currently it's ${forecast.nowCond} but expect ${forecast.laterCond} later today`;

    return {
      type: 'text',
      content,
      metadata: {
        title: `Weather — ${formatLocationDisplay(hit)}`,
        sources,
      },
    };
  },

} satisfies NerdAlertTool;

export default weatherTool;
