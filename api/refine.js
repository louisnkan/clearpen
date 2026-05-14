// api/refine.js
// Clearpen — AI Tone Refinement endpoint
// Vercel serverless function (Node.js runtime)
//
// What this does:
//   1. CORS — only allows clearpen.live and clearpen.vercel.app
//   2. Rate limiting — 10 requests per 60 seconds per IP (in-memory, resets on cold start)
//   3. Auth check — if Bearer token present, verifies with Supabase service key
//      → Pro user: unlimited refinements
//      → Student user: allowed (server trusts client count for now, plan verified)
//      → Free authenticated: checks refinements_used < 5, increments on use
//      → Returns 403 if authenticated free user exceeds server-side limit
//   4. Unauthenticated fallback — tracks by IP in-memory (soft gate, resets on cold start)
//   5. Calls Claude Haiku API with tone refinement prompt
//   6. Returns { result: "refined text" }

import { createClient } from '@supabase/supabase-js';

// ── Environment variables (set in Vercel dashboard) ──
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Allowed origins ──
const ALLOWED_ORIGINS = [
  'https://clearpen.live',
  'https://www.clearpen.live',
  'https://clearpen.vercel.app',
];

// ── In-memory stores (reset on cold start — intentional for soft gates) ──
// Rate limiter: { ip: [timestamp, timestamp, ...] }
const rateLimitStore = {};
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 seconds

// Unauthenticated IP use tracker: { ip: count }
const anonUseStore = {};
const ANON_FREE_LIMIT = 5;

// ── Tone prompt templates ──
const TONE_PROMPTS = {
  professional: `Rewrite the following text to sound more professional and formal. Remove casual language, filler words, hedging, and over-apologetic phrases. Keep the core message and meaning identical. Return only the rewritten text with no explanation, no preamble, no quotation marks.`,

  assertive: `Rewrite the following text to sound more assertive and confident. Remove apologetic language, unnecessary qualifiers like "just", "maybe", "possibly", "I think", and weak phrasing. Make it direct and clear without being aggressive. Return only the rewritten text with no explanation, no preamble, no quotation marks.`,

  legal: `Rewrite the following text using formal legal phrasing suitable for official notices, complaints, or formal letters. Use precise language, formal register, and where appropriate include language that signals legal awareness (e.g. "I hereby formally request", "pursuant to", "I reserve the right to"). Do not invent legal claims — only rephrase what is stated. Return only the rewritten text with no explanation, no preamble, no quotation marks.`,

  softer: `Rewrite the following text to sound calmer, more diplomatic, and less confrontational. Soften aggressive or blunt language while preserving the core message. Do not remove the point — just make it easier to receive. Return only the rewritten text with no explanation, no preamble, no quotation marks.`,

  simple: `Rewrite the following text in plain, simple English. Remove jargon, complex vocabulary, and convoluted sentence structure. Make it easy to read for anyone regardless of education level. Keep all the information. Return only the rewritten text with no explanation, no preamble, no quotation marks.`,

  academic: `Rewrite the following text in formal academic English suitable for essays, reports, or scholarly writing. Use appropriate academic register, avoid colloquialisms, and structure sentences clearly. Return only the rewritten text with no explanation, no preamble, no quotation marks.`,
};

// ── Helpers ──
function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    'unknown'
  );
}

function checkRateLimit(ip) {
  const now = Date.now();
  if (!rateLimitStore[ip]) rateLimitStore[ip] = [];
  // Remove timestamps outside the window
  rateLimitStore[ip] = rateLimitStore[ip].filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (rateLimitStore[ip].length >= RATE_LIMIT_MAX) return false;
  rateLimitStore[ip].push(now);
  return true;
}

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function getSupabaseAdmin() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Main handler ──
export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  const corsHeaders = getCorsHeaders(origin);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).set(corsHeaders).end();
  }

  // Set CORS on all responses
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getClientIP(req);

  // ── 1. Rate limit check ──
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests — slow down and retry.' });
  }

  // ── 2. Parse body ──
  const { text, mode } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length < 3) {
    return res.status(400).json({ error: 'No text provided.' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'Text too long — max 2000 characters.' });
  }
  const cleanMode = ['professional','assertive','legal','softer','simple','academic'].includes(mode)
    ? mode
    : 'professional';

  // ── 3. Auth check ──
  let userPlan = null;      // null = unauthenticated
  let userId   = null;

  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (bearerToken) {
    const sb = getSupabaseAdmin();
    if (sb) {
      try {
        // Verify the JWT — getUser validates signature server-side
        const { data: { user }, error } = await sb.auth.getUser(bearerToken);
        if (!error && user) {
          userId = user.id;
          // Fetch plan from clearpen_users table
          const { data: profile } = await sb
            .from('clearpen_users')
            .select('plan, refinements_used, refinements_reset_at')
            .eq('id', userId)
            .single();

          if (profile) {
            userPlan = profile.plan || 'free';

            // Enforce server-side limit for authenticated free users
            if (userPlan === 'free') {
              // Check if reset window has passed (30 days)
              const resetAt = profile.refinements_reset_at
                ? new Date(profile.refinements_reset_at)
                : new Date(0);
              const now = new Date();
              const daysSinceReset = (now - resetAt) / (1000 * 60 * 60 * 24);

              if (daysSinceReset >= 30) {
                // Reset the counter
                await sb
                  .from('clearpen_users')
                  .update({ refinements_used: 0, refinements_reset_at: now.toISOString() })
                  .eq('id', userId);
                profile.refinements_used = 0;
              }

              if (profile.refinements_used >= 5) {
                return res.status(403).json({
                  error: 'Free limit reached. Upgrade to continue.',
                  code: 'FREE_LIMIT_EXCEEDED',
                });
              }

              // Increment server-side use count
              await sb
                .from('clearpen_users')
                .update({ refinements_used: profile.refinements_used + 1 })
                .eq('id', userId);
            }

            // Student plan: 30 refinements/month — enforce server-side
            if (userPlan === 'student') {
              const resetAt = profile.refinements_reset_at
                ? new Date(profile.refinements_reset_at)
                : new Date(0);
              const now = new Date();
              const daysSinceReset = (now - resetAt) / (1000 * 60 * 60 * 24);

              if (daysSinceReset >= 30) {
                await sb
                  .from('clearpen_users')
                  .update({ refinements_used: 0, refinements_reset_at: now.toISOString() })
                  .eq('id', userId);
                profile.refinements_used = 0;
              }

              if (profile.refinements_used >= 30) {
                return res.status(403).json({
                  error: 'Student monthly limit reached. Upgrade to Pro for unlimited.',
                  code: 'STUDENT_LIMIT_EXCEEDED',
                });
              }

              await sb
                .from('clearpen_users')
                .update({ refinements_used: profile.refinements_used + 1 })
                .eq('id', userId);
            }

            // Pro: no limit check needed — fall through to API call

          } else {
            // User exists in auth.users but not yet in clearpen_users — treat as free
            userPlan = 'free';
            // Create their row
            try {
              await sb.from('clearpen_users').upsert({
                id: userId,
                email: user.email,
                plan: 'free',
                refinements_used: 1,
                refinements_reset_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              }, { onConflict: 'id' });
            } catch(e) { /* non-blocking */ }
          }
        }
      } catch (authErr) {
        // Invalid token — treat as unauthenticated, don't block
        userPlan = null;
      }
    }
  }

  // ── 4. Unauthenticated IP soft gate ──
  if (userPlan === null) {
    if (!anonUseStore[ip]) anonUseStore[ip] = 0;
    if (anonUseStore[ip] >= ANON_FREE_LIMIT) {
      return res.status(403).json({
        error: 'Free limit reached. Sign in or upgrade to continue.',
        code: 'ANON_LIMIT_EXCEEDED',
      });
    }
    anonUseStore[ip]++;
  }

  // ── 5. Call Claude Haiku ──
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured.' });
  }

  const systemPrompt = TONE_PROMPTS[cleanMode];

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
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: text.trim(),
          },
        ],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error:', response.status, errBody);
      return res.status(502).json({ error: 'AI service error — try again.' });
    }

    const data = await response.json();
    const result = data?.content?.[0]?.text?.trim() || '';

    if (!result) {
      return res.status(502).json({ error: 'Empty response from AI — try again.' });
    }

    return res.status(200).json({ result });

  } catch (err) {
    console.error('Refine handler error:', err);
    return res.status(500).json({ error: 'Server error — try again.' });
  }
}
