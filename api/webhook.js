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
//
// CHANGED (tonight): amount/currency check now accepts BOTH NGN (₦5,000)
// and USD ($4.99) instead of only NGN — everything else is byte-for-byte
// the same logic as before. This was the only block that needed to change.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch(e) {
    res.status(400).json({ error: 'Could not read body' });
    return;
  }

  // ── VERIFY PAYSTACK SIGNATURE ──────────────────────
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

  if (event.event !== 'charge.success') {
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
  const amount = data.amount; // in kobo (NGN) or cents (USD)
  const currency = data.currency;
  const userId = data.metadata?.user_id; // set in Paystack setup on frontend

  // Validate: must match Pro pricing in NGN or USD
  const EXPECTED_AMOUNT = { NGN: 500000, USD: 499 }; // ₦5,000 kobo / $4.99 cents
  const expected = EXPECTED_AMOUNT[currency];

  if (!customerEmail) {
    console.error('No customer email in webhook', reference);
    res.status(400).json({ error: 'No customer email' });
    return;
  }

  if (!expected || amount < expected) {
    console.warn('Unexpected amount or currency', { amount, currency, reference });
    res.status(200).json({ received: true, note: 'Unexpected amount' });
    return;
  }

  const sb = getSupabase();
  const now = new Date().toISOString();

  // ── UPDATE SUPABASE ────────────────────────────────
  // Case 1: userId present (user was signed in when they paid)
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
          refinements_used: 0,
        }, { onConflict: 'id' });

      if (error) {
        console.error('Supabase upsert error (by ID):', error);
      } else {
        console.log('Pro activated for user', userId, reference);
        res.status(200).json({ received: true, activated: true });
        return;
      }
    } catch(e) {
      console.error('Supabase error:', e);
    }
  }

  // Case 2: No userId, or upsert by ID failed — email lookup via admin API
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

  res.status(200).json({ received: true, pending: true });
}
