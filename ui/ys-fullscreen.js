/* ============================================================
 * KuponStore YS — Fullscreen UI script
 *
 * Sorumluluk:
 *   • Token girişi (LOGIN_WITH_TOKEN mesajı → background.js)
 *   • Durum paneli (oturum, kalan süre, sunucu, adres)
 *   • Adres listesi (chrome.storage.local → "kuponstore_addresses")
 *   • Token geçmişi (GET_TOKEN_HISTORY)
 *   • Hızlı eylemler (yenile, temizle, Yemeksepeti'ni aç, sekmeleri kapat)
 *
 * Önemli: yemekhub_session şeması rakip ile birebir aynı tutulur,
 *         çünkü inject.js ve background.js aynı alan isimlerini okuyor.
 * ============================================================ */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // Mobilde sayfa kaydırması kilitlenmesin (adres modalı vs. artıkları temizle)
  function unlockPageScroll() {
    try {
      const html = document.documentElement;
      const body = document.body;
      html.style.removeProperty('overflow');
      html.style.overflowY = 'scroll';
      body.style.removeProperty('overflow');
      body.style.removeProperty('position');
      body.style.removeProperty('top');
      body.style.removeProperty('width');
      body.style.removeProperty('height');
      body.style.removeProperty('touch-action');
      body.style.height = 'auto';
      body.style.overflow = 'visible';
      body.style.position = 'static';
      delete body.dataset.ksScrollY;
    } catch (_) {}
  }
  unlockPageScroll();
  window.addEventListener('pageshow', unlockPageScroll);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) unlockPageScroll();
  });

  const SERVER = 'https://kuponstore.com/api/extension/yemeksepeti';
  const APP_VER = chrome.runtime.getManifest().version;

  // ---------- Yardımcılar ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function toast(kind, title, text, ttl = 4200) {
    const wrap = $('#toastWrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    const icon = { ok: 'check_circle', err: 'error', info: 'info', warn: 'warning' }[kind] || 'info';
    el.innerHTML = `
      <span class="material-symbols-rounded">${icon}</span>
      <div class="toast-body">
        <div class="toast-title">${escapeHtml(title)}</div>
        ${text ? `<div class="toast-text">${escapeHtml(text)}</div>` : ''}
      </div>
    `;
    wrap.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; }, ttl - 300);
    setTimeout(() => el.remove(), ttl);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function jwtPayload(tok) {
    if (!tok || typeof tok !== 'string') return null;
    const parts = tok.split('.');
    if (parts.length < 2) return null;
    try {
      let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      p += '='.repeat((4 - (p.length % 4)) % 4);
      return JSON.parse(atob(p));
    } catch (_) { return null; }
  }

  function jwtClient(tok) {
    const p = jwtPayload(tok);
    return p && (p.client_id || p.scope) || '';
  }

  function jwtRemaining(tok) {
    const p = jwtPayload(tok);
    if (!p) return -1;
    let exp = Number(p.exp || p.expires || 0);
    if (exp > 1e12) exp = Math.floor(exp / 1000);
    if (!exp) return -1;
    return exp - Math.floor(Date.now() / 1000);
  }

  function fmtRemaining(sec) {
    if (sec < 0) return 'süresiz / okunamadı';
    if (sec < 60) return `${sec}sn`;
    if (sec < 3600) return `${Math.floor(sec / 60)}dk ${sec % 60}sn`;
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return `${h}sa ${m}dk`;
  }

  function msg(obj) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(obj, (resp) => {
          if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { success: false, error: 'no_response' });
        });
      } catch (e) { resolve({ success: false, error: e.message }); }
    });
  }

  function storageGet(keys) {
    return new Promise((r) => chrome.storage.local.get(keys, (d) => r(d || {})));
  }
  function storageSet(obj) {
    return new Promise((r) => chrome.storage.local.set(obj, () => r()));
  }
  function syncGet(keys) {
    return new Promise((r) => chrome.storage.sync.get(keys, (d) => r(d || {})));
  }
  function syncSet(obj) {
    return new Promise((r) => chrome.storage.sync.set(obj, () => r()));
  }

  // ---------- Tema ----------
  const themeBtn = $('#themeToggle');
  const themeIcon = $('#themeIcon');
  function applyTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    themeIcon.textContent = t === 'light' ? 'light_mode' : 'dark_mode';
    try { localStorage.setItem('ks-theme', t); } catch (_) {}
  }
  themeBtn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'light' ? 'dark' : 'light');
  });
  try { applyTheme(localStorage.getItem('ks-theme') || 'dark'); } catch (_) { applyTheme('dark'); }

  // ---------- Versiyon ----------
  $('#appVer').textContent = APP_VER;

  // ---------- IP + sunucu ----------
  async function updateIp() {
    const pill = $('#ipPill'), txt = $('#ipText');
    try {
      const r = await fetch('https://api.ipify.org/?format=json', { cache: 'no-store' });
      const j = await r.json();
      txt.textContent = 'IP ' + (j.ip || '?');
      pill.classList.remove('err');
    } catch (_) {
      txt.textContent = 'IP alınamadı';
      pill.classList.add('err');
    }
  }
  updateIp();

  async function pingServer() {
    const el = $('#statServerV'), card = $('#statServer');
    try {
      const t0 = performance.now();
      const r = await fetch(SERVER + '/extCheck.php', { cache: 'no-store' });
      const dt = Math.round(performance.now() - t0);
      if (r.ok) {
        el.textContent = `Çevrimiçi · ${dt}ms`;
        card.classList.add('ok'); card.classList.remove('err');
      } else {
        el.textContent = 'HTTP ' + r.status;
        card.classList.add('err'); card.classList.remove('ok');
      }
    } catch (_) {
      el.textContent = 'Çevrimdışı';
      card.classList.add('err'); card.classList.remove('ok');
    }
  }
  pingServer();
  setInterval(pingServer, 60_000);

  // ---------- Oturum durumu ----------
  async function readSession() {
    const st = await syncGet(['yemekhub_session']);
    return st.yemekhub_session || null;
  }

  async function updateStatus() {
    const sess = await readSession();
    const scLogin = $('#statLoginV'), scLoginCard = $('#statLogin');
    const scExp = $('#statExpiryV'), scExpCard = $('#statExpiry');
    const scAddr = $('#statAddrV'), scAddrCard = $('#statAddr');

    if (!sess || !sess.isLogged || !sess.token) {
      scLogin.textContent = 'Oturum yok';
      scLoginCard.classList.remove('ok', 'warn', 'err');
      scExp.textContent = '—';
      scExpCard.classList.remove('ok', 'warn', 'err');
    } else {
      const shortDisp = sess.token.slice(0, 10) + '…';
      scLogin.textContent = 'Bağlı · ' + shortDisp;
      scLoginCard.classList.add('ok'); scLoginCard.classList.remove('warn', 'err');

      // Çerez üzerinden en güncel android token kalan süresi
      let bestLeft = -1;
      try {
        const ck = await new Promise((r) => chrome.cookies.get({ url: 'https://www.yemeksepeti.com', name: 'access_token' }, r));
        if (ck && ck.value) {
          const left = jwtRemaining(ck.value);
          if (left > bestLeft) bestLeft = left;
        }
      } catch (_) {}
      if (bestLeft < 0 && Array.isArray(sess.cookies)) {
        for (const c of sess.cookies) {
          if (c.name !== 'access_token' && c.name !== 'android_token') continue;
          const left = jwtRemaining(c.value);
          if (left > bestLeft) bestLeft = left;
        }
      }
      if (bestLeft < 0) {
        scExp.textContent = 'Bilinmiyor';
        scExpCard.classList.remove('ok', 'warn', 'err');
      } else if (bestLeft < 120) {
        scExp.textContent = fmtRemaining(bestLeft);
        scExpCard.classList.add('err'); scExpCard.classList.remove('ok', 'warn');
      } else if (bestLeft < 600) {
        scExp.textContent = fmtRemaining(bestLeft);
        scExpCard.classList.add('warn'); scExpCard.classList.remove('ok', 'err');
      } else {
        scExp.textContent = fmtRemaining(bestLeft);
        scExpCard.classList.add('ok'); scExpCard.classList.remove('warn', 'err');
      }
    }

    const addr = sess && sess.selectedAddress;
    if (addr) {
      const label = addr.title || addr.name || addr.formatted_customer_address || `${addr.city || ''} ${addr.street || ''}`.trim();
      scAddr.textContent = label || 'Seçili';
      scAddrCard.classList.add('ok'); scAddrCard.classList.remove('warn', 'err');
    } else {
      scAddr.textContent = 'Seçili değil';
      scAddrCard.classList.remove('ok', 'warn', 'err');
    }
  }
  updateStatus();
  setInterval(updateStatus, 15_000);

  // ---------- Adresler ----------
  function addressLabel(a) {
    return a.title || a.name || a.formatted_customer_address ||
      [a.street, a.areas, a.neighborhood, a.city].filter(Boolean).join(', ') || 'Adres';
  }
  function addressLine(a) {
    const parts = [a.areas || a.neighborhood, a.street, a.building, a.city].filter(Boolean);
    return parts.join(', ');
  }
  function addressId(a) { return a.place_id || a.form_id || a.id; }

  async function readAddresses() {
    const st = await storageGet(['kuponstore_addresses', 'savedAddresses', 'addresses', 'kuponstore_active_address']);
    const list = (Array.isArray(st.kuponstore_addresses) && st.kuponstore_addresses) ||
                 (Array.isArray(st.savedAddresses) && st.savedAddresses) ||
                 (Array.isArray(st.addresses) && st.addresses) || [];
    return { list, active: st.kuponstore_active_address || null };
  }

  async function renderAddresses() {
    const { list, active } = await readAddresses();
    const host = $('#addressList'), sel = $('#addrSelect');
    sel.innerHTML = '<option value="">Seçili adres yok</option>';
    if (!list.length) {
      host.innerHTML = '<div class="empty">Henüz kayıtlı adresiniz yok.</div>';
      return;
    }
    host.innerHTML = '';
    for (const a of list) {
      const id = addressId(a);
      const isActive = (id && id === active) || (!active && a.isDefault);
      const row = document.createElement('div');
      row.className = 'addr-item' + (isActive ? ' active' : '');
      row.innerHTML = `
        <span class="addr-ic"><span class="material-symbols-rounded">pin_drop</span></span>
        <div class="addr-body">
          <div class="addr-title">
            ${escapeHtml(addressLabel(a))}
            ${isActive ? '<span class="default-badge">Seçili</span>' : ''}
          </div>
          <div class="addr-line">${escapeHtml(addressLine(a))}</div>
        </div>
        <div class="addr-actions">
          <button class="icon-btn" data-act="pick" title="Varsayılan yap"><span class="material-symbols-rounded">radio_button_checked</span></button>
          <button class="icon-btn" data-act="del" title="Sil"><span class="material-symbols-rounded">delete</span></button>
        </div>
      `;
      row.querySelector('[data-act="pick"]').addEventListener('click', async () => {
        await storageSet({ kuponstore_active_address: id });
        toast('ok', 'Varsayılan adres güncellendi', addressLabel(a));
        renderAddresses();
        updateStatus();
      });
      row.querySelector('[data-act="del"]').addEventListener('click', async () => {
        if (!confirm(`"${addressLabel(a)}" adresini sil?`)) return;
        const next = list.filter((x) => addressId(x) !== id);
        await storageSet({ kuponstore_addresses: next });
        toast('info', 'Adres silindi');
        renderAddresses();
        updateStatus();
      });
      host.appendChild(row);

      const opt = document.createElement('option');
      opt.value = id || '';
      opt.textContent = addressLabel(a);
      if (isActive) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  renderAddresses();

  $('#addrSelect').addEventListener('change', async (e) => {
    const v = e.target.value || null;
    await storageSet({ kuponstore_active_address: v });
    renderAddresses();
    updateStatus();
  });

  $('#addAddressBtn').addEventListener('click', () => {
    if (typeof window.KS_OpenAddressModal === 'function') {
      window.KS_OpenAddressModal({
        onSave: async (addr) => {
          const { list } = await readAddresses();
          const next = Array.isArray(list) ? list.slice() : [];
          if (!addr.id && !addr.place_id && !addr.form_id) addr.id = String(Date.now());
          next.unshift(addr);
          await storageSet({ kuponstore_addresses: next, kuponstore_active_address: addressId(addr) });
          toast('ok', 'Yeni adres eklendi');
          renderAddresses();
          updateStatus();
        }
      });
    } else {
      toast('warn', 'Adres ekleme modülü yüklenemedi', 'Lütfen eklentiyi yeniden yükleyin.');
    }
  });

  // ---------- Token geçmişi ----------
  async function renderTokenHistory() {
    const resp = await msg({ action: 'YS_GET_TOKEN_HISTORY' });
    const host = $('#tokenHistory');
    const list = (resp && resp.tokens) || [];
    if (!list.length) {
      host.innerHTML = '<div class="empty">Henüz token kullanmadınız.</div>';
      return;
    }
    host.innerHTML = '';
    for (const item of list.slice(0, 6)) {
      const tok = typeof item === 'string' ? item : (item.token || item.value || '');
      const ts = (item && item.timestamp) || (item && item.ts) || null;
      if (!tok) continue;
      const row = document.createElement('div');
      row.className = 'token-item';
      row.innerHTML = `
        <span class="material-symbols-rounded">history</span>
        <span class="ti-token">${escapeHtml(tok)}</span>
        <span class="ti-time">${ts ? new Date(ts).toLocaleString('tr-TR') : ''}</span>
      `;
      row.addEventListener('click', () => {
        $('#tokenInput').value = tok;
        $('#tokenInput').focus();
        toast('info', 'Token yüklendi', tok.slice(0, 18) + '…');
      });
      host.appendChild(row);
    }
  }
  renderTokenHistory();

  // ---------- URL'den token ön-doldurma (ana panelden yönlendirme) ----------
  try {
    const _urlTok = new URLSearchParams(location.search).get('token');
    if (_urlTok && /^ys-/i.test(_urlTok.trim())) {
      $('#tokenInput').value = _urlTok.trim();
    }
  } catch (_) {}

  // ---------- Panodan yapıştır ----------
  $('#pasteBtn').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t && t.trim()) {
        $('#tokenInput').value = t.trim();
        toast('ok', 'Panodan yapıştırıldı');
      }
    } catch (e) {
      toast('err', 'Pano okunamadı', 'Chrome izni gerekebilir.');
    }
  });

  // ---------- Overlay yönetimi ----------
  const overlay = {
    el: $('#overlay'),
    spin: $('#ovSpinner'),
    icon: $('#ovIcon'),
    title: $('#ovTitle'),
    text: $('#ovText'),
    steps: $('#ovSteps'),
    close: $('#ovClose'),
    _etaTimer: null,

    open(title, text) {
      this.stopEta();
      this.el.classList.remove('hidden');
      this.spin.style.display = 'block';
      this.icon.className = 'overlay-icon';
      this.icon.innerHTML = '';
      this.title.textContent = title || 'İşleniyor…';
      this.text.textContent = text || '';
      this.close.classList.add('hidden');
      $$('.overlay-steps li').forEach((li) => { li.classList.remove('active', 'done'); });
    },
    /** Tahmini süre — kullanıcılar sayfayı kapatmasın */
    startEta(estimateSec = 120) {
      this.stopEta();
      const started = Date.now();
      const fmt = (s) => {
        const m = Math.floor(s / 60);
        const r = s % 60;
        return m > 0 ? `${m} dk ${String(r).padStart(2, '0')} sn` : `${r} sn`;
      };
      const tick = () => {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        const left = Math.max(0, estimateSec - elapsed);
        if (left > 0) {
          this.text.textContent =
            `Tahmini kalan süre: ~${fmt(left)} · Lütfen bu sayfayı kapatmayın.`;
        } else {
          this.text.textContent =
            `Biraz daha sürebilir (OTP / sunucu) · Geçen: ${fmt(elapsed)} · Sayfayı kapatmayın.`;
        }
      };
      tick();
      this._etaTimer = setInterval(tick, 1000);
    },
    stopEta() {
      if (this._etaTimer) {
        clearInterval(this._etaTimer);
        this._etaTimer = null;
      }
    },
    step(name, status) {
      // status: 'active' | 'done'
      $$('.overlay-steps li').forEach((li) => {
        if (li.dataset.step === name) {
          li.classList.remove('active', 'done');
          li.classList.add(status);
        }
      });
    },
    finishOk(title, text) {
      this.stopEta();
      this.spin.style.display = 'none';
      this.icon.className = 'overlay-icon ok show';
      this.icon.innerHTML = '<span class="material-symbols-rounded">check_circle</span>';
      this.title.textContent = title;
      this.text.textContent = text || '';
      this.close.classList.remove('hidden');
    },
    finishErr(title, text) {
      this.stopEta();
      this.spin.style.display = 'none';
      this.icon.className = 'overlay-icon err show';
      this.icon.innerHTML = '<span class="material-symbols-rounded">error</span>';
      this.title.textContent = title;
      this.text.textContent = text || '';
      this.close.classList.remove('hidden');
    },
    hide() {
      this.stopEta();
      this.el.classList.add('hidden');
    },
  };
  $('#ovClose').addEventListener('click', () => overlay.hide());

  // ---------- Giriş ----------
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = ($('#tokenInput').value || '').trim();
    if (!token) { toast('warn', 'Token gerekli'); return; }
    // Yalnızca ys- token
    if (!/^ys-[A-Za-z0-9]+$/i.test(token)) {
      toast('warn', 'Token biçimi geçersiz', 'Yalnızca ys-… token desteklenir');
      return;
    }

    const btn = $('#loginBtn');
    btn.disabled = true;

    const autoAddr = $('#autoAddrCheck').checked;
    const selId = $('#addrSelect').value || null;
    if (selId) await storageSet({ kuponstore_active_address: selId });

    overlay.open('Giriş hazırlanıyor', 'Tahmini süre hesaplanıyor… Sayfayı kapatmayın.');
    overlay.step('refresh', 'active');
    // OTP / sunucu yenileme genelde 1–3 dk
    overlay.startEta(120);

    const resp = await msg({
      action: 'YS_UI_LOGIN',
      data: { token, autoAddress: autoAddr, force: true },
    });

    if (!resp || !resp.success) {
      const err = (resp && resp.error) || 'Bilinmeyen hata';
      // Hangi adımda kaldığını göster
      if (resp && resp.hasAndroid === false) {
        overlay.step('refresh', 'active');
      } else if (resp && resp.webLogin === false) {
        overlay.step('refresh', 'done');
        overlay.step('cookies', 'done');
        overlay.step('session', 'active');
      }
      overlay.finishErr('Giriş iptal', err);
      toast('err', 'Giriş iptal', err);
      btn.disabled = false;
      return;
    }

    overlay.step('refresh', 'done');
    overlay.step('cookies', 'done');
    overlay.step('session', 'done');
    overlay.step('redirect', 'done');

    // Token geçmişine ekle
    try {
      const h = await storageGet(['kuponstore_token_history']);
      const arr = Array.isArray(h.kuponstore_token_history) ? h.kuponstore_token_history : [];
      const next = [{ token, timestamp: Date.now() }, ...arr.filter((x) => (x.token || x) !== token)].slice(0, 20);
      await storageSet({ kuponstore_token_history: next });
    } catch (_) {}
    renderTokenHistory();

    if (!resp.hasVolo || resp.webLogin === false) {
      overlay.finishErr('Giriş iptal', 'Volo yenilenmeden Yemeksepeti açılmaz.');
      toast('err', 'Giriş iptal', 'Volo / web oturumu yok');
      btn.disabled = false;
      return;
    }

    overlay.finishOk(
      'Giriş başarılı',
      'Yemeksepeti sekmesi açılıyor. Oturum hazır — bu paneli kapatabilirsiniz.'
    );
    toast('ok', 'Oturum açıldı', 'Yemeksepeti sekmesi açılıyor…');

    // Sadece gerçek Volo başarıda sekme aç
    const url = resp.url || 'https://www.yemeksepeti.com/restaurants/new/?vertical=restaurants';
    try { await chrome.tabs.create({ url, active: true }); } catch (_) {}

    btn.disabled = false;
    updateStatus();
  });

  // ---------- Hızlı eylemler ----------
  $('#openYsBtn').addEventListener('click', async () => {
    try {
      const sess = await readSession();
      const lat = sess?.selectedAddress?.latitude || 41.0082;
      const lng = sess?.selectedAddress?.longitude || 28.9784;
      await chrome.tabs.create({ url: `https://www.yemeksepeti.com/restaurants/new/?lat=${lat}&lng=${lng}&vertical=restaurants`, active: true });
    } catch (e) { toast('err', 'Sekme açılamadı', e.message); }
  });

  $('#closeYsBtn').addEventListener('click', async () => {
    const r = await msg({ action: 'closeYemeksepetiTabs' });
    toast(r && r.success ? 'ok' : 'warn', (r && r.success) ? 'Sekmeler kapatıldı' : 'İşlem tamamlandı');
  });

  $('#clearBtn').addEventListener('click', async () => {
    if (!confirm('Yemeksepeti çerez ve site verileri silinecek. Devam?')) return;
    const r = await msg({ action: 'clearSiteData' });
    toast(r && r.success ? 'ok' : 'warn', (r && r.success) ? 'Çerezler temizlendi' : 'Kısmi temizlik yapıldı');
    updateStatus();
  });

  $('#refreshNowBtn').addEventListener('click', async () => {
    const sess = await readSession();
    if (!sess || !sess.token) { toast('warn', 'Önce giriş yapın'); return; }
    overlay.open('Token yenileniyor', 'Tahmini süre hesaplanıyor… Sayfayı kapatmayın.');
    overlay.step('refresh', 'active');
    overlay.startEta(180);
    try {
      const r = await fetch(SERVER + '/preLoginRefresh.php?token=' + encodeURIComponent(sess.token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: sess.token, prelogin: 1, force: 1 }),
      });
      const j = await r.json().catch(() => null);
      if (j && j.pending === true) {
        const deadline = Date.now() + 300_000;
        while (Date.now() < deadline) {
          await sleep(4000);
          const rs = await fetch(SERVER + '/preLoginRefresh.php?token=' + encodeURIComponent(sess.token) + '&status=1', { cache: 'no-store' });
          const js = await rs.json().catch(() => null);
          if (js && js.pending === false) {
            overlay.step('refresh', 'done');
            overlay.step('cookies', 'active');
            // extAuth ile cookie yaz
            const ea = await fetch(SERVER + '/extAuth.php?token=' + encodeURIComponent(sess.token));
            const auth = await ea.json().catch(() => null);
            if (auth && auth.status) {
              await msg({ action: 'addCookiesFromPopup', cookies: auth.data || [] });
              overlay.step('cookies', 'done');
              overlay.finishOk('Token yenilendi', js.has_android ? 'Android oturum taze.' + (js.has_volo ? ' Volo oturum taze.' : ' Volo için site üzerinden giriş gerekebilir.') : 'Yenileme kısmen tamamlandı.');
              toast('ok', 'Token yenilendi');
              updateStatus();
              return;
            } else {
              overlay.finishErr('Çerez yazılamadı', 'extAuth başarısız');
              toast('err', 'Çerez yazılamadı');
              return;
            }
          }
        }
        overlay.finishErr('Zaman aşımı', 'Sunucu 5 dakika içinde yanıt vermedi.');
      } else if (j && j.success) {
        overlay.step('refresh', 'done');
        overlay.finishOk('Token zaten taze', 'Yeni oturum gerekmedi.');
      } else {
        overlay.finishErr('Yenileme başarısız', (j && (j.error || j.info)) || 'Sunucu hatası');
      }
    } catch (e) {
      overlay.finishErr('Hata', e.message);
    }
  });

  // ---------- Yenile tuşu ----------
  $('#reloadBtn').addEventListener('click', async () => {
    await Promise.all([updateIp(), pingServer(), renderAddresses(), renderTokenHistory(), updateStatus()]);
    toast('info', 'Panel yenilendi');
  });

  // ---------- Versiyon kontrolü (admin panel → ?app=ys) ----------
  const UPDATE_CHECK_URL = 'https://kuponstore.com/public-api/extension/version?app=ys';

  function isNewerVersion(local, remote) {
    const toArr = (v) => String(v || '').replace(/[^0-9.]/g, '').split('.').map(Number);
    const l = toArr(local), r = toArr(remote);
    for (let i = 0; i < Math.max(l.length, r.length); i++) {
      if ((r[i] || 0) > (l[i] || 0)) return true;
      if ((r[i] || 0) < (l[i] || 0)) return false;
    }
    return false;
  }

  function showUpdateBanner(info) {
    const banner = $('#updateBanner');
    const msg = $('#updateBannerMsg');
    const btn = $('#updateBannerBtn');
    const closeBtn = $('#updateBannerClose');
    if (!banner || !msg || !btn || !closeBtn) return;

    msg.textContent = info.message || `v${info.latestVersion} sürümü kullanılabilir.`;
    btn.href = info.downloadUrl || 'https://kuponstore.com/extension';
    banner.style.display = 'flex';
    requestAnimationFrame(() => banner.classList.add('visible'));

    closeBtn.onclick = () => {
      banner.classList.remove('visible');
      setTimeout(() => { banner.style.display = 'none'; }, 280);
    };
  }

  function showUpdateBlocker(info) {
    const blocker = $('#updateBlocker');
    const msg = $('#updateBlockerMsg');
    const btn = $('#updateBlockerBtn');
    const current = $('#updateBlockerCurrent');
    const latest = $('#updateBlockerLatest');
    const changelog = $('#updateBlockerChangelog');
    if (!blocker || !msg || !btn) return;

    msg.textContent = info.message || 'Bu YS eklenti sürümü artık desteklenmiyor. Devam etmek için güncelleyin.';
    btn.href = info.downloadUrl || 'https://kuponstore.com/extension';
    if (current) current.textContent = `v${info.currentVersion || APP_VER}`;
    if (latest) latest.textContent = `v${info.latestVersion}`;
    if (changelog) {
      const items = Array.isArray(info.changelog) ? info.changelog : [];
      changelog.innerHTML = items.map((c) => `<li>${escapeHtml(c)}</li>`).join('');
      changelog.style.display = items.length ? 'block' : 'none';
    }

    blocker.style.display = 'flex';
    requestAnimationFrame(() => blocker.classList.add('visible'));
  }

  async function checkUpdateStatus() {
    try {
      const res = await fetch(UPDATE_CHECK_URL, {
        method: 'GET',
        headers: {
          'X-Extension-Version': APP_VER,
          'X-Extension-App': 'ys',
        },
        cache: 'no-store',
      });

      if (res.ok) {
        const data = await res.json();
        if (data && data.latestVersion) {
          const hasUpdate = isNewerVersion(APP_VER, data.latestVersion);
          const isMandatory =
            data.type === 'mandatory' &&
            data.minRequiredVersion &&
            isNewerVersion(APP_VER, data.minRequiredVersion);

          const info = {
            hasUpdate,
            isMandatory,
            latestVersion: data.latestVersion,
            currentVersion: APP_VER,
            message: data.message || '',
            changelog: Array.isArray(data.changelog) ? data.changelog : [],
            downloadUrl: data.downloadUrl || 'https://kuponstore.com/extension',
            checkedAt: Date.now(),
          };

          await chrome.storage.local.set({ ks_ys_update_info: info });

          if (!hasUpdate) return;
          if (isMandatory) return showUpdateBlocker(info);
          return showUpdateBanner(info);
        }
      }
    } catch (e) {
      console.warn('[KuponStore YS] Live update check failed:', e && e.message ? e.message : e);
    }

    try {
      const result = await chrome.storage.local.get('ks_ys_update_info');
      const info = result.ks_ys_update_info;
      if (!info || !info.hasUpdate) return;
      if (info.isMandatory) showUpdateBlocker(info);
      else showUpdateBanner(info);
    } catch (_) {}
  }

  // ---------- Service worker değişiklik dinleyici ----------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.kuponstore_addresses || changes.kuponstore_active_address)) {
      renderAddresses();
      updateStatus();
    }
    if (area === 'local' && changes.ks_ys_update_info) {
      const info = changes.ks_ys_update_info.newValue;
      if (!info || !info.hasUpdate) return;
      if (info.isMandatory) showUpdateBlocker(info);
      else showUpdateBanner(info);
    }
    if (area === 'sync' && changes.yemekhub_session) {
      updateStatus();
    }
  });

  checkUpdateStatus();
})();
