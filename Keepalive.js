// api/keepalive.js
// Hit by Vercel Cron every 3 days (see vercel.json "crons").
// Does one trivial Supabase query — just enough to count as activity
// and stop the free-tier project from auto-pausing after ~7 idle days.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    );

    const { error } = await sb.from('clearpen_users').select('id').limit(1);

    if (error) {
      console.error('Keepalive query failed:', error);
      res.status(500).json({ ok: false, error: error.message });
      return;
    }

    console.log('Keepalive ping OK', new Date().toISOString());
    res.status(200).json({ ok: true, pinged_at: new Date().toISOString() });
  } catch(e) {
    console.error('Keepalive error:', e);
    res.status(500).json({ ok: false });
  }
}
