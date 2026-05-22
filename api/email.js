/**
 * POST /api/email  — zero npm dependencies, native fetch only
 * Sends email via Resend REST API.
 * Body: { to, subject, html }
 */

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { to, subject, html } = req.body || {};
    if (!to || !subject || !html) {
      return res.status(400).json({ error: 'Missing to / subject / html' });
    }

    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) {
      return res.status(500).json({ error: 'Missing RESEND_API_KEY environment variable' });
    }

    const r = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        from:    'FCC <onboarding@resend.dev>',
        to:      Array.isArray(to) ? to : [to],
        subject,
        html
      })
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || 'Resend error', data });
    return res.status(200).json({ success: true, id: data.id });

  } catch (err) {
    console.error('[email]', err);
    return res.status(500).json({ error: err.message });
  }
};
