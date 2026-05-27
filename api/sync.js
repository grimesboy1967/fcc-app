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
        error: `Missing Vercel env vars: ${missing.join(', ')}`
      });
    }

    // ── Auth ─────────────────────────────────────────────────
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

    const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SB_KEY }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid auth token' });
    const { id: userId } = await userRes.json();

    // ── Supabase REST helpers ─────────────────────────────────
    const hdrs = {
      Authorization:  `Bearer ${token}`,
      apikey:          SB_KEY,
      'Content-Type': 'application/json'
    };

    // SELECT — returns first matching row or null
    async function sbSelect(table, filter) {
      const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}&select=*`, { headers: hdrs });
      if (!r.ok) return null;
      const rows = await r.json();
      return Array.isArray(rows) ? rows[0] || null : null;
    }

    // INSERT — creates a new row
    async function sbInsert(table, data) {
      const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
        method:  'POST',
        headers: { ...hdrs, Prefer: 'return=minimal' },
        body:    JSON.stringify(data)
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Supabase insert ${table} failed (${r.status}): ${t.slice(0, 200)}`);
      }
    }

    // PATCH — updates existing rows matching filter
    async function sbPatch(table, filter, data) {
      const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
        method:  'PATCH',
        headers: { ...hdrs, Prefer: 'return=minimal' },
        body:    JSON.stringify(data)
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Supabase patch ${table} failed (${r.status}): ${t.slice(0, 200)}`);
      }
    }

    // ── Get or claim SimpleFIN access URL ─────────────────────
    const sfRow     = await sbSelect('simplefin_config', `user_id=eq.${userId}`);
    let accessUrl   = sfRow?.access_url;

    if (!accessUrl) {
      const claimRes  = await fetch(SF_CLAIM, { method: 'POST' });
      const claimBody = await claimRes.text();

      if (!claimRes.ok) {
        return res.status(400).json({
          error: `SimpleFIN claim failed (HTTP ${claimRes.status}). The one-time token may already be used.`,
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

      // First time — INSERT the config row
      await sbInsert('simplefin_config', {
        user_id: userId, access_url: accessUrl, last_synced: null
      });
    }

    // ── Determine start date ──────────────────────────────────
    const startEpoch = sfRow?.last_synced
      ? Math.floor(new Date(sfRow.last_synced).getTime() / 1000)
      : Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);

    // ── Fetch from SimpleFIN (credentials via Basic auth) ─────
    const credMatch = accessUrl.match(/^(https?:\/\/)([^:@\s]+):([^@\s]+)@(.+)$/);
    let sfFetchUrl, sfAuthHeader;
    if (credMatch) {
      const [, scheme, user, pass, hostPath] = credMatch;
      sfFetchUrl   = (scheme + hostPath).replace(/\/$/, '') + `/accounts?start-date=${startEpoch}`;
      sfAuthHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    } else {
      sfFetchUrl   = accessUrl.replace(/\/$/, '') + `/accounts?start-date=${startEpoch}`;
      sfAuthHeader = null;
    }

    const sfRes = await fetch(sfFetchUrl, sfAuthHeader ? { headers: { Authorization: sfAuthHeader } } : {});
    const sfTxt = await sfRes.text();

    if (!sfRes.ok) {
      return res.status(502).json({
        error: `SimpleFIN fetch failed (HTTP ${sfRes.status}).`,
        detail: sfTxt.slice(0, 400)
      });
    }

    let sfData;
    try   { sfData = JSON.parse(sfTxt); }
    catch { return res.status(502).json({ error: 'SimpleFIN returned non-JSON.', detail: sfTxt.slice(0, 200) }); }

    // Warnings (e.g. date range capped) are non-fatal
    if (sfData.errors?.length) console.warn('[sync] SimpleFIN warnings:', sfData.errors);

    // ── Transform accounts + transactions ──────────────────────
    const freshAccounts = [];
    const freshTxns     = [];

    (sfData.accounts || []).forEach(acct => {
      // Infer account type from name (SimpleFIN doesn't expose a type field)
      const n = (acct.name || '').toLowerCase();
      const sfType =
        n.includes('sav')                                          ? 'savings'     :
        n.includes('credit') || n.includes('card')                ? 'credit_card' :
        n.includes('invest') || n.includes('brokerage') ||
          n.includes('ira')  || n.includes('401k')                ? 'investment'  :
        n.includes('loan')   || n.includes('mortgage')            ? 'loan'        :
                                                                     'checking';   // default

      freshAccounts.push({
        id:               acct.id,
        name:             acct.name,
        org:              acct.org?.name || acct.org?.domain || 'Unknown Bank',
        type:             sfType,
        balance:          parseFloat(acct.balance) || 0,
        availableBalance: parseFloat(acct['available-balance']) ?? parseFloat(acct.balance) ?? 0,
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

    const updatedState = {
      ...existing,
      accounts:     mergedAccounts,
      transactions: [...(existing.transactions || []), ...newTxns]
    };

    // Use PATCH if row exists, INSERT if new — avoids upsert conflict issues
    if (stateRow) {
      await sbPatch('user_state', `user_id=eq.${userId}`, {
        state: updatedState, updated_at: new Date().toISOString()
      });
    } else {
      await sbInsert('user_state', {
        user_id: userId, state: updatedState, updated_at: new Date().toISOString()
      });
    }

    // Update last_synced on simplefin_config
    await sbPatch('simplefin_config', `user_id=eq.${userId}`, {
      access_url: accessUrl, last_synced: new Date().toISOString()
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
