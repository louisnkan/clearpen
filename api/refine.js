// api/refine.js
// Clearpen AI Tone Refinement — Vercel Serverless Function
//
// Security layers:
// 1. CORS — only clearpen.live and clearpen.vercel.app
// 2. Rate limit — 10 requests per 60s per IP (server-side)
// 3. Auth check — if Bearer JWT present, verify with Supabase
//    - Authenticated free users: check refinements_used < 5 in DB
//    - Authenticated pro users: unlimited
// 4. IP fallback — unauthenticated users get 5 uses tracked in memory
//    (resets on cold start — soft gate only, not hard paywall)
// 5. Input validation — text length, mode whitelist

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

// ── CONSTANTS ──────────────────────────────────────────
const FREE_LIMIT = 5;
const ALLOWED_ORIGINS = [
  'https://clearpen.live',
  'https://www.clearpen.live',
  'https://clearpen.vercel.app',
];
const ALLOWED_MODES = ['professional', 'assertive', 'legal', 'softer', 'simple', 'academic'];
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW = 60 * 1000; // 60 seconds

// ── IN-MEMORY STORES ──────────────────────────────────
// These reset on cold start — acceptable for soft gating
// unauthenticated users. Not suitable for billing-critical logic.
const ipUsage = new Map();    // ip -> count (unauthenticated free uses)
const ipRateMap = new Map();  // ip -> [timestamps] (rate limiting)

// ── SUPABASE SERVICE CLIENT ────────────────────────────
// Uses service role key — can read/write any row.
// NEVER expose this key in frontend code.
function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
}

// ── TONE PROMPTS ───────────────────────────────────────
const PROMPTS = {
  professional: `You are a professional writing assistant. Rewrite the following text to sound more professional and formal. Remove informal language, hedging phrases ("just", "maybe", "I think", "I was wondering"), and unnecessary apologies. Keep the same meaning. Return ONLY the rewritten text, no explanation, no quotes.`,
  assertive:    `You are a writing coach. Rewrite the following text to sound more assertive and confident. Remove apologetic language, self-doubt, and unnecessary qualifiers. The writer should sound sure of themselves. Keep the meaning intact. Return ONLY the rewritten text.`,
  legal:        `You are a legal writing assistant. Rewrite the following text using formal legal register suitable for official notices, complaints, or formal correspondence in Nigeria. Use formal legal phrasing. Do not provide legal advice — only improve the register and formality. Return ONLY the rewritten text.`,
  softer:       `You are a communication coach. Rewrite the following text to sound calmer, more diplomatic, and less confrontational — while still communicating the same point clearly. Do not water down the core message. Return ONLY the rewritten text.`,
  simple:       `You are a plain language editor. Rewrite the following text in plain, clear English that anyone can understand. Remove jargon, legalese, and unnecessarily complex words. Keep the meaning identical. Return ONLY the rewritten text.`,
  academic:     `You are an academic writing assistant. Rewrite the following text in a formal academic register suitable for essays, reports, and scholarly work. Use appropriate academic vocabulary and sentence structure. Return ONLY the rewritten text.`,
};

// ── HELPERS ────────────────────────────────────────────
function getClientIP(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  if (!ipRateMap.has(ip)) ipRateMap.set(ip, []);
  const timestamps = ipRateMap.get(ip).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (timestamps.length >= RATE_LIMIT_MAX) return false;
  timestamps.push(now);
  ipRateMap.set(ip, timestamps);
  return true;
}

function setCORSHeaders(res, origin) {
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://clearpen.live');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

// ── MAIN HANDLER ──────────────────────────────────────
export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  setCORSHeaders(res, origin);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ip = getClientIP(req);

  // Rate limit check (applies to everyone)
  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
    return;
  }

  // Parse body
  let text, mode;
  try {
    ({ text, mode } = req.body || {});
  } catch(e) {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }

  // Validate input
  if (!text || typeof text !== 'string' || text.trim().length < 3) {
    res.status(400).json({ error: 'Text is required (min 3 characters)' });
    return;
  }
  if (text.length > 2000) {
    res.status(400).json({ error: 'Text too long (max 2000 characters)' });
    return;
  }
  if (!ALLOWED_MODES.includes(mode)) {
    mode = 'professional'; // safe default
  }

  // ── AUTH CHECK ──────────────────────────────────────
  const authHeader = req.headers['authorization'] || '';
  let userId = null;
  let userPlan = 'free';

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const sb = getSupabase();

      // Verify JWT and get user
      const { data: { user }, error: authErr } = await sb.auth.getUser(token);
      if (!authErr && user) {
        userId = user.id;

        // Get or create user row in clearpen_users
        const { data: userData, error: userErr } = await sb
          .from('clearpen_users')
          .select('plan, refinements_used, refinements_reset_at')
          .eq('id', userId)
          .maybeSingle();

        if (userErr && userErr.code !== 'PGRST116') {
          // Real error — continue as free unauthenticated
          userId = null;
        } else if (!userData) {
          // First time — create row
          await sb.from('clearpen_users').insert({
            id: userId,
            email: user.email,
            plan: 'free',
            refinements_used: 0,
            refinements_reset_at: new Date().toISOString(),
          });
          userPlan = 'free';
        } else {
          userPlan = userData.plan || 'free';

          // Check free limit for authenticated non-pro users
          if (userPlan !== 'pro') {
            const used = userData.refinements_used || 0;
            if (used >= FREE_LIMIT) {
              res.status(403).json({ error: 'Free refinement limit reached. Upgrade to Pro.' });
              return;
            }
            // Increment usage in DB
            await sb
              .from('clearpen_users')
              .update({ refinements_used: used + 1 })
              .eq('id', userId);
          }
          // Pro users — no limit check needed
        }
      }
    } catch(e) {
      // JWT verification failed — treat as unauthenticated
      userId = null;
    }
  }

  // ── IP FALLBACK (unauthenticated users) ─────────────
  if (!userId) {
    const used = ipUsage.get(ip) || 0;
    if (used >= FREE_LIMIT) {
      // Soft gate — still serve the request but flag it
      // We don't hard-block unauthenticated users to avoid
      // breaking the experience for legitimate users on shared IPs.
      // The real gate is the frontend upgrade modal.
      // Uncomment below to hard-block:
      // res.status(403).json({ error: 'Free limit reached. Sign in and upgrade.' });
      // return;
    }
    ipUsage.set(ip, used + 1);
  }

  // ── CALL CLAUDE API ──────────────────────────────────
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: PROMPTS[mode] + '\n\nText to rewrite:\n' + text.trim()
        }
      ]
    });

    const result = message.content?.[0]?.text?.trim() || '';

    if (!result) {
      res.status(500).json({ error: 'No result from AI. Try again.' });
      return;
    }

    res.status(200).json({ result, mode, authenticated: !!userId, plan: userPlan });

  } catch(e) {
    console.error('Claude API error:', e);
    if (e.status === 429) {
      res.status(429).json({ error: 'AI service busy. Try again in a moment.' });
    } else if (e.status === 401) {
      res.status(500).json({ error: 'API configuration error.' });
    } else {
      res.status(500).json({ error: 'Refinement failed. Check your connection.' });
    }
  }
}
