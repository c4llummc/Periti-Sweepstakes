/**
 * Netlify Function: proxy.js
 *
 * Acts as a server-side proxy to the BALLDONTLIE FIFA World Cup API.
 * - Attaches the secret API key (never exposed to the browser)
 * - Caches responses in-memory to stay within the free tier rate limit (5 req/min)
 * - Handles cursor-based pagination automatically
 *
 * Usage (from the browser):
 *   fetch('/.netlify/functions/proxy?_endpoint=matches&seasons[]=2026')
 *   fetch('/.netlify/functions/proxy?_endpoint=match_events&match_ids[]=1&match_ids[]=2')
 *
 * Required env var (set in Netlify dashboard → Site → Environment variables):
 *   BALLDONTLIE_API_KEY = your_key_here
 */

const https = require('https');

const API_BASE = 'https://api.balldontlie.io/fifa/worldcup/v1';

// In-memory cache — survives for the warm lifetime of a function instance (~26 min on Netlify free tier)
const cache = new Map();

// Cache TTLs (in seconds)
const TTL_LIVE      = 45;           // 45 s  — live/upcoming data (matches, standings)
const TTL_COMPLETED = 6 * 3600;     // 6 hr  — match events (immutable once the match ends)

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':                 'application/json',
  };

  // Pre-flight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // API key guard
  const apiKey = process.env.BALLDONTLIE_API_KEY;
  if (!apiKey) {
    console.error('BALLDONTLIE_API_KEY is not set');
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error: 'API key not configured. Add BALLDONTLIE_API_KEY to your Netlify environment variables.',
      }),
    };
  }

  // ------------------------------------------------------------------
  // Build the upstream query string from all passed params except _endpoint
  // Netlify populates multiValueQueryStringParameters for array params like match_ids[]
  // ------------------------------------------------------------------
  const svParams  = event.queryStringParameters        || {};
  const mvParams  = event.multiValueQueryStringParameters || {};
  const endpoint  = svParams._endpoint;

  if (!endpoint) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'Missing required parameter: _endpoint' }),
    };
  }

  // Build URLSearchParams (multi-value aware)
  const upstreamParams = new URLSearchParams();
  for (const [key, values] of Object.entries(mvParams)) {
    if (key === '_endpoint') continue;
    for (const v of values) upstreamParams.append(key, v);
  }
  for (const [key, value] of Object.entries(svParams)) {
    if (key === '_endpoint' || mvParams[key]) continue;
    upstreamParams.append(key, value);
  }
  upstreamParams.set('per_page', '100');

  // ------------------------------------------------------------------
  // Cache lookup
  // ------------------------------------------------------------------
  const cacheKey = `${endpoint}?${upstreamParams.toString()}`;
  const now      = Math.floor(Date.now() / 1000);
  const cached   = cache.get(cacheKey);
  const ttl      = endpoint === 'match_events' ? TTL_COMPLETED : TTL_LIVE;

  if (cached && (now - cached.ts) < ttl) {
    return {
      statusCode: 200,
      headers: { ...CORS, 'X-Cache': 'HIT' },
      body: JSON.stringify({ data: cached.data, _cached: true }),
    };
  }

  // ------------------------------------------------------------------
  // Fetch all pages from upstream API
  // ------------------------------------------------------------------
  try {
    const allData = await fetchAllPages(apiKey, endpoint, upstreamParams);
    cache.set(cacheKey, { data: allData, ts: now });

    return {
      statusCode: 200,
      headers: { ...CORS, 'X-Cache': 'MISS' },
      body: JSON.stringify({ data: allData }),
    };
  } catch (err) {
    console.error('Upstream API error:', err.message);

    // If we have stale cache, return it with a warning rather than hard-failing
    if (cached) {
      return {
        statusCode: 200,
        headers: { ...CORS, 'X-Cache': 'STALE' },
        body: JSON.stringify({ data: cached.data, _stale: true, _error: err.message }),
      };
    }

    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: `Upstream API error: ${err.message}` }),
    };
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Follows BALLDONTLIE cursor pagination and returns all records.
 */
async function fetchAllPages(apiKey, endpoint, baseParams) {
  const allData = [];
  let cursor    = null;
  let page      = 0;

  while (true) {
    page++;
    if (page > 20) break; // safety limit — no WC endpoint needs 2000+ records

    const params = new URLSearchParams(baseParams);
    if (cursor) params.set('cursor', cursor);

    const url    = `${API_BASE}/${endpoint}?${params}`;
    const result = await httpGet(url, apiKey);

    if (result.statusCode === 401) {
      throw new Error('Invalid API key (401 Unauthorized)');
    }
    if (result.statusCode === 403) {
      throw new Error(
        'This endpoint requires a paid BALLDONTLIE tier (403 Forbidden). ' +
        'Check the fallback instructions in README.md.'
      );
    }
    if (result.statusCode !== 200) {
      throw new Error(`API returned HTTP ${result.statusCode}: ${JSON.stringify(result.body).substring(0, 300)}`);
    }

    const { data, meta } = result.body;
    if (Array.isArray(data)) allData.push(...data);

    // BALLDONTLIE uses next_cursor for pagination
    if (meta && meta.next_cursor) {
      cursor = meta.next_cursor;
    } else {
      break;
    }
  }

  return allData;
}

/**
 * Simple promisified HTTPS GET with a timeout.
 */
function httpGet(url, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Authorization: apiKey } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${raw.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error(`Request timed out: ${url}`));
    });
  });
}
