/**
 * POST /api/email
 * Sends a transactional email via Resend.
 *
 * Body: { to, subject, html }
 * Auth: Bearer <supabase-jwt>  (prevents public abuse)
 */

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Verify auth
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (token) {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
  }

  const { to, subject, html } = req.body || {};
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'Missing to / subject / html' });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  const { data, error } = await resend.emails.send({
    from:    'FCC <onboarding@resend.dev>',   // swap for your domain once verified
    to:      Array.isArray(to) ? to : [to],
    subject,
    html
  });

  if (error) {
    console.error('[email]', error);
    return res.status(400).json({ error });
  }

  return res.status(200).json({ success: true, id: data?.id });
};
