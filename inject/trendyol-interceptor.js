/**
 * KuponStore - Trendyol Interceptor (tyInterceptor.js)
 * Tamamen Deobfuscate Edilmiş ve Okunabilir Açık Kaynak Hali
 * 
 * Görevi:
 * 1. MAIN World'de (sayfa context'inde) çalışarak api.tgoapis.com ve payment.tgoapps.com
 *    isteklerini yakalar ve content script relay üzerinden arka plana (background) proxyler.
 * 2. /api/app-context isteğini yakalayıp kullanıcı profilini ve web tokenını enjekte eder.
 * 3. Sepet güncellemelerinde (#dh-loading-modal) spinner gösterir.
 * 4. İndirimleri ve payment preview sonucunu hesaplayıp sepet paneline (#dh-cart-summary-discount)
 *    "Ara Toplam", yeşil indirim kalemleri ve indirimli toplam olarak ekler.
 * 5. Minimum sepet / kupon gating (10.1.8 modeli — MIN+400).
 * 6. Sayfa yönlendirmelerine (window.location / router) ASLA müdahale etmez; Next.js donmasını önler.
 * 7. Proxy kapsamı 10.1.8 gibi: SADECE checkout/cart/shipping/payment — discovery NATIVE.
 */

(function () {
  'use strict';

  if (window.__dhTyInterceptorActive) return;

  window.__dhTyInterceptorActive = true;

  // =========================================================================
  // Early Navigation & Cookie Guard (Eksik Bilgi & SSR Redirect Koruması)
  // =========================================================================
  function isBlockedTyPath(urlOrPath) {
    const s = String(urlOrPath || '');
    return (
      s.indexOf('/uyelik') !== -1 ||
      s.indexOf('eksik-bilgi') !== -1 ||
      s.indexOf('kullanici-bilgilerim') !== -1
    );
  }

  function blockedTyRedirect(urlOrPath) {
    return String(urlOrPath || '').indexOf('kullanici-bilgilerim') !== -1
      ? '/hesabim/siparislerim'
      : '/restoranlar';
  }

  (function runEarlyNavigationGuard() {
    try {
      const pathname = window.location.pathname || '';

      // v10.1.13: Root cookie silme KALDIRILDI.
      // SSR HTML cookie ile gelirken document_start'te tgo-token silmek
      // React #418 hydration + restoran tıklanınca 404 yapıyordu.
      // Eksik-bilgi koruması SW + popup cookie + path engeli ile yapılır.

      // Eksik bilgi / üyelik / kullanıcı bilgilerim sayfalarına giriş yasak
      if (isBlockedTyPath(pathname)) {
        const dest = blockedTyRedirect(pathname);
        console.log('[KuponStore Interceptor] Engellenen sayfa ->', dest);
        window.location.replace(dest);
      }
    } catch (_) {}
  })();

  // Next.js client-side router koruması
  try {
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;
    history.pushState = function (state, title, url) {
      if (typeof url === 'string' && isBlockedTyPath(url)) {
        const dest = blockedTyRedirect(url);
        console.log('[KuponStore Interceptor] pushState diverted to', dest);
        return origReplaceState.apply(this, [state, title, dest]);
      }
      return origPushState.apply(this, arguments);
    };
    history.replaceState = function (state, title, url) {
      if (typeof url === 'string' && isBlockedTyPath(url)) {
        const dest = blockedTyRedirect(url);
        console.log('[KuponStore Interceptor] replaceState diverted to', dest);
        return origReplaceState.apply(this, [state, title, dest]);
      }
      return origReplaceState.apply(this, arguments);
    };
  } catch (_) {}

  // Menü / link tıklamalarında kullanıcı bilgilerim sayfasını engelle
  try {
    document.addEventListener('click', function (ev) {
      try {
        const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
        if (!a) return;
        const href = a.getAttribute('href') || '';
        if (href.indexOf('kullanici-bilgilerim') === -1) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        window.location.replace('/hesabim/siparislerim');
      } catch (_) {}
    }, true);
  } catch (_) {}

  // postMessage kaynak belirteçleri (content script relay ile iletişim)
  const SOURCE_INTERCEPTOR = "MIGROS_KUPON_EXTENSION";
  const SOURCE_RELAY = "MIGROS_KUPON_EXTENSION_CONTENT";

  // Proxy kapsamı = 10.1.8 Integrated:
  // SADECE web-checkout / meal-mmcheckout carts+shipping+code-promotions + payment.
  // Discovery / restaurant / kitchens / homepage → NATIVE (proxy YOK).
  // Tüm api.tgoapis.com'u proxy'lemek restoran listesi + detay 404 yapıyordu.
  function isTgoProxyUrl(url, method) {
    if (!url || typeof url !== 'string') return false;
    if (url.indexOf('payment.tgoapps.com') !== -1) return true;
    if (url.indexOf('api.tgoapis.com') === -1) return false;

    const isCheckoutApi =
      url.indexOf('/web-checkout-apicheckout-santral/') !== -1 ||
      url.indexOf('/meal-mmcheckout-sfxcarts-santral/') !== -1;
    if (!isCheckoutApi) return false;

    const m = (method || 'GET').toUpperCase();

    // Native kalsın
    if (url.indexOf('/orders') !== -1) return false;
    if (url.indexOf('/carts/preferences') !== -1) return false;
    if (/\/coupons(\?|$)/.test(url) && url.indexOf('/carts/coupons') === -1) return false;

    // Proxy
    if (url.indexOf('/code-promotions') !== -1) return m === 'POST' || m === 'GET';
    if (url.indexOf('/shipping') !== -1) return m === 'POST';
    if (url.indexOf('/carts/coupons') !== -1) return true;
    if (url.indexOf('/carts/items') !== -1) return true;
    if (url.indexOf('/carts/multiple/items') !== -1) return true;
    if (url.indexOf('/carts') !== -1) return true;

    return false;
  }

  // ─── GeoFix: sayfa latitude=&longitude= boş / İzmir default gönderince tgo-address'ten doldur
  function readKsTyGeo() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)tgo-address=([^;]*)/);
      if (m && m[1]) {
        const j = JSON.parse(decodeURIComponent(m[1]));
        const lat = parseFloat(j.latitude != null ? j.latitude : j.lat);
        const lng = parseFloat(
          j.longitude != null ? j.longitude : j.lon != null ? j.lon : j.lng,
        );
        if (lat && lng) return { lat: lat, lng: lng };
      }
    } catch (_) {}
    try {
      const raw = sessionStorage.getItem('ks_ty_geo');
      if (raw) {
        const j = JSON.parse(raw);
        const lat = parseFloat(j.lat || j.latitude);
        const lng = parseFloat(j.lng || j.longitude || j.lon);
        if (lat && lng) return { lat: lat, lng: lng };
      }
    } catch (_) {}
    try {
      if (window.__ksTyGeo && window.__ksTyGeo.lat && window.__ksTyGeo.lng) {
        return window.__ksTyGeo;
      }
    } catch (_) {}
    return null;
  }

  function fixTyDiscoveryGeoUrl(url) {
    const geo = readKsTyGeo();
    if (!geo || !url || typeof url !== 'string') return url;
    if (url.indexOf('api.tgoapis.com') === -1) return url;
    const needsGeo =
      /apidiscovery-santral|web-discovery|apirestaurant|restaurantdetail|web-restaurant|flashsale|suggestions|homepage|restaurants\/(?:filters|\d+)|collectionView|coupons/i.test(
        url,
      );
    if (!needsGeo && url.indexOf('latitude') === -1 && url.indexOf('longitude') === -1) {
      return url;
    }
    let u;
    try {
      u = new URL(url, location.origin);
    } catch (_) {
      return url;
    }
    const curLat = parseFloat(u.searchParams.get('latitude') || '') || 0;
    const curLng = parseFloat(u.searchParams.get('longitude') || '') || 0;
    const empty = !curLat || !curLng;
    const izmir = Math.abs(curLat - 38.4) < 0.05 && Math.abs(curLng - 27.08) < 0.08;
    if (empty || izmir || needsGeo) {
      if (empty || izmir || u.searchParams.has('latitude') || needsGeo) {
        u.searchParams.set('latitude', String(geo.lat));
        u.searchParams.set('longitude', String(geo.lng));
      }
    }
    return u.toString();
  }

  function fixTyDiscoveryGeoBody(body) {
    const geo = readKsTyGeo();
    if (!geo || body == null) return body;
    let obj = null;
    const asString = typeof body === 'string';
    try {
      obj = asString ? JSON.parse(body) : body;
    } catch (_) {
      return body;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return body;
    const curLat = parseFloat(obj.latitude != null ? obj.latitude : obj.lat) || 0;
    const curLng =
      parseFloat(obj.longitude != null ? obj.longitude : obj.lng != null ? obj.lng : obj.lon) || 0;
    if (!curLat || !curLng || (Math.abs(curLat - 38.4) < 0.05 && Math.abs(curLng - 27.08) < 0.08)) {
      obj.latitude = geo.lat;
      obj.longitude = geo.lng;
    }
    return asString ? JSON.stringify(obj) : obj;
  }

  // Content script / SW geo push
  try {
    window.addEventListener('message', function (ev) {
      try {
        const d = ev && ev.data;
        if (!d || d.source !== SOURCE_RELAY) return;
        if (d.type === 'KS_TY_GEO' && d.lat && d.lng) {
          window.__ksTyGeo = { lat: Number(d.lat), lng: Number(d.lng) };
          try {
            sessionStorage.setItem(
              'ks_ty_geo',
              JSON.stringify({ lat: Number(d.lat), lng: Number(d.lng) }),
            );
          } catch (_) {}
        }
      } catch (_) {}
    });
  } catch (_) {}

  // Benzersiz istek kimliği üretici
  function generateRequestId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }

  const pendingCallbacks = {};
  const cartDedupCache = {};
  const CART_DEDUP_WINDOW_MS = 800;

  function parseValidNumber(val) {
    const num = Number(val);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }

  function isJsonString(str) {
    if (typeof str !== 'string') return false;
    const firstChar = str.trim().charAt(0);
    return firstChar === '{' || firstChar === '[';
  }

  function normalizeHeaders(headers, body) {
    const normalized = {};
    let hasContentType = false;
    if (headers && typeof headers === 'object') {
      for (const key in headers) {
        if (!Object.prototype.hasOwnProperty.call(headers, key)) continue;
        normalized[key] = headers[key];
        if (String(key).toLowerCase() === 'content-type') {
          hasContentType = true;
        }
      }
    }
    if (!hasContentType && isJsonString(body)) {
      normalized['content-type'] = 'application/json; charset=utf-8';
    }
    return normalized;
  }

  // Content script relay'den gelen yanıtları dinle
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== SOURCE_RELAY) return;

    if (msg.action === 'proxyResponse') {
      const cb = pendingCallbacks[msg.requestId];
      if (cb) {
        delete pendingCallbacks[msg.requestId];
        cb(msg.response);
      }
      return;
    }

    if (msg.type === 'PAYMENT_PRICE_RESPONSE') {
      const cb = pendingCallbacks[msg.requestId];
      if (cb) {
        delete pendingCallbacks[msg.requestId];
        cb(msg.response);
      }
      return;
    }
  });

  // Content script'e proxy isteği gönder (30 sn timeout)
  function sendProxyRequest(options) {
    const isCartItems = options.url && options.url.indexOf('/carts/items') !== -1;
    const method = (options.method || 'GET').toUpperCase();

    // Sepet ekleme/silme isteklerini kısa aralıkta mükerrer göndermeyi engelle
    if (isCartItems && (method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH')) {
      const dedupKey = method + '|' + options.url + '|' + (options.body || '');
      const now = Date.now();
      if (cartDedupCache[dedupKey] && now - cartDedupCache[dedupKey] < CART_DEDUP_WINDOW_MS) {
        return Promise.resolve({
          success: true,
          status: 200,
          data: '{"deduplicated":true}',
          error: null
        });
      }
      cartDedupCache[dedupKey] = now;

      // Cache temizliği
      const keys = Object.keys(cartDedupCache);
      if (keys.length > 30) {
        for (let i = 0; i < keys.length; i++) {
          if (now - cartDedupCache[keys[i]] > 5000) {
            delete cartDedupCache[keys[i]];
          }
        }
      }
    }

    return new Promise(function (resolve) {
      const reqId = generateRequestId();
      const timer = setTimeout(function () {
        delete pendingCallbacks[reqId];
        resolve({
          success: false,
          status: 0,
          data: '',
          error: 'Proxy timeout (30s)'
        });
      }, 30000);

      pendingCallbacks[reqId] = function (resp) {
        clearTimeout(timer);
        resolve(resp || {
          success: false,
          status: 0,
          data: '',
          error: 'Empty response'
        });
      };

      const action = isCartItems ? 'tyCartItemsRequest' : 'tyProxyRequest';
      window.postMessage({
        source: SOURCE_INTERCEPTOR,
        action: action,
        requestId: reqId,
        url: options.url,
        method: method,
        headers: options.headers || {},
        body: options.body || null
      }, '*');
    });
  }

  // Ödeme seçenekleri üzerinden gerçek indirimli tutarı sorgula (v3/payment/options)
  function requestPaymentPrice() {
    return new Promise(function (resolve) {
      const reqId = generateRequestId();
      const timer = setTimeout(function () {
        delete pendingCallbacks[reqId];
        resolve({
          success: false,
          status: 0,
          paymentAmount: null
        });
      }, 6500);

      pendingCallbacks[reqId] = function (resp) {
        clearTimeout(timer);
        const status = Number(resp && resp.status);
        const paymentAmount = parseValidNumber(resp && resp.paymentAmount);
        const result = {
          success: resp && resp.success === true && paymentAmount != null,
          status: Number.isInteger(status) ? status : 0,
          paymentAmount: paymentAmount
        };
        if (resp && resp.paymentSummary && resp.paymentSummary.length) {
          result.paymentSummary = resp.paymentSummary;
        }
        resolve(result);
      };

      window.postMessage({
        source: SOURCE_INTERCEPTOR,
        type: 'PAYMENT_PRICE_REQUEST',
        requestId: reqId
      }, '*');
    });
  }

  let cachedUserProfile = null;

  function isAppContextUrl(url) {
    if (!url) return false;
    return url.indexOf('/api/app-context') !== -1;
  }

  function safeJsonParse(str) {
    if (typeof str !== 'string') return null;
    try {
      return JSON.parse(str);
    } catch (_) {
      return null;
    }
  }

  function ensureCompleteUserProfile(user) {
    if (!user || typeof user !== 'object') {
      user = {};
    }
    const uid = user.userId || user.id || user.memberId || 999999;
    if (user.id == null) user.id = uid;
    if (user.userId == null) user.userId = uid;
    if (!user.firstName || typeof user.firstName !== 'string') user.firstName = 'Ali';
    if (!user.lastName || typeof user.lastName !== 'string') user.lastName = 'Kaya';
    if (!user.gender) user.gender = 'MALE';
    user.isComplete = true;
    user.profileCompleted = true;
    user.isProfileComplete = true;
    user.isPhoneVerified = true;
    return user;
  }

  // Kullanıcı profilini proxy üzerinden al
  function fetchUserProfile() {
    if (cachedUserProfile) return Promise.resolve(cachedUserProfile);
    return sendProxyRequest({
      url: 'https://api.tgoapis.com/web-user-apimemberuser-santral/user',
      method: 'GET',
      headers: {},
      body: null
    }).then(function (resp) {
      if (!resp || !resp.success || Number(resp.status) !== 200 || !resp.data) {
        const fallback = ensureCompleteUserProfile({ id: 999999, userId: 999999 });
        cachedUserProfile = fallback;
        return fallback;
      }
      const parsed = safeJsonParse(resp.data);
      if (!parsed || typeof parsed !== 'object') {
        const fallback = ensureCompleteUserProfile({ id: 999999, userId: 999999 });
        cachedUserProfile = fallback;
        return fallback;
      }
      const completed = ensureCompleteUserProfile(parsed);
      cachedUserProfile = completed;
      return completed;
    }).catch(function () {
      const fallback = ensureCompleteUserProfile({ id: 999999, userId: 999999 });
      cachedUserProfile = fallback;
      return fallback;
    });
  }

  let cachedWebToken = null;

  // Web tokenını relay üzerinden al
  function fetchWebToken() {
    if (cachedWebToken) return Promise.resolve(cachedWebToken);
    return new Promise(function (resolve) {
      const reqId = generateRequestId();
      const timer = setTimeout(function () {
        delete pendingCallbacks[reqId];
        resolve('');
      }, 8000);

      pendingCallbacks[reqId] = function (resp) {
        clearTimeout(timer);
        const tok = resp && resp.token ? String(resp.token) : '';
        if (tok) cachedWebToken = tok;
        resolve(tok);
      };

      window.postMessage({
        source: SOURCE_INTERCEPTOR,
        action: 'tyGetWebToken',
        requestId: reqId
      }, '*');
    });
  }

  function enrichUserWithToken(appContext) {
    if (!appContext || !appContext.user || typeof appContext.user !== 'object') {
      return Promise.resolve(appContext);
    }
    if (appContext.user.token) {
      return Promise.resolve(appContext);
    }
    return fetchWebToken().then(function (tok) {
      if (tok) appContext.user.token = tok;
      return appContext;
    });
  }

  function createAppContextResponse(appContext, origResponse) {
    if (!appContext.token) {
      appContext.token = appContext['guest-token'] || appContext['mobile-token'] || 'dh-web-session';
    }
    return new Response(JSON.stringify(appContext), {
      status: 200,
      statusText: (origResponse && origResponse.statusText) || 'OK',
      headers: {
        'content-type': 'application/json; charset=utf-8'
      }
    });
  }

  // /api/app-context isteklerini yakalayıp kullanıcı profilini mocklayan hook
  function hookFetchAppContext(target, args, origFetch) {
    return origFetch.apply(target, args).then(function (response) {
      if (!response || !response.ok) return response;
      return response.clone().text().then(function (text) {
        const parsed = safeJsonParse(text);
        if (!parsed || typeof parsed !== 'object') return response;

        const hasUser = parsed.user && typeof parsed.user === 'object' && (parsed.user.userId || parsed.user.id);
        if (hasUser) {
          ensureCompleteUserProfile(parsed.user);
          return enrichUserWithToken(parsed).then(function () {
            return createAppContextResponse(parsed, response);
          });
        }

        // Eğer user yoksa proxy üzerinden çekip ekle
        return fetchUserProfile().then(function (userProfile) {
          parsed.user = ensureCompleteUserProfile(userProfile);
          return enrichUserWithToken(parsed).then(function () {
            return createAppContextResponse(parsed, response);
          });
        });
      }).catch(function () {
        return response;
      });
    });
  }


  // =========================================================================
  // API yanitlarindan telefon alanlarini temizle (kurye / siparis / adres)
  // =========================================================================
  function _ksLooksLikePhoneStr(s) {
    const t = String(s || '').trim();
    if (!t || t.length > 40) return false;
    return /(?:\+?\d{1,3}[\s\-.]*)?(?:0?5\d{2}|0?7\d{2,3}|\(?0?5\d{2}\)?)[\s\-.*•xX\d()]{3,22}\d/.test(t)
      || /^\+?\d{8,15}$/.test(t.replace(/[\s\-.]/g, ''))
      || /\d{2,4}[*•xX]{2,}\d{0,6}/.test(t);
  }

  function _ksScrubPhoneFields(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) _ksScrubPhoneFields(obj[i], depth + 1);
      return;
    }
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = obj[k];
      if (/phone|gsm|mobile|telefon|msisdn|cepNo|gsmNumber/i.test(k)) {
        if (typeof v === 'string' || typeof v === 'number') obj[k] = '';
        else if (v && typeof v === 'object') _ksScrubPhoneFields(v, depth + 1);
        continue;
      }
      if (typeof v === 'string' && _ksLooksLikePhoneStr(v)) {
        obj[k] = '';
        continue;
      }
      if (v && typeof v === 'object') _ksScrubPhoneFields(v, depth + 1);
    }
  }

  function _ksScrubPhonesInPayload(raw) {
    if (typeof raw !== 'string') return raw;
    const s = raw.trim();
    if (!s || (s[0] !== '{' && s[0] !== '[')) return raw;
    try {
      const obj = JSON.parse(raw);
      _ksScrubPhoneFields(obj, 0);
      return JSON.stringify(obj);
    } catch (_) {
      return raw;
    }
  }
  // =========================================================================
  // XMLHttpRequest Hook
  // =========================================================================
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    let finalUrl = url;
    this._dhMethod = method;
    if (typeof url === 'string' && isTgoProxyUrl(url, method)) {
      // Checkout URL'lerinde boş lat varsa doldur (discovery artık proxy değil)
      finalUrl = fixTyDiscoveryGeoUrl(url);
      this._dhProxy = true;
    }
    this._dhUrl = finalUrl;
    if (finalUrl !== url) {
      arguments[1] = finalUrl;
    }
    return origXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (!this._dhProxy) {
      return origXhrSend.apply(this, arguments);
    }

    const xhr = this;
    const isCart = xhr._dhUrl && xhr._dhUrl.indexOf('/carts') !== -1;
    if (isCart) showLoadingModal();
    const fixedBody = fixTyDiscoveryGeoBody(body);

    sendProxyRequest({
      url: fixTyDiscoveryGeoUrl(xhr._dhUrl),
      method: xhr._dhMethod || 'POST',
      headers: {},
      body: fixedBody
    }).then(function (resp) {
      const isHttpSuccess = resp && resp.status && resp.status >= 100;
      Object.defineProperty(xhr, 'readyState', { configurable: true, get: () => 4 });

      if (isHttpSuccess) {
        try { resp.data = _ksScrubPhonesInPayload(resp.data); } catch (_) {}
        Object.defineProperty(xhr, 'status', { configurable: true, get: () => resp.status });
        Object.defineProperty(xhr, 'statusText', { configurable: true, get: () => resp.statusText || '' });
        Object.defineProperty(xhr, 'responseText', { configurable: true, get: () => resp.data });

        const respHeaders = normalizeHeaders(resp.headers, resp.data);
        xhr.getResponseHeader = function (headerName) {
          if (!headerName) return null;
          const lower = String(headerName).toLowerCase();
          for (const k in respHeaders) {
            if (Object.prototype.hasOwnProperty.call(respHeaders, k) && k.toLowerCase() === lower) {
              return respHeaders[k];
            }
          }
          return null;
        };

        xhr.getAllResponseHeaders = function () {
          let str = '';
          for (const k in respHeaders) {
            if (Object.prototype.hasOwnProperty.call(respHeaders, k)) {
              str += k.toLowerCase() + ': ' + respHeaders[k] + '\r\n';
            }
          }
          return str;
        };

        Object.defineProperty(xhr, 'response', {
          configurable: true,
          get: function () {
            if (xhr.responseType === 'json') {
              try { return JSON.parse(resp.data); } catch (_) { return null; }
            }
            return resp.data;
          }
        });

        if (isCart && resp.data) {
          try { onCartResponse(resp.data); } catch (_) { hideLoadingModal(); }
        } else if (isCart) {
          hideLoadingModal();
        }
      } else {
        Object.defineProperty(xhr, 'status', { configurable: true, get: () => 0 });
        if (isCart) hideLoadingModal();
      }

      setTimeout(function () {
        try { xhr.dispatchEvent(new Event('readystatechange')); } catch (_) {
          if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange();
        }
        try { xhr.dispatchEvent(new Event(isHttpSuccess ? 'load' : 'error')); } catch (_) {
          if (isHttpSuccess && typeof xhr.onload === 'function') xhr.onload();
          else if (!isHttpSuccess && typeof xhr.onerror === 'function') xhr.onerror();
        }
        try { xhr.dispatchEvent(new Event('loadend')); } catch (_) {
          if (typeof xhr.onloadend === 'function') xhr.onloadend();
        }
      }, 0);
    });
  };

  // =========================================================================
  // window.fetch Hook
  // =========================================================================
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = input instanceof Request ? input.url : String(input);

    if (isAppContextUrl(url)) {
      return hookFetchAppContext(this, arguments, origFetch);
    }

    const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');

    if (!isTgoProxyUrl(url, method)) {
      // Native discovery/restaurant — min sepet bilgisini yine yakala (gating için)
      if (/apirestaurant|restaurantdetail|restaurants\/\d+/.test(url)) {
        return origFetch.apply(this, arguments).then(function (response) {
          try {
            if (response && response.ok) {
              response
                .clone()
                .text()
                .then(function (t) {
                  try { extractMinBasketFromRestaurant(url, t); } catch (_) {}
                })
                .catch(function () {});
            }
          } catch (_) {}
          return response;
        });
      }
      return origFetch.apply(this, arguments);
    }

    url = fixTyDiscoveryGeoUrl(url);
    const headers = {};
    const initHeaders = (init && init.headers) || (input instanceof Request ? input.headers : null);
    if (initHeaders) {
      if (typeof initHeaders.forEach === 'function') {
        initHeaders.forEach((val, key) => { headers[key] = val; });
      } else if (typeof initHeaders === 'object') {
        Object.assign(headers, initHeaders);
      }
    }

    let body = (init && init.body) || null;
    body = fixTyDiscoveryGeoBody(body);
    const isCart = url.indexOf('/carts') !== -1;
    if (isCart) showLoadingModal();

    return sendProxyRequest({
      url: url,
      method: method,
      headers: headers,
      body: body
    }).then(function (resp) {
      if (!resp || !resp.status || resp.status < 100) {
        if (isCart) hideLoadingModal();
        return new Response(null, { status: 503, statusText: 'Proxy Unavailable' });
      }

      if (isCart && resp.status >= 200 && resp.status < 300 && resp.data) {
        try { onCartResponse(resp.data); } catch (_) { hideLoadingModal(); }
      } else if (isCart) {
        hideLoadingModal();
      } else if (resp.status >= 200 && resp.status < 300 && resp.data) {
        try { extractMinBasketFromRestaurant(url, resp.data); } catch (_) {}
      }

      try { resp.data = _ksScrubPhonesInPayload(resp.data); } catch (_) {}
      return new Response(resp.data, {
        status: resp.status,
        statusText: resp.statusText || '',
        headers: normalizeHeaders(resp.headers, resp.data)
      });
    });
  };

  // =========================================================================
  // Yükleniyor Spinner Modal (#dh-loading-modal)
  // =========================================================================
  let loadingCounter = 0;

  function showLoadingModal() {
    loadingCounter++;
    if (document.getElementById('dh-loading-modal')) return;

    if (!document.getElementById('dh-loading-style')) {
      const style = document.createElement('style');
      style.id = 'dh-loading-style';
      style.textContent = '@keyframes dh-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(style);
    }

    const modal = document.createElement('div');
    modal.id = 'dh-loading-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;z-index:999999;transition:opacity 0.2s;';

    const card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:16px;padding:28px 40px;display:flex;flex-direction:column;align-items:center;gap:14px;box-shadow:0 8px 32px rgba(0,0,0,0.18);';

    const spinner = document.createElement('div');
    spinner.style.cssText = 'width:36px;height:36px;border:3px solid #e0e0e0;border-top:3px solid #FF6000;border-radius:50%;animation:dh-spin 0.8s linear infinite;';

    const label = document.createElement('div');
    label.style.cssText = 'font-size:15px;font-weight:600;color:#333;letter-spacing:0.3px;';
    label.textContent = 'İşleniyor...';

    card.appendChild(spinner);
    card.appendChild(label);
    modal.appendChild(card);
    document.body.appendChild(modal);
  }

  function hideLoadingModal() {
    if (loadingCounter > 0) loadingCounter--;
    if (loadingCounter > 0) return;
    const modal = document.getElementById('dh-loading-modal');
    if (modal) modal.remove();
  }

  // =========================================================================
  // Sepet Yanıtı İşleme & İndirim Özeti
  // =========================================================================
  let cartSummaryData = null;
  let cartUpdateSequence = 0;

  function onCartResponse(cartJsonText) {
    let cart;
    try { cart = JSON.parse(cartJsonText); } catch (_) { hideLoadingModal(); return; }
    if (!cart) { hideLoadingModal(); return; }

    if (!cart.totalProductCount || cart.totalProductCount === 0) {
      cartSummaryData = null;
      removeCartSummaryDiscount();
      ungateCheckoutButton();
      hideLoadingModal();
      return;
    }

    const discountLines = [];
    const discountKeys = {};

    function addDiscountLine(title, amount) {
      const key = (title || '') + '|' + Math.round(amount * 100);
      if (discountKeys[key]) return;
      discountKeys[key] = true;
      discountLines.push({ title: title || 'İndirim', amount: amount });
    }

    if (cart.summary && cart.summary.length) {
      for (let i = 0; i < cart.summary.length; i++) {
        const item = cart.summary[i];
        if (item.amount < 0) addDiscountLine(item.title, item.amount);
      }
    }

    if (cart.channelSummary && cart.channelSummary.promotions) {
      for (let i = 0; i < cart.channelSummary.promotions.length; i++) {
        const promo = cart.channelSummary.promotions[i];
        if (promo.amount < 0) addDiscountLine(promo.title, promo.amount);
      }
    }

    if (cart.discount && cart.discount.promotion) {
      const promoObj = cart.discount.promotion;
      if (promoObj.promotions && promoObj.promotions.length) {
        for (let i = 0; i < promoObj.promotions.length; i++) {
          if (promoObj.promotions[i].discount > 0) {
            addDiscountLine(promoObj.promotions[i].name, -promoObj.promotions[i].discount);
          }
        }
      }
      if (!discountLines.length && promoObj.discounts && promoObj.discounts.totalDiscount > 0) {
        addDiscountLine('İndirim', -promoObj.discounts.totalDiscount);
      }
    }

    if (!discountLines.length && cart.totalSellerPaidDiscount > 0) {
      addDiscountLine('İndirim', -cart.totalSellerPaidDiscount);
    }

    if (!discountLines.length) {
      const prodPrice = cart.totalProductPrice || 0;
      const totPrice = cart.totalPrice || 0;
      if (prodPrice > totPrice && prodPrice - totPrice > 0.5) {
        addDiscountLine('İndirim', -(prodPrice - totPrice));
      }
    }

    const totalPrice = cart.totalPrice || cart.totalProductPriceDiscounted || cart.totalProductPrice || 0;
    const totalProductPrice = cart.totalProductPrice || 0;

    // Eski kupon/minimum sepet kilidi kapalı — butonu serbest bırak
    checkAndApplyGating(totalProductPrice);

    if (!discountLines.length) {
      if (cartSummaryData) cartSummaryData.ara = totalProductPrice;
    } else {
      cartSummaryData = {
        lines: discountLines,
        ara: totalProductPrice,
        total: totalPrice
      };
      renderCartSummaryDiscount();
      setTimeout(renderCartSummaryDiscount, 400);
      setTimeout(renderCartSummaryDiscount, 1200);
    }

    // Payment options üzerinden nihai indirimli tutarı çek
    const currentSeq = ++cartUpdateSequence;
    requestPaymentPrice().then(function (payPreview) {
      if (currentSeq !== cartUpdateSequence) { hideLoadingModal(); return; }
      if (!payPreview || !payPreview.success) { hideLoadingModal(); return; }

      const paymentAmount = payPreview.paymentAmount;
      if (paymentAmount == null || paymentAmount < 0) { hideLoadingModal(); return; }

      const araToplam = (cartSummaryData && cartSummaryData.ara) || cart.totalProductPrice || 0;

      if (payPreview.paymentSummary && payPreview.paymentSummary.length) {
        const previewLines = [];
        const previewKeys = {};
        for (let i = 0; i < payPreview.paymentSummary.length; i++) {
          const item = payPreview.paymentSummary[i];
          if (item.amount < 0) {
            const k = (item.title || '') + '|' + Math.round(item.amount * 100);
            if (!previewKeys[k]) {
              previewKeys[k] = true;
              previewLines.push({ title: item.title || 'İndirim', amount: item.amount });
            }
          }
        }
        if (previewLines.length) {
          cartSummaryData = {
            lines: previewLines,
            ara: araToplam,
            total: paymentAmount
          };
          renderCartSummaryDiscount();
          setTimeout(renderCartSummaryDiscount, 400);
          setTimeout(renderCartSummaryDiscount, 1200);
          hideLoadingModal();
          return;
        }
      }

      const diff = araToplam - paymentAmount;
      if (diff > 0.5) {
        cartSummaryData = {
          lines: [{ title: 'İndirim', amount: -diff }],
          ara: araToplam,
          total: paymentAmount
        };
        renderCartSummaryDiscount();
        setTimeout(renderCartSummaryDiscount, 400);
        setTimeout(renderCartSummaryDiscount, 1200);
      } else {
        cartSummaryData = null;
        removeCartSummaryDiscount();
      }
      hideLoadingModal();
    }).catch(function () {
      hideLoadingModal();
    });
  }

  function removeCartSummaryDiscount() {
    const el = document.getElementById('dh-cart-summary-discount');
    if (el) el.remove();
  }

  // =========================================================================
  // Minimum Sepet Tutarı Denetimi (Gating) — 10.1.8 modeli geri yüklendi
  // =========================================================================
  const MIN_BASKET_THRESHOLD_OFFSET = 400; // Kuponun uygulanabilmesi için ek gereken tutar
  const MIN_BASKET_ENFORCE_LOCK = false; // Hesap duruyor; buton kilitlenmez, uyarı yazılmaz
  let cachedMinBasketPrice = null;
  let activeGatedMinPrice = null;

  function parsePrice(str) {
    if (str == null) return null;
    str = String(str).replace(/[^\d.,]/g, '');
    if (!str) return null;
    if (str.indexOf(',') !== -1) {
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      const parts = str.split('.');
      if (parts.length > 1 && parts[parts.length - 1].length === 3) {
        str = str.replace(/\./g, '');
      }
    }
    const val = parseFloat(str);
    return isNaN(val) ? null : val;
  }

  function extractMinBasketFromObject(obj, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    if (typeof obj.minBasketPrice === 'number') return obj.minBasketPrice;
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const val = obj[key];
        if (val && typeof val === 'object') {
          const res = extractMinBasketFromObject(val, depth + 1);
          if (res != null) return res;
        }
      }
    }
    return null;
  }

  function extractMinBasketFromRestaurant(url, bodyText) {
    try {
      if (!url || !bodyText) return;
      if (url.indexOf('restaurantdetail') === -1 && url.indexOf('apirestaurant') === -1 && !/restaurants\/\d+/.test(url)) return;
      const parsed = JSON.parse(bodyText);
      const minBasket = extractMinBasketFromObject(parsed);
      if (minBasket != null && minBasket >= 0) cachedMinBasketPrice = minBasket;
    } catch (_) {}
  }

  function extractMinBasketFromBodyText() {
    try {
      const text = document.body ? document.body.innerText : '';
      const m = text.match(/Min\.\s*Tutar\s*([\d.,]+)\s*TL/i) || text.match(/Min\.?\s*([\d.,]+)\s*TL/i);
      if (m) {
        const val = parsePrice(m[1]);
        if (val != null && val >= 0 && val < 100000) return val;
      }
    } catch (_) {}
    return null;
  }

  function getMinBasketPrice() {
    if (cachedMinBasketPrice != null && cachedMinBasketPrice >= 0) return cachedMinBasketPrice;
    const fromDom = extractMinBasketFromBodyText();
    if (fromDom != null) return fromDom;
    return null;
  }

  function findCheckoutButtons() {
    const buttons = [];
    const elements = document.querySelectorAll('button, a[role="button"], [role="button"]');
    for (let i = 0; i < elements.length; i++) {
      const text = (elements[i].textContent || '').trim();
      if (elements[i].getAttribute('data-dh-gated') === '1' || /sepeti\s*onayla/i.test(text)) {
        buttons.push(elements[i]);
      }
    }
    return buttons;
  }

  function onGatedButtonClick(ev) {
    if (this.getAttribute && this.getAttribute('data-dh-gated') === '1') {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    }
  }

  const GATED_STYLE_KEYS = [
    'whiteSpace', 'height', 'maxHeight', 'minHeight', 'lineHeight',
    'padding', 'fontSize', 'textAlign', 'overflow', 'textOverflow',
    'display', 'alignItems', 'justifyContent', 'wordBreak', 'flexShrink', 'boxSizing'
  ];

  function ungateCheckoutButton() {
    const buttons = findCheckoutButtons();
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      if (btn.getAttribute('data-dh-gated') === '1') {
        const origHtml = btn.getAttribute('data-dh-orig-html');
        if (origHtml != null) btn.innerHTML = origHtml;
        btn.removeAttribute('data-dh-gated');
        try { btn.disabled = false; } catch (_) {}
        btn.style.pointerEvents = '';
        btn.style.opacity = '';
        btn.style.cursor = '';
        for (let k = 0; k < GATED_STYLE_KEYS.length; k++) {
          btn.style[GATED_STYLE_KEYS[k]] = '';
        }
        let parent = btn.parentElement;
        for (let p = 0; p < 3 && parent; p++) {
          if (parent.getAttribute && parent.getAttribute('data-dh-gate-relaxed') === '1') {
            parent.style.height = '';
            parent.style.maxHeight = '';
            parent.style.overflow = '';
            parent.removeAttribute('data-dh-gate-relaxed');
          }
          parent = parent.parentElement;
        }
      }
    }
  }

  function gateCheckoutButton(minBasket) {
    if (!MIN_BASKET_ENFORCE_LOCK) {
      ungateCheckoutButton();
      return;
    }
    const buttons = findCheckoutButtons();
    const requiredTotal = minBasket + MIN_BASKET_THRESHOLD_OFFSET;
    const msg = "Kupon gösterilemez ve sepete devam edilemez (minimum restoran sepet tutarı " +
      formatPrice(minBasket).replace('-', '') + " dir, kuponlu tutar minimum restoran sepet tutarını geçmelidir) " +
      "Kuponu görmek ve sepete devam etmek için " + formatPrice(requiredTotal).replace('-', '') + " sepet yapmanız gerekli";

    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      if (!btn.hasAttribute('data-dh-orig-html')) {
        btn.setAttribute('data-dh-orig-html', btn.innerHTML);
      }
      if (btn.innerHTML !== msg) {
        btn.innerHTML = msg;
      }
      btn.setAttribute('data-dh-gated', '1');
      btn.style.pointerEvents = 'auto';
      btn.style.opacity = '0.9';
      btn.style.cursor = 'not-allowed';
      btn.style.whiteSpace = 'normal';
      btn.style.height = 'auto';
      btn.style.maxHeight = 'none';
      btn.style.minHeight = '48px';
      btn.style.lineHeight = '1.35';
      btn.style.padding = '12px 16px';
      btn.style.fontSize = 'clamp(11px, 3.2vw, 14px)';
      btn.style.textAlign = 'center';
      btn.style.overflow = 'visible';
      btn.style.textOverflow = 'clip';
      btn.style.display = 'flex';
      btn.style.alignItems = 'center';
      btn.style.justifyContent = 'center';
      btn.style.wordBreak = 'break-word';
      btn.style.flexShrink = '0';
      btn.style.boxSizing = 'border-box';
      try { btn.disabled = true; } catch (_) {}

      if (!btn._dhGateBound) {
        btn.addEventListener('click', onGatedButtonClick, true);
        btn._dhGateBound = true;
      }

      let parent = btn.parentElement;
      for (let p = 0; p < 2 && parent && parent !== document.body; p++) {
        try {
          const comp = window.getComputedStyle(parent);
          const isHidden = comp && (comp.overflow === 'hidden' || comp.overflowY === 'hidden');
          const isScrollable = comp && (comp.overflowY === 'auto' || comp.overflowY === 'scroll' || comp.overflow === 'auto' || comp.overflow === 'scroll');
          if (isHidden && !isScrollable) {
            parent.setAttribute('data-dh-gate-relaxed', '1');
            parent.style.height = 'auto';
            parent.style.maxHeight = 'none';
          }
        } catch (_) {}
        parent = parent.parentElement;
      }
    }
  }

  function checkAndApplyGating(totalProductPrice) {
    const minBasket = getMinBasketPrice();
    if (minBasket == null) {
      activeGatedMinPrice = null;
      ungateCheckoutButton();
      return false;
    }
    const requiredTotal = minBasket + MIN_BASKET_THRESHOLD_OFFSET;
    if (totalProductPrice < requiredTotal - 0.001) {
      activeGatedMinPrice = minBasket;
      gateCheckoutButton(minBasket);
      setTimeout(function () { gateCheckoutButton(minBasket); }, 300);
      setTimeout(function () { gateCheckoutButton(minBasket); }, 1000);
      return true;
    }
    activeGatedMinPrice = null;
    ungateCheckoutButton();
    return false;
  }

  // DOM yeniden çizildiğinde gating'i koru
  setInterval(function () {
    if (activeGatedMinPrice == null || !MIN_BASKET_ENFORCE_LOCK) return;
    const buttons = findCheckoutButtons();
    for (let i = 0; i < buttons.length; i++) {
      if (buttons[i].getAttribute('data-dh-gated') !== '1') {
        gateCheckoutButton(activeGatedMinPrice);
        break;
      }
    }
  }, 700);

  function formatPrice(val) {
    const abs = Math.abs(val);
    const formatted = abs % 1 === 0 ? abs.toFixed(0) : abs.toFixed(2).replace('.', ',');
    return (val < 0 ? '-' : '') + formatted + ' TL';
  }

  function findCartTotalRow() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    const matches = [];
    while ((node = walker.nextNode())) {
      if (node.textContent.trim() === 'Toplam') {
        matches.push(node.parentElement);
      }
    }

    for (let i = 0; i < matches.length; i++) {
      let cur = matches[i];
      let root = cur;
      for (let p = 0; p < 6 && root.parentElement; p++) {
        root = root.parentElement;
      }
      const text = root.textContent || '';
      if (text.indexOf('Sepeti Onayla') !== -1 || text.indexOf('Hesap') !== -1) {
        let candidate = cur;
        while (candidate && (candidate.textContent || '').indexOf('TL') === -1 && candidate.parentElement && candidate !== root) {
          candidate = candidate.parentElement;
        }
        if (candidate && candidate !== root) return candidate;
      }
    }
    return null;
  }

  // Sepet özet tablosuna (#dh-cart-summary-discount) Ara Toplam ve İndirimleri yerleştir
  function renderCartSummaryDiscount() {
    if (!cartSummaryData || !cartSummaryData.lines.length) return;
    const totalRow = findCartTotalRow();
    if (!totalRow) return;

    removeCartSummaryDiscount();
    const parent = totalRow.parentElement;
    if (!parent) return;

    const compStyle = window.getComputedStyle(totalRow);
    const fontSize = compStyle.fontSize || '14px';

    const container = document.createElement('div');
    container.id = 'dh-cart-summary-discount';
    container.style.cssText = 'padding:0;margin:0;';

    const araRow = document.createElement('div');
    araRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:' + fontSize + ';';
    araRow.innerHTML = '<span>Ara Toplam</span><span>' + formatPrice(cartSummaryData.ara) + '</span>';
    container.appendChild(araRow);

    for (let i = 0; i < cartSummaryData.lines.length; i++) {
      const line = cartSummaryData.lines[i];
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:' + fontSize + ';color:#00C853;font-weight:500;';
      row.innerHTML = '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:8px;">' +
        line.title + '</span><span style="white-space:nowrap;">' + formatPrice(line.amount) + '</span>';
      container.appendChild(row);
    }

    parent.insertBefore(container, totalRow);

    // Nihai toplam tutarını güncelle
    if (cartSummaryData.total && cartSummaryData.total > 0) {
      const spans = totalRow.querySelectorAll('span');
      for (let i = 0; i < spans.length; i++) {
        const text = spans[i].textContent.trim();
        if (text.indexOf('TL') !== -1 && text !== 'Toplam') {
          spans[i].textContent = formatPrice(cartSummaryData.total);
          break;
        }
      }
    }
  }

  // React yeniden render ettiğinde indirim kutusunun kaybolmasını engelle
  setInterval(function () {
    try {
      if (!cartSummaryData || !cartSummaryData.lines || !cartSummaryData.lines.length) return;
      const totalRow = findCartTotalRow();
      if (!totalRow) return;
      const current = document.getElementById('dh-cart-summary-discount');
      if (!current || current.parentElement !== totalRow.parentElement) {
        renderCartSummaryDiscount();
      }
    } catch (_) {}
  }, 1500);

  // =========================================================================
  // Adres / siparis / kurye ekraninda telefon gizle + kullanici bilgilerim kaldir
  // =========================================================================
  (function privacyUiGuard() {
    // TR + UK + maskeli + parantezli — NOT: "500 TL" gibi fiyatlara dokunma
    // (eski tr2 boşlukla 5xx TL yiyordu → iOS/Android Ara Toplam/Toplam sadece "TL")
    const PHONE_RE = /(?:\+?90[\s\-.]*)?(?:0?5\d{2})[\s\-.]?\d{3}[\s\-.]?\d{2}[\s\-.]?\d{2}\b|(?:\+?90[\s\-.]*)?(?:0?5\d{2})[\s\-.]{0,2}[*•xX]{2,}[\d*•xX\s\-.]{0,10}\b|\b5\d{2}[*•xX]{3,}\d{0,4}(?!\d)|0?\(\s*[57]\d{2}\s*\)[\s\-.*•xX\d]{4,22}\d|(?:\+?44[\s\-.]*)?(?:0?7\d{2,3})[\s\-.]?\d{3}[\s\-.]?\d{3,4}\b|(?:\+?44[\s\-.]*)?0?7\d{2,3}[\s\-.]{0,2}[*•xX]{2,}[\d*•xX\s\-.]{0,10}\b|\b0\d{3}[*•xX]{2,}\d{1,4}\b|\+\d{8,15}\b/g;
    const ONLY_PHONE_RE = /^\s*(?:\+?\d{1,3}[\s\-.]*)?(?:0?\(?\d{2,4}\)?[\s\-.*•xX\d()]{4,28})\s*$/;

    function isPriceLikeText(text) {
      const t = String(text || '').trim();
      if (!t) return false;
      if (/(?:₺|\bTL\b)/i.test(t)) return true;
      // Saf tutar: 500 / 500,00 / 1.250,50
      if (/^\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?$/.test(t) && t.replace(/\D/g, '').length <= 7) return true;
      return false;
    }

    function isPhoneLikeText(text) {
      const t = String(text || '').trim();
      if (!t || t.length > 48) return false;
      if (isPriceLikeText(t)) return false;
      const digits = t.replace(/\D/g, '');
      if (digits.length >= 10 && digits.length <= 13 && (/^0?[57]\d{8,11}$/.test(digits) || /^\d{10,13}$/.test(digits))) {
        if (/[()\-\s]/.test(t) || /^0?[57]/.test(digits)) return true;
      }
      if (ONLY_PHONE_RE.test(t) && /\d/.test(t) && (/[*•xX]/.test(t) || digits.length >= 10)) return true;
      PHONE_RE.lastIndex = 0;
      return PHONE_RE.test(t) && (/[*•xX]/.test(t) || digits.length >= 10);
    }

    function hideEl(el) {
      if (!el || el.getAttribute('data-ks-phone-hidden') === '1') return;
      el.setAttribute('data-ks-phone-hidden', '1');
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('font-size', '0', 'important');
      el.style.setProperty('height', '0', 'important');
      el.style.setProperty('overflow', 'hidden', 'important');
    }

    function hideProfileLinks(root) {
      const scope = root && root.querySelectorAll ? root : document;
      const links = scope.querySelectorAll ? scope.querySelectorAll('a[href*="kullanici-bilgilerim"]') : [];
      for (let i = 0; i < links.length; i++) {
        const el = links[i];
        if (el.getAttribute('data-ks-hidden') === '1') continue;
        el.setAttribute('data-ks-hidden', '1');
        el.style.setProperty('display', 'none', 'important');
        el.setAttribute('href', '/hesabim/siparislerim');
        const row = el.closest('li, a, button, [role="button"], div');
        if (row && row !== el && /kullanıcı bilgilerim|kullanici bilgilerim/i.test(row.textContent || '')) {
          row.style.setProperty('display', 'none', 'important');
        }
      }
    }

    function hideTelLinks(root) {
      const scope = root && root.querySelectorAll ? root : document;
      if (!scope.querySelectorAll) return;
      const tels = scope.querySelectorAll('a[href^="tel:"], a[href*="tel:"], button[onclick*="tel:"]');
      for (let i = 0; i < tels.length; i++) {
        hideEl(tels[i]);
        const wrap = tels[i].closest('li, button, [role="button"], div, span, a');
        if (wrap && wrap !== tels[i] && ((wrap.textContent || '').trim().length < 48 || isPhoneLikeText(wrap.textContent))) {
          hideEl(wrap);
        }
      }
    }

    function hideDeliveryAddressPhones(root) {
      const scope = root && root.querySelectorAll ? root : document;
      const nodes = scope.querySelectorAll ? scope.querySelectorAll('p, span, div, li, dd, td, a, button, label, strong, b') : [];
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (el.getAttribute('data-ks-phone-hidden') === '1') continue;
        if (el.childElementCount === 0 && isPhoneLikeText(el.textContent)) {
          hideEl(el);
          continue;
        }
        // "Telefon / Cep / Gsm" etiketli satirlar (kurye takip)
        const txt = (el.textContent || '').trim();
        if (el.childElementCount <= 3 && txt.length < 60 && /(?:telefon|cep|gsm|iletişim|iletisim|phone)/i.test(txt) && (/\d{3}/.test(txt) || /[*•xX]{2,}/.test(txt))) {
          if (isPhoneLikeText(txt) || PHONE_RE.test(txt)) {
            PHONE_RE.lastIndex = 0;
            hideEl(el);
          }
        }
      }
      const allText = scope.querySelectorAll ? scope.querySelectorAll('h1,h2,h3,h4,p,span,div,strong,b,label') : [];
      for (let i = 0; i < allText.length; i++) {
        const title = allText[i];
        const titleTxt = (title.textContent || '').trim();
        if (!/teslimat\s*adresi|teslimat\s*bilgi|kurye|canlı\s*takip|canli\s*takip|sipariş\s*takip|siparis\s*takip|iletişim|iletisim/i.test(titleTxt)) continue;
        let card = title.parentElement;
        for (let d = 0; d < 6 && card; d++) {
          const kids = card.querySelectorAll('p, span, div, a, button, li, dd, td, label');
          for (let k = 0; k < kids.length; k++) {
            const kid = kids[k];
            if (kid.childElementCount > 3) continue;
            if (isPhoneLikeText(kid.textContent)) hideEl(kid);
          }
          card = card.parentElement;
        }
      }
    }

    function maskPhoneInNode(node) {
      if (!node || node.nodeType !== 3) return;
      const text = node.nodeValue || '';
      // Fiyat / TL satırlarına asla dokunma (500 TL → TL bug'ı)
      if (isPriceLikeText(text) || /(?:₺|\bTL\b)/i.test(text)) return;
      PHONE_RE.lastIndex = 0;
      if (!PHONE_RE.test(text) && !ONLY_PHONE_RE.test(text.trim())) {
        PHONE_RE.lastIndex = 0;
        return;
      }
      PHONE_RE.lastIndex = 0;
      if (isPhoneLikeText(text) || ONLY_PHONE_RE.test(text.trim())) {
        const parent = node.parentElement;
        if (parent) hideEl(parent);
        node.nodeValue = '';
        return;
      }
      node.nodeValue = text.replace(PHONE_RE, '').replace(/\n{2,}/g, '\n').trim();
    }

    function scrubNextData() {
      try {
        const scripts = document.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"]');
        for (let i = 0; i < scripts.length; i++) {
          const el = scripts[i];
          if (el.getAttribute('data-ks-phone-scrubbed') === '1') continue;
          const raw = el.textContent || '';
          if (!/phone|gsm|telefon/i.test(raw) && !/\d{3}[*•xX]{2,}/.test(raw)) continue;
          const cleaned = _ksScrubPhonesInPayload(raw);
          if (cleaned !== raw) {
            el.textContent = cleaned;
            el.setAttribute('data-ks-phone-scrubbed', '1');
          }
        }
      } catch (_) {}
    }

    function walk(root) {
      if (!root) return;
      if (root.nodeType === 3) {
        maskPhoneInNode(root);
        return;
      }
      if (root.nodeType !== 1) return;
      const tag = (root.tagName || '').toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'textarea' || tag === 'input') return;
      if (root.getAttribute && root.getAttribute('data-ks-phone-hidden') === '1') return;
      const children = root.childNodes;
      for (let i = 0; i < children.length; i++) walk(children[i]);
    }

    function sweep(target) {
      try {
        hideProfileLinks(target || document);
        hideTelLinks(target || document);
        hideDeliveryAddressPhones(target || document);
        scrubNextData();
        walk(target || document.body);
      } catch (_) {}
    }

    function start() {
      sweep(document);
      if (typeof MutationObserver !== 'function' || !document.documentElement) return;
      const obs = new MutationObserver(function (mutations) {
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          if (m.type === 'characterData') {
            maskPhoneInNode(m.target);
            continue;
          }
          const nodes = m.addedNodes || [];
          for (let j = 0; j < nodes.length; j++) {
            hideProfileLinks(nodes[j]);
            hideTelLinks(nodes[j]);
            walk(nodes[j]);
          }
        }
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      setInterval(function () { sweep(document); }, 1500);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  })();

})();
