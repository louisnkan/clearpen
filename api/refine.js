// api/refine.js
// Clearpen AI Tone Refinement — Vercel Serverless Function
// Your API key lives ONLY in Vercel environment variables.
// It never touches the frontend HTML. Ever.

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// Server-side rate limiting using a simple in-memory store.
// Note: Vercel functions are stateless — this resets per cold start.
// For production scale, replace with Upstash Redis or Vercel KV.
const rateLimitMap = new Map();
const RATE_LIMIT = 10;        // max requests
const RATE_WINDOW = 60000;    // per 60 seconds per IP

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, start: now };
  
  // Reset window if expired
  if (now - record.start > RATE_WINDOW) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return true;
  }
  
  if (record.count >= RATE_LIMIT) return false;
  
  record.count++;
  rateLimitMap.set(ip, record);
  return true;
}

const SYSTEM_PROMPTS = {
  professional: 'You are a professional writing assistant. Rewrite the provided text to sound professionally appropriate. Remove informal language, hedging phrases, and over-apologetic tone. Maintain the core message. Return ONLY the rewritten text with no explanation, no preamble, no quotation marks.',
  assertive:    'You are a writing assistant. Rewrite the provided text to sound confident and direct. Remove apologetic language, qualifiers, and uncertainty. The writer should sound sure of themselves. Return ONLY the rewritten text with no explanation.',
  legal:        'You are a legal writing assistant. Rewrite the provided text using formal legal-style phrasing appropriate for official notices, complaints, or formal correspondence. Return ONLY the rewritten text with no explanation.',
  softer:       'You are a writing assistant. Rewrite the provided text to sound calmer, more empathetic, and less confrontational while preserving the core message. Return ONLY the rewritten text with no explanation.',
  simple:       'You are a writing assistant. Rewrite the provided text in plain, clear English. Remove jargon, complex words, and convoluted sentences. Make it easy for anyone to understand. Return ONLY the rewritten text with no explanation.',
  academic:     'You are an academic writing assistant. Rewrite the provided text to meet academic writing standards: formal register, precise vocabulary, objective tone, and proper academic phrasing. Return ONLY the rewritten text with no explanation.',
};

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS — only allow your own domain
  // During dev: allow vercel.app. After domain purchase: lock to clearpen.live
  const origin = req.headers.origin || '';
  const allowed = [
    'https://clearpen.vercel.app',
    'https://clearpen.live',
    'https://www.clearpen.live',
  ];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Rate limit by IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Wait 60 seconds.' });
  }

  // Validate request body
  const { text, mode } = req.body || {};

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing text' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'Text too long — max 2000 characters' });
  }
  if (!SYSTEM_PROMPTS[mode]) {
    return res.status(400).json({ error: 'Invalid mode' });
  }

  // API key check
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API not configured' });
  }

  try {
    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',  // Fastest + cheapest for tone refinement
        max_tokens: 1024,
        system: SYSTEM_PROMPTS[mode],
        messages: [
          { role: 'user', content: text }
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('Anthropic error:', response.status, err);
      
      if (response.status === 401) return res.status(500).json({ error: 'API key invalid' });
      if (response.status === 429) return res.status(429).json({ error: 'AI service busy — try again shortly' });
      if (response.status === 529) return res.status(503).json({ error: 'AI service overloaded — try again in 30s' });
      
      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await response.json();
    const result = data?.content?.[0]?.text?.trim();

    if (!result) {
      return res.status(502).json({ error: 'Empty response from AI' });
    }

    return res.status(200).json({ result });

  } catch (err) {
    console.error('Refine error:', err);
    return res.status(500).json({ error: 'Server error — try again' });
  }
}
