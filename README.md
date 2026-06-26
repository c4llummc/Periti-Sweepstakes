# ⚽ World Cup 2026 Sweepstake Tracker

A single-page leaderboard site for a 48-person sweepstake, with live data from the BALLDONTLIE FIFA World Cup API and a built-in results simulator.

---

## What you need to do (one-time setup)

You need accounts on three free services. Each step takes about 5 minutes.

---

### Step 1 — Get a BALLDONTLIE API key

1. Go to **https://www.balldontlie.io** and create a free account.
2. In your dashboard, generate an API key.
3. Keep it handy — you'll paste it into Netlify in Step 4.

> **Note on the free tier:** The free tier supports the matches, teams, and standings endpoints.  
> If `match_events` returns a 403 error (required for Cards and Penalties boards), see the **Fallback API** section at the bottom of this file.

---

### Step 2 — Push this folder to GitHub

1. Create a new **public** or **private** repository on https://github.com (free account is fine).
2. In your terminal, from this folder:

```bash
git init
git add .
git commit -m "Initial sweepstake site"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

---

### Step 3 — Create a Netlify site

1. Go to **https://app.netlify.com** and sign up (free).
2. Click **Add new site → Import an existing project**.
3. Choose **GitHub**, authorise Netlify, and pick the repo you just created.
4. Build settings — leave everything blank (no build command, publish directory = `.`).
5. Click **Deploy site**. Netlify will give you a URL like `https://magical-baklava-abc123.netlify.app`.

> The first deploy will **fail** because the API key isn't set yet. That's fine — continue to Step 4.

---

### Step 4 — Add the API key as an environment variable

**Never paste the API key into the source files or commit it to git.** Netlify reads it server-side only.

1. In the Netlify dashboard, go to your site → **Site configuration → Environment variables**.
2. Click **Add a variable**.
3. Key: `BALLDONTLIE_API_KEY`  
   Value: the key you got in Step 1.
4. Click **Save**.
5. Go to **Deploys** and click **Trigger deploy → Deploy site**.

After about 30 seconds your site will be live. Open the URL and you should see the leaderboard loading.

---

### Step 5 — Share the URL

Send the Netlify URL to the sweepstake group. The site is read-only and informational — no accounts, no money, no personal data stored.

---

## How the site works

| Tab | What it shows |
|-----|--------------|
| 🏆 Overview | Current champion, runner-up, 3rd place + summary of all 5 bonus leaderboards |
| 🟨 Cards | Ranked by disciplinary points (Y=1, double-Y=2, straight red=3) |
| ⚽ Penalties | Ranked by penalty goals scored (in-play + shootouts) |
| 🔥 Most Goals/G | Ranked by highest average goals per game (both teams combined) |
| 🧊 Fewest Goals/G | Same metric, lowest average wins |
| 🐊 Underdog | Points for beating higher-ranked opponents (FIFA rank gap) |
| 📋 Fixtures | All matches; enter predicted scores for upcoming games |

### Simulator

- Toggle **"Show predictions"** to activate the simulator.
- Enter a predicted score for any upcoming match. All leaderboards update live.
- For Cards and Penalties boards, expand the prediction row to enter expected card/penalty counts — otherwise those boards won't react to upcoming matches.
- Knockout bracket: when you predict a result, the winner automatically populates the correct next-round fixture.
- Predictions are saved in your browser (`localStorage`) — a refresh won't wipe them.
- **Reset predictions** clears everything and returns to actual-only mode.

### Tiebreaker

When two players are tied on any metric, the player whose team has the **higher FIFA ranking number** (i.e. the worse-ranked team) wins the tie.

---

## Updating automatically

Netlify serves the static site. Data is fetched live from BALLDONTLIE every time someone opens the page (cached 45 seconds in the serverless function). No redeployment needed as results come in.

---

## Fallback API (if match_events is gated)

If BALLDONTLIE's free tier doesn't include `match_events` (you'll see a yellow warning on the Cards and Penalties tabs), you have two options:

**Option A — Upgrade BALLDONTLIE** to their paid "GOAT" tier (~$9/month) which unlocks all endpoints.

**Option B — Switch to Highlightly** (100 req/day free):
1. Sign up at https://highlightly.net and get a free API key.
2. In `netlify/functions/proxy.js`, replace the `API_BASE` and auth header with Highlightly's endpoint.  
   The proxy abstraction means it's a single-file change.
3. Add `HIGHLIGHTLY_API_KEY` as a Netlify env var.
4. Redeploy.

The frontend scoring engine is data-provider-agnostic — only the proxy needs changing.

---

## File structure

```
sweepstake/
├── index.html              ← the entire frontend (HTML + CSS + JS)
├── netlify.toml            ← Netlify build configuration
├── netlify/
│   └── functions/
│       └── proxy.js        ← serverless API proxy (Node 18)
└── README.md               ← this file
```

---

## Disclaimer

This is an unofficial tracker for a friends' sweepstake. Final prize allocation is validated manually by the organiser. Data is best-effort and sourced from a third-party API.
