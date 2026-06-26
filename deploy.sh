#!/bin/bash
# World Cup Sweepstake — one-shot GitHub deploy script
# Run from the sweepstake/ folder: bash deploy.sh

set -e

REPO="https://github.com/c4llummc/Periti-Sweepstakes.git"

echo "🚀 Deploying World Cup Sweepstake to GitHub..."
echo ""

cd "$(dirname "$0")"

if [ -d ".git" ]; then
  echo "✓ Git repo already initialised"
else
  git init
  echo "✓ Git initialised"
fi

git add -A
git commit -m "World Cup 2026 sweepstake site" 2>/dev/null || git commit --allow-empty -m "World Cup 2026 sweepstake site"

git branch -M main

if git remote get-url origin &>/dev/null; then
  git remote set-url origin "$REPO"
else
  git remote add origin "$REPO"
fi

echo ""
echo "⬆️  Pushing to GitHub (you may be asked to sign in)..."
git push -u origin main --force

echo ""
echo "✅ Done! Files are now at: $REPO"
echo ""
echo "Next step: update Netlify env var"
echo "  1. Go to https://app.netlify.com → your site → Site configuration → Environment variables"
echo "  2. Delete any old BALLDONTLIE_API_KEY or API_FOOTBALL_KEY entry"
echo "  3. Add a variable:"
echo "     Key:   API_FOOTBALL_KEY"
echo "     Value: your football-data.org token (do not commit it to git)"
echo "  4. Go to Deploys → Trigger deploy → Deploy site"
