/**
 * Netlify Function: proxy.js  (API-Football v3 edition)
 *
 * Proxies to https://v3.football.api-sports.io and normalises responses
 * to the internal format the frontend expects.
 *
 * Required env var (Netlify → Site configuration → Environment variables):
 *   API_FOOTBALL_KEY = your key from dashboard.api-football.com
 *
 * Free plan: 100 requests/day — sufficient because:
 *   - Fixtures are cached 60 s (live) → ~1 req/minute at most
 *   - Match events cached 6 h → fetched once per completed match, ever
 *   - Browser localStorage also caches events across cold starts
 */

'use strict';
const https = require('https');

const API_BASE   = 'https://v3.football.api-sports.io';
const WC_LEAGUE  = 1;      // FIFA World Cup in API-Football
const WC_SEASON  = 2026;

// In-memory cache (survives ~26 min Netlify warm window)
const cache = new Map();
const TTL_FIXTURES = 60;        // 60 s — live/upcoming data
const TTL_EVENTS   = 6 * 3600;  // 6 h  — completed match events never change

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':                 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error: 'API key not set. Add API_FOOTBALL_KEY to Netlify → Site configuration → Environment variables.',
      }),
    };
  }

  const svParams = event.queryStringParameters        || {};
  const mvParams = event.multiValueQueryStringParameters || {};
  const endpoint = svParams._endpoint;

  if (!endpoint) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing _endpoint' }) };
  }

  try {
    let data;

    if (endpoint === 'matches') {
      data = await cachedFixtures(apiKey);
    } else if (endpoint === 'teams') {
      // Derive teams list from fixtures (saves an API call)
      const fixtures = await cachedFixtures(apiKey);
      const seen = {};
      data = [];
      for (const m of fixtures) {
        if (m.home_team && !seen[m.home_team.id]) { seen[m.home_team.id] = true; data.push(m.home_team); }
        if (m.away_team && !seen[m.away_team.id]) { seen[m.away_team.id] = true; data.push(m.away_team); }
      }
    } else if (endpoint === 'match_events') {
      // Collect fixture IDs from multi-value params
      const ids = (mvParams['match_ids[]'] || [])
        .concat(svParams['match_ids[]'] ? [svParams['match_ids[]']] : [])
        .map(Number)
        .filter(Boolean);

      data = await fetchEventsForFixtures(apiKey, ids);
    } else {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Unknown endpoint: ${endpoint}` }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ data }),
    };
  } catch (err) {
    console.error('Proxy error:', err.message);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ---------------------------------------------------------------------------
// Fixtures (all WC 2026 matches)
// ---------------------------------------------------------------------------
async function cachedFixtures(apiKey) {
  const key = 'fixtures';
  const now = Math.floor(Date.now() / 1000);
  const hit = cache.get(key);
  if (hit && (now - hit.ts) < TTL_FIXTURES) return hit.data;

  const raw = await apiFetch(apiKey, `/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}&timezone=UTC`);
  const data = (raw.response || []).map(normFixture);
  cache.set(key, { data, ts: now });
  return data;
}

// ---------------------------------------------------------------------------
// Events (cards, goals) — fetched per fixture, cached individually
// ---------------------------------------------------------------------------
async function fetchEventsForFixtures(apiKey, fixtureIds) {
  const all = [];
  const now = Math.floor(Date.now() / 1000);

  for (const fid of fixtureIds) {
    const key = `events_${fid}`;
    const hit = cache.get(key);
    if (hit && (now - hit.ts) < TTL_EVENTS) {
      all.push(...hit.data);
      continue;
    }

    const raw = await apiFetch(apiKey, `/fixtures/events?fixture=${fid}`);
    const evts = (raw.response || []).map(e => normEvent(fid, e));
    cache.set(key, { data: evts, ts: now });
    all.push(...evts);
  }
  return all;
}

// ---------------------------------------------------------------------------
// Raw API call
// ---------------------------------------------------------------------------
function apiFetch(apiKey, path) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${path}`;
    const req = https.get(url, {
      headers: {
        'x-apisports-key': apiKey,
        'Accept': 'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch (e) {
          return reject(new Error(`JSON parse error (HTTP ${res.statusCode}): ${raw.substring(0, 200)}`));
        }

        if (res.statusCode === 401 || (body.errors && body.errors.token)) {
          return reject(new Error(
            `API-Football: invalid API key (${res.statusCode}). ` +
            `Check API_FOOTBALL_KEY in Netlify. Raw: ${JSON.stringify(body.errors || body).substring(0,200)}`
          ));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`API-Football HTTP ${res.statusCode}: ${JSON.stringify(body).substring(0,300)}`));
        }
        if (body.errors && Object.keys(body.errors).length > 0) {
          return reject(new Error(`API-Football error: ${JSON.stringify(body.errors)}`));
        }

        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// ---------------------------------------------------------------------------
// Normalisers — convert API-Football format to internal format
// ---------------------------------------------------------------------------

function normFixture(f) {
  const fix   = f.fixture   || {};
  const lge   = f.league    || {};
  const teams = f.teams     || {};
  const goals = f.goals     || {};
  const score = f.score     || {};
  const pen   = score.penalty || {};
  const hasPen = pen.home != null && pen.away != null;

  return {
    id:              fix.id,
    status:          normStatus(fix.status?.short),
    round:           normRound(lge.round || ''),
    group:           extractGroup(lge.round || ''),
    date:            fix.date ? fix.date.split('T')[0] : '',
    time:            fix.date ? fix.date.split('T')[1]?.substring(0, 5) : '',
    home_team:       { id: teams.home?.id, name: teams.home?.name || 'TBD' },
    away_team:       { id: teams.away?.id, name: teams.away?.name || 'TBD' },
    home_team_score: goals.home ?? 0,
    away_team_score: goals.away ?? 0,
    home_team_score_p: hasPen ? pen.home : null,
    away_team_score_p: hasPen ? pen.away : null,
    decided_by_penalties: hasPen,
    _raw_status: fix.status?.short,
  };
}

function normStatus(s) {
  const map = {
    'FT':  'Final',       // full time
    'AET': 'Final',       // after extra time
    'PEN': 'Final',       // after penalties
    'AWD': 'Final',       // awarded
    '1H':  'In Progress', 'HT': 'In Progress', '2H': 'In Progress',
    'ET':  'In Progress', 'BT': 'In Progress', 'P':  'In Progress',
    'LIVE':'In Progress',
    'NS':  'Scheduled',   // not started
    'TBD': 'Scheduled',
    'PST': 'Postponed',
    'CANC':'Cancelled',
  };
  return map[s] || s || 'Scheduled';
}

function normRound(round) {
  // API-Football round strings e.g. "Group Stage - 1", "Round of 32", "Quarter-finals", "Semi-finals", "3rd Place Final", "Final"
  const r = round.toLowerCase();
  if (r.includes('group'))    return 'Group Stage';
  if (r.includes('32'))       return 'Round of 32';
  if (r.includes('16'))       return 'Round of 16';
  if (r.includes('quarter'))  return 'Quarter-Final';
  if (r.includes('semi'))     return 'Semi-Final';
  if (r.includes('3rd') || r.includes('third')) return 'Third Place';
  if (r === 'final')          return 'Final';
  return round;
}

function extractGroup(round) {
  // "Group Stage - A" → "A", "Group A" → "A"
  const m = round.match(/group\s+(?:stage\s*[-–]?\s*)?([A-La-l])\b/i);
  return m ? m[1].toUpperCase() : null;
}

function normEvent(fixtureId, e) {
  const type   = (e.type   || '').toLowerCase();
  const detail = (e.detail || '').toLowerCase();

  let normType, normSubType;

  if (type === 'goal') {
    normType    = 'goal';
    normSubType = detail.includes('penalty') ? 'penalty'
                : detail.includes('own')     ? 'own_goal'
                : 'normal';
  } else if (type === 'card') {
    normType    = detail.includes('red') ? 'red_card' : 'yellow_card';
    normSubType = null;
  } else if (type === 'var') {
    // VAR decision — ignore for scoring purposes
    normType    = 'var';
    normSubType = detail;
  } else {
    normType    = type;
    normSubType = detail;
  }

  return {
    id:        `${fixtureId}_${e.time?.elapsed}_${e.team?.id}_${e.player?.id}`,
    match_id:  fixtureId,
    type:      normType,
    sub_type:  normSubType,
    goal_type: normSubType,        // alias used by scoring engine
    team_id:   e.team?.id   ?? null,
    player_id: e.player?.id ?? `anon_${fixtureId}_${Math.random()}`,
    minute:    e.time?.elapsed ?? 0,
  };
}
