// ============================================================
// tools/builtin/maps-tool.ts
// ============================================================
// Maps and location lookup. Closes Q1 checklist item q1-maps.
//
// WHY THIS TOOL EXISTS
// ──────────────────────────────────────────────────────────
// "How far is X from Y" and "where is X" are common assistant
// queries that today get routed to the web tool, which returns
// search-result snippets rather than authoritative data. With
// a real geocoder + router behind a tool, the agent can answer
// directly: distance in miles, drive time, canonical address.
//
// WHY OPENSTREETMAP
// ──────────────────────────────────────────────────────────
// Same trust profile as the weather and wikipedia tools:
// outbound HTTP, no auth, no credentials. Nominatim is the
// reference geocoder for OSM data; OSRM is the reference
// routing engine. Both are free, both have demo servers, both
// are open-data so attribution is the only license obligation.
//
// The alternative (Google Maps Geocoding + Directions APIs)
// would require billing setup, an API key per user, and a
// credit-card-backed Google Cloud project. None of that fits
// the keyless / homelab-friendly product shape.
//
// USAGE POLICY (important — don't skip)
// ──────────────────────────────────────────────────────────
// Nominatim has a strict usage policy:
//   - max 1 request per second
//   - REQUIRED descriptive User-Agent identifying the app
//   - no bulk geocoding
// Violating any of these will get the source IP blocked by
// the OSMF servers. The User-Agent rule is exactly the same
// lesson we learned with CrowdSec in v0.5.5 — silent rejection
// when the UA is missing or generic. We send NERDALERT_UA on
// every call.
//
// The 1 rps cap is enforced by a throttle that sleeps the
// difference between Date.now() and lastNominatimAt + 1100ms
// (50ms safety margin) before each call. Two-geocode directions
// queries will therefore take ~1.1s minimum — acceptable.
//
// OSRM's demo server (router.project-osrm.org) has no published
// rate limit but explicitly says "for testing only." For v0.5.20
// the demo server is fine; if we ever go GA with maps in a
// publicly-deployed NerdAlert, swap in our own OSRM instance.
//
// SINGLE-CHOKEPOINT PATTERN
// ──────────────────────────────────────────────────────────
// Same shape as wikipedia-tool.ts's fetchWikipediaSummary():
// every external call funnels through ONE function per upstream
// (fetchGeocode, fetchDirections). When we add an offline tile
// server / Photon-on-Pi later, those two functions become thin
// routers and nothing else in the file changes.
//
// TRUST LEVEL: L1
// ──────────────────────────────────────────────────────────
// Outbound HTTP only. No auth, no credentials, no writes.
// ============================================================

import { NerdAlertTool, NerdAlertResponse, Source } from '../../types/response.types';
import { recent } from '../../memory/engine';

// ── Configuration ─────────────────────────────────────────────

const NOMINATIM_SEARCH_URL  = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const OSRM_BASE_URL         = 'https://router.project-osrm.org/route/v1';

const REQUEST_TIMEOUT_MS    = 10_000;   // 10s — OSRM can take a moment on long routes
const NOMINATIM_MIN_GAP_MS  = 1_100;    // 1.1s between Nominatim calls (50ms safety)

// Cap on result text length per response — §5 output discipline.
// 1200 chars covers a 3-step description with breathing room.
const RESULT_TEXT_CAP = 1_200;

// Nominatim's policy explicitly requires a descriptive UA identifying
// the application and a contact URL. Same convention as wikipedia-tool.
const NERDALERT_UA = 'NerdAlertAI/0.5.20 (https://github.com/dumaki/NerdAlertAI)';

// Memory subject convention — same string the weather tool reads from.
// If a user.location is stored, "directions to X" can default the
// origin without asking.
const LOCATION_SUBJECT = 'user.location';

// Geocode cache. Address strings are very repetitive in a single
// session ("directions home", "how far to the office") so even a
// short TTL pays for itself on the second call. 1 hour balances
// freshness vs round-trip count; addresses don't move.
const GEOCODE_CACHE = new Map<string, { at: number; data: GeocodeHit }>();
const GEOCODE_CACHE_TTL_MS = 60 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────

// Nominatim's jsonv2 response shape (only the fields we use).
// Note: lat and lon come back as STRINGS, not numbers. Convert
// at the boundary so the rest of the code can use real numerics.
interface NominatimResult {
  lat:          string;
  lon:          string;
  display_name: string;
  type?:        string;
  class?:       string;
  importance?:  number;
}

// Our internal canonical shape — decoupled from Nominatim so a
// future provider (Photon, offline tile server) can return this
// without contortion.
interface GeocodeHit {
  latitude:    number;
  longitude:   number;
  displayName: string;   // e.g. "1600 Pennsylvania Ave NW, Washington, DC, USA"
}

// OSRM route response (truncated to fields used).
interface OsrmRouteResponse {
  code: string;
  routes?: Array<{
    distance: number;   // meters
    duration: number;   // seconds
  }>;
  message?: string;
}

// ── Nominatim 1-rps throttle ──────────────────────────────────
// In-process counter, fine for single-server NerdAlert. Becomes
// insufficient if we ever run multiple NerdAlert instances against
// the same upstream Nominatim — at that point we'd move to a shared
// Redis lock or stand up our own Nominatim instance. Not a v0.5.20
// concern.

let lastNominatimAt = 0;

async function throttleNominatim(): Promise<void> {
  const elapsed = Date.now() - lastNominatimAt;
  if (elapsed < NOMINATIM_MIN_GAP_MS) {
    await new Promise(resolve => setTimeout(resolve, NOMINATIM_MIN_GAP_MS - elapsed));
  }
  lastNominatimAt = Date.now();
}

// ── Fetch helper ──────────────────────────────────────────────
// Same AbortController pattern as wikipedia / weather tools. The
// NerdAlert UA is sent on every call — see file header for why
// that matters with Nominatim.

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
      throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    }
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── THE CHOKEPOINT — geocoding ────────────────────────────────
// Every "address → coords" call routes through this function.
// Provider swap (Photon, offline) becomes a thin router here.

async function fetchGeocode(query: string): Promise<GeocodeHit | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Cache check — addresses don't move; same query within TTL is safe.
  const cacheKey = trimmed.toLowerCase();
  const cached = GEOCODE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < GEOCODE_CACHE_TTL_MS) {
    return cached.data;
  }

  await throttleNominatim();

  // limit=1 — we want the top result. jsonv2 is the modern response
  // format with stable field names.
  const url =
    `${NOMINATIM_SEARCH_URL}` +
    `?format=jsonv2` +
    `&q=${encodeURIComponent(trimmed)}` +
    `&limit=1` +
    `&addressdetails=0`;

  const results = await fetchJSON<NominatimResult[]>(url);
  if (!Array.isArray(results) || results.length === 0) return null;

  const top = results[0];
  // Defensive parseFloat — Nominatim returns string lat/lon by design.
  const lat = parseFloat(top.lat);
  const lon = parseFloat(top.lon);
  if (!isFinite(lat) || !isFinite(lon)) return null;

  const hit: GeocodeHit = {
    latitude:    lat,
    longitude:   lon,
    displayName: top.display_name,
  };

  GEOCODE_CACHE.set(cacheKey, { at: Date.now(), data: hit });
  return hit;
}

// ── THE CHOKEPOINT — reverse geocoding ────────────────────────
// Coords → canonical address. Exposed via the future reverse_geocode
// action; today the tool surface only uses it internally as a
// helper if a coord pair is passed where a name was expected. Kept
// as its own function so the same chokepoint pattern extends
// cleanly when the action is added.

async function fetchReverseGeocode(lat: number, lon: number): Promise<GeocodeHit | null> {
  await throttleNominatim();

  const url =
    `${NOMINATIM_REVERSE_URL}` +
    `?format=jsonv2` +
    `&lat=${lat}` +
    `&lon=${lon}`;

  const result = await fetchJSON<NominatimResult>(url);
  if (!result || !result.display_name) return null;

  return {
    latitude:    parseFloat(result.lat),
    longitude:   parseFloat(result.lon),
    displayName: result.display_name,
  };
}

// ── THE CHOKEPOINT — routing ──────────────────────────────────
// OSRM endpoint order is LON,LAT — opposite of the latitude/longitude
// order most humans expect. The wrong order returns either a routing
// failure ("NoRoute") or, worse, a route somewhere unexpected. Always
// convert at this boundary.

type TravelMode = 'driving' | 'walking' | 'cycling';

interface RouteResult {
  distanceMeters:  number;
  durationSeconds: number;
}

async function fetchDirections(
  from: GeocodeHit,
  to:   GeocodeHit,
  mode: TravelMode,
): Promise<RouteResult | null> {
  const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  // overview=false + steps=false means we get distance and duration
  // only, no polyline or step-by-step. Smallest possible response.
  // Step-by-step directions are a v0.6+ addition when we have a UI
  // surface to render them.
  const url = `${OSRM_BASE_URL}/${mode}/${coords}?overview=false&steps=false`;

  const data = await fetchJSON<OsrmRouteResponse>(url);
  if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
    return null;
  }
  const r = data.routes[0];
  return { distanceMeters: r.distance, durationSeconds: r.duration };
}

// ── Memory lookup ────────────────────────────────────────────
// Same sanitizer pattern as weather-tool.ts — memory entries are
// user-authored and may be sentence-shaped ("User lives in Chicago").
// We strip common prefixes so the geocoder sees a clean place name.
//
// Deliberately a smaller subset than weather's full sanitizer —
// maps tolerates more wording than the geocoding-only weather path
// because Nominatim is flexible about address shape ("Chicago, IL"
// works fine without splitting). If we hit a memory format that
// breaks, port the rest of the weather sanitizer here verbatim.

function readStoredLocation(): string | null {
  try {
    const hits = recent({ subject: LOCATION_SUBJECT, limit: 1 });
    const raw  = hits[0]?.content;
    if (!raw) return null;

    const trimmed = raw.trim().replace(/[.!?]+$/, '');
    const prefixes = [
      /^user lives in /i,
      /^i live in /i,
      /^i'?m in /i,
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
    return trimmed;
  } catch {
    return null;
  }
}

// ── Display helpers ──────────────────────────────────────────

// metersToHuman — chooses miles vs km. Default to miles since the
// product's primary user is US-based and `user.location` defaults
// to Chicago. A future config setting could flip this to km based
// on a memory entry (user.preferences.units). For v0.5.20 we keep
// it simple.
function metersToHuman(meters: number): string {
  const miles = meters / 1609.344;
  if (miles < 0.1) {
    // Sub-tenth-mile — show feet. Helpful for "walk to the corner".
    const feet = Math.round(meters * 3.28084);
    return `${feet} ft`;
  }
  if (miles < 10) {
    return `${miles.toFixed(1)} mi`;
  }
  return `${Math.round(miles)} mi`;
}

// secondsToHuman — short readable duration. Mirrors the cron module's
// time formatting convention so the user sees consistent prose across
// tools.
function secondsToHuman(seconds: number): string {
  if (seconds < 60) return 'less than a minute';
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const mins  = totalMinutes % 60;
  if (mins === 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${hours} hr ${mins} min`;
}

function cap(text: string, limit: number): string {
  return text.length > limit
    ? text.slice(0, limit) + ' …'
    : text;
}

// OSM attribution — required by the OSM license terms. Same shape
// as Wikipedia's source row; the sources rail renders both
// uniformly.
const OSM_SOURCE: Source = {
  label: 'OpenStreetMap',
  url:   'https://www.openstreetmap.org/copyright',
};

// ── The tool ─────────────────────────────────────────────────

const mapsTool: NerdAlertTool = {
  name: 'maps',

  description:
    'Look up locations and routing using OpenStreetMap. Use this tool ' +
    'for ANY question about addresses, distances, drive time, or ' +
    'where something is located. ' +
    '\n\n' +
    'ACTIONS:\n' +
    '  - geocode: address → coordinates + canonical address. ' +
    'For "where is X" / "what\'s the address of X" / "find X on a map".\n' +
    '  - directions: A → B distance and travel time. ' +
    'For "how far is X from Y" / "directions to X" / "drive time to X".\n' +
    '\n' +
    'DIRECTIONS DEFAULTS:\n' +
    '  - If only "to" is provided and the user has a stored ' +
    '"user.location" memory, that location is used as "from" ' +
    'automatically (same pattern as the weather tool).\n' +
    '  - mode defaults to driving. Pass mode="walking" or "cycling" for ' +
    'pedestrian or bike routing.\n' +
    '\n' +
    'WHEN NOT TO USE (use the web tool instead):\n' +
    '  - "what to do in X" / tourist recommendations / restaurant picks — ' +
    'this tool answers location questions, not opinion questions.\n' +
    '  - Real-time traffic — OSRM does not include live conditions.\n' +
    '\n' +
    'AUTHORITATIVE FOR LOCATION QUERIES — when this tool returns ' +
    'an address or route, do NOT also call the web tool to ' +
    'corroborate. OpenStreetMap is the source of truth for ' +
    'addresses and routing geometry; sources rail already cites it.',

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['geocode', 'directions'],
        description: 'The operation to perform.',
      },
      query: {
        type: 'string',
        description:
          'For "geocode": the place name or address to look up. ' +
          'Examples: "Eiffel Tower", "1600 Pennsylvania Ave", "Chicago O\'Hare Airport".',
      },
      from: {
        type: 'string',
        description:
          'For "directions": starting address. If omitted, ' +
          'the user\'s stored user.location is used.',
      },
      to: {
        type: 'string',
        description: 'For "directions": destination address. Required for directions.',
      },
      mode: {
        type: 'string',
        enum: ['driving', 'walking', 'cycling'],
        description: 'For "directions": travel mode. Defaults to driving.',
      },
    },
    required: ['action'],
  },

  execute: async (params: Record<string, unknown>): Promise<NerdAlertResponse> => {

    const action = params.action;

    if (action === 'geocode') {
      // ── geocode ──────────────────────────────────────────
      const query = params.query;
      if (typeof query !== 'string' || query.trim().length === 0) {
        return {
          type:     'text',
          content:  'maps.geocode requires a non-empty "query".',
          metadata: {},
        };
      }

      let hit: GeocodeHit | null;
      try {
        hit = await fetchGeocode(query);
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'AbortError') {
          return {
            type:     'text',
            content:  `Geocoding request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. ` +
                      `The Nominatim service may be busy — try again in a moment.`,
            metadata: { sources: [OSM_SOURCE] },
          };
        }
        const msg = e instanceof Error ? e.message : String(e);
        return {
          type:     'text',
          content:  `Couldn't reach the geocoding service (${msg}).`,
          metadata: { sources: [OSM_SOURCE] },
        };
      }

      if (!hit) {
        return {
          type:    'text',
          content:
            `Couldn't find a place matching "${query}". ` +
            `Try adding more detail (city, state, country) or a more specific name.`,
          metadata: {},
        };
      }

      return {
        type:    'text',
        content:
          `${cap(hit.displayName, RESULT_TEXT_CAP)}\n` +
          `Coordinates: ${hit.latitude.toFixed(5)}, ${hit.longitude.toFixed(5)}`,
        metadata: {
          title:   `Map — ${cap(hit.displayName, 80)}`,
          sources: [OSM_SOURCE],
        },
      };
    }

    if (action === 'directions') {
      // ── directions ───────────────────────────────────────
      const toRaw   = params.to;
      const fromRaw = params.from;
      const mode    = (params.mode as TravelMode | undefined) ?? 'driving';

      if (typeof toRaw !== 'string' || toRaw.trim().length === 0) {
        return {
          type:     'text',
          content:  'maps.directions requires a non-empty "to" address.',
          metadata: {},
        };
      }

      // Resolve "from" — explicit param wins, otherwise fall back to
      // the memory-stored user.location, otherwise prompt.
      let fromQuery: string;
      let fromIsImplicit = false;
      if (typeof fromRaw === 'string' && fromRaw.trim().length > 0) {
        fromQuery = fromRaw.trim();
      } else {
        const stored = readStoredLocation();
        if (!stored) {
          return {
            type:    'text',
            content:
              'I don\'t know where to start from. Either give me a "from" address ' +
              'or tell me your location (e.g. "I\'m in Chicago") and I\'ll remember it.',
            metadata: { title: 'Directions — origin needed' },
          };
        }
        fromQuery = stored;
        fromIsImplicit = true;
      }

      const toQuery = toRaw.trim();

      // Two geocodes — sequential through the throttle. Total time
      // 2 * NOMINATIM_MIN_GAP_MS + network = ~2.2s minimum, which is
      // acceptable for a directions query.
      let fromHit: GeocodeHit | null;
      let toHit:   GeocodeHit | null;
      try {
        fromHit = await fetchGeocode(fromQuery);
        toHit   = await fetchGeocode(toQuery);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          type:     'text',
          content:  `Couldn't reach the geocoding service (${msg}). Try again in a moment.`,
          metadata: { sources: [OSM_SOURCE] },
        };
      }

      if (!fromHit) {
        return {
          type:    'text',
          content: `Couldn't find a place matching the start "${fromQuery}". ` +
                   `Try a more specific address or city + state.`,
          metadata: {},
        };
      }
      if (!toHit) {
        return {
          type:    'text',
          content: `Couldn't find a place matching the destination "${toQuery}". ` +
                   `Try a more specific address or city + state.`,
          metadata: {},
        };
      }

      // Route lookup.
      let route: RouteResult | null;
      try {
        route = await fetchDirections(fromHit, toHit, mode);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          type:     'text',
          content:  `Couldn't reach the routing service (${msg}). ` +
                    `The two locations resolved fine — try again in a moment.`,
          metadata: { sources: [OSM_SOURCE] },
        };
      }

      if (!route) {
        return {
          type:    'text',
          content:
            `No ${mode} route found between "${fromHit.displayName}" and ` +
            `"${toHit.displayName}". They may not be reachable by ${mode} ` +
            `(e.g. across an ocean) or one of the addresses may be too vague.`,
          metadata: { sources: [OSM_SOURCE] },
        };
      }

      const fromLine = fromIsImplicit
        ? `From: ${cap(fromHit.displayName, 80)} _(your stored location)_`
        : `From: ${cap(fromHit.displayName, 80)}`;

      return {
        type: 'text',
        content:
          fromLine + '\n' +
          `To:   ${cap(toHit.displayName, 80)}\n` +
          `Mode: ${mode}\n` +
          `Distance: ${metersToHuman(route.distanceMeters)}\n` +
          `Travel time: ${secondsToHuman(route.durationSeconds)}`,
        metadata: {
          title:   `Directions — ${cap(toHit.displayName, 60)}`,
          sources: [OSM_SOURCE],
        },
      };
    }

    return {
      type:    'text',
      content: `Unknown action: "${String(action)}". Valid actions: geocode, directions.`,
      metadata: {},
    };
  },
};

export default mapsTool;
// Exported for test scaffolding and future direct usage from other
// internal callers. Same export pattern as wikipedia-tool's
// fetchWikipediaSummary — keeps the chokepoint addressable from
// outside without exposing the rest of the tool's internals.
export { fetchGeocode, fetchReverseGeocode, fetchDirections };
