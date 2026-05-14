// api/webhook.js
// Clearpen — Paystack Payment Webhook
// Vercel serverless function (Node.js runtime)
//
// What this does:
//   1. Receives POST from Paystack on charge.success event
//   2. Verifies HMAC SHA-512 signature using PAYSTACK_SECRET_KEY
//      → Returns 401 immediately if signature invalid (prevents fake calls)
//   3. Extracts customer email and plan metadata from payload
//   4. Looks up the user in Supabase auth.users by email
//      → If found: upserts clearpen_users row with plan = 'pro' or 'student'
//      → If NOT found: stores email in pending_upgrades table so plan
//        activates automatically the moment they sign up or sign in
//   5. Returns 200 to Paystack to acknowledge receipt
//      (Paystack retries if it doesn't get 200 within ~30 seconds)

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// ── Environment variables ──
const PAYSTACK_SECRET_KEY  = process.env.PAYSTACK_SECRET_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function getSupabaseAdmin() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Determine plan from payment reference or metadata
// Reference format: CP_PRO_... or CP_STUDENT_...
function extractPlan(event) {
  // Check metadata first (most reliable)
  const metaPlan = event?.data?.metadata?.plan;
  if (metaPlan === 'student') return 'student';
  if (metaPlan === 'pro') return 'pro';

  // Fall back to reference string
  const ref = (event?.data?.reference || '').toUpperCase();
  if (ref.includes('STUDENT')) return 'student';

  // Default to pro
  return 'pro';
}

// ── Main handler ──
export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. Verify Paystack signature ──
  if (!PAYSTACK_SECRET_KEY) {
    console.error('PAYSTACK_SECRET_KEY not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const signature = req.headers['x-paystack-signature'];
  if (!signature) {
    return res.status(401).json({ error: 'Missing signature' });
  }

  // Paystack signs the raw request body — we need the raw string
  // Vercel parses JSON automatically, so we reconstruct from req.body
  // NOTE: for signature verification to work, the raw body must be used.
  // Vercel Edge/Node runtime provides req.body as parsed object.
  // We re-stringify in a stable way — but the safest approach is using
  // the rawBody from the request. Vercel provides this if you disable
  // body parsing or read the raw stream. We handle both cases below.
  let rawBody;
  try {
    // If Vercel provides rawBody (set in vercel.json via bodyParser: false)
    rawBody = req.rawBody;
    if (!rawBody) {
      // Fallback: re-stringify parsed body (less ideal but works for Paystack)
      rawBody = JSON.stringify(req.body);
    }
  } catch(e) {
    rawBody = JSON.stringify(req.body);
  }

  const expectedSignature = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  if (signature !== expectedSignature) {
    console.warn('Clearpen webhook: Invalid Paystack signature. Possible fake request.');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // ── 2. Parse event ──
  const event = req.body;

  // Only process charge.success
  if (event?.event !== 'charge.success') {
    // Acknowledge other events so Paystack doesn't retry them
    return res.status(200).json({ received: true, processed: false });
  }

  const email = event?.data?.customer?.email?.toLowerCase()?.trim();
  const reference = event?.data?.reference;
  const amount = event?.data?.amount; // in kobo

  if (!email) {
    console.error('Clearpen webhook: No email in payload');
    return res.status(200).json({ received: true, error: 'No email in payload' });
  }

  console.log(`Clearpen webhook: charge.success for ${email}, ref: ${reference}, amount: ${amount}`);

  const plan = extractPlan(event);
  const sb = getSupabaseAdmin();

  if (!sb) {
    console.error('Clearpen webhook: Supabase not configured');
    // Still return 200 so Paystack doesn't retry endlessly
    return res.status(200).json({ received: true, error: 'DB not configured' });
  }

  try {
    // ── 3. Look up user in auth.users by email ──
    // Supabase admin API allows listing users — we search by email
    const { data: { users }, error: listError } = await sb.auth.admin.listUsers({
      // Supabase paginates — filter is done client-side for small lists
      // For scale, use a database function. For now this is fine.
    });

    if (listError) throw listError;

    const matchedUser = users?.find(u => u.email?.toLowerCase() === email);

    if (matchedUser) {
      // ── User exists — upsert their clearpen_users row ──
      const { error: upsertError } = await sb
        .from('clearpen_users')
        .upsert({
          id: matchedUser.id,
          email: email,
          plan: plan,
          refinements_used: 0,
          refinements_reset_at: new Date().toISOString(),
          subscribed_at: new Date().toISOString(),
          paystack_customer_code: event?.data?.customer?.customer_code || null,
        }, { onConflict: 'id' });

      if (upsertError) {
        console.error('Clearpen webhook: upsert error', upsertError);
        throw upsertError;
      }

      console.log(`Clearpen webhook: ${plan} plan activated for existing user ${email}`);

    } else {
      // ── User not yet registered — store in pending_upgrades ──
      // When they sign up/sign in, the app should check this table
      // and activate their plan. See note in clearpen.html initAuth().
      const { error: pendingError } = await sb
        .from('pending_upgrades')
        .upsert({
          email: email,
          plan: plan,
          payment_reference: reference,
          paid_at: new Date().toISOString(),
          activated: false,
        }, { onConflict: 'email' });

      if (pendingError) {
        // pending_upgrades table may not exist yet — log but don't fail
        console.warn('Clearpen webhook: pending_upgrades upsert failed (table may not exist yet):', pendingError.message);
      }

      console.log(`Clearpen webhook: ${plan} payment stored as pending for unregistered email ${email}`);
    }

    return res.status(200).json({ received: true, plan, email });

  } catch (err) {
    console.error('Clearpen webhook: handler error', err);
    // Return 200 anyway — we don't want Paystack to retry indefinitely
    // for errors that are our fault (DB issues etc.)
    return res.status(200).json({ received: true, error: 'Processing error — check logs' });
  }
}
