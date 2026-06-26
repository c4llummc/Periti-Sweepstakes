/**
 * Netlify Function: proxy.js  (football-data.org v4 edition)
 *
 * Uses the FREE football-data.org API — World Cup is included at no cost.
 * One API call fetches all matches + embedded goals & bookings, so we stay
 * well within the 10 req/minute rate limit.
 *
 * Required env var (Netlify → Site configuration → Environment variables):
 *   API_FOOTBALL_KEY = your key from football-data.org/client/register
 *
 * football-data.org free tier: no daily cap, 10 requests/minute.
 * We cache the full match list for 60 s, so at most 1 req/minute in practice.
 */

'use strict';
const https = require('https');

const API_BASE     = 'https://api.football-data.org/v4';
const WC_CODE      = 'WC';   // football-data.org competition code for FIFA World Cup
const WC_SEASON    = 2026;

// In-memory cache (persists for ~26 min Netlify warm window)
const cache = new Map();
const TTL_MATCHES = 60; // seconds — refresh live scores every minute

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
        error: 'API key not configured. Add API_FOOTBALL_KEY to Netlify → Site configuration → Environment variables.',
      }),
    };
  }

  const svParams = event.queryStringParameters || {};
  const mvParams = event.multiValueQueryStringParameters || {};
  const endpoint = svParams._endpoint;

  if (!endpoint) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing _endpoint' }) };
  }

  try {
    // All data comes from one API call — we cache the full payload
    const { matches, eventsByMatchId, teams } = await getAllData(apiKey);

    let data;
    if (endpoint === 'matches') {
      data = matches;
    } else if (endpoint === 'teams') {
      data = teams;
    } else if (endpoint === 'match_events') {
      // Return events for the requested match IDs — served from cache, no extra API calls
      const ids = (mvParams['match_ids[]'] || [])
        .concat(svParams['match_ids[]'] ? [svParams['match_ids[]']] : [])
        .map(Number)
        .filter(Boolean);
      data = ids.flatMap(id => eventsByMatchId[id] || []);
    } else {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Unknown endpoint: ${endpoint}` }) };
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ data }) };

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
// Fetch + cache all WC 2026 data in one API call
// ---------------------------------------------------------------------------
async function getAllData(apiKey) {
  const CACHE_KEY = 'wc2026_all';
  const now = Math.floor(Date.now() / 1000);
  const hit = cache.get(CACHE_KEY);
  if (hit && (now - hit.ts) < TTL_MATCHES) return hit.data;

  const raw = await apiFetch(apiKey, `/competitions/${WC_CODE}/matches?season=${WC_SEASON}`);
  const rawMatches = raw.matches || [];

  const matches         = rawMatches.map(normMatch);
  const eventsByMatchId = {};
  for (const m of rawMatches) {
    eventsByMatchId[m.id] = extractEvents(m);
  }

  // Derive unique teams from the match list
  const teamsSeen = {};
  for (const nm of matches) {
    if (nm.home_team?.id && !teamsSeen[nm.home_team.id]) teamsSeen[nm.home_team.id] = nm.home_team;
    if (nm.away_team?.id && !teamsSeen[nm.away_team.id]) teamsSeen[nm.away_team.id] = nm.away_team;
  }
  const teams = Object.values(teamsSeen);

  const data = { matches, eventsByMatchId, teams };
  cache.set(CACHE_KEY, { data, ts: now });
  return data;
}

// ---------------------------------------------------------------------------
// Raw HTTPS call to football-data.org
// ---------------------------------------------------------------------------
function apiFetch(apiKey, path) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${path}`;
    const req = https.get(url, {
      headers: {
        'X-Auth-Token': apiKey,
        'Accept':       'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch (e) {
          return reject(new Error(`JSON parse error (HTTP ${res.statusCode}): ${raw.substring(0, 200)}`));
        }
        if (res.statusCode === 400 && body.message) {
          return reject(new Error(`football-data.org: ${JSON.stringify(body)}`));
        }
        if (res.statusCode === 401) {
          return reject(new Error(
            `football-data.org: invalid API key (401). ` +
            `Check API_FOOTBALL_KEY in Netlify. Raw: ${raw.substring(0, 200)}`
          ));
        }
        if (res.statusCode === 403) {
          return reject(new Error(
            `football-data.org: access denied (403) — "${body.message || raw.substring(0,150)}". ` +
            `World Cup should be free; check your account tier at football-data.org.`
          ));
        }
        if (res.statusCode === 429) {
          return reject(new Error('football-data.org: rate limit hit (429). Will retry on next request.'));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`football-data.org HTTP ${res.statusCode}: ${raw.substring(0, 300)}`));
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Request timed out: ${url}`)); });
  });
}

// ---------------------------------------------------------------------------
// Normalisers — convert football-data.org v4 format to our internal format
// ---------------------------------------------------------------------------

function normMatch(m) {
  const score = m.score || {};
  const ft    = score.fullTime  || {};
  const et    = score.extraTime || {};
  const pens  = score.penalties || {};
  const hasPen = pens.home != null && pens.away != null;

  return {
    id:              m.id,
    status:          normStatus(m.status),
    round:           normStage(m.stage || ''),
    group:           normGroup(m.group || ''),
    date:            m.utcDate ? m.utcDate.split('T')[0] : '',
    time:            m.utcDate ? m.utcDate.split('T')[1]?.substring(0, 5) : '',
    home_team:       { id: m.homeTeam?.id, name: m.homeTeam?.name || 'TBD' },
    away_team:       { id: m.awayTeam?.id, name: m.awayTeam?.name || 'TBD' },
    // Full-time score (includes extra time goals if AET, excludes shootout)
    home_team_score: ft.home ?? 0,
    away_team_score: ft.away ?? 0,
    // Penalty shootout score (null if no shootout)
    home_team_score_p: hasPen ? pens.home : null,
    away_team_score_p: hasPen ? pens.away : null,
    decided_by_penalties: hasPen,
  };
}

function normStatus(s) {
  switch (s) {
    case 'FINISHED':   return 'Final';
    case 'IN_PLAY':
    case 'PAUSED':
    case 'EXTRA_TIME':
    case 'PENALTY_SHOOTOUT': return 'In Progress';
    case 'TIMED':
    case 'SCHEDULED':  return 'Scheduled';
    case 'POSTPONED':  return 'Postponed';
    case 'CANCELLED':  return 'Cancelled';
    case 'SUSPENDED':  return 'Suspended';
    default:           return s || 'Scheduled';
  }
}

function normStage(stage) {
  switch (stage) {
    case 'GROUP_STAGE':      return 'Group Stage';
    case 'LAST_32':          return 'Round of 32';
    case 'LAST_16':          return 'Round of 16';
    case 'QUARTER_FINALS':   return 'Quarter-Final';
    case 'SEMI_FINALS':      return 'Semi-Final';
    case 'THIRD_PLACE':      return 'Third Place';
    case 'FINAL':            return 'Final';
    default:                 return stage || 'Unknown';
  }
}

function normGroup(g) {
  // "GROUP_A" → "A"
  return g.replace(/^GROUP_/, '') || null;
}

/**
 * Extract goals and bookings from a match object and return them as
 * normalised event objects compatible with the frontend scoring engine.
 */
function extractEvents(m) {
  const events = [];

  // ---- Goals ----
  for (const g of (m.goals || [])) {
    const subType = g.type === 'PENALTY'   ? 'penalty'
                  : g.type === 'OWN_GOAL' ? 'own_goal'
                  : 'normal';

    events.push({
      id:        `${m.id}_goal_${g.minute}_${g.scorer?.id || Math.random()}`,
      match_id:  m.id,
      type:      'goal',
      sub_type:  subType,
      goal_type: subType,
      team_id:   g.team?.id,
      player_id: g.scorer?.id || `scorer_${Math.random()}`,
      minute:    g.minute || 0,
    });
  }

  // ---- Bookings (cards) ----
  for (const b of (m.bookings || [])) {
    const cardType = b.card; // "YELLOW_CARD", "YELLOW_RED_CARD", "RED_CARD"

    if (cardType === 'YELLOW_CARD' || cardType === 'YELLOW_RED_CARD') {
      // Emit a yellow_card event.
      // football-data.org sends BOTH the initial YELLOW_CARD and the YELLOW_RED_CARD
      // for the same player, so the engine will see two yellows → 2 pts total. ✓
      events.push({
        id:        `${m.id}_card_${b.minute}_${b.player?.id || Math.random()}_yellow`,
        match_id:  m.id,
        type:      'yellow_card',
        sub_type:  null,
        team_id:   b.team?.id,
        player_id: b.player?.id || `player_${Math.random()}`,
        minute:    b.minute || 0,
      });
    } else if (cardType === 'RED_CARD') {
      events.push({
        id:        `${m.id}_card_${b.minute}_${b.player?.id || Math.random()}_red`,
        match_id:  m.id,
        type:      'red_card',
        sub_type:  null,
        team_id:   b.team?.id,
        player_id: b.player?.id || `player_${Math.random()}`,
        minute:    b.minute || 0,
      });
    }
  }

  // ---- Penalty shootout goals (synthetic events) ----
  // football-data.org gives us the total scored in each shootout but not
  // individual kicks. We generate synthetic events by team so the
  // Penalties Scored leaderboard counts them correctly.
  const pens = m.score?.penalties;
  if (pens && pens.home != null && pens.away != null) {
    for (let i = 0; i < pens.home; i++) {
      events.push({
        id:        `${m.id}_pso_home_${i}`,
        match_id:  m.id,
        type:      'penalty_kick',
        sub_type:  'scored',
        team_id:   m.homeTeam?.id,
        player_id: `pso_home_${m.id}_${i}`,
        minute:    120 + i,
        missed:    false,
      });
    }
    for (let i = 0; i < pens.away; i++) {
      events.push({
        id:        `${m.id}_pso_away_${i}`,
        match_id:  m.id,
        type:      'penalty_kick',
        sub_type:  'scored',
        team_id:   m.awayTeam?.id,
        player_id: `pso_away_${m.id}_${i}`,
        minute:    120 + i,
        missed:    false,
      });
    }
  }

  return events;
}
