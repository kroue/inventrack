/**
 * send-alert-email — InvenTrack Automated Notification Service
 *
 * Invoked by the `trg_notify_alert_webhook` database trigger (migration 00009)
 * whenever a new Active row lands in the `alerts` table. Formats the alert and
 * calls the Resend API so the Admin is notified without opening the system.
 *
 * Deploy:
 *   supabase functions deploy send-alert-email
 *   supabase secrets set RESEND_API_KEY=re_xxx ALERT_RECIPIENT=owner@albazar.example
 *
 * Then point the database at it (see migration 00009 header):
 *   INSERT INTO private.app_settings (key, value) VALUES
 *     ('alert_function_url', 'https://<project-ref>.functions.supabase.co/send-alert-email'),
 *     ('alert_function_key', '<service-role-key>');
 */

interface AlertPayload {
  alert_id: string;
  alert_type: 'LOW STOCK' | 'NEAR EXPIRY';
  product_id: string;
  product_name: string;
  stock_quantity: number;
  reorder_point: number;
  triggered_at: string;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function buildEmail(alert: AlertPayload): { subject: string; html: string } {
  const triggered = new Date(alert.triggered_at).toLocaleString('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  if (alert.alert_type === 'NEAR EXPIRY') {
    return {
      subject: `InvenTrack: ${alert.product_name} is near expiry`,
      html: `
        <h2 style="font-family:sans-serif;color:#b45309;margin:0 0 12px">Near-Expiry Stock</h2>
        <p style="font-family:sans-serif;color:#374151;line-height:1.6">
          <strong>${alert.product_name}</strong> is holding stock with 14 days or less of
          shelf life remaining. The markdown discount is now being applied automatically
          at checkout under the FEFO policy.
        </p>
        <p style="font-family:sans-serif;color:#6b7280;font-size:12px">
          On hand: ${alert.stock_quantity} &middot; Detected ${triggered}
        </p>
      `,
    };
  }

  return {
    subject: `InvenTrack: ${alert.product_name} has hit its reorder point`,
    html: `
      <h2 style="font-family:sans-serif;color:#b91c1c;margin:0 0 12px">Low Stock Alert</h2>
      <p style="font-family:sans-serif;color:#374151;line-height:1.6">
        <strong>${alert.product_name}</strong> has fallen to or below its calculated
        Reorder Point. Restocking now accounts for the supplier lead time.
      </p>
      <table style="font-family:sans-serif;color:#374151;font-size:14px;border-collapse:collapse">
        <tr><td style="padding:4px 16px 4px 0">Current stock</td><td><strong>${alert.stock_quantity}</strong></td></tr>
        <tr><td style="padding:4px 16px 4px 0">Reorder point</td><td><strong>${alert.reorder_point}</strong></td></tr>
        <tr><td style="padding:4px 16px 4px 0">Detected</td><td>${triggered}</td></tr>
      </table>
      <p style="font-family:sans-serif;color:#6b7280;font-size:12px;margin-top:16px">
        A restock request has been queued in the Procurement dashboard.
      </p>
    `,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = Deno.env.get('RESEND_API_KEY');
  const recipient = Deno.env.get('ALERT_RECIPIENT');
  // Resend's shared test sender is the only address usable without a verified
  // domain, and it will only deliver to the account holder's own email. Set
  // ALERT_SENDER to an address on a verified domain for real delivery.
  const sender = Deno.env.get('ALERT_SENDER') ?? 'InvenTrack <onboarding@resend.dev>';

  if (!apiKey || !recipient) {
    console.error('RESEND_API_KEY and ALERT_RECIPIENT must both be set.');
    return new Response(
      JSON.stringify({ error: 'Notification service is not configured.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  let alert: AlertPayload;
  try {
    alert = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!alert?.product_name || !alert?.alert_type) {
    return new Response(JSON.stringify({ error: 'Malformed alert payload.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { subject, html } = buildEmail(alert);

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: sender, to: [recipient], subject, html }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error(`Resend rejected the alert email: ${response.status} ${detail}`);
    return new Response(JSON.stringify({ error: 'Failed to send alert email.' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ sent: true, alert_id: alert.alert_id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
