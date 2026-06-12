// Cloudflare Worker — Finance Tracker Backend
// Handles four jobs:
// 1. Proxies requests to the Anthropic API (keeps your API key secret)
// 2. Listens for Telegram bot webhook events and sends the welcome message on /start
// 3. Receives anonymous analytics events from the mini app at /track
// 4. Serves a password-protected admin dashboard at /admin
//
// Environment variables needed in Cloudflare dashboard:
//   ANTHROPIC_API_KEY  — your Anthropic API key (secret)
//   TELEGRAM_BOT_TOKEN — your Telegram bot token from BotFather (secret)
//   APP_URL            — your GitHub Pages URL
//   ADMIN_PASSWORD     — password for the admin dashboard (secret) — pick something long & random
//
// D1 binding required:
//   DB — a D1 database. See setup-db.sql for schema. Bind it in Worker → Settings → Variables → D1 Database Bindings.

// Welcome messages keyed by ui language. Picked based on Telegram user's `language_code`.
const WELCOME_MESSAGES = {
  English: `👋 Hi! Welcome to Saqta — your personal financial assistant

Here's how it works:
🐶 Get AI pet — it will help you grow your savings (and grumble a bit when you overspend).
🏦 Manage all accounts in one place — from traditional banks to crypto (USDT & BTC) with auto-updated rates.
📊 Say goodbye to budget deficits — smart analytics and spend heatmaps will show exactly where your money goes.

Open the app and choose your pet! 👇`,

  Russian: `👋 Привет!

Это Saqta — твой карманный финансовый помощник.

Здесь всё просто:
🐶 Заведи питомца — он будет помогать вместе с твоими накоплениями (или ворчать за лишние траты).
🏦 Управляй всеми счетами — от Kaspi и Freedom до крипты в USDT и BTC с автокурсом.
📊 Забывай про дефицит — умная аналитика и тепловые карты покажут, куда уходят деньги.

Переходи в приложение и выбери своего питомца! 👇`,

  Kazakh: `👋 Сәлем!

Бұл Saqta — сенің қалтаңдағы қаржылық көмекшің.

Мұнда бәрі оңай:
🐶 Виртуалды үй жануарын ал — ол саған ақша сақтауға көмектеседі (немесе артық шығындарың үшін кейіп сөйлейді).
🏦 Барлық шоттарыңды басқар — Kaspi мен Freedom-нан бастап, автоматты бағамы бар USDT және BTC криптасына дейін.
📊 Қаржы тапшылығын ұмыт — ақылды аналитика мен шығындардың жылу картасы ақшаның қайда кетіп жатқанын көрсетеді.

Қосымшаға өтіп, өз үй жануарыңды таңда! 👇`
};

// Button label per language — shown on the inline keyboard below the welcome message
const OPEN_APP_BUTTON = {
  English: '💰 Open Saqta',
  Russian: '💰 Открыть Saqta',
  Kazakh: '💰 Saqta-ны ашу'
};

// Map a Telegram language_code (e.g. "ru", "ru-RU", "kk", "kz") to one of our 3 supported langs
function pickWelcomeLang(code) {
  const c = (code || '').toLowerCase();
  if (c.startsWith('ru')) return 'Russian';
  if (c.startsWith('kk') || c.startsWith('kz')) return 'Kazakh';
  return 'English';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/telegram-webhook') return handleTelegramWebhook(request, env);
    if (url.pathname === '/track')            return handleTrack(request, env);
    if (url.pathname.startsWith('/admin'))    return handleAdmin(request, env, url);
    // PDF bank statement parser — uses Anthropic vision to extract transactions
    if (url.pathname === '/parse-statement')  return handleParseStatement(request, env);
    // Server-side user data storage (D1). Source of truth for txns + state.
    if (url.pathname.startsWith('/api/data/')) return handleDataApi(request, env, url);
    // Email OTP + identity linking (Phase 1b). Used by Telegram Mini App to link email,
    // and by future native apps to sign in via email.
    if (url.pathname.startsWith('/api/auth/')) return handleAuthApi(request, env, url);

    return handleAnthropicProxy(request, env);
  },

  // Cron trigger handler — fires daily at 15:00 UTC (20:00 Astana time, GMT+5).
  // Configure cron in Cloudflare: Worker → Settings → Triggers → Cron Triggers → "0 15 * * *"
  // We also expose a manual /admin/api/send-reminders endpoint for testing.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyReminders(env));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// /track — receives anonymous events from the mini app
// Body shape:
//   { tg_id, username, first_name, language_code, ui_language, ai_language,
//     ai_pet, ai_tone, platform, session_id, event_type, metadata }
// On every event we upsert the user row (last_active, settings) and append an
// event row. No transaction amounts or account/category names are accepted.
// ─────────────────────────────────────────────────────────────────────────────
async function handleTrack(request, env) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST')    return new Response('Method not allowed', { status: 405, headers: cors });

  try {
    const body = await request.json();
    const {
      tg_id, username, first_name, language_code,
      ui_language, ai_language, ai_pet, ai_tone, platform,
      reminders_enabled,
      session_id, event_type, metadata
    } = body;

    // Reject anything that doesn't have a Telegram ID — we don't track anonymous web visitors here
    if (!tg_id || !event_type) return new Response('Bad request', { status: 400, headers: cors });

    // Country from Cloudflare's geo header (free, no IP storage required)
    const country = request.headers.get('CF-IPCountry') || null;

    const now = Date.now();

    // Strip metadata to a known safe whitelist — no amounts, no notes, no balances
    const safeMeta = sanitizeMetadata(metadata);

    // Coerce reminders_enabled to 0/1 (default to 1 for new users so reminders are opt-out)
    const remindersFlag = reminders_enabled === undefined || reminders_enabled === null
      ? null  // null = don't update — preserves existing setting
      : (reminders_enabled ? 1 : 0);

    // Upsert user row. SQLite upsert via INSERT ... ON CONFLICT.
    // First-seen registers the user; subsequent events update last_active and counters.
    await env.DB.prepare(`
      INSERT INTO users (
        tg_id, username, first_name, language_code,
        ui_language, ai_language, ai_pet, ai_tone, platform, country,
        reminders_enabled,
        registered_at, last_active, total_sessions, txn_count, account_count,
        goal_count, ai_request_count, current_streak, longest_streak
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1), ?, ?, 0, 0, 0, 0, 0, 0, 0)
      ON CONFLICT(tg_id) DO UPDATE SET
        username = COALESCE(excluded.username, users.username),
        first_name = COALESCE(excluded.first_name, users.first_name),
        language_code = COALESCE(excluded.language_code, users.language_code),
        ui_language = COALESCE(excluded.ui_language, users.ui_language),
        ai_language = COALESCE(excluded.ai_language, users.ai_language),
        ai_pet = COALESCE(excluded.ai_pet, users.ai_pet),
        ai_tone = COALESCE(excluded.ai_tone, users.ai_tone),
        platform = COALESCE(excluded.platform, users.platform),
        country = COALESCE(excluded.country, users.country),
        reminders_enabled = COALESCE(excluded.reminders_enabled, users.reminders_enabled),
        last_active = excluded.last_active
    `).bind(
      tg_id, username || null, first_name || null, language_code || null,
      ui_language || null, ai_language || null, ai_pet || null, ai_tone || null,
      platform || null, country, remindersFlag, now, now
    ).run();

    // Increment per-event counters on the user row
    if (event_type === 'app_open') {
      await env.DB.prepare(`UPDATE users SET total_sessions = total_sessions + 1 WHERE tg_id = ?`).bind(tg_id).run();
      await updateStreak(env, tg_id, now);
    } else if (event_type === 'txn_create') {
      await env.DB.prepare(`UPDATE users SET txn_count = txn_count + 1 WHERE tg_id = ?`).bind(tg_id).run();
    } else if (event_type === 'goal_create') {
      await env.DB.prepare(`UPDATE users SET goal_count = goal_count + 1 WHERE tg_id = ?`).bind(tg_id).run();
    } else if (event_type === 'ai_request') {
      await env.DB.prepare(`UPDATE users SET ai_request_count = ai_request_count + 1 WHERE tg_id = ?`).bind(tg_id).run();
    } else if (event_type === 'account_create') {
      await env.DB.prepare(`UPDATE users SET account_count = account_count + 1 WHERE tg_id = ?`).bind(tg_id).run();
    } else if (event_type === 'js_error' || event_type === 'ai_error') {
      await env.DB.prepare(`
        INSERT INTO errors (tg_id, ts, error_type, message, stack)
        VALUES (?, ?, ?, ?, ?)
      `).bind(tg_id, now, event_type, (safeMeta.message || '').slice(0, 500), (safeMeta.stack || '').slice(0, 2000)).run();
    }

    // Append event row
    await env.DB.prepare(`
      INSERT INTO events (tg_id, event_type, ts, session_id, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).bind(tg_id, event_type, now, session_id || null, JSON.stringify(safeMeta)).run();

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...cors }
    });
  } catch (e) {
    console.error('Track error:', e);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors }
    });
  }
}

// Allowlist of metadata keys we accept — anything else is dropped before storage.
// Specifically excludes anything that could contain amounts, balances, or note content.
function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const allowed = ['type', 'currency', 'has_note', 'screen', 'feature', 'message', 'stack', 'pet', 'tone', 'language'];
  const out = {};
  for (const k of allowed) {
    if (meta[k] !== undefined) {
      out[k] = typeof meta[k] === 'string' ? meta[k].slice(0, 200) : meta[k];
    }
  }
  return out;
}

// Streak: consecutive days with at least one app_open. Compare current local
// date with last_active's local date. If same day, no change. If exactly +1
// day, increment. Otherwise reset to 1.
async function updateStreak(env, tg_id, now) {
  const row = await env.DB.prepare(`SELECT last_active, current_streak, longest_streak FROM users WHERE tg_id = ?`).bind(tg_id).first();
  if (!row) return;

  const dayOf = (ts) => Math.floor(ts / 86400000); // UTC day index — close enough for streaks
  const todayDay = dayOf(now);
  const lastDay  = row.last_active ? dayOf(row.last_active) : null;

  let newStreak = row.current_streak || 0;
  if (lastDay === null || newStreak === 0) newStreak = 1;
  else if (todayDay === lastDay)           newStreak = newStreak; // same day — no change
  else if (todayDay === lastDay + 1)       newStreak += 1;
  else                                     newStreak = 1;

  const longest = Math.max(newStreak, row.longest_streak || 0);
  await env.DB.prepare(`UPDATE users SET current_streak = ?, longest_streak = ? WHERE tg_id = ?`).bind(newStreak, longest, tg_id).run();
}

// ─────────────────────────────────────────────────────────────────────────────
// /admin — password-protected dashboard
// ─────────────────────────────────────────────────────────────────────────────
async function handleAdmin(request, env, url) {
  // HTTP Basic auth check
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Basic ')) return needsAuth();
  const decoded = atob(auth.slice(6));
  const [, password] = decoded.split(':');
  // Resolve the admin password. Cloudflare has two secret systems:
  // - Secrets Store binding: accessed as `await env.ADMIN_PASSWORD.get()`
  // - Plain Worker Secret: accessed as `env.ADMIN_PASSWORD` (string directly)
  // We support both — check which type was bound and read accordingly.
  let adminPassword;
  if (env.ADMIN_PASSWORD && typeof env.ADMIN_PASSWORD.get === 'function') {
    adminPassword = await env.ADMIN_PASSWORD.get();
  } else {
    adminPassword = env.ADMIN_PASSWORD;
  }
  if (!timingSafeEqualStr(password, adminPassword)) return needsAuth();

  // JSON API endpoints under /admin/api
  if (url.pathname.startsWith('/admin/api/')) {
    const sub = url.pathname.slice('/admin/api/'.length);
    return handleAdminApi(request, env, sub, url);
  }

  // Otherwise serve the dashboard HTML
  return new Response(adminDashboardHtml(), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function needsAuth() {
  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Finance Tracker Admin"' }
  });
}

async function handleAdminApi(request, env, sub, url) {
  const j = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

  if (sub === 'metrics') {
    const now = Date.now();
    const day = 86400000;
    const dau = (await env.DB.prepare(`SELECT COUNT(DISTINCT tg_id) as c FROM events WHERE ts > ? AND event_type = 'app_open'`).bind(now - day).first()).c;
    const wau = (await env.DB.prepare(`SELECT COUNT(DISTINCT tg_id) as c FROM events WHERE ts > ? AND event_type = 'app_open'`).bind(now - 7 * day).first()).c;
    const mau = (await env.DB.prepare(`SELECT COUNT(DISTINCT tg_id) as c FROM events WHERE ts > ? AND event_type = 'app_open'`).bind(now - 30 * day).first()).c;
    const total = (await env.DB.prepare(`SELECT COUNT(*) as c FROM users`).first()).c;
    const txnsToday = (await env.DB.prepare(`SELECT COUNT(*) as c FROM events WHERE ts > ? AND event_type = 'txn_create'`).bind(now - day).first()).c;
    const aiToday = (await env.DB.prepare(`SELECT COUNT(*) as c FROM events WHERE ts > ? AND event_type = 'ai_request'`).bind(now - day).first()).c;
    const errorsToday = (await env.DB.prepare(`SELECT COUNT(*) as c FROM errors WHERE ts > ?`).bind(now - day).first()).c;

    // Avg session length — defined as time between first and last event with the same session_id, today
    const sessions = await env.DB.prepare(`
      SELECT session_id, MAX(ts) - MIN(ts) as duration
      FROM events
      WHERE ts > ? AND session_id IS NOT NULL
      GROUP BY session_id
      HAVING duration > 0
    `).bind(now - day).all();
    const avgSession = sessions.results.length
      ? Math.round(sessions.results.reduce((s, r) => s + r.duration, 0) / sessions.results.length / 1000)
      : 0;

    return j({ total, dau, wau, mau, txnsToday, aiToday, errorsToday, avgSession });
  }

  if (sub === 'users') {
    const users = await env.DB.prepare(`SELECT * FROM users ORDER BY last_active DESC LIMIT 500`).all();
    return j(users.results);
  }

  // DAU/WAU/MAU over time — returns 30 daily buckets ending today.
  // We compute three sliding-window values per day so charts read naturally:
  //   dau_d = unique users active on that day
  //   wau_d = unique users active in 7 days ending that day
  //   mau_d = unique users active in 30 days ending that day
  if (sub === 'chart') {
    const now = Date.now();
    const day = 86400000;
    const days = 30;
    // Pull all app_open events in the last 60 days once, then bucket in JS — much cheaper than 30 separate queries.
    const events = await env.DB.prepare(`
      SELECT tg_id, ts FROM events
      WHERE event_type = 'app_open' AND ts > ?
    `).bind(now - (days + 30) * day).all();

    const points = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayEnd = now - i * day;
      const dayStart = dayEnd - day;
      const week = dayEnd - 7 * day;
      const month = dayEnd - 30 * day;
      const dauSet = new Set(), wauSet = new Set(), mauSet = new Set();
      for (const e of events.results) {
        if (e.ts > dayStart && e.ts <= dayEnd) dauSet.add(e.tg_id);
        if (e.ts > week     && e.ts <= dayEnd) wauSet.add(e.tg_id);
        if (e.ts > month    && e.ts <= dayEnd) mauSet.add(e.tg_id);
      }
      points.push({
        date: new Date(dayEnd).toISOString().split('T')[0],
        dau: dauSet.size, wau: wauSet.size, mau: mauSet.size
      });
    }
    return j(points);
  }

  // Cohort retention — users grouped by week of registration, then % who came back in subsequent weeks.
  // Returns a triangular grid: cohorts × weeks-since-registration → retention %.
  if (sub === 'cohorts') {
    const now = Date.now();
    const week = 7 * 86400000;
    const cohortCount = 8; // last 8 weeks of cohorts
    // Pull all users + all app_open events in the relevant window
    const users = await env.DB.prepare(`
      SELECT tg_id, registered_at FROM users
      WHERE registered_at > ?
    `).bind(now - cohortCount * week).all();
    const events = await env.DB.prepare(`
      SELECT DISTINCT tg_id, ts FROM events
      WHERE event_type = 'app_open' AND ts > ?
    `).bind(now - cohortCount * week).all();

    // Group user → set of week indices they were active
    const weekOf = (ts) => Math.floor((now - ts) / week);
    const userActiveWeeks = new Map(); // tg_id → Set<weekIndex from registration>
    const userRegWeek = new Map();     // tg_id → cohort week index
    users.results.forEach(u => {
      userRegWeek.set(u.tg_id, weekOf(u.registered_at));
      userActiveWeeks.set(u.tg_id, new Set());
    });
    events.results.forEach(e => {
      const reg = userRegWeek.get(e.tg_id);
      if (reg === undefined) return;
      const evWeek = weekOf(e.ts);
      const offset = reg - evWeek; // weeks since registration (0 = same week)
      if (offset >= 0) userActiveWeeks.get(e.tg_id).add(offset);
    });

    // Build the grid: rows = cohorts (0 = current week, 1 = last week, ...), cols = week offset
    const cohorts = [];
    for (let c = 0; c < cohortCount; c++) {
      const cohortUsers = [...userRegWeek.entries()].filter(([, w]) => w === c).map(([id]) => id);
      const size = cohortUsers.length;
      const retention = [];
      for (let offset = 0; offset <= c; offset++) {
        const returned = cohortUsers.filter(id => userActiveWeeks.get(id).has(offset)).length;
        retention.push({
          offset,
          pct: size > 0 ? Math.round((returned / size) * 100) : 0,
          count: returned
        });
      }
      cohorts.push({
        weeksAgo: c,
        label: c === 0 ? 'This week' : c === 1 ? 'Last week' : `${c} weeks ago`,
        size,
        retention
      });
    }
    return j(cohorts);
  }

  // "Live now" — users with at least one event in the last 5 minutes
  if (sub === 'live') {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const r = await env.DB.prepare(`SELECT COUNT(DISTINCT tg_id) as c FROM events WHERE ts > ?`).bind(fiveMinAgo).first();
    return j({ count: r.c });
  }

  // Errors grouped by message — most common errors first
  if (sub === 'errors-grouped') {
    const now = Date.now();
    const day = 86400000;
    const errs = await env.DB.prepare(`
      SELECT message, error_type, COUNT(*) as count, MAX(ts) as last_seen, COUNT(DISTINCT tg_id) as users_affected
      FROM errors WHERE ts > ?
      GROUP BY message, error_type
      ORDER BY count DESC
      LIMIT 100
    `).bind(now - 30 * day).all();
    return j(errs.results);
  }

  // Cost tracker — estimates Anthropic API spend based on AI request counts.
  // Pricing (per 1M tokens): Haiku 4.5 = $1 input / $5 output, Sonnet 4.6 = $3 / $15.
  // Average per pet comment: ~250 input tokens, ~80 output tokens (1-2 sentences).
  // Kazakh requests use Sonnet, others use Haiku — we approximate by language split.
  if (sub === 'costs') {
    const now = Date.now();
    const day = 86400000;
    const month = 30 * day;
    // Get AI requests grouped by language for the last 30 days
    const byLang = await env.DB.prepare(`
      SELECT
        COALESCE(json_extract(metadata, '$.language'), 'English') as lang,
        COUNT(*) as count
      FROM events
      WHERE event_type = 'ai_request' AND ts > ?
      GROUP BY lang
    `).bind(now - month).all();

    // Token estimates per request
    const inputTokens = 250, outputTokens = 80;
    const haikuCost  = (inputTokens * 1 + outputTokens * 5)  / 1_000_000;   // $0.00065/req
    const sonnetCost = (inputTokens * 3 + outputTokens * 15) / 1_000_000;   // $0.00195/req

    let totalRequests = 0, totalCost = 0;
    const breakdown = byLang.results.map(r => {
      const isKazakh = r.lang === 'Kazakh';
      const perReq = isKazakh ? sonnetCost : haikuCost;
      const cost = r.count * perReq;
      totalRequests += r.count;
      totalCost += cost;
      return {
        lang: r.lang || 'unknown',
        count: r.count,
        model: isKazakh ? 'Sonnet 4.6' : 'Haiku 4.5',
        cost: Math.round(cost * 10000) / 10000
      };
    });

    // Today's request count for the small "today" badge
    const todayReq = (await env.DB.prepare(`SELECT COUNT(*) as c FROM events WHERE event_type = 'ai_request' AND ts > ?`).bind(now - day).first()).c;

    return j({
      total30d: { requests: totalRequests, cost: Math.round(totalCost * 100) / 100 },
      todayRequests: todayReq,
      breakdown
    });
  }

  if (sub === 'user-events') {
    const tgId = url.searchParams.get('tg_id');
    const events = await env.DB.prepare(`SELECT * FROM events WHERE tg_id = ? ORDER BY ts DESC LIMIT 100`).bind(tgId).all();
    return j(events.results);
  }

  if (sub === 'errors') {
    const errs = await env.DB.prepare(`SELECT * FROM errors ORDER BY ts DESC LIMIT 200`).all();
    return j(errs.results);
  }

  if (sub === 'ban' && url.searchParams.get('tg_id')) {
    const tgId = url.searchParams.get('tg_id');
    const reason = url.searchParams.get('reason') || 'No reason provided';
    await env.DB.prepare(`UPDATE users SET banned = 1, banned_reason = ?, banned_at = ? WHERE tg_id = ?`).bind(reason, Date.now(), tgId).run();
    return j({ ok: true });
  }

  if (sub === 'unban' && url.searchParams.get('tg_id')) {
    const tgId = url.searchParams.get('tg_id');
    await env.DB.prepare(`UPDATE users SET banned = 0, banned_reason = NULL, banned_at = NULL WHERE tg_id = ?`).bind(tgId).run();
    return j({ ok: true });
  }

  if (sub === 'reset-onboarding' && url.searchParams.get('tg_id')) {
    // We can't directly modify the user's CloudStorage from here, but we can flag it in the DB.
    // The mini app on next launch checks /admin/api/should-reset and resets if flagged.
    const tgId = url.searchParams.get('tg_id');
    await env.DB.prepare(`UPDATE users SET reset_onboarding_flag = 1 WHERE tg_id = ?`).bind(tgId).run();
    return j({ ok: true });
  }

  // Manual trigger: send the daily reminder batch right now.
  // Useful for testing the cron flow without waiting for 8 PM, and as a backup if cron fails.
  if (sub === 'send-reminders-now') {
    const result = await sendDailyReminders(env);
    return j(result);
  }

  // Send a test reminder to a specific user — useful to verify per-user delivery
  if (sub === 'test-reminder' && url.searchParams.get('tg_id')) {
    const tgId = url.searchParams.get('tg_id');
    const u = await env.DB.prepare(`SELECT * FROM users WHERE tg_id = ?`).bind(tgId).first();
    if (!u) return j({ ok: false, error: 'User not found' });
    const lang = u.ui_language || pickLanguage(u.language_code);
    const pet = u.ai_pet || 'dog';
    const message = pickReminder(lang, pet);
    try {
      // Build the message body. Include the inline button only if APP_URL is set —
      // otherwise Telegram rejects the message because a button without a URL is invalid.
      const messageBody = {
        chat_id: tgId,
        text: message
      };
      if (env.APP_URL) {
        messageBody.reply_markup = {
          inline_keyboard: [[{ text: '💰 Open Finance Tracker', web_app: { url: env.APP_URL } }]]
        };
      }
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messageBody)
      });
      // Read Telegram's response body — they include a `description` field that says exactly what went wrong
      // (e.g. "Forbidden: bot can't initiate conversation with a user", "Bad Request: chat not found")
      const tgResponse = await res.json().catch(() => ({}));
      // If the test send actually delivered, count it like a real reminder so the dashboard reflects it
      if (res.ok) {
        await env.DB.prepare(`
          UPDATE users
          SET reminders_sent = COALESCE(reminders_sent, 0) + 1,
              last_reminder_sent = ?
          WHERE tg_id = ?
        `).bind(Date.now(), tgId).run();
      }
      return j({
        ok: res.ok,
        status: res.status,
        telegram_response: tgResponse,
        message,
        language: lang,
        pet,
        bot_token_set: !!env.TELEGRAM_BOT_TOKEN,
        bot_token_length: env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.length : 0,
        app_url_set: !!env.APP_URL,
        app_url_value: env.APP_URL || '(not set)'
      });
    } catch (e) {
      return j({ ok: false, error: e.message });
    }
  }

  // ─── BROADCAST ENDPOINT ───
  // POST /admin/api/broadcast
  // Body: { mode: "custom"|"random", text?: string, tg_ids?: number[] }
  // - mode "custom": send `text` to every recipient (same message)
  // - mode "random": pick a random reminder per recipient (matches their language + pet)
  // - tg_ids missing/empty: send to ALL eligible (banned=0, reminders_enabled=1)
  // - tg_ids present:      send only to those, still filtered by opt-out
  if (sub === 'broadcast' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { mode, text, tg_ids } = body;
      if (mode !== 'custom' && mode !== 'random') {
        return j({ ok: false, error: 'mode must be "custom" or "random"' });
      }
      if (mode === 'custom' && (!text || !text.trim())) {
        return j({ ok: false, error: 'text is required for custom mode' });
      }
      const result = await sendBroadcast(env, {
        mode,
        text: text ? text.trim() : null,
        targetTgIds: (Array.isArray(tg_ids) && tg_ids.length > 0) ? tg_ids : null
      });
      return j({ ok: true, ...result });
    } catch (e) {
      return j({ ok: false, error: e.message });
    }
  }

  // POST /admin/api/send-to-user — single-user send (used from user detail modal)
  // Body: { tg_id: number, text: string }
  if (sub === 'send-to-user' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { tg_id, text } = body;
      if (!tg_id || !text || !text.trim()) {
        return j({ ok: false, error: 'tg_id and text are required' });
      }
      const result = await sendBroadcast(env, {
        mode: 'custom',
        text: text.trim(),
        targetTgIds: [tg_id]
      });
      return j({ ok: true, ...result });
    } catch (e) {
      return j({ ok: false, error: e.message });
    }
  }

  if (sub === 'broadcasts') {
    await ensureBroadcastsTable(env);
    const rows = await env.DB.prepare(`
      SELECT * FROM broadcasts ORDER BY ts DESC LIMIT 50
    `).all();
    return j(rows.results);
  }

  return new Response('Not found', { status: 404 });
}

// Lazy-create the broadcasts table on first use so users don't have to run a separate migration
async function ensureBroadcastsTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      mode TEXT,
      text TEXT,
      target TEXT,
      total INTEGER,
      sent INTEGER,
      failed INTEGER,
      tg_ids_json TEXT
    )
  `).run();
}

// ─── BROADCAST SEND LOGIC ───
// Sends a message to a set of users. Always respects opt-out (reminders_enabled=1) and bans.
// mode: "custom" sends `text`, "random" picks per-user random reminder using their pet+language.
// targetTgIds: null = all eligible users, [...] = only those (still filtered by opt-out)
async function sendBroadcast(env, { mode, text, targetTgIds }) {
  await ensureBroadcastsTable(env);

  // Resolve recipient list
  let users;
  if (targetTgIds && targetTgIds.length > 0) {
    // Targeted: only those tg_ids that aren't banned and have reminders enabled
    const placeholders = targetTgIds.map(() => '?').join(',');
    users = await env.DB.prepare(`
      SELECT tg_id, language_code, ui_language, ai_pet
      FROM users
      WHERE banned = 0
        AND COALESCE(reminders_enabled, 1) = 1
        AND tg_id IN (${placeholders})
    `).bind(...targetTgIds).all();
  } else {
    // All eligible
    users = await env.DB.prepare(`
      SELECT tg_id, language_code, ui_language, ai_pet
      FROM users
      WHERE banned = 0
        AND COALESCE(reminders_enabled, 1) = 1
    `).all();
  }

  let sent = 0, failed = 0;
  const recipients = users.results || [];

  for (let i = 0; i < recipients.length; i++) {
    const u = recipients[i];
    // Pick the message: custom (same for all) or random per user
    let msg;
    if (mode === 'random') {
      const lang = u.ui_language || pickLanguage(u.language_code);
      const pet  = u.ai_pet || 'dog';
      msg = pickReminder(lang, pet);
    } else {
      msg = text;
    }

    try {
      const body = { chat_id: u.tg_id, text: msg };
      if (env.APP_URL) {
        body.reply_markup = {
          inline_keyboard: [[{ text: '💰 Open Finance Tracker', web_app: { url: env.APP_URL } }]]
        };
      }
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        sent++;
        // Count toward the user's reminders_sent counter — keeps the dashboard honest
        await env.DB.prepare(`
          UPDATE users SET reminders_sent = COALESCE(reminders_sent,0)+1, last_reminder_sent = ?
          WHERE tg_id = ?
        `).bind(Date.now(), u.tg_id).run();
      } else {
        failed++;
        if (res.status === 403) {
          await env.DB.prepare(`UPDATE users SET reminders_enabled = 0 WHERE tg_id = ?`).bind(u.tg_id).run();
        }
      }
    } catch (e) {
      console.error('Broadcast send failed for', u.tg_id, e);
      failed++;
    }

    // Rate-limit: Telegram allows ~30 msgs/sec for bots. We pace at ~50ms = 20/sec to be safe.
    if (i < recipients.length - 1) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // Log the broadcast for the recent-history table
  await env.DB.prepare(`
    INSERT INTO broadcasts (ts, mode, text, target, total, sent, failed, tg_ids_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    Date.now(),
    mode,
    (text || '').slice(0, 500),
    targetTgIds ? 'selected' : 'all',
    recipients.length,
    sent,
    failed,
    targetTgIds ? JSON.stringify(targetTgIds) : null
  ).run();

  return { total: recipients.length, sent, failed };
}

// The admin dashboard HTML/JS is inlined as a single string. Kept simple — vanilla JS,
// no build step, no framework. Reads from /admin/api/* endpoints.
function adminDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Finance Tracker — Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro", system-ui, sans-serif; background: #0a0f1e; color: #e2e8f0; padding: 16px; min-height: 100vh; }
  h1 { font-size: 20px; margin-bottom: 14px; color: #10b981; display: flex; align-items: center; gap: 10px; }
  .live-dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  .live-text { font-size: 12px; font-weight: 400; color: #94a3b8; }
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid #1e2d3d; }
  .tabs button { background: transparent; border: none; color: #94a3b8; padding: 9px 14px; cursor: pointer; font-size: 13px; font-family: inherit; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tabs button.active { color: #10b981; border-bottom-color: #10b981; }
  .tabs button:hover:not(.active) { color: #e2e8f0; }
  .tab-pane { display: none; }
  .tab-pane.active { display: block; }
  .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); margin-bottom: 18px; }
  .card { background: #111827; border: 1px solid #1e2d3d; border-radius: 10px; padding: 12px 14px; }
  .card .label { font-size: 11px; color: #94a3b8; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.4px; }
  .card .value { font-size: 22px; font-weight: 700; font-family: ui-monospace, "SF Mono", monospace; color: #e2e8f0; }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; align-items: center; }
  .toolbar input, .toolbar select { background: #1e2d3d; color: #e2e8f0; border: 1px solid #2d3d4d; border-radius: 7px; padding: 7px 10px; font-size: 13px; font-family: inherit; }
  .toolbar input { flex: 1; min-width: 140px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; background: #111827; border-radius: 10px; overflow: hidden; }
  th { background: #1e2d3d; padding: 9px 8px; text-align: left; font-weight: 600; color: #94a3b8; cursor: pointer; user-select: none; white-space: nowrap; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
  th:hover { background: #2d3d4d; color: #e2e8f0; }
  th .arrow { font-size: 9px; opacity: 0.5; margin-left: 3px; }
  td { padding: 8px; border-bottom: 1px solid #1e2d3d; white-space: nowrap; font-family: ui-monospace, "SF Mono", monospace; font-size: 12px; }
  tr.banned { opacity: 0.45; }
  tr.banned td:first-child::before { content: "🚫 "; }
  tr:hover td { background: #1a2333; cursor: pointer; }
  .small { font-size: 10px; color: #64748b; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 10px; background: #1e2d3d; color: #94a3b8; }
  .pill.green { background: #10b98122; color: #10b981; }
  .pill.red { background: #ef444422; color: #ef4444; }
  .pill.blue { background: #3b82f622; color: #3b82f6; }
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: none; z-index: 100; align-items: center; justify-content: center; padding: 16px; }
  .modal-bg.show { display: flex; }
  .modal { background: #0a0f1e; border: 1px solid #1e2d3d; border-radius: 12px; padding: 18px; max-width: 600px; width: 100%; max-height: 80vh; overflow: auto; }
  .modal h2 { font-size: 16px; margin-bottom: 12px; color: #10b981; }
  .modal button { background: #1e2d3d; color: #e2e8f0; border: none; border-radius: 7px; padding: 7px 14px; cursor: pointer; margin-right: 8px; margin-bottom: 8px; font-size: 12px; font-family: inherit; }
  .modal button.danger { background: #ef444433; color: #ef4444; }
  .modal button.success { background: #10b98133; color: #10b981; }
  .modal button.warning { background: #f59e0b33; color: #f59e0b; }
  .modal button:hover { filter: brightness(1.2); }
  .event-line { padding: 5px 0; border-bottom: 1px solid #1e2d3d; font-size: 11px; }
  .event-line .type { font-weight: 600; color: #3b82f6; }
  .event-line .ts { color: #64748b; margin-right: 8px; }
  .empty { text-align: center; padding: 40px; color: #64748b; }
  .chart-card { background: #111827; border: 1px solid #1e2d3d; border-radius: 10px; padding: 14px; margin-bottom: 16px; }
  .chart-card h3 { font-size: 13px; color: #e2e8f0; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
  .chart-card .legend { display: flex; gap: 10px; font-size: 11px; }
  .chart-card .legend span { display: flex; align-items: center; gap: 4px; color: #94a3b8; }
  .chart-card .legend .dot { width: 8px; height: 8px; border-radius: 2px; }
  .cohort-table { font-size: 11px; }
  .cohort-table td { padding: 6px 8px; text-align: center; }
  .cohort-table td.label { text-align: left; color: #94a3b8; }
  .cohort-cell { border-radius: 4px; padding: 4px 7px; display: inline-block; min-width: 36px; }
  .err-row { background: #111827; border: 1px solid #1e2d3d; border-radius: 8px; padding: 10px 12px; margin-bottom: 6px; cursor: pointer; }
  .err-row:hover { border-color: #ef444466; }
  .err-row .msg { font-family: ui-monospace, monospace; font-size: 12px; color: #f87171; word-break: break-word; }
  .err-row .meta { font-size: 10px; color: #64748b; margin-top: 4px; display: flex; gap: 12px; }
  .confirm-step { font-size: 13px; color: #f59e0b; margin: 10px 0; padding: 10px; background: #f59e0b22; border-radius: 8px; border-left: 3px solid #f59e0b; }
</style>
</head>
<body>
  <h1>📊 Finance Tracker — Admin <span class="live-text"><span class="live-dot"></span> <span id="live-now">0</span> active now</span></h1>

  <div class="tabs">
    <button class="active" data-tab="overview">Overview</button>
    <button data-tab="users">Users</button>
    <button data-tab="broadcast">Broadcast</button>
    <button data-tab="errors">Errors</button>
    <button data-tab="costs">Costs</button>
  </div>

  <!-- ─────────── OVERVIEW TAB ─────────── -->
  <div class="tab-pane active" id="tab-overview">
    <div class="grid">
      <div class="card"><div class="label">Total users</div><div class="value" id="m-total">…</div></div>
      <div class="card"><div class="label">DAU</div><div class="value" id="m-dau">…</div></div>
      <div class="card"><div class="label">WAU</div><div class="value" id="m-wau">…</div></div>
      <div class="card"><div class="label">MAU</div><div class="value" id="m-mau">…</div></div>
      <div class="card"><div class="label">Txns today</div><div class="value" id="m-txns">…</div></div>
      <div class="card"><div class="label">AI requests</div><div class="value" id="m-ai">…</div></div>
      <div class="card"><div class="label">Errors today</div><div class="value" id="m-errors">…</div></div>
      <div class="card"><div class="label">Avg session</div><div class="value" id="m-session">…</div></div>
    </div>

    <div class="chart-card">
      <h3>
        <span>Active users — last 30 days</span>
        <span class="legend">
          <span><span class="dot" style="background:#10b981"></span> DAU</span>
          <span><span class="dot" style="background:#3b82f6"></span> WAU</span>
          <span><span class="dot" style="background:#a855f7"></span> MAU</span>
        </span>
      </h3>
      <div id="chart-active"></div>
    </div>

    <div class="chart-card">
      <h3>Cohort retention <span class="small" style="color:#64748b">(% of each weekly cohort active in following weeks)</span></h3>
      <div id="cohort-grid"></div>
    </div>
  </div>

  <!-- ─────────── USERS TAB ─────────── -->
  <div class="tab-pane" id="tab-users">
    <div class="toolbar">
      <input type="search" id="search" placeholder="Search by username, name, ID…">
      <select id="f-language"><option value="">All languages</option></select>
      <select id="f-pet"><option value="">All pets</option><option value="dog">Dog</option><option value="cat">Cat</option></select>
      <select id="f-tone"><option value="">All tones</option><option value="soft">Soft</option><option value="medium">Medium</option><option value="harsh">Harsh</option><option value="explicit">18+</option></select>
      <select id="f-platform"><option value="">All platforms</option></select>
      <select id="f-banned"><option value="">All users</option><option value="0">Active</option><option value="1">Banned</option></select>
    </div>
    <!-- Selection toolbar: shows current selection count + select-all/clear. Visible when something is selected. -->
    <div id="selection-toolbar" style="display:none; margin-bottom:8px; padding:8px 12px; background:#10b98122; border:1px solid #10b98155; border-radius:8px; font-size:12px; color:#10b981; align-items:center; gap:10px; justify-content:space-between;">
      <span><b id="sel-count">0</b> users selected for broadcast</span>
      <span>
        <button id="sel-clear" style="background:transparent; border:1px solid #10b98155; color:#10b981; border-radius:6px; padding:4px 10px; font-size:11px; cursor:pointer; font-family:inherit;">Clear</button>
      </span>
    </div>
    <div style="display:flex; gap:8px; margin-bottom:8px;">
      <button id="sel-all-visible" style="background:#1e2d3d; border:1px solid #2d3d4d; color:#e2e8f0; border-radius:7px; padding:6px 12px; font-size:12px; cursor:pointer; font-family:inherit;">☑ Select all visible</button>
      <button id="sel-clear-all" style="background:#1e2d3d; border:1px solid #2d3d4d; color:#94a3b8; border-radius:7px; padding:6px 12px; font-size:12px; cursor:pointer; font-family:inherit;">☐ Clear selection</button>
    </div>
    <div style="overflow:auto; border-radius:10px;">
      <table id="users">
        <thead><tr id="header-row"></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div id="empty" class="empty" style="display:none;">No users match your filters.</div>
  </div>

  <!-- ─────────── BROADCAST TAB ─────────── -->
  <div class="tab-pane" id="tab-broadcast">
    <div class="small" style="margin-bottom:14px; line-height:1.5;">
      Send a message to users from the bot. Banned users and users who disabled reminders are always excluded — no override.
    </div>

    <!-- Compose card -->
    <div style="background:#111827; border:1px solid #1e2d3d; border-radius:12px; padding:14px; margin-bottom:14px;">
      <div style="display:flex; gap:8px; margin-bottom:12px;">
        <label style="flex:1; cursor:pointer;">
          <input type="radio" name="bcmode" value="custom" checked id="bcmode-custom" style="margin-right:6px;">
          <span style="font-size:13px; color:#e2e8f0;">Custom message</span>
        </label>
        <label style="flex:1; cursor:pointer;">
          <input type="radio" name="bcmode" value="random" id="bcmode-random" style="margin-right:6px;">
          <span style="font-size:13px; color:#e2e8f0;">Random reminder (per user)</span>
        </label>
      </div>

      <!-- Custom message textarea (hidden when random mode is picked) -->
      <div id="bc-custom-area">
        <textarea id="bc-text" placeholder="Type your message... emoji are fine 🚀"
          maxlength="500"
          style="width:100%; background:#1e2d3d; color:#e2e8f0; border:1px solid #2d3d4d; border-radius:8px; padding:10px; font-size:13px; font-family:inherit; min-height:90px; resize:vertical; box-sizing:border-box;"></textarea>
        <div style="display:flex; justify-content:space-between; margin-top:4px;">
          <div class="small" id="bc-charcount">0 / 500</div>
          <div class="small" style="color:#64748b;">Plain text only — no Markdown</div>
        </div>
      </div>

      <!-- Random mode explainer -->
      <div id="bc-random-area" style="display:none; padding:10px; background:#1e2d3d; border-radius:8px; font-size:12px; color:#cbd5e1; line-height:1.5;">
        Each recipient gets a random reminder from the daily-reminder pool, picked to match their language and pet preference. Same logic as the 8 PM cron.
      </div>

      <!-- Target -->
      <div style="margin-top:14px; padding-top:12px; border-top:1px solid #1e2d3d;">
        <div style="font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.4px; font-weight:600; margin-bottom:6px;">Target</div>
        <div style="display:flex; gap:8px; align-items:center;">
          <select id="bc-target" style="flex:1; background:#1e2d3d; color:#e2e8f0; border:1px solid #2d3d4d; border-radius:7px; padding:8px 10px; font-size:13px; font-family:inherit; cursor:pointer;">
            <option value="all">All eligible users</option>
            <option value="selected">Only selected users (use checkboxes in Users tab)</option>
          </select>
        </div>
        <div class="small" id="bc-recipients" style="margin-top:6px; color:#64748b;">…</div>
      </div>

      <!-- Preview + send -->
      <div style="margin-top:16px; padding-top:14px; border-top:1px solid #1e2d3d;">
        <button id="bc-send" style="width:100%; background:#10b981; color:#fff; border:none; border-radius:8px; padding:11px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit;">
          Review and send →
        </button>
      </div>
    </div>

    <!-- Recent broadcasts -->
    <div style="background:#111827; border:1px solid #1e2d3d; border-radius:12px; padding:14px;">
      <div style="font-size:12px; font-weight:600; color:#94a3b8; text-transform:uppercase; letter-spacing:0.4px; margin-bottom:10px;">📊 Recent broadcasts</div>
      <div id="bc-history">Loading…</div>
    </div>
  </div>

  <!-- ─────────── ERRORS TAB ─────────── -->
  <div class="tab-pane" id="tab-errors">
    <div class="small" style="margin-bottom:10px;">Errors grouped by message — most common first. Last 30 days.</div>
    <div id="errors-list"></div>
  </div>

  <!-- ─────────── COSTS TAB ─────────── -->
  <div class="tab-pane" id="tab-costs">
    <div class="grid">
      <div class="card"><div class="label">Spent (30d est.)</div><div class="value" id="cost-30d">…</div></div>
      <div class="card"><div class="label">Requests (30d)</div><div class="value" id="cost-req">…</div></div>
      <div class="card"><div class="label">Today</div><div class="value" id="cost-today">…</div></div>
      <div class="card"><div class="label">Avg / request</div><div class="value" id="cost-avg">…</div></div>
    </div>
    <div class="chart-card">
      <h3>Breakdown by language / model</h3>
      <div id="cost-breakdown"></div>
      <div class="small" style="margin-top:14px; line-height:1.5">
        Estimates based on Anthropic's published pricing (Haiku 4.5: $1/$5 per 1M tokens, Sonnet 4.6: $3/$15) and ~250 input + 80 output tokens per request. Actual billing in your Anthropic Console may differ slightly.
      </div>
    </div>
  </div>

  <!-- ─────────── MODAL ─────────── -->
  <div class="modal-bg" id="modal-bg" onclick="if(event.target===this)closeModal()">
    <div class="modal" id="modal-content"></div>
  </div>

<script>
const COLUMNS = [
  { k: 'first_name',       l: 'Name' },
  { k: 'username',         l: 'Username' },
  { k: 'tg_id',            l: 'TG ID' },
  { k: 'ui_language',      l: 'UI Lang' },
  { k: 'ai_language',      l: 'AI Lang' },
  { k: 'ai_pet',           l: 'Pet' },
  { k: 'ai_tone',          l: 'Tone' },
  { k: 'platform',         l: 'Platform' },
  { k: 'country',          l: 'Country' },
  { k: 'total_sessions',   l: 'Sessions', num: true },
  { k: 'txn_count',        l: 'Txns',     num: true },
  { k: 'ai_request_count', l: 'AI calls', num: true },
  { k: 'current_streak',   l: 'Streak',   num: true },
  { k: 'reminders_sent',   l: 'Reminders sent', num: true },
  { k: 'last_reminder_sent', l: 'Last reminder',  date: true },
  { k: 'registered_at',    l: 'Registered', date: true },
  { k: 'last_active',      l: 'Last seen',  date: true },
  { k: 'banned',           l: 'Status' }
];

let allUsers = [];
// Set of selected tg_ids for broadcast targeting (multi-select). Survives across re-renders.
let selectedTgIds = new Set();
let sortKey = 'last_active';
let sortDir = 'desc';

const fmtDate = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const fmtRelative = (ms) => {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
};

// ─────────── TAB SWITCHING ───────────
document.querySelectorAll('.tabs button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('tab-' + b.dataset.tab).classList.add('active');
    // Lazy-load tab data the first time it's opened
    if (b.dataset.tab === 'errors') loadErrors();
    if (b.dataset.tab === 'costs') loadCosts();
    if (b.dataset.tab === 'broadcast') loadBroadcastTab();
  });
});

// ─────────── METRICS + LIVE ───────────
async function loadMetrics() {
  const r = await fetch('/admin/api/metrics');
  const m = await r.json();
  document.getElementById('m-total').textContent = m.total;
  document.getElementById('m-dau').textContent = m.dau;
  document.getElementById('m-wau').textContent = m.wau;
  document.getElementById('m-mau').textContent = m.mau;
  document.getElementById('m-txns').textContent = m.txnsToday;
  document.getElementById('m-ai').textContent = m.aiToday;
  document.getElementById('m-errors').textContent = m.errorsToday;
  document.getElementById('m-session').textContent = m.avgSession + 's';
}
async function loadLive() {
  const r = await fetch('/admin/api/live');
  const m = await r.json();
  document.getElementById('live-now').textContent = m.count;
}

// ─────────── DAU/WAU/MAU CHART (SVG) ───────────
async function loadChart() {
  const data = await fetch('/admin/api/chart').then(r => r.json());
  const el = document.getElementById('chart-active');
  if (!data.length) { el.innerHTML = '<div class="empty">No data yet</div>'; return; }
  const W = el.offsetWidth || 600, H = 220, pad = { l: 30, r: 12, t: 12, b: 24 };
  const max = Math.max(1, ...data.map(d => d.mau));
  const x = i => pad.l + i * (W - pad.l - pad.r) / (data.length - 1 || 1);
  const y = v => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const series = (key, color) => {
    const path = data.map((d, i) => (i === 0 ? 'M' : 'L') + x(i) + ',' + y(d[key])).join(' ');
    return '<path d="' + path + '" stroke="' + color + '" stroke-width="2" fill="none"/>';
  };
  // Y-axis labels (4 ticks)
  let yLabels = '';
  for (let i = 0; i <= 4; i++) {
    const v = Math.round((max / 4) * i);
    const yp = y(v);
    yLabels += '<text x="' + (pad.l - 4) + '" y="' + (yp + 3) + '" text-anchor="end" fill="#64748b" font-size="9">' + v + '</text>';
    yLabels += '<line x1="' + pad.l + '" y1="' + yp + '" x2="' + (W - pad.r) + '" y2="' + yp + '" stroke="#1e2d3d" stroke-width="0.5"/>';
  }
  // X-axis labels (every 5 days)
  let xLabels = '';
  for (let i = 0; i < data.length; i += 5) {
    const lbl = data[i].date.slice(5); // mm-dd
    xLabels += '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle" fill="#64748b" font-size="9">' + lbl + '</text>';
  }
  el.innerHTML = '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
    yLabels + xLabels +
    series('mau', '#a855f7') + series('wau', '#3b82f6') + series('dau', '#10b981') +
    '</svg>';
}

// ─────────── COHORT RETENTION GRID ───────────
async function loadCohorts() {
  const cohorts = await fetch('/admin/api/cohorts').then(r => r.json());
  const el = document.getElementById('cohort-grid');
  if (!cohorts.length || cohorts.every(c => c.size === 0)) {
    el.innerHTML = '<div class="empty">Not enough data yet — cohorts appear once users have been active for a few weeks.</div>';
    return;
  }
  const maxOffset = Math.max(...cohorts.map(c => c.retention.length - 1), 0);
  let html = '<table class="cohort-table"><thead><tr><th class="label">Cohort</th><th>Size</th>';
  for (let i = 0; i <= maxOffset; i++) html += '<th>W' + i + '</th>';
  html += '</tr></thead><tbody>';
  cohorts.forEach(c => {
    if (c.size === 0) return;
    html += '<tr><td class="label">' + c.label + '</td><td>' + c.size + '</td>';
    for (let i = 0; i <= maxOffset; i++) {
      const cell = c.retention[i];
      if (!cell) { html += '<td></td>'; continue; }
      const intensity = Math.min(1, cell.pct / 100);
      const bg = 'rgba(16,185,129,' + (0.1 + intensity * 0.7) + ')';
      html += '<td><span class="cohort-cell" style="background:' + bg + '">' + cell.pct + '%</span></td>';
    }
    html += '</tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

// ─────────── ERRORS PAGE ───────────
let errorsLoaded = false;
async function loadErrors() {
  if (errorsLoaded) return;
  errorsLoaded = true;
  const errs = await fetch('/admin/api/errors-grouped').then(r => r.json());
  const el = document.getElementById('errors-list');
  if (!errs.length) { el.innerHTML = '<div class="empty">No errors in the last 30 days. ✨</div>'; return; }
  el.innerHTML = errs.map(e => \`
    <div class="err-row" onclick="this.querySelector('.stack')?.classList.toggle('hidden')">
      <div class="msg">\${escapeHtml(e.message || '(no message)')}</div>
      <div class="meta">
        <span><b>\${e.count}</b>× occurred</span>
        <span><b>\${e.users_affected}</b> users affected</span>
        <span>Last: \${fmtRelative(e.last_seen)}</span>
        <span class="pill">\${e.error_type}</span>
      </div>
    </div>
  \`).join('');
}

// ─────────── COSTS PAGE ───────────
let costsLoaded = false;
async function loadCosts() {
  if (costsLoaded) return;
  costsLoaded = true;
  const c = await fetch('/admin/api/costs').then(r => r.json());
  document.getElementById('cost-30d').textContent = '$' + c.total30d.cost;
  document.getElementById('cost-req').textContent = c.total30d.requests;
  document.getElementById('cost-today').textContent = c.todayRequests;
  const avg = c.total30d.requests > 0 ? (c.total30d.cost / c.total30d.requests).toFixed(4) : '0';
  document.getElementById('cost-avg').textContent = '$' + avg;
  const el = document.getElementById('cost-breakdown');
  if (!c.breakdown.length) { el.innerHTML = '<div class="empty">No AI requests in the last 30 days.</div>'; return; }
  el.innerHTML = '<table style="margin-top:8px"><thead><tr><th>Language</th><th>Model</th><th>Requests</th><th>Cost</th></tr></thead><tbody>' +
    c.breakdown.map(b => \`<tr><td>\${escapeHtml(b.lang)}</td><td>\${escapeHtml(b.model)}</td><td>\${b.count}</td><td>$\${b.cost}</td></tr>\`).join('') +
    '</tbody></table>';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ─────────── USERS TABLE ───────────
async function loadUsers() {
  const r = await fetch('/admin/api/users');
  allUsers = await r.json();
  populateFilters();
  render();
}

function populateFilters() {
  const langs = [...new Set(allUsers.map(u => u.ui_language).filter(Boolean))].sort();
  const plats = [...new Set(allUsers.map(u => u.platform).filter(Boolean))].sort();
  const langSel = document.getElementById('f-language');
  const platSel = document.getElementById('f-platform');
  // Clear existing options except "All"
  [...langSel.querySelectorAll('option:not(:first-child)')].forEach(o => o.remove());
  [...platSel.querySelectorAll('option:not(:first-child)')].forEach(o => o.remove());
  langs.forEach(l => { const o = document.createElement('option'); o.value = l; o.textContent = l; langSel.appendChild(o); });
  plats.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; platSel.appendChild(o); });
}

function buildHeader() {
  const row = document.getElementById('header-row');
  row.innerHTML = '';
  // Checkbox column first — for multi-select broadcast targeting
  const thCheck = document.createElement('th');
  thCheck.style.width = '32px';
  thCheck.innerHTML = '<input type="checkbox" id="header-check" style="cursor:pointer;">';
  row.appendChild(thCheck);
  document.getElementById('header-check').onclick = (e) => {
    // Tick = select all currently filtered/visible rows; untick = clear them all from selection
    const checked = e.target.checked;
    const visibleIds = [...document.querySelectorAll('tr[data-tg-id]')].map(tr => Number(tr.dataset.tgId));
    visibleIds.forEach(id => checked ? selectedTgIds.add(id) : selectedTgIds.delete(id));
    updateSelectionUI();
    render();
  };
  COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.l;
    if (col.k === sortKey) {
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = sortDir === 'asc' ? '▲' : '▼';
      th.appendChild(arrow);
    }
    th.onclick = () => {
      if (sortKey === col.k) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortKey = col.k; sortDir = col.num || col.date ? 'desc' : 'asc'; }
      render();
    };
    row.appendChild(th);
  });
}

function render() {
  buildHeader();
  const search = document.getElementById('search').value.trim().toLowerCase();
  const fLang = document.getElementById('f-language').value;
  const fPet = document.getElementById('f-pet').value;
  const fTone = document.getElementById('f-tone').value;
  const fPlat = document.getElementById('f-platform').value;
  const fBanned = document.getElementById('f-banned').value;

  let filtered = allUsers.filter(u => {
    if (search) {
      const blob = ((u.username || '') + ' ' + (u.first_name || '') + ' ' + u.tg_id).toLowerCase();
      if (!blob.includes(search)) return false;
    }
    if (fLang && u.ui_language !== fLang) return false;
    if (fPet && u.ai_pet !== fPet) return false;
    if (fTone && u.ai_tone !== fTone) return false;
    if (fPlat && u.platform !== fPlat) return false;
    if (fBanned !== '' && String(u.banned || 0) !== fBanned) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const av = a[sortKey] ?? '';
    const bv = b[sortKey] ?? '';
    if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
    return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });

  const tbody = document.querySelector('#users tbody');
  tbody.innerHTML = '';
  document.getElementById('empty').style.display = filtered.length ? 'none' : 'block';

  filtered.forEach(u => {
    const tr = document.createElement('tr');
    tr.dataset.tgId = u.tg_id;
    if (u.banned) tr.className = 'banned';
    tr.onclick = () => showUser(u);

    // Checkbox cell — for broadcast multi-select targeting
    const tdCheck = document.createElement('td');
    tdCheck.style.width = '32px';
    tdCheck.onclick = (e) => e.stopPropagation(); // don't open the modal when toggling the checkbox
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.style.cursor = 'pointer';
    checkbox.checked = selectedTgIds.has(u.tg_id);
    checkbox.onchange = () => {
      if (checkbox.checked) selectedTgIds.add(u.tg_id);
      else selectedTgIds.delete(u.tg_id);
      updateSelectionUI();
    };
    tdCheck.appendChild(checkbox);
    tr.appendChild(tdCheck);

    COLUMNS.forEach(col => {
      const td = document.createElement('td');
      let v = u[col.k];
      if (col.k === 'username') v = v ? '@' + v : '—';
      else if (col.k === 'banned') {
        td.innerHTML = u.banned ? '<span class="pill red">banned</span>' : '<span class="pill green">active</span>';
        tr.appendChild(td);
        return;
      }
      else if (col.date) v = fmtRelative(v);
      else if (v === null || v === undefined || v === '') v = '—';
      td.textContent = v;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  updateSelectionUI();
}

// Show/hide the green selection bar based on what's currently selected.
// Updates the count badge and the broadcast tab's recipient line.
function updateSelectionUI() {
  const count = selectedTgIds.size;
  const bar = document.getElementById('selection-toolbar');
  const countEl = document.getElementById('sel-count');
  if (countEl) countEl.textContent = count;
  if (bar) bar.style.display = count > 0 ? 'flex' : 'none';
  // Refresh the broadcast tab's recipient count if open
  if (typeof refreshBroadcastRecipients === 'function') refreshBroadcastRecipients();
}

// ─────────── USER DETAIL MODAL ───────────
async function showUser(u) {
  const events = await fetch('/admin/api/user-events?tg_id=' + u.tg_id).then(r => r.json());
  const eventsHtml = events.length ? events.map(e => \`
    <div class="event-line">
      <span class="ts">\${fmtDate(e.ts)}</span>
      <span class="type">\${escapeHtml(e.event_type)}</span>
      \${e.metadata && e.metadata !== '{}' ? '<span class="small" style="margin-left:6px">' + escapeHtml(e.metadata) + '</span>' : ''}
    </div>
  \`).join('') : '<div class="small">No events recorded.</div>';

  document.getElementById('modal-content').innerHTML = \`
    <h2>\${escapeHtml(u.first_name || '—')} \${u.username ? '(@' + escapeHtml(u.username) + ')' : ''}</h2>
    <div class="small" style="margin-bottom:12px">
      ID: \${u.tg_id} · Country: \${escapeHtml(u.country || '—')} · Platform: \${escapeHtml(u.platform || '—')}<br>
      Registered: \${fmtDate(u.registered_at)} · Last active: \${fmtDate(u.last_active)}<br>
      Sessions: \${u.total_sessions || 0} · Transactions: \${u.txn_count || 0} · AI calls: \${u.ai_request_count || 0}<br>
      Streak: \${u.current_streak || 0} (longest \${u.longest_streak || 0})<br>
      Reminders sent: \${u.reminders_sent || 0}\${u.last_reminder_sent ? ' · last ' + fmtRelative(u.last_reminder_sent) : ''} · \${u.reminders_enabled === 0 ? '<span style="color:#ef4444">disabled</span>' : '<span style="color:#10b981">enabled</span>'}
    </div>
    <div id="action-area" style="margin-bottom:14px">
      \${u.banned
        ? '<button class="success" onclick="confirmAction(\\'unban\\', ' + u.tg_id + ', \\'' + escapeHtml(u.first_name || u.tg_id) + '\\')">✓ Unban user</button>'
        : '<button class="danger" onclick="confirmAction(\\'ban\\', ' + u.tg_id + ', \\'' + escapeHtml(u.first_name || u.tg_id) + '\\')">🚫 Ban user</button>'}
      <button class="warning" onclick="confirmAction('reset-onboarding', \${u.tg_id}, '\${escapeHtml(u.first_name || u.tg_id)}')">↻ Reset onboarding</button>
      <button onclick="openSendMessage(\${u.tg_id}, '\${escapeHtml(u.first_name || u.tg_id)}')">✉ Send message</button>
      <button onclick="closeModal()">Close</button>
    </div>
    <h3 style="font-size:13px; color:#94a3b8; margin-bottom:8px">Recent events</h3>
    \${eventsHtml}
  \`;
  document.getElementById('modal-bg').classList.add('show');
}

// ─────────── DOUBLE CONFIRMATION ───────────
// Step 1: ask "are you sure?". Step 2: type the user's name to confirm. This prevents
// accidental clicks AND prevents muscle-memory rapid double-clicking.
function confirmAction(act, tgId, name) {
  const labels = {
    ban: { title: '🚫 Ban user', verb: 'ban', desc: 'They will no longer be able to use the app. You can unban them later.' },
    unban: { title: '✓ Unban user', verb: 'unban', desc: 'They will be able to use the app again.' },
    'reset-onboarding': { title: '↻ Reset onboarding', verb: 'reset onboarding for', desc: "Next time they open the app, they'll see the welcome flow again. Their data is NOT deleted." }
  };
  const cfg = labels[act];
  const area = document.getElementById('action-area');
  area.innerHTML = \`
    <div class="confirm-step">
      <strong>\${cfg.title}</strong>
      <div style="margin-top:6px; font-weight:400; color:#cbd5e1">Are you sure you want to \${cfg.verb} <b>\${escapeHtml(name)}</b>?</div>
      <div style="margin-top:6px; font-size:11px; color:#94a3b8">\${cfg.desc}</div>
      <div style="margin-top:10px">
        Type <code style="background:#0a0f1e; padding:2px 6px; border-radius:4px">\${escapeHtml(name)}</code> to confirm:
      </div>
      <input id="confirm-input" type="text" autofocus style="background:#1e2d3d; color:#e2e8f0; border:1px solid #2d3d4d; border-radius:6px; padding:7px 10px; margin-top:6px; width:100%; font-family:inherit" oninput="checkConfirm('\${act}', \${tgId}, '\${escapeHtml(name)}')">
      <div style="margin-top:10px">
        <button id="confirm-btn" disabled style="background:#374151; color:#64748b; cursor:not-allowed">Confirm</button>
        <button onclick="cancelConfirm(\${tgId})">Cancel</button>
      </div>
    </div>
  \`;
  setTimeout(() => document.getElementById('confirm-input')?.focus(), 50);
}

function checkConfirm(act, tgId, name) {
  const input = document.getElementById('confirm-input');
  const btn = document.getElementById('confirm-btn');
  if (input.value === name) {
    btn.disabled = false;
    btn.style.background = act === 'ban' ? '#ef444433' : act === 'unban' ? '#10b98133' : '#f59e0b33';
    btn.style.color = act === 'ban' ? '#ef4444' : act === 'unban' ? '#10b981' : '#f59e0b';
    btn.style.cursor = 'pointer';
    btn.onclick = () => doAction(act, tgId);
  } else {
    btn.disabled = true;
    btn.style.background = '#374151';
    btn.style.color = '#64748b';
    btn.style.cursor = 'not-allowed';
    btn.onclick = null;
  }
}

async function cancelConfirm(tgId) {
  // Re-render the original modal with the user's data
  const r = await fetch('/admin/api/users');
  const users = await r.json();
  const u = users.find(x => x.tg_id === tgId);
  if (u) showUser(u);
}

async function doAction(act, tgId) {
  if (act === 'ban') {
    const reason = prompt('Optional ban reason (leave blank to skip):') || 'No reason provided';
    await fetch('/admin/api/ban?tg_id=' + tgId + '&reason=' + encodeURIComponent(reason));
  } else {
    await fetch('/admin/api/' + act + '?tg_id=' + tgId);
  }
  closeModal();
  loadUsers();
}

function closeModal() {
  document.getElementById('modal-bg').classList.remove('show');
}

// ─────────── FILTER LISTENERS ───────────
['search','f-language','f-pet','f-tone','f-platform','f-banned'].forEach(id => {
  document.getElementById(id).addEventListener('input', render);
  document.getElementById(id).addEventListener('change', render);
});

// Selection toolbar buttons
document.getElementById('sel-all-visible').onclick = () => {
  // Add all currently filtered/visible users to the selection
  [...document.querySelectorAll('tr[data-tg-id]')].forEach(tr => selectedTgIds.add(Number(tr.dataset.tgId)));
  render();
};
document.getElementById('sel-clear-all').onclick = () => {
  selectedTgIds.clear();
  render();
};
document.getElementById('sel-clear').onclick = () => {
  selectedTgIds.clear();
  render();
};

// ─────────── BROADCAST TAB ───────────
let broadcastTabReady = false;
async function loadBroadcastTab() {
  if (!broadcastTabReady) {
    // Wire up event listeners once
    const customRadio = document.getElementById('bcmode-custom');
    const randomRadio = document.getElementById('bcmode-random');
    const customArea = document.getElementById('bc-custom-area');
    const randomArea = document.getElementById('bc-random-area');
    const updateMode = () => {
      const isRandom = randomRadio.checked;
      customArea.style.display = isRandom ? 'none' : 'block';
      randomArea.style.display = isRandom ? 'block' : 'none';
    };
    customRadio.onchange = updateMode;
    randomRadio.onchange = updateMode;

    const text = document.getElementById('bc-text');
    text.oninput = () => {
      document.getElementById('bc-charcount').textContent = text.value.length + ' / 500';
    };

    document.getElementById('bc-target').onchange = refreshBroadcastRecipients;

    document.getElementById('bc-send').onclick = handleBroadcastSend;
    broadcastTabReady = true;
  }
  refreshBroadcastRecipients();
  loadBroadcastHistory();
}

// Update the "X recipients" line based on current target + selection
function refreshBroadcastRecipients() {
  const el = document.getElementById('bc-recipients');
  if (!el) return;
  const target = document.getElementById('bc-target').value;
  if (target === 'all') {
    // Eligible = not banned AND reminders_enabled (treat null/undefined as enabled per server logic)
    const eligible = allUsers.filter(u => !u.banned && (u.reminders_enabled === undefined || u.reminders_enabled === null || u.reminders_enabled === 1));
    el.innerHTML = '→ Will send to <b>' + eligible.length + '</b> eligible users (banned and opted-out are excluded)';
  } else {
    // selected — count only those that are still eligible
    const eligibleSelected = [...selectedTgIds].filter(id => {
      const u = allUsers.find(x => x.tg_id === id);
      return u && !u.banned && (u.reminders_enabled === undefined || u.reminders_enabled === null || u.reminders_enabled === 1);
    });
    if (selectedTgIds.size === 0) {
      el.innerHTML = '<span style="color:#ef4444">⚠ No users selected. Tick checkboxes in the Users tab.</span>';
    } else if (eligibleSelected.length < selectedTgIds.size) {
      const skipped = selectedTgIds.size - eligibleSelected.length;
      el.innerHTML = '→ Will send to <b>' + eligibleSelected.length + '</b> users (' + skipped + ' selected but ineligible — banned or opted-out)';
    } else {
      el.innerHTML = '→ Will send to <b>' + eligibleSelected.length + '</b> selected users';
    }
  }
}

async function handleBroadcastSend() {
  const mode = document.querySelector('input[name="bcmode"]:checked').value;
  const text = document.getElementById('bc-text').value.trim();
  const target = document.getElementById('bc-target').value;

  if (mode === 'custom' && !text) {
    alert('Type a message first.');
    return;
  }
  if (target === 'selected' && selectedTgIds.size === 0) {
    alert('No users selected. Pick some in the Users tab first.');
    return;
  }

  // Confirm with type-to-confirm — the same pattern used for ban
  const tgIds = target === 'selected' ? [...selectedTgIds] : null;
  const eligibleCount = tgIds
    ? tgIds.filter(id => { const u = allUsers.find(x => x.tg_id === id); return u && !u.banned && (u.reminders_enabled === undefined || u.reminders_enabled === null || u.reminders_enabled === 1); }).length
    : allUsers.filter(u => !u.banned && (u.reminders_enabled === undefined || u.reminders_enabled === null || u.reminders_enabled === 1)).length;

  const preview = mode === 'random' ? '(random reminder per user)' : ('"' + text.slice(0, 100) + (text.length > 100 ? '…' : '') + '"');
  showBroadcastConfirmModal({ mode, text, tgIds, eligibleCount, preview });
}

function showBroadcastConfirmModal({ mode, text, tgIds, eligibleCount, preview }) {
  const confirmWord = 'SEND';
  const html = \`
    <h2 style="color:#f59e0b">⚠ Confirm broadcast</h2>
    <div class="small" style="margin-bottom:14px; line-height:1.6;">
      You are about to send a message to <b style="color:#fff">\${eligibleCount} users</b>.<br>
      <div style="margin-top:8px; padding:10px; background:#1e2d3d; border-radius:6px; font-family:monospace; font-size:11px; color:#cbd5e1;">\${escapeHtml(preview)}</div>
      <div style="margin-top:10px; color:#94a3b8;">This cannot be undone.</div>
    </div>
    <div>
      Type <code style="background:#0a0f1e; padding:2px 6px; border-radius:4px">\${confirmWord}</code> to confirm:
    </div>
    <input id="bc-confirm-input" type="text" autofocus
      style="background:#1e2d3d; color:#e2e8f0; border:1px solid #2d3d4d; border-radius:6px; padding:7px 10px; margin-top:6px; width:100%; font-family:inherit"/>
    <div style="margin-top:12px;">
      <button id="bc-confirm-btn" disabled style="background:#374151; color:#64748b; cursor:not-allowed">Send to \${eligibleCount} users</button>
      <button onclick="closeModal()">Cancel</button>
    </div>
  \`;
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-bg').classList.add('show');

  const input = document.getElementById('bc-confirm-input');
  const btn = document.getElementById('bc-confirm-btn');
  input.oninput = () => {
    if (input.value === confirmWord) {
      btn.disabled = false;
      btn.style.background = '#10b98133';
      btn.style.color = '#10b981';
      btn.style.cursor = 'pointer';
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = 'Sending...';
        try {
          const res = await fetch('/admin/api/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode, text: mode === 'custom' ? text : undefined, tg_ids: tgIds || undefined })
          });
          const result = await res.json();
          closeModal();
          alert(result.ok ? \`Sent to \${result.sent} of \${result.total}. Failed: \${result.failed}.\` : ('Error: ' + result.error));
          if (result.ok) {
            // Clear text & selection so we don't double-send by accident
            document.getElementById('bc-text').value = '';
            document.getElementById('bc-charcount').textContent = '0 / 500';
            selectedTgIds.clear();
            updateSelectionUI();
            loadUsers(); // refresh counts
            loadBroadcastHistory();
          }
        } catch (e) {
          alert('Send failed: ' + e.message);
          closeModal();
        }
      };
    } else {
      btn.disabled = true;
      btn.style.background = '#374151';
      btn.style.color = '#64748b';
      btn.style.cursor = 'not-allowed';
      btn.onclick = null;
    }
  };
}

async function loadBroadcastHistory() {
  const el = document.getElementById('bc-history');
  if (!el) return;
  try {
    const rows = await fetch('/admin/api/broadcasts').then(r => r.json());
    if (!rows.length) {
      el.innerHTML = '<div class="small">No broadcasts yet.</div>';
      return;
    }
    el.innerHTML = rows.map(b => \`
      <div style="padding:9px 0; border-bottom:1px solid #1e2d3d; font-size:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
          <span style="color:#94a3b8;">\${fmtDate(b.ts)} · \${b.mode === 'random' ? 'Random reminder' : 'Custom'} · \${b.target}</span>
          <span style="color:#10b981; font-family:monospace;">\${b.sent}/\${b.total} sent</span>
        </div>
        \${b.text ? '<div style="color:#cbd5e1; font-style:italic; margin-top:2px;">"' + escapeHtml(b.text.slice(0, 120)) + (b.text.length > 120 ? '…' : '') + '"</div>' : ''}
        \${b.failed > 0 ? '<div style="color:#ef4444; font-size:10px; margin-top:2px;">' + b.failed + ' failed</div>' : ''}
      </div>
    \`).join('');
  } catch (e) {
    el.innerHTML = '<div class="small" style="color:#ef4444">Failed to load history.</div>';
  }
}

// Per-user direct message — opens a small text input, sends to one tg_id
function openSendMessage(tgId, name) {
  document.getElementById('modal-content').innerHTML = \`
    <h2>✉ Send message to \${escapeHtml(name)}</h2>
    <div class="small" style="margin-bottom:12px; line-height:1.5;">
      Sends a direct message via the bot. The user must have reminders enabled and not be banned (otherwise it'll silently fail).
    </div>
    <textarea id="dm-text" placeholder="Type your message..." maxlength="500"
      style="width:100%; background:#1e2d3d; color:#e2e8f0; border:1px solid #2d3d4d; border-radius:8px; padding:10px; font-size:13px; font-family:inherit; min-height:90px; resize:vertical; box-sizing:border-box;"></textarea>
    <div class="small" id="dm-charcount" style="margin-top:4px; margin-bottom:14px;">0 / 500</div>
    <div>
      <button id="dm-send" style="background:#10b98133; color:#10b981;">Send</button>
      <button onclick="closeModal()">Cancel</button>
    </div>
  \`;
  const text = document.getElementById('dm-text');
  text.oninput = () => {
    document.getElementById('dm-charcount').textContent = text.value.length + ' / 500';
  };
  text.focus();
  document.getElementById('dm-send').onclick = async () => {
    const value = text.value.trim();
    if (!value) { alert('Type a message first.'); return; }
    document.getElementById('dm-send').disabled = true;
    document.getElementById('dm-send').textContent = 'Sending...';
    try {
      const res = await fetch('/admin/api/send-to-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tg_id: tgId, text: value })
      });
      const result = await res.json();
      closeModal();
      if (result.ok) {
        alert(result.sent === 1 ? 'Message sent ✓' : 'Send failed — user may have opted out or been banned. Failed: ' + result.failed);
      } else {
        alert('Error: ' + result.error);
      }
      loadUsers();
    } catch (e) {
      alert('Send failed: ' + e.message);
      closeModal();
    }
  };
}

// ─────────── INITIAL LOAD + REFRESH ───────────
loadMetrics();
loadUsers();
loadLive();
loadChart();
loadCohorts();
setInterval(loadMetrics, 30000);
setInterval(loadLive, 15000);
window.addEventListener('resize', () => { loadChart(); }); // re-render chart on resize
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily reminders — Duolingo-style notifications
// Sent once per day to users who:
//   1. Have reminders enabled (default ON)
//   2. Haven't logged a transaction or opened the app in the last 12 hours
//   3. Are not banned
// Message language is picked from user's Telegram language_code (ru/kk/en, default en).
// Pet is picked from user's ai_pet setting (dog/cat).
// ─────────────────────────────────────────────────────────────────────────────

// Reminder message pools. ~18 messages per pet per language so users see variety.
// Each message is in-character: dogs are loyal/cheerful, cats are sassy/judgmental.
// Currency-neutral (no specific amounts) and gentle (no shaming).
const REMINDERS = {
  English: {
    dog: [
      "🐶 Where did your money go today? Let's find out!",
      "🐶 Every tracked expense is one step closer to financial freedom.",
      "🐶 You spent money today. 10 seconds of tracking, please?",
      "🐶 I haven't seen a single transaction today 👀 Should we fix that?",
      "🐶 Tracking your money is self-care. Let's do it!",
      "🐶 Your future self will thank you for logging this now.",
      "🐶 Tail wagging stops until you log today's expenses.",
      "🐶 Bork bork! Translation: open the app already 🎯",
      "🐶 Don't let your money run away unnoticed.",
      "🐶 Quick log? It takes less time than a belly rub.",
      "🐶 Loyal reminder: track today before it becomes 'where did it all go?'",
      "🐶 You're building awareness, not just tracking numbers.",
      "🐶 Financial peace starts with tiny daily habits.",
      "🐶 Tracking today = treats for your future self 🦴",
      "🐶 Ignoring your finances doesn't make them disappear.",
      "🐶 You did great today. Now let's make sure your wallet knows it.",
      "🐶 Drop everything (except your phone). Time to log!",
      "🐶 I'm wagging until you open the app. Don't make me wait.",
    ],
    cat: [
      "🐱 I ate salmon for free. Did you pay for food and forget to track?",
      "🐱 Oh, you're back. Logged today's expenses? Didn't think so.",
      "🐱 Rich people know where their money goes. Does your budget know?",
      "🐱 *slow blink* That means 'log your expenses' in cat.",
      "🐱 I knocked your wallet off the table. Now log today's spending.",
      "🐱 Track expenses before they become 'where did my salary go?'",
      "🐱 Your money went somewhere today. Wanna investigate, or just pretend?",
      "🐱 You're ignoring me AND your finances. Bold.",
      "🐱 I have nine lives. You have one budget. Take care of it.",
      "🐱 Tracking takes 10 seconds. Denial takes a lifetime.",
      "🐱 Your future self called. They want to know why nothing's logged today.",
      "🐱 *judges from the windowsill* Log it, human.",
      "🐱 I've been watching. You've spent money. Track it.",
      "🐱 Not saying you have a problem. Just no transactions logged today. Same thing.",
      "🐱 Time is money. You're wasting both not logging.",
      "🐱 Open the app. Log something. I'll judge you less.",
      "🐱 Your cat is judging your spending. Track it before it gets worse.",
      "🐱 No transactions today? Bold financial strategy.",
    ]
  },
  Russian: {
    dog: [
      "🐶 Куда улетели твои деньги сегодня? Расследуем вместе!",
      "🐶 Каждая записанная трата — шаг к финансовой свободе.",
      "🐶 Ты сегодня тратил деньги. 10 секунд на учёт, пожалуйста?",
      "🐶 Не вижу ни одной записи за сегодня 👀 Исправим?",
      "🐶 Учёт денег — это забота о себе. Давай сделаем это!",
      "🐶 Твоё будущее «я» будет благодарно за запись сейчас.",
      "🐶 Хвост перестаёт вилять, пока ты не запишешь траты.",
      "🐶 Гав-гав! Перевод: открой приложение уже 🎯",
      "🐶 Не дай деньгам уйти незаметно.",
      "🐶 Быстро записать? Это быстрее, чем погладить меня.",
      "🐶 Преданное напоминание: запиши сегодня, пока не стало «куда всё ушло?»",
      "🐶 Ты строишь осознанность, а не просто записываешь цифры.",
      "🐶 Финансовый мир начинается с маленьких ежедневных привычек.",
      "🐶 Учёт сегодня = лакомства будущему тебе 🦴",
      "🐶 Игнорировать финансы — не значит, что они исчезнут.",
      "🐶 Ты сегодня молодец. Теперь пусть твой кошелёк об этом узнает.",
      "🐶 Брось всё (кроме телефона). Время записывать!",
      "🐶 Я виляю хвостом, пока ты не откроешь приложение.",
    ],
    cat: [
      "🐱 Я ел лосось бесплатно. А ты заплатил за еду и забыл записать?",
      "🐱 А, вернулся. Записал сегодняшние траты? Так и думал, что нет.",
      "🐱 Богатые знают, куда уходят их деньги. Твой бюджет знает?",
      "🐱 *медленно моргает* Это значит «запиши расходы» на кошачьем.",
      "🐱 Я столкнул кошелёк со стола. Теперь записывай.",
      "🐱 Записывай расходы, пока не стало «куда ушла зарплата?»",
      "🐱 Твои деньги куда-то ушли сегодня. Расследуем или сделаем вид?",
      "🐱 Ты игнорируешь меня И свои финансы. Смело.",
      "🐱 У меня девять жизней. У тебя один бюджет. Береги.",
      "🐱 Учёт — 10 секунд. Самообман — целая жизнь.",
      "🐱 Будущее «я» звонило. Спрашивает, почему ничего не записано.",
      "🐱 *осуждаю с подоконника* Записывай, человек.",
      "🐱 Я наблюдал. Ты тратил деньги. Запиши.",
      "🐱 Не говорю, что у тебя проблемы. Просто записей за сегодня — ноль.",
      "🐱 Время — деньги. Ты теряешь и то, и другое.",
      "🐱 Открой приложение. Запиши. Буду меньше осуждать.",
      "🐱 Твой кот осуждает твои траты. Запиши, пока не стало хуже.",
      "🐱 Ноль записей сегодня? Смелая стратегия.",
    ]
  },
  Kazakh: {
    dog: [
      "🐶 Бүгін ақшаң қайда кетті? Бірге іздейік!",
      "🐶 Жазылған әрбір шығын — қаржы еркіндігіне қадам.",
      "🐶 Сен бүгін ақша жұмсадың. 10 секунд жазуға, өтінемін?",
      "🐶 Бүгінге бір де жазба көрмедім 👀 Түзетейік пе?",
      "🐶 Қаржыңды бақылау — өзіңе қамқорлық. Кеттік!",
      "🐶 Болашақ өзің қазір жазғаныңа алғыс айтады.",
      "🐶 Сен шығындарды жазғанша құйрығымды бұлғамаймын.",
      "🐶 Аф-аф! Аударма: қолданбаны ашшы 🎯",
      "🐶 Ақшаң байқаусыз кетпесін.",
      "🐶 Тез жазу? Ол менің құрсағымды сипаудан да жылдам.",
      "🐶 Адал ескертпе: бүгін жаз, «бәрі қайда кетті?» болғанша.",
      "🐶 Сен сандарды бақыламайсың — сен сананы құрып жатырсың.",
      "🐶 Қаржылық тыныштық кішкентай күнделікті әдеттерден басталады.",
      "🐶 Бүгінгі есеп = болашақ саған сыйлық 🦴",
      "🐶 Қаржыны елемесең, олар жоғалмайды.",
      "🐶 Бүгін жарайсың. Енді әмияның да білсін.",
      "🐶 Бәрін таста (телефоннан басқа). Жазу уақыты!",
      "🐶 Қолданбаны ашқанша құйрығымды бұлғаймын.",
    ],
    cat: [
      "🐱 Мен лососьді тегін жедім. Сен тамаққа төлеп, жазуды ұмыттың ба?",
      "🐱 А, қайтып келдің. Бүгінгі шығындарды жаздың ба? Жазбаған шығарсың.",
      "🐱 Байлар ақшасы қайда екенін біледі. Сенің бюджетің біле ме?",
      "🐱 *баяу жыпылықтайды* Бұл «шығынды жаз» дегені мысықшаласа.",
      "🐱 Әмияныңды үстелден түсірдім. Енді жаз.",
      "🐱 Шығынды жаз, «жалақы қайда кетті?» болғанша.",
      "🐱 Бүгін ақшаң бір жерге кетті. Іздейік пе, әлде елемейміз бе?",
      "🐱 Сен мені ДЕ, қаржыңды ДА елемейсің. Батыл.",
      "🐱 Менде тоғыз өмір бар. Сенде бір бюджет бар. Күт.",
      "🐱 Жазу — 10 секунд. Өзіңді алдау — өмір бойы.",
      "🐱 Болашақ өзің қоңырау шалды. Бүгін неге жазба жоқ?",
      "🐱 *терезеден баға беремін* Жаз, адам.",
      "🐱 Бақылап тұрдым. Сен ақша жұмсадың. Жаз.",
      "🐱 Проблемаң бар деп айтпаймын. Бүгін жазба нөл, сонымен бірдей.",
      "🐱 Уақыт — ақша. Сен екеуінен де айырылып жатырсың.",
      "🐱 Қолданбаны аш. Жаз. Аз баға беремін.",
      "🐱 Мысығың шығындарыңа баға беріп тұр. Жаз, нашарламас бұрын.",
      "🐱 Бүгін нөл жазба? Батыл қаржы стратегиясы.",
    ]
  }
};

// Map a Telegram language_code to our supported set
function pickLanguage(code) {
  if (!code) return 'English';
  const c = code.toLowerCase();
  if (c.startsWith('ru')) return 'Russian';
  if (c.startsWith('kk') || c.startsWith('kz')) return 'Kazakh';
  return 'English';
}

// Pick a random reminder for a user based on their pet + language
function pickReminder(language, pet) {
  const langPool = REMINDERS[language] || REMINDERS.English;
  const petPool = langPool[pet === 'cat' ? 'cat' : 'dog']; // default to dog if missing
  return petPool[Math.floor(Math.random() * petPool.length)];
}

async function sendDailyReminders(env) {
  // Find users who: have reminders enabled, haven't been active in 12+ hours,
  // aren't banned, and have used the bot at least once (we have their tg_id).
  const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
  const candidates = await env.DB.prepare(`
    SELECT tg_id, language_code, ui_language, ai_pet, last_active
    FROM users
    WHERE banned = 0
      AND COALESCE(reminders_enabled, 1) = 1
      AND (last_active IS NULL OR last_active < ?)
  `).bind(twelveHoursAgo).all();

  let sent = 0, failed = 0;
  for (const u of candidates.results) {
    // Prefer user's chosen UI language, fall back to system language code
    const lang = u.ui_language || pickLanguage(u.language_code);
    const pet = u.ai_pet || 'dog';
    const message = pickReminder(lang, pet);

    try {
      const messageBody = {
        chat_id: u.tg_id,
        text: message
      };
      if (env.APP_URL) {
        messageBody.reply_markup = {
          inline_keyboard: [[{ text: '💰 Open Finance Tracker', web_app: { url: env.APP_URL } }]]
        };
      }
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messageBody)
      });
      if (res.ok) {
        sent++;
        // Track the delivery: bump the count and stamp the time so the admin panel can show
        // "10 reminders, last sent 2 days ago" per user.
        await env.DB.prepare(`
          UPDATE users
          SET reminders_sent = COALESCE(reminders_sent, 0) + 1,
              last_reminder_sent = ?
          WHERE tg_id = ?
        `).bind(Date.now(), u.tg_id).run();
      } else {
        failed++;
        // 403 = user blocked the bot. Auto-disable reminders for them so we stop trying.
        if (res.status === 403) {
          await env.DB.prepare(`UPDATE users SET reminders_enabled = 0 WHERE tg_id = ?`).bind(u.tg_id).run();
        }
      }
    } catch (e) {
      console.error('Reminder send failed for', u.tg_id, e);
      failed++;
    }
  }

  // Log a summary event so you can see in the dashboard how many were sent
  await env.DB.prepare(`
    INSERT INTO events (tg_id, event_type, ts, session_id, metadata)
    VALUES (0, 'reminder_batch', ?, NULL, ?)
  `).bind(Date.now(), JSON.stringify({ sent, failed, total: candidates.results.length })).run();

  return { sent, failed, total: candidates.results.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram webhook handler — sends welcome message on /start
// ─────────────────────────────────────────────────────────────────────────────
async function handleTelegramWebhook(request, env) {
  if (request.method !== 'POST') return new Response('OK', { status: 200 });

  try {
    const update = await request.json();
    const message = update.message;
    if (!message || !message.text) return new Response('OK', { status: 200 });

    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text === '/start' || text === '/help') {
      // Pick the welcome message based on the user's Telegram language. Falls back to English.
      const lang = pickWelcomeLang(message.from?.language_code);
      await sendTelegramMessage(env, chatId, WELCOME_MESSAGES[lang] || WELCOME_MESSAGES.English, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: OPEN_APP_BUTTON[lang] || OPEN_APP_BUTTON.English, web_app: { url: env.APP_URL } }]] }
      });
    }
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('Webhook error:', e);
    return new Response('OK', { status: 200 });
  }
}

async function sendTelegramMessage(env, chatId, text, extra = {}) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...extra })
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF bank statement parser — uses Claude's vision to extract transactions
// Request body: { pdf_base64, bank, categories, ui_language, tg_id }
//   - pdf_base64: the file as base64 string (no data: prefix)
//   - bank: "kaspi" | "freedom" | "other"
//   - categories: [{ id, name, type, icon }] from the user's app
//   - ui_language: "English" | "Russian" | "Kazakh"
//   - tg_id: for rate limiting
// Returns: { ok: true, transactions: [...], stats: {found, errors} }
// Each transaction: { date (ISO), amount (number), currency, type, description,
//                     suggested_category_id (string|null), confidence (0-1) }
// ─────────────────────────────────────────────────────────────────────────────
async function handleParseStatement(request, env) {
  // Handle CORS preflight
  const baseCors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: baseCors });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const cors = { ...baseCors, 'Content-Type': 'application/json' };

  try {
    const body = await request.json();
    const { pdf_base64, bank, categories, ui_language, tg_id } = body;

    if (!pdf_base64) {
      return new Response(JSON.stringify({ ok: false, error: 'pdf_base64 required' }), { status: 400, headers: cors });
    }
    // Sanity check on size — base64 inflates ~33%, cap raw input around 8MB to avoid timeouts
    if (pdf_base64.length > 11_000_000) {
      return new Response(JSON.stringify({ ok: false, error: 'PDF too large (max ~8MB). Try a shorter date range.' }), { status: 400, headers: cors });
    }

    // Per-IP rate limit — each call runs an expensive Claude vision request, so cap abuse/cost.
    // (tg_id here is client-supplied and unverified, so IP is the reliable key.) Auth requirement
    // is deferred to M2 when the Flutter client can authenticate.
    await ensureDataTables(env);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!await checkRateLimit(env, `parse:ip:${ip}`, 20, 60 * 60 * 1000)) {
      return new Response(JSON.stringify({ ok: false, error: 'Too many requests. Try again in a bit.' }), { status: 429, headers: cors });
    }

    // Build a category list for the prompt. Expense categories only — income/transfers detection
    // is rule-based in the prompt (income = positive amount, transfer = description has "перевод"/"transfer").
    const expenseCats = (categories || [])
      .filter(c => c.type === 'expense')
      .map(c => `- ${c.id}: ${c.name} (${c.icon || ''})`).join('\n');

    // Bank-specific hints help the parser. We keep these short — the LLM is smart, just nudges.
    const bankHints = {
      kaspi: 'This is a Kaspi Bank statement (Kazakhstan). Common merchants: Magnum, Small, Galmart, Glovo, Wolt, Yandex Go. Card-block lines that look like "Авторизация" or "Hold" are pending — skip them. The "Дата" column is the transaction date.',
      freedom: 'This is a Freedom Bank statement (Kazakhstan). Look for the "Дата операции" column. Transfers usually say "Перевод" or "P2P". Fees may appear as "Комиссия" — categorize as a small expense in "Other" if no fee category exists.',
      other: 'Generic bank statement. Identify transactions by their date, description, and amount columns.'
    };
    const bankHint = bankHints[bank] || bankHints.other;

    // Strict JSON-output prompt. We tell Claude exactly what shape we need so we don't have to parse
    // freeform text. Asking for explicit confidence per transaction gives us a signal for the review UI.
    const systemPrompt = `You are a bank statement parser. Extract every transaction from the PDF and return ONLY a JSON object — no commentary, no markdown fences.

${bankHint}

CATEGORIES (use the ID, not the name, for suggested_category_id; only for expense transactions):
${expenseCats}
- "other": fallback for unknown merchants

Rules:
- type: "income" for money in, "expense" for money out, "transfer" for movement between own accounts (P2P, "перевод на свою карту", "between own accounts").
- amount: always positive, the absolute value.
- date: ISO 8601 ("2026-05-10T12:00:00.000Z"). If statement has only date, use noon UTC.
- currency: "KZT" unless explicitly stated otherwise.
- description: short merchant or transaction description from the statement, trimmed.
- suggested_category_id: ONLY for expenses. Use the closest matching category ID from the list above, or "other". Leave null for income/transfers.
- confidence: 0.0-1.0 — how sure you are about the category. 0.9+ for obvious merchants (Glovo→Food), 0.5-0.7 for ambiguous, <0.5 for guesses.
- SKIP: pending/authorization holds, statement headers, account balance lines, opening/closing balance rows.
- DEDUPE: do not include the same transaction twice (some statements list both the auth hold and final charge).

Output shape (strict):
{
  "transactions": [
    {
      "date": "2026-05-10T12:00:00.000Z",
      "amount": 4250,
      "currency": "KZT",
      "type": "expense",
      "description": "Magnum",
      "suggested_category_id": "food",
      "confidence": 0.95
    }
  ],
  "warnings": []
}`;

    // Call Anthropic with the PDF attached as a document block (vision mode)
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', // Sonnet is the sweet spot for vision tasks; Haiku can struggle with table layouts
        max_tokens: 8000,           // ~250 transactions worth of JSON output, generous buffer
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 }
              },
              {
                type: 'text',
                text: 'Parse this bank statement. Return JSON only.'
              }
            ]
          }
        ]
      })
    });

    if (!anthropicRes.ok) {
      // Log upstream detail server-side only — never echo it to the client (could leak key/account state).
      const errText = await anthropicRes.text();
      console.error('[parse-statement] Anthropic failed:', anthropicRes.status, errText.slice(0, 500));
      const status = anthropicRes.status === 429 ? 429 : 502;
      return new Response(JSON.stringify({ ok: false, error: 'AI service temporarily unavailable. Try again shortly.' }), { status, headers: cors });
    }

    const data = await anthropicRes.json();
    const rawText = data?.content?.[0]?.text || '';

    // Strip any accidental markdown code fences, then parse
    let cleaned = rawText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON parse failed. Raw text:', rawText.slice(0, 500));
      return new Response(JSON.stringify({ ok: false, error: 'AI returned invalid JSON. Try a different PDF or split into smaller date ranges.' }), { status: 500, headers: cors });
    }

    // Light validation — every transaction must have the required fields
    const transactions = (parsed.transactions || []).filter(tx =>
      tx && typeof tx.amount === 'number' && tx.amount > 0 &&
      tx.date && tx.type && tx.currency
    );

    // Optional: log to analytics so we can see how often this feature gets used
    if (tg_id) {
      try {
        await env.DB.prepare(`
          INSERT INTO events (tg_id, event_type, metadata, ts)
          VALUES (?, 'statement_imported', ?, ?)
        `).bind(tg_id, JSON.stringify({ bank, count: transactions.length }), Date.now()).run();
      } catch (e) { /* non-critical */ }
    }

    return new Response(JSON.stringify({
      ok: true,
      transactions,
      stats: {
        found: transactions.length,
        warnings: parsed.warnings || []
      }
    }), { headers: cors });
  } catch (e) {
    console.error('parse-statement error:', e);
    return new Response(JSON.stringify({ ok: false, error: 'Parsing failed. Please try again.' }), { status: 500, headers: cors });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/data/* — server-side storage for user transactions and state (D1).
// This is the source of truth (replacing Telegram CloudStorage). Each request
// must include a valid Telegram WebApp `initData` string for HMAC-based auth.
// The `tg_id` is extracted from the verified initData — never trust the client.
// ─────────────────────────────────────────────────────────────────────────────
// Origins permitted to read API responses cross-origin. Auth is body initData /
// bearer JWT (never cookies), so a foreign site can't forge an authenticated request
// regardless — this allowlist is defense-in-depth. OFF by default (returns '*', today's
// behavior) so deploying can't break the live app. To enable: set ALLOWED_ORIGINS to your
// real app origin(s) — the scheme+host of APP_URL, e.g. "https://yourname.github.io"
// (comma-separated for several). Once set, only listed origins get a matching CORS header.
function allowedOrigin(request, env) {
  const configured = ((env && env.ALLOWED_ORIGINS) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  // Empty, or an explicit "*" entry => allow all (today's behavior). Cloudflare requires a
  // value, so set ALLOWED_ORIGINS="*" to mean "no restriction". Safe here because auth is
  // body initData / bearer JWT, never cookies. List real origins to actually restrict.
  if (!configured.length || configured.includes('*')) return '*';
  const origin = request.headers.get('Origin');
  if (!origin) return '*';                       // native app / non-browser: CORS not enforced
  return configured.includes(origin) ? origin : configured[0];
}
function corsHeaders(request, env) {
  return {
    'Access-Control-Allow-Origin': allowedOrigin(request, env),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    // Authorization is required for native/web clients authenticating with a Bearer JWT.
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}
// Static fallback CORS, used by jsonResp when no per-request headers are threaded through.
const dataCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const jsonResp = (data, status = 200, cors = dataCors) => new Response(JSON.stringify(data), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json' }
});

// Verify Telegram WebApp initData per https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// secret_key = HMAC_SHA256("WebAppData", bot_token); hash = HMAC_SHA256(secret_key, data_check_string)
async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return { ok: false, reason: 'missing' };
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { ok: false, reason: 'no-hash' };
    params.delete('hash');
    // Sort keys alphabetically, join as key=value\nkey=value
    const dataCheckString = [...params.entries()]
      .sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const enc = new TextEncoder();
    const secretKeyKey = await crypto.subtle.importKey(
      'raw', enc.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const secretKeyBuf = await crypto.subtle.sign('HMAC', secretKeyKey, enc.encode(botToken));
    const dataKey = await crypto.subtle.importKey(
      'raw', secretKeyBuf,
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const calcBuf = await crypto.subtle.sign('HMAC', dataKey, enc.encode(dataCheckString));
    const calcHash = Array.from(new Uint8Array(calcBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (calcHash !== hash) return { ok: false, reason: 'bad-hash' };
    const userJson = params.get('user');
    if (!userJson) return { ok: false, reason: 'no-user' };
    const user = JSON.parse(userJson);
    if (!user || !user.id) return { ok: false, reason: 'bad-user' };
    // Reject auth_date older than 24h — limits replay window
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (Date.now() / 1000 - authDate > 86400) return { ok: false, reason: 'expired' };
    return { ok: true, user };
  } catch (e) {
    return { ok: false, reason: 'parse-error', error: e.message };
  }
}

async function ensureDataTables(env) {
  // Data tables are keyed by user_id (the stable internal account id) so that
  // Telegram-less accounts (email / Apple sign-in) can write, not just read.
  // tg_id is kept as a nullable legacy column. Existing prod DBs created with the
  // old tg_id PK are rebuilt to this shape by ensureUserIdPkMigration on first call.
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_transactions (
      user_id TEXT NOT NULL,
      txn_id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER DEFAULT 0,
      tg_id INTEGER,
      PRIMARY KEY (user_id, txn_id)
    )
  `).run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_txn_user_updated
    ON user_transactions(user_id, updated_at)
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_state (
      user_id TEXT PRIMARY KEY,
      accounts TEXT,
      categories TEXT,
      fixed_expenses TEXT,
      goals TEXT,
      settings TEXT,
      updated_at INTEGER NOT NULL,
      tg_id INTEGER
    )
  `).run();

  // ── PHASE 1 AUTH TABLES (universal account model) ──
  // user_accounts: stable internal user IDs. All transactions/state link here via user_id.
  // Identity (telegram, email, etc.) is decoupled into user_identifiers.
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_accounts (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      ui_language TEXT,
      subscription_status TEXT DEFAULT 'free',
      subscription_provider TEXT,
      subscription_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER,
      is_disabled INTEGER DEFAULT 0,
      deleted_at INTEGER
    )
  `).run();
  // user_identifiers: many-to-one. Each row is one way to reach an account
  // (telegram_id, primary email, recovery email, apple_user_id, etc.).
  // is_recovery=1 marks the secondary recovery email — at most one per account.
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_identifiers (
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      user_id TEXT NOT NULL,
      is_recovery INTEGER DEFAULT 0,
      verified_at INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (type, value),
      FOREIGN KEY (user_id) REFERENCES user_accounts(id)
    )
  `).run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_identifiers_user ON user_identifiers(user_id)
  `).run();
  // sessions: opaque refresh tokens (server-revocable). JWTs are derived from these.
  // Stores a hash of the token so DB compromise doesn't leak live tokens.
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      refresh_token_hash TEXT NOT NULL,
      device_info TEXT,
      ip TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES user_accounts(id)
    )
  `).run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)
  `).run();
  // auth_codes: short-lived OTPs. Hashed (never stored in plaintext).
  // attempts column counts wrong-code submissions per code (lock after N).
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS auth_codes (
      id TEXT PRIMARY KEY,
      identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL,
      user_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0,
      consumed_at INTEGER
    )
  `).run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_auth_codes_identifier
    ON auth_codes(identifier_type, identifier_value, created_at DESC)
  `).run();
  // auth_audit: security events (login, link, merge, delete, etc.) — for support + GDPR
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS auth_audit (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      event_type TEXT NOT NULL,
      identifier_type TEXT,
      identifier_value TEXT,
      ip TEXT,
      user_agent TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_audit_user ON auth_audit(user_id, created_at DESC)
  `).run();
  // rate_limits: simple counter per (key, window_start). Cheap & D1-native, no KV needed.
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (key, window_start)
    )
  `).run();
  // migrations: tracks one-shot data migrations so we run each exactly once
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      done_at INTEGER NOT NULL
    )
  `).run();

  // ── DUAL-WRITE TRANSITION COLUMNS ──
  // Add user_id to existing tables WITHOUT removing tg_id. Reads & writes target both
  // during the transition. After the new system is stable, tg_id can be dropped.
  // SQLite doesn't support "ADD COLUMN IF NOT EXISTS" — wrap in try/catch for idempotency.
  for (const sql of [
    `ALTER TABLE user_transactions ADD COLUMN user_id TEXT`,
    `ALTER TABLE user_state ADD COLUMN user_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_txn_user_updated ON user_transactions(user_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_state_user ON user_state(user_id)`
  ]) {
    try { await env.DB.prepare(sql).run(); } catch (e) {
      // "duplicate column" or "already exists" — safe to ignore on repeat runs
      if (!/duplicate column|already exists/i.test(e.message)) throw e;
    }
  }
}

// Resolves the stable user_id for an incoming Telegram user. Creates the account
// + telegram identifier if this is a brand-new user (post-backfill scenario).
// Also updates last_active_at on every call so we have rough liveness signal.
async function getOrCreateUserForTelegram(env, tgUser) {
  const tg_id = String(tgUser.id);
  const now = Date.now();
  const existing = await env.DB.prepare(
    `SELECT user_id FROM user_identifiers WHERE type = 'telegram' AND value = ?`
  ).bind(tg_id).first();
  if (existing) {
    // Update activity timestamp (fire and forget — don't block on it)
    env.DB.prepare(`UPDATE user_accounts SET last_active_at = ? WHERE id = ?`)
      .bind(now, existing.user_id).run().catch(() => {});
    return existing.user_id;
  }
  // New user — create account + identifier transactionally
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user_accounts (id, display_name, ui_language, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(userId, tgUser.first_name || null, tgUser.language_code || null, now, now),
    env.DB.prepare(
      `INSERT INTO user_identifiers (type, value, user_id, verified_at, created_at) VALUES ('telegram', ?, ?, ?, ?)`
    ).bind(tg_id, userId, now, now)
  ]);
  return userId;
}

// One-shot backfill: for every existing tg_id in user_transactions / user_state,
// create a user_account + telegram identifier and update rows with the new user_id.
// Idempotent via the `migrations` table — runs at most once.
async function ensureAccountBackfill(env) {
  const flag = await env.DB.prepare(`SELECT name FROM migrations WHERE name = 'v2_account_backfill'`).first();
  if (flag) return; // already done
  const now = Date.now();
  // Collect every distinct tg_id we know about across both tables
  const txnIds = await env.DB.prepare(`SELECT DISTINCT tg_id FROM user_transactions WHERE tg_id IS NOT NULL`).all();
  const stateIds = await env.DB.prepare(`SELECT DISTINCT tg_id FROM user_state WHERE tg_id IS NOT NULL`).all();
  const allTgIds = new Set();
  for (const r of (txnIds.results || [])) allTgIds.add(String(r.tg_id));
  for (const r of (stateIds.results || [])) allTgIds.add(String(r.tg_id));
  if (allTgIds.size === 0) {
    // No existing data — mark migration done and skip
    await env.DB.prepare(`INSERT INTO migrations (name, done_at) VALUES ('v2_account_backfill', ?)`).bind(now).run();
    return;
  }
  // For each tg_id: create user_account, identifier, and update rows.
  // D1 supports batched statements which run as a single transaction.
  const stmts = [];
  for (const tg_id of allTgIds) {
    // Check if an identifier already exists for this tg_id (idempotency safety)
    const existing = await env.DB.prepare(
      `SELECT user_id FROM user_identifiers WHERE type = 'telegram' AND value = ?`
    ).bind(tg_id).first();
    if (existing) continue;
    const userId = crypto.randomUUID();
    stmts.push(env.DB.prepare(
      `INSERT INTO user_accounts (id, created_at, last_active_at) VALUES (?, ?, ?)`
    ).bind(userId, now, now));
    stmts.push(env.DB.prepare(
      `INSERT INTO user_identifiers (type, value, user_id, verified_at, created_at) VALUES ('telegram', ?, ?, ?, ?)`
    ).bind(tg_id, userId, now, now));
    stmts.push(env.DB.prepare(
      `UPDATE user_transactions SET user_id = ? WHERE tg_id = ?`
    ).bind(userId, Number(tg_id)));
    stmts.push(env.DB.prepare(
      `UPDATE user_state SET user_id = ? WHERE tg_id = ?`
    ).bind(userId, Number(tg_id)));
  }
  stmts.push(env.DB.prepare(`INSERT INTO migrations (name, done_at) VALUES ('v2_account_backfill', ?)`).bind(now));
  // Run as a batch — D1 wraps batch() in a transaction
  if (stmts.length > 0) await env.DB.batch(stmts);
  console.log(`[MIGRATION] v2_account_backfill: created ${allTgIds.size} accounts.`);
}

// Final step of the tg_id → user_id transition: rebuild user_transactions and
// user_state so their PRIMARY KEY is user_id (was tg_id). Until this runs, the
// `tg_id INTEGER NOT NULL` constraint silently rejects writes from Telegram-less
// accounts (email / Apple) — the exact path every store/new user takes. Runs once,
// guarded by the migrations table, as a single atomic D1 batch() (transactional, so
// a partial failure rolls back and retries on the next request). ensureAccountBackfill
// runs first on every request, so every legacy row already carries a user_id; rows
// without one are unreachable orphans and are intentionally not carried over.
// Cloudflare D1 Time Travel is the external backup/rollback net.
async function ensureUserIdPkMigration(env) {
  const flag = await env.DB.prepare(`SELECT name FROM migrations WHERE name = 'v3_userid_pk'`).first();
  if (flag) return; // already done
  const now = Date.now();
  await env.DB.batch([
    // ── user_transactions → PK (user_id, txn_id); tg_id demoted to a nullable column ──
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS user_transactions_v3 (
        user_id TEXT NOT NULL,
        txn_id TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER DEFAULT 0,
        tg_id INTEGER,
        PRIMARY KEY (user_id, txn_id)
      )
    `),
    env.DB.prepare(`
      INSERT OR IGNORE INTO user_transactions_v3 (user_id, txn_id, data, updated_at, deleted, tg_id)
      SELECT user_id, txn_id, data, updated_at, deleted, tg_id
      FROM user_transactions WHERE user_id IS NOT NULL
    `),
    env.DB.prepare(`DROP TABLE user_transactions`),
    env.DB.prepare(`ALTER TABLE user_transactions_v3 RENAME TO user_transactions`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_txn_user_updated ON user_transactions(user_id, updated_at)`),
    // ── user_state → PK (user_id); dedupe by newest updated_at (the email-user
    //    auto-rowid quirk may have left several rows per user_id). ──
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS user_state_v3 (
        user_id TEXT PRIMARY KEY,
        accounts TEXT,
        categories TEXT,
        fixed_expenses TEXT,
        goals TEXT,
        settings TEXT,
        updated_at INTEGER NOT NULL,
        tg_id INTEGER
      )
    `),
    env.DB.prepare(`
      INSERT OR IGNORE INTO user_state_v3 (user_id, accounts, categories, fixed_expenses, goals, settings, updated_at, tg_id)
      SELECT user_id, accounts, categories, fixed_expenses, goals, settings, MAX(updated_at), tg_id
      FROM user_state WHERE user_id IS NOT NULL GROUP BY user_id
    `),
    env.DB.prepare(`DROP TABLE user_state`),
    env.DB.prepare(`ALTER TABLE user_state_v3 RENAME TO user_state`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_state_user ON user_state(user_id)`),
    env.DB.prepare(`INSERT INTO migrations (name, done_at) VALUES ('v3_userid_pk', ?)`).bind(now),
  ]);
  console.log('[MIGRATION] v3_userid_pk: user_transactions/user_state now keyed by user_id.');
}

async function handleDataApi(request, env, url) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST')    return jsonResp({ error: 'Method not allowed' }, 405, cors);
  let body;
  try { body = await request.json(); }
  catch { return jsonResp({ error: 'Invalid JSON' }, 400, cors); }
  try {
    await ensureDataTables(env);
    // One-shot backfill: turns every legacy tg_id into a user_account + telegram identifier.
    // Idempotent (guarded by the migrations table), so safe to call on every request.
    await ensureAccountBackfill(env);
    // One-shot final cutover: rebuild the data tables to be keyed by user_id so
    // Telegram-less accounts can WRITE. Guarded by the migrations table (runs once).
    await ensureUserIdPkMigration(env);
    // Accept either a Bearer JWT (email / native clients) or Telegram initData (Mini App).
    const user_id = await resolveAuthUser(env, body, request);
    if (!user_id) return jsonResp({ error: 'Auth failed' }, 401, cors);
    // Writes are keyed by user_id. We still resolve tg_id and store it as a legacy
    // column when known (initData gives it directly; JWT users via their telegram
    // identifier); it's simply null for Telegram-less accounts, which is now fine.
    let tg_id = null;
    if (body.initData) {
      const a = await verifyInitData(body.initData, env.TELEGRAM_BOT_TOKEN);
      if (a.ok) tg_id = a.user.id;
    }
    if (tg_id == null) {
      const row = await env.DB.prepare(
        `SELECT value FROM user_identifiers WHERE type = 'telegram' AND user_id = ? LIMIT 1`
      ).bind(user_id).first();
      if (row) tg_id = parseInt(row.value, 10);
    }
    const sub = url.pathname.slice('/api/data/'.length);
    if (sub === 'sync')       return jsonResp(await dataSync(env, user_id, tg_id, body), 200, cors);
    if (sub === 'txn')        return jsonResp(await dataSaveTxn(env, user_id, tg_id, body), 200, cors);
    if (sub === 'txn-delete') return jsonResp(await dataDeleteTxn(env, user_id, tg_id, body), 200, cors);
    if (sub === 'state')      return jsonResp(await dataSaveState(env, user_id, tg_id, body), 200, cors);
    if (sub === 'migrate')    return jsonResp(await dataMigrate(env, user_id, tg_id, body), 200, cors);
    if (sub === 'reset')      return jsonResp(await dataReset(env, user_id, tg_id), 200, cors);
    return jsonResp({ error: 'Not found' }, 404, cors);
  } catch (e) {
    console.error('[data-api]', e);
    return jsonResp({ error: 'Internal error' }, 500, cors);
  }
}

// Delta-sync: return all changes since `body.since` (ms epoch). 0 = full pull.
// Reads by user_id (the stable account ID); tg_id is no longer used for lookup.
// _tg_id is kept in the signature for symmetry with other endpoints; underscore = intentional.
// ALWAYS returns the user's identifiers (email, telegram, etc.) — these are server-side truth
// and the client renders auth UI from them, not from a settings flag (which can desync).
async function dataSync(env, user_id, _tg_id, body) {
  const since = parseInt(body.since) || 0;
  const txnRes = await env.DB.prepare(`
    SELECT txn_id, data, updated_at, deleted
    FROM user_transactions
    WHERE user_id = ? AND updated_at > ?
  `).bind(user_id, since).all();
  const transactions = [];
  const deletedIds = [];
  for (const r of (txnRes.results || [])) {
    if (r.deleted) deletedIds.push(r.txn_id);
    else { try { transactions.push(JSON.parse(r.data)); } catch {} }
  }
  const sRow = await env.DB.prepare(`
    SELECT accounts, categories, fixed_expenses, goals, settings, updated_at
    FROM user_state WHERE user_id = ?
  `).bind(user_id).first();
  let state = null;
  if (sRow && sRow.updated_at > since) {
    const parse = (v) => { if (!v) return null; try { return JSON.parse(v); } catch { return null; } };
    state = {
      accounts: parse(sRow.accounts),
      categories: parse(sRow.categories),
      fixed_expenses: parse(sRow.fixed_expenses),
      goals: parse(sRow.goals),
      settings: parse(sRow.settings),
      updated_at: sRow.updated_at
    };
  }
  // Identifiers — server-side truth for "is this user linked to an email / apple id".
  // Returned on every sync (cheap, ~50 bytes) so client always knows the real auth state.
  const idsRes = await env.DB.prepare(`
    SELECT type, value, is_recovery, verified_at
    FROM user_identifiers WHERE user_id = ?
  `).bind(user_id).all();
  const identifiers = (idsRes.results || []).map(r => ({
    type: r.type,
    value: r.value,
    is_recovery: !!r.is_recovery,
    verified_at: r.verified_at
  }));
  return { ok: true, transactions, deletedIds, state, identifiers, serverTime: Date.now() };
}

// Upsert one transaction. Dual-writes user_id + tg_id during the transition period
// so legacy tg_id-keyed reads still work if anything reads them before the cutover.
async function dataSaveTxn(env, user_id, tg_id, body) {
  const txn = body.txn;
  if (!txn || !txn.id) return { ok: false, error: 'Missing txn' };
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO user_transactions (user_id, txn_id, data, updated_at, deleted, tg_id)
    VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT(user_id, txn_id) DO UPDATE SET
      data = excluded.data, updated_at = excluded.updated_at, deleted = 0,
      tg_id = COALESCE(excluded.tg_id, user_transactions.tg_id)
  `).bind(user_id, txn.id, JSON.stringify(txn), now, tg_id).run();
  return { ok: true, updated_at: now };
}

async function dataDeleteTxn(env, user_id, _tg_id, body) {
  if (!body.txn_id) return { ok: false, error: 'Missing txn_id' };
  const now = Date.now();
  await env.DB.prepare(`
    UPDATE user_transactions SET deleted = 1, updated_at = ?, user_id = ?
    WHERE user_id = ? AND txn_id = ?
  `).bind(now, user_id, user_id, body.txn_id).run();
  return { ok: true, updated_at: now };
}

async function dataSaveState(env, user_id, tg_id, body) {
  const now = Date.now();
  // Keyed by user_id; tg_id is stored as a legacy column when known.
  // COALESCE pattern preserves sections not included in this update.
  await env.DB.prepare(`
    INSERT INTO user_state (user_id, tg_id, accounts, categories, fixed_expenses, goals, settings, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      tg_id = COALESCE(excluded.tg_id, user_state.tg_id),
      accounts = COALESCE(excluded.accounts, user_state.accounts),
      categories = COALESCE(excluded.categories, user_state.categories),
      fixed_expenses = COALESCE(excluded.fixed_expenses, user_state.fixed_expenses),
      goals = COALESCE(excluded.goals, user_state.goals),
      settings = COALESCE(excluded.settings, user_state.settings),
      updated_at = excluded.updated_at
  `).bind(
    user_id, tg_id,
    body.accounts != null ? JSON.stringify(body.accounts) : null,
    body.categories != null ? JSON.stringify(body.categories) : null,
    body.fixed_expenses != null ? JSON.stringify(body.fixed_expenses) : null,
    body.goals != null ? JSON.stringify(body.goals) : null,
    body.settings != null ? JSON.stringify(body.settings) : null,
    now
  ).run();
  return { ok: true, updated_at: now };
}

// Bulk migrate — used once per user when upgrading from CloudStorage to server.
// Idempotent: existing rows are not overwritten (uses ON CONFLICT DO NOTHING).
async function dataMigrate(env, user_id, tg_id, body) {
  const now = Date.now();
  const txns = Array.isArray(body.transactions) ? body.transactions : [];
  // D1 supports batch inserts via .batch()
  if (txns.length > 0) {
    const stmt = env.DB.prepare(`
      INSERT INTO user_transactions (user_id, txn_id, data, updated_at, tg_id, deleted)
      VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(user_id, txn_id) DO NOTHING
    `);
    const batched = txns.filter(t => t && t.id).map(t => stmt.bind(user_id, t.id, JSON.stringify(t), now, tg_id));
    // D1 has a per-batch size limit; chunk to be safe
    for (let i = 0; i < batched.length; i += 50) {
      await env.DB.batch(batched.slice(i, i + 50));
    }
  }
  if (body.state) {
    await dataSaveState(env, user_id, tg_id, body.state);
  }
  return { ok: true, count: txns.length };
}

// Wipe all server-side data for this user. Used by the "Reset All Data" button.
// Deletes by user_id so it works even if some rows lack tg_id (future non-Telegram users).
async function dataReset(env, user_id, tg_id) {
  await env.DB.prepare(`DELETE FROM user_transactions WHERE user_id = ? OR tg_id = ?`).bind(user_id, tg_id).run();
  await env.DB.prepare(`DELETE FROM user_state WHERE user_id = ? OR tg_id = ?`).bind(user_id, tg_id).run();
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/auth/* — email OTP, account linking, audit logging (Phase 1b).
// Endpoints:
//   POST /api/auth/email/start         — send OTP for sign-in (future native apps)
//   POST /api/auth/email/verify        — verify OTP, sign in or create account
//   POST /api/auth/link/email/start    — send OTP to link email to current Telegram user
//   POST /api/auth/link/email/verify   — verify OTP, link email (returns merge preview if email exists elsewhere)
// ─────────────────────────────────────────────────────────────────────────────

// Increments a counter for (key, window). Returns true if within limit, false if exceeded.
// Uses D1 INSERT...ON CONFLICT to be atomic. Old windows are cleaned up lazily by their absence
// in queries — we never read stale rows, and disk usage is negligible.
async function checkRateLimit(env, key, maxPerWindow, windowMs) {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  await env.DB.prepare(`
    INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
  `).bind(key, windowStart).run();
  const row = await env.DB.prepare(`
    SELECT count FROM rate_limits WHERE key = ? AND window_start = ?
  `).bind(key, windowStart).first();
  return row && row.count <= maxPerWindow;
}

// Generates a cryptographically random 6-digit numeric code (000000–999999).
function generateOtpCode() {
  const buf = crypto.getRandomValues(new Uint8Array(4));
  const num = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return String(num % 1000000).padStart(6, '0');
}

// HMAC-SHA256 of the code keyed by a server-side pepper, stored instead of the raw code.
// A plain unsalted SHA-256 of a 6-digit code is trivially precomputable (only 1M values),
// so a DB read would expose live codes. Keying with a secret pepper makes that infeasible
// without also stealing the secret. Falls back to plain SHA-256 if no pepper is configured,
// so auth keeps working — set OTP_PEPPER (or rely on JWT_SECRET) to enable hardening.
async function hashOtpCode(code, env) {
  const pepper = (env && (env.OTP_PEPPER || env.JWT_SECRET)) || '';
  if (pepper) {
    const sig = await hmacSign(pepper, code);
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Localized email subject + HTML body. Same code shown in any language.
function buildEmailOtp(code, lang) {
  const t = {
    English: {
      subject: 'Saqta — your verification code',
      title: 'Your verification code',
      sub: 'Enter this code in the app to continue',
      footer: 'Expires in 10 minutes. If you didn\'t request this, ignore this email.'
    },
    Russian: {
      subject: 'Saqta — код подтверждения',
      title: 'Ваш код подтверждения',
      sub: 'Введите этот код в приложении, чтобы продолжить',
      footer: 'Срок действия — 10 минут. Если вы не запрашивали этот код, проигнорируйте письмо.'
    },
    Kazakh: {
      subject: 'Saqta — растау коды',
      title: 'Растау кодыңыз',
      sub: 'Жалғастыру үшін осы кодты қолданбада енгізіңіз',
      footer: 'Қолданылу мерзімі — 10 минут. Егер сіз сұрамаған болсаңыз, осы хатты елемеңіз.'
    }
  }[lang] || null;
  const tt = t || {
    subject: 'Saqta — your verification code',
    title: 'Your verification code',
    sub: 'Enter this code in the app to continue',
    footer: 'Expires in 10 minutes. If you didn\'t request this, ignore this email.'
  };
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;background:#f5f5f5;margin:0;padding:40px 20px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;text-align:center;">
    <div style="font-size:32px;margin-bottom:12px;">💰</div>
    <h1 style="font-size:22px;margin:0 0 6px;color:#10b981;">Saqta</h1>
    <p style="color:#64748b;margin:0 0 24px;font-size:14px;">${tt.sub}</p>
    <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#1e293b;padding:18px;background:#f1f5f9;border-radius:10px;font-family:ui-monospace,monospace;">${code}</div>
    <p style="color:#94a3b8;font-size:12px;margin:24px 0 0;line-height:1.6;">${tt.footer}</p>
  </div>
</body></html>`;
  return { subject: tt.subject, html };
}

// Sends an OTP email via Resend. Throws on failure (caller decides whether to expose to user).
async function sendOtpEmail(env, email, code, lang) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const { subject, html } = buildEmailOtp(code, lang);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM_ADDRESS || 'Saqta <onboarding@resend.dev>',
      to: [email],
      subject,
      html
    })
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${err}`);
  }
  return res.json();
}

// Audit log — fire-and-forget recording of security-relevant events.
async function logAuditEvent(env, ev) {
  try {
    await env.DB.prepare(`
      INSERT INTO auth_audit (id, user_id, event_type, identifier_type, identifier_value, ip, user_agent, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      ev.user_id || null,
      ev.event_type,
      ev.identifier_type || null,
      ev.identifier_value || null,
      ev.ip || null,
      ev.user_agent || null,
      ev.metadata ? JSON.stringify(ev.metadata) : null,
      Date.now()
    ).run();
  } catch (e) { console.warn('[AUDIT] write failed:', e.message); }
}

// Looks up a user's preferred UI language from their stored settings (if any).
// Defaults to English. Used to send the OTP email in their language.
async function getUserLanguage(env, user_id) {
  if (!user_id) return 'English';
  try {
    const row = await env.DB.prepare(`SELECT settings FROM user_state WHERE user_id = ?`).bind(user_id).first();
    if (row && row.settings) {
      const s = JSON.parse(row.settings);
      if (s.uiLanguage) return s.uiLanguage;
    }
  } catch {}
  return 'English';
}

// Returns a minimal preview of an account for the merge dialog — name, txn count, age.
async function getMergePreview(env, user_id) {
  const account = await env.DB.prepare(
    `SELECT display_name, created_at FROM user_accounts WHERE id = ?`
  ).bind(user_id).first();
  const txnCount = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM user_transactions WHERE user_id = ? AND deleted = 0`
  ).bind(user_id).first();
  return {
    user_id,
    display_name: account?.display_name || null,
    created_at: account?.created_at || null,
    transaction_count: txnCount?.c || 0
  };
}

// Basic email syntax check. Not RFC-perfect but rejects obvious garbage.
function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}

// ── JWT + SESSION HELPERS ──
// Native apps authenticate with an opaque refresh token (server-revocable, stored hashed)
// plus a short-lived HS256 JWT access token. JWT carries user_id + session_id only — every
// other claim is looked up fresh, so we can revoke a device by flipping sessions.revoked_at.
const ACCESS_TTL_MS  = 60 * 60 * 1000;            // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

function b64UrlEncode(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64UrlEncodeStr(s) { return b64UrlEncode(new TextEncoder().encode(s)); }
function b64UrlDecodeStr(s) {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : s.length % 4 === 1 ? '===' : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function hmacSign(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
}
async function signJwt(payload, secret, ttlMs) {
  const now = Math.floor(Date.now() / 1000);
  const headerEnc = b64UrlEncodeStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const bodyEnc   = b64UrlEncodeStr(JSON.stringify({ ...payload, iat: now, exp: now + Math.floor(ttlMs / 1000) }));
  const sig = await hmacSign(secret, `${headerEnc}.${bodyEnc}`);
  return `${headerEnc}.${bodyEnc}.${b64UrlEncode(sig)}`;
}
// Constant-time string comparison — avoids leaking secrets (passwords, signatures)
// via early-exit response timing. Length mismatch returns false immediately.
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}
async function verifyJwt(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const expected = b64UrlEncode(await hmacSign(secret, `${parts[0]}.${parts[1]}`));
    if (!timingSafeEqualStr(expected, parts[2])) return null;
    const payload = JSON.parse(b64UrlDecodeStr(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
function generateRefreshToken() {
  const buf = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
// Inserts a sessions row and returns the freshly-issued token pair. Caller must have
// already verified the user's identity (OTP, initData, etc.). Throws if JWT_SECRET missing.
async function createSession(env, user_id, request) {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET not configured');
  const session_id = crypto.randomUUID();
  const refresh_token = generateRefreshToken();
  const refresh_token_hash = await sha256Hex(refresh_token);
  const now = Date.now();
  const refresh_expires_at = now + REFRESH_TTL_MS;
  const device_info = request.headers.get('User-Agent') || null;
  const ip = request.headers.get('CF-Connecting-IP') || null;
  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, refresh_token_hash, device_info, ip, created_at, last_used_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(session_id, user_id, refresh_token_hash, device_info, ip, now, now, refresh_expires_at).run();
  const jwt = await signJwt({ sub: user_id, sid: session_id }, env.JWT_SECRET, ACCESS_TTL_MS);
  return {
    jwt,
    refresh_token,
    session_id,
    access_expires_at: now + ACCESS_TTL_MS,
    refresh_expires_at
  };
}
// Resolves the calling user from either Authorization: Bearer <jwt> (native apps) or
// initData in the body (Telegram Mini App). Returns user_id or null.
async function resolveAuthUser(env, body, request) {
  const authz = request.headers.get('Authorization') || '';
  if (authz.startsWith('Bearer ') && env.JWT_SECRET) {
    const payload = await verifyJwt(authz.slice(7), env.JWT_SECRET);
    if (payload && payload.sub) {
      // JWT alone isn't enough — confirm session wasn't revoked
      if (payload.sid) {
        const s = await env.DB.prepare(
          `SELECT revoked_at, expires_at FROM sessions WHERE id = ?`
        ).bind(payload.sid).first();
        if (!s || s.revoked_at || s.expires_at < Date.now()) return null;
      }
      return payload.sub;
    }
  }
  if (body && body.initData) {
    const auth = await verifyInitData(body.initData, env.TELEGRAM_BOT_TOKEN);
    if (auth.ok) return await getOrCreateUserForTelegram(env, auth.user);
  }
  return null;
}

async function handleAuthApi(request, env, url) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST')    return jsonResp({ error: 'Method not allowed' }, 405, cors);
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400, cors); }
  try {
    await ensureDataTables(env);
    const sub = url.pathname.slice('/api/auth/'.length);
    if (sub === 'email/start')         return jsonResp(await authEmailStart(env, body, request, /*linking*/ false), 200, cors);
    if (sub === 'email/verify')        return jsonResp(await authEmailVerify(env, body, request, /*linking*/ false), 200, cors);
    if (sub === 'link/email/start')    return jsonResp(await authEmailStart(env, body, request, /*linking*/ true), 200, cors);
    if (sub === 'link/email/verify')   return jsonResp(await authEmailVerify(env, body, request, /*linking*/ true), 200, cors);
    if (sub === 'unlink')              return jsonResp(await authUnlink(env, body, request), 200, cors);
    if (sub === 'refresh')             return jsonResp(await authRefresh(env, body, request), 200, cors);
    if (sub === 'sessions/list')       return jsonResp(await authSessionsList(env, body, request), 200, cors);
    if (sub === 'sessions/revoke')     return jsonResp(await authSessionsRevoke(env, body, request), 200, cors);
    if (sub === 'account/delete')      return jsonResp(await authAccountDelete(env, body, request), 200, cors);
    return jsonResp({ error: 'Not found' }, 404, cors);
  } catch (e) {
    console.error('[auth-api]', e);
    return jsonResp({ error: 'Internal error' }, 500, cors);
  }
}

// Sends an email OTP. If `linking` is true, requires initData and ties the code to the
// authenticated Telegram user — used to link an email to an existing account.
async function authEmailStart(env, body, request, linking) {
  const email = (body.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) return { ok: false, error: 'Invalid email' };
  const ip = request.headers.get('CF-Connecting-IP') || null;

  // If linking, resolve current Telegram user — they must be authenticated to link to their account
  let user_id = null;
  if (linking) {
    const auth = await verifyInitData(body.initData, env.TELEGRAM_BOT_TOKEN);
    if (!auth.ok) return { ok: false, error: 'Auth failed' };
    user_id = await getOrCreateUserForTelegram(env, auth.user);
  }

  // Rate limits — per email (5/15min), per IP (20/hour). Stops abuse + email-bombing.
  if (!await checkRateLimit(env, `otp:email:${email}`, 5, 15 * 60 * 1000)) {
    await logAuditEvent(env, { user_id, event_type: 'otp_rate_limit_email', identifier_type: 'email', identifier_value: email, ip });
    return { ok: false, error: 'Too many attempts for this email. Try again in 15 minutes.' };
  }
  if (ip && !await checkRateLimit(env, `otp:ip:${ip}`, 20, 60 * 60 * 1000)) {
    await logAuditEvent(env, { user_id, event_type: 'otp_rate_limit_ip', ip });
    return { ok: false, error: 'Too many attempts. Try again later.' };
  }

  // Generate, hash, store
  const code = generateOtpCode();
  const code_hash = await hashOtpCode(code, env);
  const request_id = crypto.randomUUID();
  const now = Date.now();
  const expires_at = now + 10 * 60 * 1000; // 10 minutes
  const purpose = linking ? 'link' : 'login';
  await env.DB.prepare(`
    INSERT INTO auth_codes (id, identifier_type, identifier_value, code_hash, purpose, user_id, created_at, expires_at)
    VALUES (?, 'email', ?, ?, ?, ?, ?, ?)
  `).bind(request_id, email, code_hash, purpose, user_id, now, expires_at).run();

  // Send email in the user's language (if known)
  const lang = await getUserLanguage(env, user_id);
  try {
    await sendOtpEmail(env, email, code, lang);
  } catch (e) {
    console.error('[OTP] send failed:', e.message);
    await logAuditEvent(env, { user_id, event_type: 'otp_send_failed', identifier_type: 'email', identifier_value: email, ip, metadata: { error: e.message } });
    return { ok: false, error: 'Could not send email. Please try again.' };
  }

  await logAuditEvent(env, { user_id, event_type: `${purpose}_email_start`, identifier_type: 'email', identifier_value: email, ip });
  return { ok: true, request_id };
}

// Verifies an OTP. Logic differs by `linking`:
//  - linking=false (sign-in): finds or creates account by email, returns user_id
//  - linking=true (link to Telegram): verifies code belongs to current user, adds email identifier.
//    If email already linked to ANOTHER account, returns conflict preview (no merge performed).
async function authEmailVerify(env, body, request, linking) {
  const { request_id, code } = body;
  if (!request_id || !code) return { ok: false, error: 'Missing request_id or code' };
  const ip = request.headers.get('CF-Connecting-IP') || null;

  // Lookup OTP record
  const row = await env.DB.prepare(`SELECT * FROM auth_codes WHERE id = ?`).bind(request_id).first();
  if (!row) return { ok: false, error: 'Invalid request' };
  if (row.purpose !== (linking ? 'link' : 'login')) return { ok: false, error: 'Invalid request type' };
  if (row.consumed_at) return { ok: false, error: 'Code already used' };
  if (row.expires_at < Date.now()) return { ok: false, error: 'Code expired. Request a new one.' };
  if (row.attempts >= 5) return { ok: false, error: 'Too many failed attempts. Request a new code.' };

  // For linking, the requester must be the same Telegram user who initiated the request
  let current_user_id = row.user_id;
  if (linking) {
    const auth = await verifyInitData(body.initData, env.TELEGRAM_BOT_TOKEN);
    if (!auth.ok) return { ok: false, error: 'Auth failed' };
    const reqUserId = await getOrCreateUserForTelegram(env, auth.user);
    if (reqUserId !== row.user_id) return { ok: false, error: 'Mismatched user' };
    current_user_id = reqUserId;
  }

  // Compare code hashes in constant time (defense-in-depth alongside the attempts lock)
  const code_hash = await hashOtpCode(String(code).trim(), env);
  if (!timingSafeEqualStr(code_hash, row.code_hash)) {
    await env.DB.prepare(`UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?`).bind(request_id).run();
    await logAuditEvent(env, { user_id: current_user_id, event_type: 'otp_invalid_code', identifier_type: 'email', identifier_value: row.identifier_value, ip });
    return { ok: false, error: 'Invalid code' };
  }

  const email = row.identifier_value;
  const now = Date.now();

  if (linking) {
    // Is this email already linked to another account?
    const existing = await env.DB.prepare(
      `SELECT user_id FROM user_identifiers WHERE type = 'email' AND value = ?`
    ).bind(email).first();
    if (existing && existing.user_id !== current_user_id) {
      // Conflict — return preview, do not link yet. Client shows merge dialog.
      const [me, them] = await Promise.all([
        getMergePreview(env, current_user_id),
        getMergePreview(env, existing.user_id)
      ]);
      // Consume the code so it can't be reused even on conflict
      await env.DB.prepare(`UPDATE auth_codes SET consumed_at = ? WHERE id = ?`).bind(now, request_id).run();
      await logAuditEvent(env, { user_id: current_user_id, event_type: 'link_email_conflict', identifier_type: 'email', identifier_value: email, ip, metadata: { other_user_id: existing.user_id } });
      return { ok: false, conflict: true, current_account: me, other_account: them };
    }
    // No conflict — link
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO user_identifiers (type, value, user_id, verified_at, created_at) VALUES ('email', ?, ?, ?, ?)
        ON CONFLICT(type, value) DO UPDATE SET verified_at = excluded.verified_at
      `).bind(email, current_user_id, now, now),
      env.DB.prepare(`UPDATE auth_codes SET consumed_at = ? WHERE id = ?`).bind(now, request_id)
    ]);
    await logAuditEvent(env, { user_id: current_user_id, event_type: 'link_email_success', identifier_type: 'email', identifier_value: email, ip });
    return { ok: true, email };
  }

  // Sign-in flow (not linking) — find or create account, return user_id.
  // Used by future native apps. Telegram Mini App doesn't hit this path.
  const existing = await env.DB.prepare(
    `SELECT user_id FROM user_identifiers WHERE type = 'email' AND value = ?`
  ).bind(email).first();
  let user_id;
  if (existing) {
    user_id = existing.user_id;
  } else {
    // Brand-new user signing in via email
    user_id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user_accounts (id, created_at, last_active_at) VALUES (?, ?, ?)`
      ).bind(user_id, now, now),
      env.DB.prepare(
        `INSERT INTO user_identifiers (type, value, user_id, verified_at, created_at) VALUES ('email', ?, ?, ?, ?)`
      ).bind(email, user_id, now, now)
    ]);
  }
  await env.DB.prepare(`UPDATE auth_codes SET consumed_at = ? WHERE id = ?`).bind(now, request_id).run();
  await logAuditEvent(env, { user_id, event_type: existing ? 'sign_in_email' : 'sign_up_email', identifier_type: 'email', identifier_value: email, ip });

  // Issue a session for native apps. If JWT_SECRET isn't configured, callers still get
  // user_id back — the Telegram Mini App ignores tokens and just uses initData.
  if (env.JWT_SECRET) {
    try {
      const session = await createSession(env, user_id, request);
      return { ok: true, user_id, is_new_account: !existing, ...session };
    } catch (e) {
      console.error('[auth] session create failed:', e.message);
    }
  }
  return { ok: true, user_id, is_new_account: !existing };
}

// Rotates the supplied refresh token: validates it, replaces its hash (single-use),
// and returns a new JWT + refresh pair. Old token becomes invalid the moment we write
// the new hash, so an attacker who replays a leaked token after the legitimate client
// has rotated will fail validation.
async function authRefresh(env, body, request) {
  if (!env.JWT_SECRET) return { ok: false, error: 'JWT not configured' };
  const refresh_token = (body.refresh_token || '').trim();
  if (!refresh_token) return { ok: false, error: 'Missing refresh_token' };
  const ip = request.headers.get('CF-Connecting-IP') || null;
  // Rate-limit by IP — curbs brute-forcing of stolen refresh tokens. Legit clients
  // refresh ~once per access-token lifetime (1h), so this is very generous.
  if (!await checkRateLimit(env, `refresh:ip:${ip || 'unknown'}`, 20, 5 * 60 * 1000)) {
    return { ok: false, error: 'Too many refresh attempts. Try again later.' };
  }
  const hash = await sha256Hex(refresh_token);
  const row = await env.DB.prepare(
    `SELECT id, user_id, expires_at, revoked_at FROM sessions WHERE refresh_token_hash = ?`
  ).bind(hash).first();
  if (!row) {
    await logAuditEvent(env, { event_type: 'refresh_invalid', ip });
    return { ok: false, error: 'Invalid refresh token' };
  }
  if (row.revoked_at) {
    await logAuditEvent(env, { user_id: row.user_id, event_type: 'refresh_revoked', ip });
    return { ok: false, error: 'Session revoked' };
  }
  if (row.expires_at < Date.now()) {
    await logAuditEvent(env, { user_id: row.user_id, event_type: 'refresh_expired', ip });
    return { ok: false, error: 'Session expired' };
  }
  const new_refresh = generateRefreshToken();
  const new_hash = await sha256Hex(new_refresh);
  const now = Date.now();
  const new_expires_at = now + REFRESH_TTL_MS;
  await env.DB.prepare(`
    UPDATE sessions SET refresh_token_hash = ?, last_used_at = ?, expires_at = ?, ip = ? WHERE id = ?
  `).bind(new_hash, now, new_expires_at, ip, row.id).run();
  const jwt = await signJwt({ sub: row.user_id, sid: row.id }, env.JWT_SECRET, ACCESS_TTL_MS);
  await logAuditEvent(env, { user_id: row.user_id, event_type: 'refresh_success', ip });
  return {
    ok: true,
    jwt,
    refresh_token: new_refresh,
    session_id: row.id,
    user_id: row.user_id,
    access_expires_at: now + ACCESS_TTL_MS,
    refresh_expires_at: new_expires_at
  };
}

// Lists active (non-revoked, non-expired) sessions for the calling user. Used by a
// future "Active devices" screen. Returns no token material — just metadata.
async function authSessionsList(env, body, request) {
  const user_id = await resolveAuthUser(env, body, request);
  if (!user_id) return { ok: false, error: 'Auth failed' };
  const res = await env.DB.prepare(`
    SELECT id, device_info, ip, created_at, last_used_at, expires_at
    FROM sessions
    WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    ORDER BY last_used_at DESC
  `).bind(user_id, Date.now()).all();
  return { ok: true, sessions: res.results || [] };
}

// Revokes either a single session (sign-out on one device) or all sessions for the user
// (sign-out everywhere). Authorization comes from JWT or initData via resolveAuthUser.
async function authSessionsRevoke(env, body, request) {
  const user_id = await resolveAuthUser(env, body, request);
  if (!user_id) return { ok: false, error: 'Auth failed' };
  const ip = request.headers.get('CF-Connecting-IP') || null;
  const now = Date.now();
  if (body.all === true) {
    await env.DB.prepare(
      `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`
    ).bind(now, user_id).run();
    await logAuditEvent(env, { user_id, event_type: 'sessions_revoke_all', ip });
    return { ok: true };
  }
  const session_id = (body.session_id || '').trim();
  if (!session_id) return { ok: false, error: 'Missing session_id' };
  const row = await env.DB.prepare(`SELECT user_id FROM sessions WHERE id = ?`).bind(session_id).first();
  if (!row || row.user_id !== user_id) return { ok: false, error: 'Session not found' };
  await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`).bind(now, session_id).run();
  await logAuditEvent(env, { user_id, event_type: 'session_revoke', ip, metadata: { session_id } });
  return { ok: true };
}

// Removes a non-Telegram identifier from the user's account (email, future Apple ID, etc.).
// We refuse to unlink `telegram` for Telegram Mini App users since that's their only auth method;
// without it they'd be locked out of the Mini App. They can always re-link via the same flow.
async function authUnlink(env, body, request) {
  const auth = await verifyInitData(body.initData, env.TELEGRAM_BOT_TOKEN);
  if (!auth.ok) return { ok: false, error: 'Auth failed' };
  const user_id = await getOrCreateUserForTelegram(env, auth.user);
  const ip = request.headers.get('CF-Connecting-IP') || null;
  const type = (body.type || '').trim();
  const value = (body.value || '').trim().toLowerCase();
  if (!type || !value) return { ok: false, error: 'Missing type or value' };
  if (type === 'telegram') return { ok: false, error: 'Cannot unlink Telegram identifier' };

  // Ownership check — only delete if this identifier actually belongs to the current user
  const row = await env.DB.prepare(
    `SELECT user_id FROM user_identifiers WHERE type = ? AND value = ?`
  ).bind(type, value).first();
  if (!row) return { ok: false, error: 'Identifier not found' };
  if (row.user_id !== user_id) return { ok: false, error: 'Identifier does not belong to this account' };

  await env.DB.prepare(`DELETE FROM user_identifiers WHERE type = ? AND value = ?`).bind(type, value).run();
  await logAuditEvent(env, { user_id, event_type: 'unlink_identifier', identifier_type: type, identifier_value: value, ip });
  return { ok: true };
}

// Permanently deletes the caller's account and all associated data. Required by Apple App
// Store Guideline 5.1.1(v) for any app that offers account creation. Hard-deletes user data
// (transactions, state) and identifiers, drops all sessions (signs out everywhere + voids
// refresh tokens), and tombstones the user_accounts row — keeping the id but clearing PII and
// setting deleted_at — so the id is never reused and an audit trail survives. Authorization
// comes from a Bearer JWT (native apps) or initData (Mini App) via resolveAuthUser.
async function authAccountDelete(env, body, request) {
  const user_id = await resolveAuthUser(env, body, request);
  if (!user_id) return { ok: false, error: 'Auth failed' };
  const ip = request.headers.get('CF-Connecting-IP') || null;
  const now = Date.now();

  // Resolve the legacy tg_id (if any) so we also clear rows keyed only by tg_id.
  let tg_id = null;
  const tgRow = await env.DB.prepare(
    `SELECT value FROM user_identifiers WHERE type = 'telegram' AND user_id = ? LIMIT 1`
  ).bind(user_id).first();
  if (tgRow) tg_id = parseInt(tgRow.value, 10);

  // 1. User data — transactions + state. Mirrors dataReset; deletes by either key.
  await env.DB.prepare(`DELETE FROM user_transactions WHERE user_id = ? OR tg_id = ?`).bind(user_id, tg_id).run();
  await env.DB.prepare(`DELETE FROM user_state WHERE user_id = ? OR tg_id = ?`).bind(user_id, tg_id).run();
  // 2. Identifiers — removes every way to reach the account (email, telegram, future apple id).
  await env.DB.prepare(`DELETE FROM user_identifiers WHERE user_id = ?`).bind(user_id).run();
  // 3. Sessions — sign out everywhere and drop refresh tokens.
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(user_id).run();
  // 4. Tombstone the account row: keep the id, clear PII, mark deleted + disabled.
  await env.DB.prepare(`
    UPDATE user_accounts
    SET deleted_at = ?, is_disabled = 1, display_name = NULL,
        subscription_status = 'free', subscription_provider = NULL, subscription_expires_at = NULL
    WHERE id = ?
  `).bind(now, user_id).run();
  // 5. Legacy Telegram profile/analytics row, if this account was ever a Telegram user.
  if (tg_id != null) {
    try { await env.DB.prepare(`DELETE FROM users WHERE tg_id = ?`).bind(tg_id).run(); } catch {}
  }
  await logAuditEvent(env, {
    user_id, event_type: 'account_delete', ip, user_agent: request.headers.get('User-Agent') || null
  });
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic API proxy — default for any other path
// ─────────────────────────────────────────────────────────────────────────────
async function handleAnthropicProxy(request, env) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { ...cors, 'Access-Control-Max-Age': '86400' } });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Per-IP rate limit — this endpoint spends the Anthropic API key, so cap abuse/cost.
  // Fails open if the rate-limit store is unavailable so legit AI comments never break.
  // (Auth requirement is deferred to M2; the current HTML Mini App calls this unauthenticated.)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    if (!await checkRateLimit(env, `proxy:ip:${ip}`, 120, 60 * 60 * 1000)) {
      return new Response(JSON.stringify({ error: { type: 'rate_limited', message: 'Too many requests. Try again shortly.' } }), {
        status: 429, headers: { 'Content-Type': 'application/json', ...cors }
      });
    }
  } catch (e) { console.error('[proxy] rate-limit check failed (allowing):', e.message); }

  const body = await request.text();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body
  });
  if (!response.ok) {
    // Never echo upstream error detail to the client (could leak key/account state). Log server-side.
    const detail = await response.text();
    console.error('[anthropic-proxy]', response.status, detail.slice(0, 500));
    const status = response.status === 429 ? 429 : 502;
    return new Response(JSON.stringify({ error: { type: 'upstream_error', message: 'AI service temporarily unavailable.' } }), {
      status, headers: { 'Content-Type': 'application/json', ...cors }
    });
  }
  const data = await response.text();
  return new Response(data, {
    status: response.status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}
