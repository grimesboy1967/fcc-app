/**
 * GET /api/cron
 * Runs daily at 8 AM (configured in vercel.json).
 * Scans all users' bills, sends Resend email reminders for bills
 * due within the next 3 days.
 *
 * Vercel calls this automatically — secured by CRON_SECRET env var.
 */

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

module.exports = async (req, res) => {
  // Vercel cron passes Authorization header with the CRON_SECRET
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Service-role client can read all users
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const resend = new Resend(process.env.RESEND_API_KEY);

  const today   = new Date();
  const dayNum  = today.getDate();
  const REMIND_DAYS = 3;

  // Fetch all user states
  const { data: rows, error } = await sb
    .from('user_state')
    .select('user_id, state');

  if (error) {
    console.error('[cron] supabase error', error);
    return res.status(500).json({ error: error.message });
  }

  let emailsSent = 0;

  for (const row of rows || []) {
    const state    = row.state || {};
    const bills    = state.bills    || [];
    const settings = state.settings || {};

    // Get email from settings; fall back to REMINDER_EMAIL env var
    const emailTo = settings.email || process.env.REMINDER_EMAIL;
    if (!emailTo) continue;

    const p1Name = settings.p1 || 'Scott';

    // Bills due in next REMIND_DAYS days and not already paid
    const dueSoon = bills.filter(b => {
      if (b.paid || b.linkedTo) return false;  // skip paid + linked children
      const dueDay = parseInt(b.dueDay) || 0;
      if (!dueDay) return false;
      const diff = dueDay - dayNum;
      return diff >= 0 && diff <= REMIND_DAYS;
    });

    if (dueSoon.length === 0) continue;

    const rows_html = dueSoon.map(b => `
      <tr style="border-bottom:1px solid #e2e8f0">
        <td style="padding:10px 14px;font-weight:600">${esc(b.name)}</td>
        <td style="padding:10px 14px;color:#1d4ed8">$${fmt(b.amount)}</td>
        <td style="padding:10px 14px;color:#64748b">
          Due the ${b.dueDay}${ordinal(b.dueDay)}
          ${daysLabel(b.dueDay - dayNum)}
        </td>
        ${ b.url ? `<td style="padding:10px 14px"><a href="${esc(b.url)}" style="color:#3b82f6">Pay Now</a></td>` : '<td></td>' }
      </tr>`).join('');

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;margin:0;padding:32px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
    <div style="background:#0f172a;padding:24px 28px">
      <h1 style="color:#fff;margin:0;font-size:20px">💰 Financial Command Center</h1>
      <p style="color:#94a3b8;margin:4px 0 0;font-size:13px">Robertson Family · Bill Reminder</p>
    </div>
    <div style="padding:28px">
      <p style="margin:0 0 20px;color:#1e293b">Hi ${esc(p1Name)}, you have <strong>${dueSoon.length} bill${dueSoon.length > 1 ? 's' : ''}</strong> coming up in the next ${REMIND_DAYS} days:</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f1f5f9;text-align:left">
            <th style="padding:10px 14px;color:#64748b;font-weight:600">Bill</th>
            <th style="padding:10px 14px;color:#64748b;font-weight:600">Amount</th>
            <th style="padding:10px 14px;color:#64748b;font-weight:600">Due</th>
            <th style="padding:10px 14px;color:#64748b;font-weight:600">Link</th>
          </tr>
        </thead>
        <tbody>${rows_html}</tbody>
      </table>
      <div style="margin-top:28px;text-align:center">
        <a href="https://your-app.vercel.app/dashboard"
           style="background:#3b82f6;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
          Open Dashboard
        </a>
      </div>
    </div>
    <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;text-align:center">
      Family Financial Command Center · Automated reminder
    </div>
  </div>
</body>
</html>`;

    try {
      await resend.emails.send({
        from:    'FCC Bills <onboarding@resend.dev>',
        to:      emailTo,
        subject: `📅 ${dueSoon.length} bill${dueSoon.length > 1 ? 's' : ''} due within ${REMIND_DAYS} days`,
        html
      });
      emailsSent++;
    } catch (e) {
      console.error('[cron] email error', e);
    }
  }

  return res.status(200).json({ success: true, emailsSent, usersChecked: rows?.length || 0 });
};

// ── helpers ──────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(n) {
  return Math.abs(parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function ordinal(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return s[(v-20)%10] || s[v] || s[0];
}
function daysLabel(diff) {
  if (diff === 0) return '<span style="color:#ef4444;font-weight:600">(TODAY)</span>';
  if (diff === 1) return '<span style="color:#f97316">(tomorrow)</span>';
  return `(in ${diff} days)`;
}
