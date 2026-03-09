// FILE LOCATION IN YOUR REPO: api/refine.js
// This is a Vercel serverless function.
// It sits between your frontend and Anthropic's API.
// Your API key NEVER touches the browser. It lives only here, in Vercel's environment.

// ── SIMPLE IN-MEMORY RATE LIMITER ──
// Limits each IP to 20 requests per 10 minutes.
// Resets when the serverless function cold-starts (good enough for MVP).
const ipMap = new Map();
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_REQUESTS = 20;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = ipMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > WINDOW_MS) {
    // Window expired — reset
    ipMap.set(ip, { count: 1, start: now });
    return false;
  }
  if (entry.count >= MAX_REQUESTS) return true;
  entry.count++;
  ipMap.set(ip, entry);
  return false;
}

// ── MODE PROMPTS ──
const PROMPTS = {
  professional:
    'Rewrite this text to sound more professionally appropriate for workplace or formal correspondence. Remove informal language, hedging, and over-apologetic phrases. Return ONLY the rewritten text, nothing else.',
  assertive:
    'Rewrite this text to sound more confident and direct. Remove apologetic language and unnecessary qualifiers like "maybe", "just", "wondering if". Return ONLY the rewritten text, nothing else.',
  legal:
    'Rewrite this text using appropriate formal and legal-style phrasing suitable for official notices, formal complaints, or legal correspondence. Return ONLY the rewritten text, nothing else.',
  softer:
    'Rewrite this text to sound warmer and more empathetic while preserving the core message. Reduce bluntness. Return ONLY the rewritten text, nothing else.',
  simple:
    'Rewrite this text in plain, clear English. Remove jargon, overly formal language, and long sentences. Return ONLY the rewritten text, nothing else.',
  academic:
    'Rewrite this text to meet academic writing standards: formal register, precise vocabulary, third-person where appropriate. Return ONLY the rewritten text, nothing else.',
};

export default async function handler(req, res) {
  // ── CORS HEADERS ──
  // Change 'https://clearpen.live' to your actual domain once deployed.
  // During testing on Vercel preview URLs, temporarily set to '*' then lock it down.
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── RATE LIMIT ──
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  // ── VALIDATE INPUT ──
  const { text, mode } = req.body || {};

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing text field' });
  }
  if (text.trim().length < 5) {
    return res.status(400).json({ error: 'Text too short' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'Text too long — max 2000 characters' });
  }
  if (!mode || !PROMPTS[mode]) {
    return res.status(400).json({ error: 'Invalid mode' });
  }

  // ── CHECK API KEY EXISTS ──
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY environment variable is not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // ── CALL ANTHROPIC ──
  // Using claude-haiku — fast, cheap, perfect for short refinements.
  // Costs ~$0.00025 per call. 1000 free-tier users using 5 each = $1.25 total.
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system:
          'You are a precise writing refinement assistant. You rewrite text exactly as instructed. You never explain your changes, never add preamble, never use quotation marks around the result. You return ONLY the rewritten text.',
        messages: [
          {
            role: 'user',
            content: `${PROMPTS[mode]}\n\nText to rewrite:\n${text}`,
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const errorBody = await anthropicRes.text();
      console.error('Anthropic API error:', anthropicRes.status, errorBody);
      return res.status(502).json({ error: 'AI service error — please try again' });
    }

    const data = await anthropicRes.json();
    const result = data?.content?.[0]?.text?.trim() || '';

    if (!result) {
      return res.status(500).json({ error: 'Empty response from AI — please try again' });
    }

    return res.status(200).json({ result });

  } catch (err) {
    console.error('refine.js error:', err);
    return res.status(500).json({ error: 'Server error — please try again' });
  }
}
