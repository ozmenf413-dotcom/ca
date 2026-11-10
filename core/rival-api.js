/**
 * Rakip endpoint köprüsü — TÜM çağrılar kuponstore.com proxy üzerinden.
 * extension-notices kullanılmaz.
 *
 * Proxy: https://kuponstore.com/api/extension/yemeksepeti/rivalProxy.php
 */
'use strict';

const RivalAPI = (() => {
  const PROXY = 'https://kuponstore.com/api/extension/yemeksepeti/rivalProxy.php';
  // Kendi auth mantığımız (rakip şema, kendi DB + gerekirse tek sefer import)
  const EXT_LOGIN = 'https://kuponstore.com/api/extension/yemeksepeti/extLogin.php';

  function extractTokenTag(token) {
    if (!token || typeof token !== 'string') return null;
    const m = token.trim().match(/^([A-Za-z]+)-/);
    return m ? m[1].toUpperCase() : null;
  }

  function isRivalTaggedToken(token) {
    return !!extractTokenTag(token);
  }

  function resolveHiddenVouchersForTag(tag, hiddenByTag) {
    if (!tag || !hiddenByTag || typeof hiddenByTag !== 'object') {
      return { codes: [], keywords: [], hideAddVoucher: false };
    }
    const entry = hiddenByTag[tag] || hiddenByTag[tag.toLowerCase()] || hiddenByTag[tag.toUpperCase()] || {};
    const codes = Array.isArray(entry.codes)
      ? entry.codes.map((c) => String(c).trim().toLowerCase()).filter(Boolean)
      : [];
    const keywords = Array.isArray(entry.keywords)
      ? entry.keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean)
      : [];
    return { codes: [...new Set(codes)], keywords: [...new Set(keywords)], hideAddVoucher: false };
  }

  async function proxyCall(op, params) {
    const body = Object.assign({ op }, params || {});
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(PROXY, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          cache: 'no-store',
          body: JSON.stringify(body)
        });
        const text = await r.text();
        let j = null;
        try { j = JSON.parse(text); } catch (_) {}
        if (!j) {
          lastErr = new Error('rivalProxy JSON değil HTTP ' + r.status + ': ' + String(text).slice(0, 120));
          await new Promise((r) => setTimeout(r, 400 * (i + 1)));
          continue;
        }
        j._http = r.status;
        return j;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw lastErr || new Error('rivalProxy ulaşılamadı');
  }

  async function fetchVersionCheck(version) {
    const v = version || (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest
      ? chrome.runtime.getManifest().version
      : '1.2.0');
    const j = await proxyCall('version-check', { v });
    if (!j.success) throw new Error((j.error) || 'version-check fail');
    return j.data || {};
  }

  async function applyHiddenVoucherRules(token, serverData) {
    const hiddenByTag = (serverData && serverData.hidden_vouchers_by_tag) || {};
    const tag = extractTokenTag(token);
    const resolved = resolveHiddenVouchersForTag(tag, hiddenByTag);
    await chrome.storage.local.set({
      hidden_vouchers_by_tag: hiddenByTag,
      active_token_tag: tag || '',
      active_hidden_voucher_codes: resolved.codes,
      active_hidden_voucher_keywords: resolved.keywords,
      active_hide_add_voucher_button: false,
      hidden_vouchers_updated_at: Date.now()
    });
    return { tag, ...resolved };
  }

  async function fetchCookieSource(token) {
    const j = await proxyCall('cookie-source', { token });
    return (j && j.data) || { status: false };
  }

  async function fetchAuth(token) {
    const clean = String(token || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    let j = null;
    let lastMsg = 'Auth başarısız';

    // Kendi extLogin (DB önce, yoksa tek sefer import)
    try {
      const gu = EXT_LOGIN + '?token=' + encodeURIComponent(clean);
      const gr = await fetch(gu, { method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' } });
      const gt = await gr.text();
      try { j = JSON.parse(gt); } catch (_) { j = null; }
      if (j && (j.success || j.status) && Array.isArray(j.data) && j.data.length) {
        // Cookie value string garanti
        const data = j.data.map((c) => ({
          name: String((c && (c.name || c.Name)) || ''),
          value: String((c && (c.value != null ? c.value : c.Value)) || ''),
          domain: (c && c.domain) || '.yemeksepeti.com',
          path: (c && c.path) || '/',
          secure: true
        })).filter((c) => c.name && c.value);
        return {
          status: true,
          data,
          headers_data: j.headers_data || null,
          device_data: j.device_data || null,
          email: j.email || '',
          source: j.source || 'kuponstore-extLogin',
          imported: !!j.imported
        };
      }
      if (j) lastMsg = j.error || j.message || lastMsg;
    } catch (e) {
      lastMsg = e.message || lastMsg;
    }

    // Eski rivalProxy fallback
    try {
      const gu = PROXY + '?op=auth&token=' + encodeURIComponent(clean);
      const gr = await fetch(gu, { method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' } });
      const gt = await gr.text();
      try { j = JSON.parse(gt); } catch (_) { j = null; }
      if (j && j.success && Array.isArray(j.data) && j.data.length) {
        return {
          status: true,
          data: j.data,
          headers_data: j.headers_data || null,
          device_data: j.device_data || null,
          email: j.email || '',
          source: 'kuponstore-proxy-get'
        };
      }
      if (j) lastMsg = j.error || j._upstream_error || lastMsg;
    } catch (e) {
      lastMsg = e.message || lastMsg;
    }

    throw new Error(lastMsg);
  }

  async function reverseGeocode(lat, lng) {
    const j = await proxyCall('geo', { geo: 'reverse', lat, lng });
    return (j && j.data) || j;
  }

  async function autocomplete(input) {
    const j = await proxyCall('geo', { geo: 'autocomplete', input });
    return (j && j.data) || j;
  }

  async function geocode(address) {
    const j = await proxyCall('geo', { geo: 'geocode', address });
    return (j && j.data) || j;
  }

  async function placeDetails(placeId) {
    const j = await proxyCall('geo', { geo: 'placedetails', place_id: placeId });
    return (j && j.data) || j;
  }

  async function fetchCities() {
    const j = await proxyCall('cities', {});
    return (j && j.data) || j;
  }

  async function fetchDistricts(city) {
    const j = await proxyCall('districts', { city });
    return (j && j.data) || j;
  }

  return {
    PROXY,
    extractTokenTag,
    isRivalTaggedToken,
    fetchVersionCheck,
    applyHiddenVoucherRules,
    fetchCookieSource,
    fetchAuth,
    reverseGeocode,
    autocomplete,
    geocode,
    placeDetails,
    fetchCities,
    fetchDistricts
  };
})();

if (typeof self !== 'undefined') self.RivalAPI = RivalAPI;
if (typeof globalThis !== 'undefined') globalThis.RivalAPI = RivalAPI;
