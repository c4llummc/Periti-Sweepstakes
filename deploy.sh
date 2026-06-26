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
echo "Next step: set up Netlify"
echo "  1. Go to https://app.netlify.com"
echo "  2. Add new site → Import from Git → GitHub → Periti-Sweepstakes"
echo "  3. Leave build settings blank, click Deploy"
echo "  4. Site config → Environment variables → Add:"
echo "     Key:   BALLDONTLIE_API_KEY"
echo "     (paste your API key — do not put it in any source file)"
echo "  5. Deploys → Trigger deploy"
