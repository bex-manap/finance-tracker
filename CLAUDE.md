# Saqta — Personal Finance Telegram Mini App

## What this is
A Telegram Mini App for personal finance tracking. Single-user, runs inside Telegram WebView.
Bot: @Saqta_App_Bot. Live URL: https://bex-manap.github.io/finance-tracker/

## Files
- `index.html` — entire frontend (React 18 + Babel via CDN, single file ~4700 lines)
- `cloudflare-worker.js` — Cloudflare Worker: Anthropic API proxy, Telegram bot, analytics, admin panel
- Worker URL: https://finance-tracker-proxy.life-bekzat.workers.dev

## Stack
- React 18 from CDN (no build step, JSX transpiled in-browser via Babel)
- Tabler Icons webfont from jsDelivr
- Cloudflare D1 (SQLite) for analytics & user tracking
- Lottie player for animated pet on Home
- Anthropic Claude Sonnet 4.6 for AI features
- Telegram WebApp SDK for CloudStorage + user identity

## Languages
English, Russian (Русский), Kazakh (Қазақша). All user-facing strings go through `tr(key, lang)`.
Translations live in the `TRANSLATIONS` object near the top of index.html.

## Deploy flow
- Frontend: edit `index.html` → `git push` → GitHub Pages auto-deploys (~30s)
- Worker: edit `cloudflare-worker.js` → copy/paste contents into Cloudflare dashboard → Deploy

## Important conventions
- NO build step. Single-file constraint is intentional.
- Inline styles only — no CSS classes, no Tailwind, no CSS-in-JS
- Component names PascalCase, helpers camelCase
- Comments above functions explaining "why", not "what". Never inside JSX.
- All settings persist via Telegram CloudStorage with localStorage fallback
- Test that JSX parses before claiming done (see "Verifying changes" below)

## Architecture notes
- D1 tables: users, events, errors, broadcasts
- Cron runs daily at 8 PM Astana (15:00 UTC) — sendDailyReminders
- Admin panel at /admin (password-protected)
- Two pets users can pick: dog or cat (Lottie animations embedded in index.html)

## Don't do
- Don't add Webpack/Vite/any bundler
- Don't add TypeScript
- Don't add CSS frameworks
- Don't auto-deploy on every edit — let me commit deliberately
- Don't sudo install anything

## Personal preferences (Beka)
- Push back honestly when ideas have flaws
- Flag tradeoffs and costs BEFORE building
- Prefer minimal precise edits over rewrites
- Native Kazakh speaker — flag awkward Kazakh phrasing
- Cost-conscious as users grow

## Verifying changes
- For HTML: there's no syntax checker yet. Open the file in browser and verify it loads without errors.
- For worker: `node --check cloudflare-worker.js` checks syntax.