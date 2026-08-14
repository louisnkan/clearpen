// api/refine.js — STREAMING VERSION
// Same security layers as before (CORS, rate limit, auth, IP fallback,
// input validation) — only the "call Claude" section changed to stream
// plain text back instead of waiting for the full completion and
// returning JSON. This is what makes refinement feel near-instant:
// the client starts rendering text within ~1s instead of waiting for
// the whole round trip.
//
// ⚠️ BREAKING CHANGE — deploy this together with the updated client
// runRefine() (in clearpen-39-patched.html), not separately. The old
// client expects `{ result: "..." }` JSON; this returns raw streamed
// text with Content-Type: text/plain. Test on a preview deployment
// before pushing to production.

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
// Unchanged from before. Still not safe across multiple serverless
// instances under real concurrent load — see the note I gave you
// separately about Redis/Upstash for when you scale this up.
const ipUsage = new Map();
const ipRateMap = new Map();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
}

const PROMPTS = {
  professional: `You are a professional writing assistant. Rewrite the following text to sound more professional and formal. Remove informal language, hedging phrases ("just", "maybe", "I think", "I was wondering"), and unnecessary apologies. Keep the same meaning. Return ONLY the rewritten text, no explanation, no quotes.`,
  assertive:    `You are a writing coach. Rewrite the following text to sound more assertive and confident. Remove apologetic language, self-doubt, and unnecessary qualifiers. The writer should sound sure of themselves. Keep the meaning intact. Return ONLY the rewritten text.`,
  legal:        `You are a legal writing assistant. Rewrite the following text using formal legal register suitable for official notices, complaints, or formal correspondence in Nigeria. Use formal legal phrasing. Do not provide legal advice — only improve the register and formality. Return ONLY the rewritten text.`,
  softer:       `You are a communication coach. Rewrite the following text to sound calmer, more diplomatic, and less confrontational — while still communicating the same point clearly. Do not water down the core message. Return ONLY the rewritten text.`,
  simple:       `You are a plain language editor. Rewrite the following text in plain, clear English that anyone can understand. Remove jargon, legalese, and unnecessarily complex words. Keep the meaning identical. Return ONLY the rewritten text.`,
  academic:     `You are an academic writing assistant. Rewrite the following text in a formal academic register suitable for essays, reports, and scholarly work. Use appropriate academic vocabulary and sentence structure. Return ONLY the rewritten text.`,
};

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

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  setCORSHeaders(res, origin);

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const ip = getClientIP(req);
  if (!checkRateLimit(ip)) { res.status(429).json({ error: 'Too many requests. Please slow down.' }); return; }

  let text, mode;
  try { ({ text, mode } = req.body || {}); }
  catch(e) { res.status(400).json({ error: 'Invalid request body' }); return; }

  if (!text || typeof text !== 'string' || text.trim().length < 3) {
    res.status(400).json({ error: 'Text is required (min 3 characters)' }); return;
  }
  if (text.length > 2000) { res.status(400).json({ error: 'Text too long (max 2000 characters)' }); return; }
  if (!ALLOWED_MODES.includes(mode)) mode = 'professional';

  // ── AUTH CHECK (unchanged) ───────────────────────────
  const authHeader = req.headers['authorization'] || '';
  let userId = null;
  let userPlan = 'free';

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const sb = getSupabase();
      const { data: { user }, error: authErr } = await sb.auth.getUser(token);
      if (!authErr && user) {
        userId = user.id;
        const { data: userData, error: userErr } = await sb
          .from('clearpen_users')
          .select('plan, refinements_used, refinements_reset_at')
          .eq('id', userId)
          .maybeSingle();

        if (userErr && userErr.code !== 'PGRST116') {
          userId = null;
        } else if (!userData) {
          await sb.from('clearpen_users').insert({
            id: userId, email: user.email, plan: 'free',
            refinements_used: 0, refinements_reset_at: new Date().toISOString(),
          });
          userPlan = 'free';
        } else {
          userPlan = userData.plan || 'free';
          if (userPlan !== 'pro') {
            const used = userData.refinements_used || 0;
            if (used >= FREE_LIMIT) {
              res.status(403).json({ error: 'Free refinement limit reached. Upgrade to Pro.' });
              return;
            }
            await sb.from('clearpen_users').update({ refinements_used: used + 1 }).eq('id', userId);
          }
        }
      }
    } catch(e) { userId = null; }
  }

  if (!userId) {
    const used = ipUsage.get(ip) || 0;
    ipUsage.set(ip, used + 1);
  }

  // ── CALL CLAUDE API — STREAMED ───────────────────────
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', // stop any intermediary proxy from buffering the whole thing
    });

    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: PROMPTS[mode] + '\n\nText to rewrite:\n' + text.trim() }],
    });

    stream.on('text', (chunk) => { res.write(chunk); });
    stream.on('error', (e) => {
      console.error('Stream error:', e);
      res.end(); // headers already sent — best we can do is close the connection
    });

    await stream.finalMessage();
    res.end();

  } catch(e) {
    console.error('Claude API error:', e);
    if (!res.headersSent) {
      if (e.status === 429) res.status(429).json({ error: 'AI service busy. Try again in a moment.' });
      else res.status(500).json({ error: 'Refinement failed. Check your connection.' });
    } else {
      res.end();
    }
  }
}
