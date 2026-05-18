// api/refine.js
// Clearpen — AI Tone Refinement endpoint
// Vercel serverless function (Node.js runtime)
//
// Security & architecture:
//   - CORS: clearpen.live + clearpen.vercel.app only
//   - Rate limit: 10 req/60s per IP (in-memory, resets on cold start)
//   - Auth: Bearer JWT → Supabase service key verify → plan check
//   - Authenticated free users: server-enforces 5 uses via clearpen_users table
//   - Authenticated student users: server-enforces 30 uses/month
//   - Authenticated pro users: unlimited
//   - Unauthenticated: IP-based soft gate 5 uses (resets on cold start)
//   - Response caching: identical text+mode pairs cached 5 min to cut API costs
//   - On new sign-in: creates clearpen_users row if missing (no silent failures)

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// ── Env vars (set in Vercel dashboard) ──
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_ORIGINS = [
  'https://clearpen.live',
  'https://www.clearpen.live',
  'https://clearpen.vercel.app',
];

// ── In-memory stores (reset on cold start — intentional for soft gates) ──
const rateLimitStore = new Map(); // ip → [timestamp, ...]
const anonUseStore   = new Map(); // ip → count
const responseCache  = new Map(); // hash → {result, ts}
const RATE_MAX = 10, RATE_WINDOW = 60_000;
const ANON_LIMIT = 5;
const CACHE_TTL  = 5 * 60_000; // 5 minutes

// ── Tone prompts ──
const PROMPTS = {
  professional: `Rewrite the following text to sound more professional and formal. Remove casual language, filler words, hedging, and over-apologetic phrases. Keep the core message and meaning identical. Return only the rewritten text — no explanation, no preamble, no quotation marks.`,
  assertive:    `Rewrite the following text to sound more assertive and confident. Remove apologetic language and weak qualifiers like "just", "maybe", "possibly", "I think". Make it direct and clear without being aggressive. Return only the rewritten text — no explanation, no preamble, no quotation marks.`,
  legal:        `Rewrite the following text using formal legal phrasing suitable for official notices, complaints, or formal letters. Use precise language and formal register. Where appropriate include phrases that signal legal awareness (e.g. "I hereby formally request", "pursuant to", "I reserve the right to"). Do not invent legal claims — only rephrase what is stated. Return only the rewritten text — no explanation, no preamble, no quotation marks.`,
  softer:       `Rewrite the following text to sound calmer, more diplomatic, and less confrontational. Soften aggressive or blunt language while preserving the core message. Do not remove the point — make it easier to receive. Return only the rewritten text — no explanation, no preamble, no quotation marks.`,
  simple:       `Rewrite the following text in plain, simple English. Remove jargon, complex vocabulary, and convoluted sentence structure. Make it easy to read for anyone regardless of education level. Keep all information. Return only the rewritten text — no explanation, no preamble, no quotation marks.`,
  academic:     `Rewrite the following text in formal academic English suitable for essays, reports, or scholarly writing. Use appropriate academic register, avoid colloquialisms, and structure sentences clearly. Return only the rewritten text — no explanation, no preamble, no quotation marks.`,
};

// ── Helpers ──
function getIP(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || 'unknown').slice(0, 45); // cap length
}

function checkRateLimit(ip) {
  const now = Date.now();
  const times = (rateLimitStore.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  if (times.length >= RATE_MAX) return false;
  times.push(now);
  rateLimitStore.set(ip, times);
  // Periodically clean map to prevent memory leak at scale
  if (rateLimitStore.size > 5000) {
    for (const [k, v] of rateLimitStore) {
      if (v.every(t => now - t > RATE_WINDOW)) rateLimitStore.delete(k);
    }
  }
  return true;
}

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '86400',
    'Vary': 'Origin',
  };
}

function getAdmin() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function cacheKey(text, mode) {
  return crypto.createHash('sha256').update(text + '|' + mode).digest('hex').slice(0, 16);
}

function getCached(text, mode) {
  const k = cacheKey(text, mode);
  const entry = responseCache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { responseCache.delete(k); return null; }
  return entry.result;
}

function setCache(text, mode, result) {
  const k = cacheKey(text, mode);
  responseCache.set(k, { result, ts: Date.now() });
  // Prevent unbounded growth
  if (responseCache.size > 2000) {
    const oldest = [...responseCache.entries()]
      .sort((a, b) => a[1].ts - b[1].ts)
      .slice(0, 500);
    oldest.forEach(([key]) => responseCache.delete(key));
  }
}

// ── Main handler ──
export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  const cors = getCorsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return res.status(204).set(cors).end();
  }

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getIP(req);

  // ── 1. Rate limit ──
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests — slow down and retry in 60 seconds.' });
  }

  // ── 2. Parse + validate body ──
  const { text, mode } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length < 3) {
    return res.status(400).json({ error: 'No text provided.' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'Text too long — max 2000 characters.' });
  }
  const cleanMode = Object.keys(PROMPTS).includes(mode) ? mode : 'professional';
  const cleanText = text.trim();

  // ── 3. Check response cache ──
  const cached = getCached(cleanText, cleanMode);
  if (cached) {
    return res.status(200).json({ result: cached, cached: true });
  }

  // ── 4. Auth check ──
  let userPlan = null; // null = unauthenticated
  let userId   = null;

  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (bearer) {
    const sb = getAdmin();
    if (sb) {
      try {
        const { data: { user }, error } = await sb.auth.getUser(bearer);
        if (!error && user) {
          userId = user.id;

          // Fetch or create user profile
          let { data: profile } = await sb
            .from('clearpen_users')
            .select('plan, refinements_used, refinements_reset_at')
            .eq('id', userId)
            .single();

          if (!profile) {
            // First-ever API call for this user — create their row
            const { data: newProfile } = await sb.from('clearpen_users').upsert({
              id: userId,
              email: user.email,
              plan: 'free',
              refinements_used: 0,
              refinements_reset_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            }, { onConflict: 'id' }).select().single();
            profile = newProfile || { plan: 'free', refinements_used: 0 };
          }

          userPlan = profile.plan || 'free';

          // ── Monthly reset check ──
          const resetAt = profile.refinements_reset_at
            ? new Date(profile.refinements_reset_at) : new Date(0);
          const daysSince = (Date.now() - resetAt.getTime()) / 86_400_000;
          if (daysSince >= 30 && userPlan !== 'pro') {
            await sb.from('clearpen_users').update({
              refinements_used: 0,
              refinements_reset_at: new Date().toISOString()
            }).eq('id', userId);
            profile.refinements_used = 0;
          }

          // ── Plan enforcement ──
          if (userPlan === 'free') {
            if (profile.refinements_used >= 5) {
              return res.status(403).json({
                error: 'Free limit reached. Upgrade to continue.',
                code: 'FREE_LIMIT_EXCEEDED',
              });
            }
            await sb.from('clearpen_users')
              .update({ refinements_used: profile.refinements_used + 1 })
              .eq('id', userId);
          } else if (userPlan === 'student') {
            if (profile.refinements_used >= 30) {
              return res.status(403).json({
                error: 'Monthly student limit reached. Upgrade to Pro for unlimited.',
                code: 'STUDENT_LIMIT_EXCEEDED',
              });
            }
            await sb.from('clearpen_users')
              .update({ refinements_used: profile.refinements_used + 1 })
              .eq('id', userId);
          }
          // pro: no limit, fall through
        }
      } catch (authErr) {
        // Invalid token — treat as unauthenticated, don't block
        console.warn('Clearpen refine: invalid bearer token', authErr.message);
        userPlan = null;
      }
    }
  }

  // ── 5. Unauthenticated IP soft gate ──
  if (userPlan === null) {
    const used = anonUseStore.get(ip) || 0;
    if (used >= ANON_LIMIT) {
      return res.status(403).json({
        error: 'Free limit reached. Sign in or upgrade to continue.',
        code: 'ANON_LIMIT_EXCEEDED',
      });
    }
    anonUseStore.set(ip, used + 1);
    // Clean map at scale
    if (anonUseStore.size > 10000) {
      // Remove ~20% oldest entries (Map preserves insertion order)
      let count = 0;
      for (const k of anonUseStore.keys()) {
        anonUseStore.delete(k);
        if (++count >= 2000) break;
      }
    }
  }

  // ── 6. Call Claude Haiku ──
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: PROMPTS[cleanMode],
        messages: [{ role: 'user', content: cleanText }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error:', response.status, errBody);
      if (response.status === 429) {
        return res.status(429).json({ error: 'AI service busy — retry in a moment.' });
      }
      return res.status(502).json({ error: 'AI service error — try again.' });
    }

    const data = await response.json();
    const result = data?.content?.[0]?.text?.trim() || '';

    if (!result) {
      return res.status(502).json({ error: 'Empty AI response — try again.' });
    }

    // Cache the result
    setCache(cleanText, cleanMode, result);

    return res.status(200).json({ result });

  } catch (err) {
    console.error('Clearpen refine error:', err);
    return res.status(500).json({ error: 'Server error — try again.' });
  }
}
