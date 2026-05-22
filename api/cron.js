/**
 * GET /api/cron  — zero npm dependencies, native fetch only
 * Runs daily at 8 AM UTC via Vercel cron (vercel.json).
 * Sends bill reminder emails for bills due within 3 days.
 */

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // Vercel sends Authorization: Bearer <CRON_SECRET>
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const SB_URL      = process.env.SUPABASE_URL;
    const SB_SVCKEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND_KEY  = process.env.RESEND_API_KEY;
    const REMIND_TO   = process.env.REMINDER_EMAIL;

    if (!SB_URL || !SB_SVCKEY || !RESEND_KEY) {
      return res.status(500).json({ error: 'Missing env vars: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY' });
    }

    // Fetch all user states (service role bypasses RLS)
    const r = await fetch(`${SB_URL}/rest/v1/user_state?select=user_id,state`, {
      headers: { Authorization: `Bearer ${SB_SVCKEY}`, apikey: SB_SVCKEY }
    });
    const rows = await r.json();

    const today    = new Date();
    const dayNum   = today.getDate();
    const DAYS_AHD = 3;
    let emailsSent = 0;

    for (const { state } of (rows || [])) {
      const bills    = state?.bills    || [];
      const settings = state?.settings || {};
      const emailTo  = settings.email || REMIND_TO;
      if (!emailTo) continue;

      const dueSoon = bills.filter(b => {
        if (b.paid || b.linkedTo) return false;
        const d = parseInt(b.dueDay) || 0;
        if (!d) return false;
        const diff = d - dayNum;
        return diff >= 0 && diff <= DAYS_AHD;
      });
      if (!dueSoon.length) continue;

      const rowsHtml = dueSoon.map(b => `
        <tr style="border-bottom:1px solid #e2e8f0">
          <td style="padding:10px 14px;font-weight:600">${esc(b.name)}</td>
          <td style="padding:10px 14px;color:#1d4ed8">$${fmt(b.amount)}</td>
          <td style="padding:10px 14px;color:#64748b">
            Due the ${b.dueDay}${ord(b.dueDay)} ${diffLabel(b.dueDay - dayNum)}
          </td>
          ${b.url ? `<td style="padding:10px 14px"><a href="${esc(b.url)}" style="color:#3b82f6">Pay Now</a></td>` : '<td></td>'}
        </tr>`).join('');

      const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f8fafc;padding:32px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
  <div style="background:#0f172a;padding:24px 28px">
    <h1 style="color:#fff;margin:0;font-size:20px">💰 Financial Command Center</h1>
    <p style="color:#94a3b8;margin:4px 0 0;font-size:13px">Robertson Family · Bill Reminder</p>
  </div>
  <div style="padding:28px">
    <p style="margin:0 0 20px;color:#1e293b">Hi ${esc(settings.p1 || 'Scott')}, you have <strong>${dueSoon.length} bill${dueSoon.length > 1 ? 's' : ''}</strong> coming up in the next ${DAYS_AHD} days:</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f1f5f9;text-align:left">
        <th style="padding:10px 14px;color:#64748b">Bill</th>
        <th style="padding:10px 14px;color:#64748b">Amount</th>
        <th style="padding:10px 14px;color:#64748b">Due</th>
        <th style="padding:10px 14px;color:#64748b">Link</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div style="margin-top:28px;text-align:center">
      <a href="https://your-app.vercel.app/dashboard" style="background:#3b82f6;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Open Dashboard</a>
    </div>
  </div>
</div></body></html>`;

      const er = await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          from:    'FCC Bills <onboarding@resend.dev>',
          to:      emailTo,
          subject: `📅 ${dueSoon.length} bill${dueSoon.length > 1 ? 's' : ''} due in ${DAYS_AHD} days`,
          html
        })
      });
      if (er.ok) emailsSent++;
    }

    return res.status(200).json({ success: true, emailsSent, usersChecked: rows?.length || 0 });

  } catch (err) {
    console.error('[cron]', err);
    return res.status(500).json({ error: err.message });
  }
};

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmt(n) { return Math.abs(parseFloat(n)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function ord(n) { const s=['th','st','nd','rd'],v=n%100; return s[(v-20)%10]||s[v]||s[0]; }
function diffLabel(d) {
  if (d===0) return '<span style="color:#ef4444;font-weight:600">(TODAY)</span>';
  if (d===1) return '<span style="color:#f97316">(tomorrow)</span>';
  return `(in ${d} days)`;
}
