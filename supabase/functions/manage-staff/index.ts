/**
 * manage-staff — cashier account lifecycle for InvenTrack
 *
 * Creating a login requires the Supabase Admin API, which needs the service role
 * key. That key can never reach the browser, so this function is the only place
 * cashier accounts are created, renamed or removed.
 *
 * Scope is deliberately narrow:
 *   - Only an Admin may call it (verified against public.users, not the JWT).
 *   - It only ever touches accounts whose role is 'Cashier'. Admin accounts are
 *     provisioned in the Supabase dashboard by design, so a compromised admin
 *     session cannot use this to mint or delete other admins.
 *
 * Deploy:
 *   npx supabase functions deploy manage-staff
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type Action = 'create' | 'update' | 'delete';

interface Payload {
  action: Action;
  user_id?: string;
  email?: string;
  full_name?: string;
  password?: string;
}

// Invoked directly from the browser, so the preflight has to be answered and
// every response needs the CORS headers — otherwise supabase-js only ever
// reports "Failed to send a request to the Edge Function".
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    return json({ error: 'Staff management is not configured.' }, 500);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // ─── Authorise the caller ────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Missing authorization.' }, 401);

  const { data: caller, error: callerError } = await admin.auth.getUser(jwt);
  if (callerError || !caller?.user) return json({ error: 'Invalid session.' }, 401);

  // The role comes from the database, never from the token's claims.
  const { data: callerProfile } = await admin
    .from('users')
    .select('role, is_active')
    .eq('user_id', caller.user.id)
    .maybeSingle();

  if (!callerProfile || callerProfile.role !== 'Admin' || callerProfile.is_active === false) {
    return json({ error: 'Only an active administrator may manage staff accounts.' }, 403);
  }

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const email = payload.email?.trim().toLowerCase();
  const fullName = payload.full_name?.trim();

  try {
    // ─── CREATE ────────────────────────────────────────────────────────────
    if (payload.action === 'create') {
      if (!email || !fullName) return json({ error: 'Name and email are both required.' }, 400);
      if (!payload.password || payload.password.length < 8) {
        return json({ error: 'Password must be at least 8 characters.' }, 400);
      }

      const { data: existing } = await admin.from('users').select('user_id').eq('email', email).maybeSingle();
      if (existing) return json({ error: `A staff record for ${email} already exists.` }, 409);

      // email_confirm skips the verification mail — an admin creating a till
      // account in front of the cashier has already established who they are.
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password: payload.password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });

      if (createError || !created?.user) {
        const alreadyRegistered = /already been registered|already exists/i.test(createError?.message ?? '');
        return json({
          error: alreadyRegistered
            ? `A Supabase Auth login already exists for ${email}, but it has no staff record. Delete that login in the dashboard, or add the person with the Admin role option to link the existing account.`
            : (createError?.message ?? 'Could not create the login.'),
        }, 400);
      }

      // Upsert rather than insert so this stays correct even if something else
      // (a trigger, a prior partial run) has already written a row for this id.
      const { error: profileError } = await admin.from('users').upsert({
        user_id: created.user.id,
        email,
        full_name: fullName,
        role: 'Cashier',
        is_active: true,
      }, { onConflict: 'user_id' });

      if (profileError) {
        // Don't leave an auth user stranded without a profile — it would be able
        // to sign in and then fail every role check.
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: `Login created but the staff record failed: ${profileError.message}` }, 500);
      }

      return json({ ok: true, user_id: created.user.id, email, role: 'Cashier' });
    }

    // Everything below targets an existing cashier.
    if (!payload.user_id) return json({ error: 'user_id is required.' }, 400);

    const { data: target } = await admin
      .from('users')
      .select('user_id, email, full_name, role')
      .eq('user_id', payload.user_id)
      .maybeSingle();

    if (!target) return json({ error: 'That staff record no longer exists.' }, 404);
    if (target.role !== 'Cashier') {
      return json({ error: 'Administrator accounts are managed in the Supabase dashboard.' }, 403);
    }

    // ─── UPDATE ────────────────────────────────────────────────────────────
    if (payload.action === 'update') {
      if (!email || !fullName) return json({ error: 'Name and email are both required.' }, 400);

      if (email !== target.email) {
        const { error: authError } = await admin.auth.admin.updateUserById(target.user_id, { email });
        if (authError) {
          const missing = /user not found/i.test(authError.message);
          return json({
            error: missing
              ? `${target.full_name} has no Supabase Auth login, so the email cannot be changed. Delete this staff record and add them again to create a working account.`
              : `Could not update the login email: ${authError.message}`,
          }, 400);
        }
      }

      const { error: profileError } = await admin
        .from('users')
        .update({ email, full_name: fullName })
        .eq('user_id', target.user_id);

      if (profileError) return json({ error: profileError.message }, 400);
      return json({ ok: true, user_id: target.user_id, email });
    }

    // ─── DELETE ────────────────────────────────────────────────────────────
    if (payload.action === 'delete') {
      // A cashier who has rung up sales is part of the audit trail. Removing the
      // row would either break those references or blank the name against real
      // transactions, so deactivation is the correct outcome there.
      const [sales, stockLog, deliveries, priceHistory] = await Promise.all([
        admin.from('sales').select('sale_id', { count: 'exact', head: true }).eq('user_id', target.user_id),
        admin.from('stock_log').select('log_id', { count: 'exact', head: true }).eq('user_id', target.user_id),
        admin.from('deliveries').select('delivery_id', { count: 'exact', head: true }).eq('received_by', target.user_id),
        admin.from('product_price_history').select('history_id', { count: 'exact', head: true }).eq('changed_by', target.user_id),
      ]);

      const references =
        (sales.count ?? 0) + (stockLog.count ?? 0) + (deliveries.count ?? 0) + (priceHistory.count ?? 0);

      if (references > 0) {
        return json({
          error: `${target.full_name} has ${references} recorded transaction(s) and cannot be deleted without breaking the audit trail. Deactivate the account instead — they will no longer be able to sign in.`,
          references,
        }, 409);
      }

      const { error: profileError } = await admin.from('users').delete().eq('user_id', target.user_id);
      if (profileError) return json({ error: profileError.message }, 400);

      const { error: authError } = await admin.auth.admin.deleteUser(target.user_id);
      if (authError && !/user not found/i.test(authError.message)) {
        return json({ error: `Staff record removed but the login could not be deleted: ${authError.message}` }, 500);
      }

      // "User not found" is fine here: the staff record was an orphan with no
      // login behind it, and removing it is exactly the intended outcome.
      return json({ ok: true, deleted: target.email, loginWasMissing: !!authError });
    }

    return json({ error: `Unknown action "${payload.action}".` }, 400);
  } catch (err) {
    console.error('manage-staff failed', err);
    return json({ error: 'Unexpected error handling the staff account.' }, 500);
  }
});
