/**
 * POST /api/sync  — zero npm dependencies, native fetch only
 * Fetches transactions from SimpleFIN Bridge → merges into Supabase state.
 * Authorization: Bearer <supabase-jwt>
 */

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  try {
    if (req.method === 'OPTIONS') return res.status(200).end();

    // ── Required env vars ────────────────────────────────────
    const SB_URL   = process.env.SUPABASE_URL;
    const SB_KEY   = process.env.SUPABASE_ANON_KEY;
    const SF_CLAIM = process.env.SIMPLEFIN_CLAIM_URL;

    const missing = [
      !SB_URL   && 'SUPABASE_URL',
      !SB_KEY   && 'SUPABASE_ANON_KEY',
      !SF_CLAIM && 'SIMPLEFIN_CLAIM_URL'
    ].filter(Boolean);

    if (missing.length) {
      return res.status(500).json({
        error: `Missing Vercel environment variables: ${missing.join(', ')}. ` +
               'Go to Vercel → Project Settings → Environment Variables, add them, then redeploy.'
      });
    }

    // ── Auth ─────────────────────────────────────────────────
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

    // Verify JWT via Supabase Auth REST API
    const userRes  = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SB_KEY }
    });
    if (!userRes.ok) {
      const body = await userRes.text();
      return res.status(401).json({ error: 'Invalid auth token', detail: body.slice(0, 200) });
    }
    const { id: userId } = await userRes.json();

    // ── Supabase REST helpers (no SDK needed) ─────────────────
    const hdrs = {
      Authorization:  `Bearer ${token}`,
      apikey:          SB_KEY,
      'Content-Type': 'application/json'
    };

    async function sbSelect(table, filter) {
      const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}&select=*`, { headers: hdrs });
      if (!r.ok) return null;
      const rows = await r.json();
      return Array.isArray(rows) ? rows[0] || null : null;
    }

    async function sbUpsert(table, data) {
      const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
        method:  'POST',
        headers: { ...hdrs, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body:    JSON.stringify(data)
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Supabase upsert ${table} failed (${r.status}): ${t.slice(0, 200)}`);
      }
    }

    // ── Get or claim SimpleFIN access URL ─────────────────────
    let sfRow     = await sbSelect('simplefin_config', `user_id=eq.${userId}`);
    let accessUrl = sfRow?.access_url;

    if (!accessUrl) {
      const claimRes  = await fetch(SF_CLAIM, { method: 'POST' });
      const claimBody = await claimRes.text();

      if (!claimRes.ok) {
        return res.status(400).json({
          error: `SimpleFIN claim failed (HTTP ${claimRes.status}). ` +
                 'The one-time token may already be used. Buy a new one at simplefin.org.',
          detail: claimBody.slice(0, 300)
        });
      }

      accessUrl = claimBody.trim();
      if (!accessUrl.startsWith('http')) {
        return res.status(400).json({
          error: 'SimpleFIN returned unexpected response (not a URL).',
          detail: accessUrl.slice(0, 200)
        });
      }

      await sbUpsert('simplefin_config', {
        user_id: userId, access_url: accessUrl, last_synced: null
      });
    }

    // ── Fetch accounts + transactions from SimpleFIN ───────────
    const startEpoch = sfRow?.last_synced
      ? Math.floor(new Date(sfRow.last_synced).getTime() / 1000)
      : Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000); // 90-day default

    // Node 18 fetch rejects URLs with embedded credentials (https://user:pass@host).
    // Use regex to extract credentials and build a clean URL, then send Basic auth header.
    let sfFetchUrl, sfAuthHeader;
    const credMatch = accessUrl.match(/^(https?:\/\/)([^:@\s]+):([^@\s]+)@(.+)$/);
    if (credMatch) {
      const [, scheme, user, pass, hostPath] = credMatch;
      sfFetchUrl  = (scheme + hostPath).replace(/\/$/, '') + `/accounts?start-date=${startEpoch}`;
      sfAuthHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    } else {
      // No credentials in URL — use as-is
      sfFetchUrl  = accessUrl.replace(/\/$/, '') + `/accounts?start-date=${startEpoch}`;
      sfAuthHeader = null;
    }

    const sfRes = await fetch(sfFetchUrl, sfAuthHeader ? { headers: { Authorization: sfAuthHeader } } : {});
    const sfTxt = await sfRes.text();

    if (!sfRes.ok) {
      return res.status(502).json({
        error: `SimpleFIN accounts fetch failed (HTTP ${sfRes.status}).`,
        detail: sfTxt.slice(0, 400)
      });
    }

    let sfData;
    try   { sfData = JSON.parse(sfTxt); }
    catch { return res.status(502).json({ error: 'SimpleFIN returned non-JSON.', detail: sfTxt.slice(0, 200) }); }

    // Log SimpleFIN warnings but don't abort — they're informational (e.g. date range capped)
    if (sfData.errors?.length) {
      console.warn('[sync] SimpleFIN warnings:', sfData.errors);
    }

    // ── Transform ─────────────────────────────────────────────
    const freshAccounts = [];
    const freshTxns     = [];

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

    // ── Merge into Supabase state ─────────────────────────────
    const stateRow = await sbSelect('user_state', `user_id=eq.${userId}`);
    const existing = stateRow?.state || {};
    const knownIds = new Set((existing.transactions || []).map(t => t.id));
    const newTxns  = freshTxns.filter(t => !knownIds.has(t.id));

    const mergedAccounts = [...(existing.accounts || [])];
    freshAccounts.forEach(fa => {
      const i = mergedAccounts.findIndex(a => a.id === fa.id);
      if (i >= 0) mergedAccounts[i] = { ...mergedAccounts[i], ...fa };
      else mergedAccounts.push(fa);
    });

    await sbUpsert('user_state', {
      user_id:    userId,
      state:      { ...existing, accounts: mergedAccounts, transactions: [...(existing.transactions || []), ...newTxns] },
      updated_at: new Date().toISOString()
    });

    await sbUpsert('simplefin_config', {
      user_id:     userId,
      access_url:  accessUrl,
      last_synced: new Date().toISOString()
    });

    return res.status(200).json({
      success:         true,
      newTransactions: newTxns.length,
      accounts:        freshAccounts.length,
      transactions:    newTxns
    });

  } catch (err) {
    console.error('[sync]', err);
    return res.status(500).json({ error: err.message });
  }
};
