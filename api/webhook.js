// api/webhook.js
// Paystack Webhook Handler — Clearpen
//
// Flow:
// 1. Paystack sends POST to this endpoint after payment
// 2. We verify the signature using HMAC SHA512
// 3. On charge.success, we update Supabase clearpen_users
// 4. If user doesn't exist in auth.users yet (paid before signing in),
//    we write to pending_upgrades table
// 5. When user later signs in, the frontend checks pending_upgrades
//    and activates Pro
//
// IMPORTANT: Paystack requires raw body for signature verification.
// vercel.json must set "bodyParser: false" for this route.
// See vercel.json in this project.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
}

// Read raw body as string for signature verification
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Get raw body before parsing
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch(e) {
    res.status(400).json({ error: 'Could not read body' });
    return;
  }

  // ── VERIFY PAYSTACK SIGNATURE ──────────────────────
  // Paystack signs the body with your secret key using HMAC SHA512
  // and sends the hash in the x-paystack-signature header.
  // If signatures don't match, reject immediately.
  const paystackSig = req.headers['x-paystack-signature'];
  if (!paystackSig) {
    res.status(401).json({ error: 'Missing signature' });
    return;
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    console.error('PAYSTACK_SECRET_KEY not set in environment');
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  const computedSig = crypto
    .createHmac('sha512', secretKey)
    .update(rawBody)
    .digest('hex');

  if (computedSig !== paystackSig) {
    // Signature mismatch — reject. This prevents fake payment events.
    console.warn('Paystack signature mismatch — possible fake webhook');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // ── PARSE EVENT ────────────────────────────────────
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch(e) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  // We only care about successful charges
  if (event.event !== 'charge.success') {
    // Acknowledge other events without processing
    res.status(200).json({ received: true });
    return;
  }

  const data = event.data;
  if (!data) {
    res.status(400).json({ error: 'No event data' });
    return;
  }

  const customerEmail = data.customer?.email;
  const reference = data.reference;
  const amount = data.amount; // in kobo
  const currency = data.currency;
  const userId = data.metadata?.user_id; // set in Paystack setup on frontend

  // Validate: must be ₦5,000 (500000 kobo) and NGN
  if (!customerEmail) {
    console.error('No customer email in webhook', reference);
    res.status(400).json({ error: 'No customer email' });
    return;
  }

  if (amount < 500000 || currency !== 'NGN') {
    console.warn('Unexpected amount or currency', { amount, currency, reference });
    // Still acknowledge to avoid Paystack retrying
    res.status(200).json({ received: true, note: 'Unexpected amount' });
    return;
  }

  const sb = getSupabase();
  const now = new Date().toISOString();

  // ── UPDATE SUPABASE ────────────────────────────────
  // Case 1: We have a userId from metadata (user was signed in when they paid)
  if (userId && userId !== 'guest') {
    try {
      const { error } = await sb
        .from('clearpen_users')
        .upsert({
          id: userId,
          email: customerEmail,
          plan: 'pro',
          paystack_customer_code: data.customer?.customer_code || null,
          subscribed_at: now,
          refinements_used: 0, // reset on upgrade
        }, { onConflict: 'id' });

      if (error) {
        console.error('Supabase upsert error (by ID):', error);
        // Don't fail — fall through to email-based upsert
      } else {
        console.log('Pro activated for user', userId, reference);
        res.status(200).json({ received: true, activated: true });
        return;
      }
    } catch(e) {
      console.error('Supabase error:', e);
    }
  }

  // Case 2: No userId, or upsert by ID failed — use email lookup
  // First try to find the user in auth.users by email via admin API
  try {
    const { data: { users }, error: listErr } = await sb.auth.admin.listUsers();
    if (!listErr && users) {
      const matchedUser = users.find(u => u.email === customerEmail);
      if (matchedUser) {
        const { error: upsertErr } = await sb
          .from('clearpen_users')
          .upsert({
            id: matchedUser.id,
            email: customerEmail,
            plan: 'pro',
            paystack_customer_code: data.customer?.customer_code || null,
            subscribed_at: now,
            refinements_used: 0,
          }, { onConflict: 'id' });

        if (upsertErr) {
          console.error('Supabase upsert error (by email):', upsertErr);
        } else {
          console.log('Pro activated for', customerEmail, reference);
          res.status(200).json({ received: true, activated: true });
          return;
        }
      }
    }
  } catch(e) {
    console.error('Auth admin lookup error:', e);
  }

  // Case 3: User hasn't signed in yet — store in pending_upgrades
  // When they sign in, the frontend will check this table
  try {
    const { error: pendingErr } = await sb
      .from('pending_upgrades')
      .upsert({
        email: customerEmail,
        plan: 'pro',
        subscribed_at: now,
        activated: false,
        payment_reference: reference,
      }, { onConflict: 'email' });

    if (pendingErr) {
      console.error('Pending upgrades insert error:', pendingErr);
    } else {
      console.log('Stored pending upgrade for', customerEmail);
    }
  } catch(e) {
    console.error('Pending upgrade error:', e);
  }

  // Always return 200 to Paystack so it stops retrying
  res.status(200).json({ received: true, pending: true });
}
