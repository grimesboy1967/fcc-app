/**
 * POST /api/sync
 * Fetches latest transactions from SimpleFIN Bridge and merges them
 * into the user's Supabase state.
 *
 * Client must send:  Authorization: Bearer <supabase-jwt>
 */

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  // ── CORS preflight ───────────────────────────────────────────
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth ─────────────────────────────────────────────────────
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  const { data: { user }, error: authErr } = await sb.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  try {
    // ── Get / claim SimpleFIN access URL ─────────────────────
    let { data: sfRow } = await sb
      .from('simplefin_config')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    let accessUrl = sfRow?.access_url;

    if (!accessUrl) {
      const claimUrl = process.env.SIMPLEFIN_CLAIM_URL;
      if (!claimUrl) {
        return res.status(400).json({
          error: 'SIMPLEFIN_CLAIM_URL not set in Vercel environment variables.'
        });
      }

      // One-time claim POST
      const claimRes = await fetch(claimUrl, { method: 'POST' });
      if (!claimRes.ok) {
        const body = await claimRes.text();
        return res.status(400).json({
          error: `SimpleFIN claim failed (${claimRes.status}). The claim URL may have already been used.`,
          detail: body
        });
      }
      accessUrl = (await claimRes.text()).trim();

      await sb.from('simplefin_config').upsert(
        { user_id: user.id, access_url: accessUrl, last_synced: null },
        { onConflict: 'user_id' }
      );
    }

    // ── Determine date range ──────────────────────────────────
    const startEpoch = sfRow?.last_synced
      ? Math.floor(new Date(sfRow.last_synced).getTime() / 1000)
      : Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000); // 90 days default

    // ── Fetch from SimpleFIN ──────────────────────────────────
    // accessUrl looks like: https://user:pass@beta-bridge.simplefin.org/simplefin
    const sfAccountsUrl = accessUrl.replace(/\/$/, '') + `/accounts?start-date=${startEpoch}`;

    const sfRes = await fetch(sfAccountsUrl);
    if (!sfRes.ok) {
      const body = await sfRes.text();
      return res.status(502).json({
        error: `SimpleFIN fetch failed (${sfRes.status})`,
        detail: body
      });
    }

    const sfData = await sfRes.json();

    if (sfData.errors?.length > 0) {
      return res.status(502).json({ error: 'SimpleFIN errors', details: sfData.errors });
    }

    // ── Transform accounts + transactions ─────────────────────
    const freshAccounts = [];
    const freshTxns = [];

    (sfData.accounts || []).forEach(acct => {
      freshAccounts.push({
        id:               acct.id,
        name:             acct.name,
        org:              acct.org?.name || acct.org?.domain || 'Unknown Bank',
        balance:          parseFloat(acct.balance) || 0,
        availableBalance: parseFloat(acct['available-balance']) || 0,
        balanceDate:      new Date((acct['balance-date'] || 0) * 1000).toISOString(),
        currency:         acct.currency || 'USD',
        source:           'simplefin'
      });

      (acct.transactions || []).forEach(txn => {
        freshTxns.push({
          id:          'sf_' + txn.id,
          date:        new Date((txn.posted || 0) * 1000).toISOString().split('T')[0],
          description: txn.description || txn.payee || 'Unknown',
          amount:      parseFloat(txn.amount) || 0,
          account:     acct.name,
          accountId:   acct.id,
          category:    'Other',
          reviewed:    false,
          source:      'simplefin',
          memo:        txn.memo || '',
          pending:     false
        });
      });
    });

    // ── Merge into existing state ─────────────────────────────
    const { data: stateRow } = await sb
      .from('user_state')
      .select('state')
      .eq('user_id', user.id)
      .maybeSingle();

    const existing = stateRow?.state || {};
    const existingTxnIds = new Set((existing.transactions || []).map(t => t.id));

    // Only append truly new transactions
    const newTxns = freshTxns.filter(t => !existingTxnIds.has(t.id));

    // Upsert accounts by id
    const mergedAccounts = [...(existing.accounts || [])];
    freshAccounts.forEach(fa => {
      const idx = mergedAccounts.findIndex(a => a.id === fa.id);
      if (idx >= 0) mergedAccounts[idx] = { ...mergedAccounts[idx], ...fa };
      else mergedAccounts.push(fa);
    });

    const updatedState = {
      ...existing,
      accounts:     mergedAccounts,
      transactions: [...(existing.transactions || []), ...newTxns]
    };

    await sb.from('user_state').upsert(
      { user_id: user.id, state: updatedState, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );

    // Update last_synced
    await sb.from('simplefin_config').upsert(
      { user_id: user.id, access_url: accessUrl, last_synced: new Date().toISOString() },
      { onConflict: 'user_id' }
    );

    return res.status(200).json({
      success:        true,
      newTransactions: newTxns.length,
      accounts:       freshAccounts.length,
      transactions:   newTxns      // so client can do a toast
    });

  } catch (err) {
    console.error('[sync]', err);
    return res.status(500).json({ error: err.message });
  }
};
