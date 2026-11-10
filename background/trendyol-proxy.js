function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Otomatik indirimler (İlk 5 Sipariş vb.) bu segmentlerle hesaplanıyor
const TY_DISCOUNT_SEGMENTS =
  "410750033_generic_6,410750050_1_6,278500001_1753975821420,278500001_1764162914545,278500001_1764163821920,278500001_1754397916073,278500001_1759307428295,278500001_1747050329340,410750032_coupon_6,410750245_donemmeyve3aralikic_6,410750245_donemmeyve3aralikic1_6,278500001_1709048753408,278500001_1765377989358,278500001_1765377978691,278500001_1765798226726,278500001_1764856830345,278500001_1766559756200,278500001_1766066429506,410750284_a101lansmanhl_6,278500001_1767078916829,410750721_meal_nursery__01-2026__01-2026,278500001_1767188773735,410750284_150tlmarkethl_6,410750284_donemkahvakti1ocak_6,410750284_donematistir2ocak_6,278500001_a101all,410750245_grpceryyilbasi_6,410750245_grpceryyilbasigo_6,410750284_donematistirmalik9ocak_6,410750284_donemkahvalti10ocak_6";

// ─────────────────────────────────────────────────────────────────
// JWT Helpers - mobil/web token ayrımı için
// ─────────────────────────────────────────────────────────────────
function decodeJwtPayload(token) {
  try {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "===".slice((base64.length + 3) % 4);
    return JSON.parse(atob(padded));
  } catch (e) {
    return null;
  }
}

// Trendyol API'sinin kabul ettiği JWT göstergeleri:
// - issuer 'auth.trendyol.com' → KABUL (gerçek auth servisi)
// - appName 'lc' (localcommerce) → KABUL — meal API bunu kabul ediyor!
// - appName/applicationName 'TrendyolGo' → KABUL (mobil)
// - channelId === 4 → KABUL (mobil)
// - userId field'ı varsa kullanıcı tokenı (anon değil) → KABUL
//
// Reddedilenler:
// - role === 'anon' (guest token) → KABUL ETME, kupon uygulanmaz
// - tgo-token web cookie (genelde JWT bile değil veya farklı format) → KABUL ETME
//
// VPS'te yapılan E2E test (2026-04-28) ile kanıtlandı:
// "lc" appName'li auth.trendyol.com JWT'si meal-mmcheckout-sfxcarts-santral/code-promotions
// endpoint'i tarafından KABUL EDİLİYOR (401 değil — sadece body/cart hataları görülüyor).
function looksLikeMobileJwt(token) {
  const p = decodeJwtPayload(token);
  if (!p) return false;

  // Anon/guest token'ı asla kabul etme
  if (p.role === "anon") return false;

  // Trendyol auth issuer'ı + userId varsa (gerçek hesap tokenı) → KABUL
  if (
    typeof p.iss === "string" &&
    p.iss.includes("trendyol.com") &&
    (p.userId || p.sub)
  ) {
    return true;
  }

  // Klasik mobil göstergeler
  if (p.channelId === 4) return true;
  if (
    typeof p.applicationName === "string" &&
    p.applicationName.toLowerCase().includes("trendyolgo")
  )
    return true;
  if (
    typeof p.appName === "string" &&
    p.appName.toLowerCase().includes("trendyolgo")
  )
    return true;
  if (
    typeof p.clientId === "string" &&
    p.clientId.toLowerCase().includes("trendyolgo")
  )
    return true;

  // appName 'lc' (localcommerce) + userId varsa → meal API kabul ediyor
  if (
    typeof p.appName === "string" &&
    p.appName === "lc" &&
    (p.userId || p.sub)
  )
    return true;

  return false;
}

function summarizeJwt(token) {
  const p = decodeJwtPayload(token);
  if (!p) return { length: token?.length || 0, decoded: false };
  return {
    length: token.length,
    iss: p.iss,
    appName: p.appName || p.applicationName,
    role: p.role,
    channelId: p.channelId,
    userId: p.userId || p.sub,
    exp: p.exp ? new Date(p.exp * 1000).toISOString() : null,
    isAcceptable: looksLikeMobileJwt(token),
  };
}

function generateRandomHex(length) {
  let result = "";
  const characters = "0123456789abcdef";
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

function getOrCreateDeviceInfo() {
  return {
    manufacturer: "samsung",
    model: "SM-S911B",
    osVersion: "13",
    build: "TP1A.220624.014",
  };
}

async function generateTrendyolDeviceSignals(options) {
  try {
    // Public signals endpoint'i — gerçek imzalı header dönüyor
    // (kuponstore.com endpoint'i fake/predictable signal döndürüyor olabilir, fraud trigger eder)
    const response = await fetch("https://bikupon.co/api/generate-signals", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const result = await response.json();

    if (result.success && result.data) {
      console.log("[TY Proxy] Device signals alındı");
      return {
        payload: result.data.payload,
        signature: result.data.signature,
        timestamp: result.data.timestamp,
      };
    } else {
      throw new Error("Device signals API başarısız");
    }
  } catch (error) {
    const timestamp = Date.now();
    return {
      payload: `ts=${timestamp}&e=0&v=2.5.3.335&r=0&f=0&rs=0`,
      signature: btoa(timestamp.toString()),
      timestamp: timestamp,
    };
  }
}

async function getTrendyolToken() {
  // Öncelik sırası:
  // 1. tyMobileToken (saf mobil JWT — en güvenilir)
  // 2. tyToken (sadece tyTokenSource mobil ise)
  // 3. tyToken (mobil JWT görünüyorsa, kaynak yoksa bile)
  // 4. tyToken / tgoMobileToken / trendyolToken / trendyolWebToken (fallback)
  // 5. cookie fallback (access_token, tgo-token)
  try {
    const storageData = await chrome.storage.local.get([
      "tyMobileToken",
      "tyToken",
      "tyTokenSource",
      "tgoMobileToken",
      "trendyolToken",
      "trendyolWebToken",
      "tgoWebToken",
    ]);

    // 1. tyMobileToken (kupon istekleri için ÖZEL alan)
    if (storageData.tyMobileToken) {
      const t = storageData.tyMobileToken;
      console.log("[TY Proxy] ✅ tyMobileToken kullanılıyor:", summarizeJwt(t));
      return t;
    }

    // 2. Kaynak mobil ise tyToken kullan
    const src = storageData.tyTokenSource || "";
    if (storageData.tyToken && src.includes("mobile")) {
      const t = storageData.tyToken;
      console.log(
        "[TY Proxy] ✅ tyToken (source=" + src + ") kullanılıyor:",
        summarizeJwt(t),
      );
      return t;
    }

    // 3. Kaynak yok ama JWT mobil görünüyor — kullan
    if (storageData.tyToken && looksLikeMobileJwt(storageData.tyToken)) {
      const t = storageData.tyToken;
      console.log(
        "[TY Proxy] ✅ tyToken (mobil görünüyor, source yok) kullanılıyor:",
        summarizeJwt(t),
      );
      return t;
    }

    // 4. tyToken geçerli uzunluktaysa fallback olarak kabul et
    if (storageData.tyToken && typeof storageData.tyToken === "string" && storageData.tyToken.length > 20) {
      console.log(
        "[TY Proxy] ✅ tyToken fallback kullanılıyor:",
        summarizeJwt(storageData.tyToken),
      );
      return storageData.tyToken;
    }

    // 5. Diğer depolanan token anahtarları
    const altToken = storageData.tgoMobileToken || storageData.trendyolToken || storageData.trendyolWebToken || storageData.tgoWebToken;
    if (altToken && typeof altToken === "string" && altToken.length > 20) {
      console.log(
        "[TY Proxy] ✅ altToken fallback kullanılıyor:",
        summarizeJwt(altToken),
      );
      return altToken;
    }
  } catch (e) {
    console.warn("[TY Proxy] Storage hatası:", e);
  }

  // 6. Cookie fallback — access_token veya tgo-token
  try {
    const accessCookie = await chrome.cookies.get({
      url: "https://tgoyemek.com",
      name: "access_token",
    });
    if (accessCookie && accessCookie.value && accessCookie.value.length > 20) {
      console.log(
        "[TY Proxy] ✅ access_token cookie kullanılıyor:",
        summarizeJwt(accessCookie.value),
      );
      return accessCookie.value;
    }
  } catch (e) {
    console.warn("[TY Proxy] access_token cookie hatası:", e);
  }

  try {
    const tgoCookie = await chrome.cookies.get({
      url: "https://tgoyemek.com",
      name: "tgo-token",
    });
    if (tgoCookie && tgoCookie.value && tgoCookie.value.length > 20) {
      console.log(
        "[TY Proxy] ✅ tgo-token cookie kullanılıyor:",
        summarizeJwt(tgoCookie.value),
      );
      return tgoCookie.value;
    }
  } catch (e) {
    console.warn("[TY Proxy] tgo-token cookie hatası:", e);
  }

  console.error(
    "[TY Proxy] ❌ Token bulunamadı! Lütfen tekrar giriş yapın.",
  );
  return null;
}

// ═════════════════════════════════════════════════════════════════
// v37: Payment button fix — referanstan eksik ROOT-level fields eklendi (totalSellingPrice, totalSellerPaidDiscount, etc.)
// v36: Payment button fix — groupedProducts.id eklendi + isCheckoutEnabled/isMinBasketMet mobil API'den alınıyor
// v12: Tüm Trendyol mobil API trafiği PHP proxy üzerinden
// ═════════════════════════════════════════════════════════════════
// Tüm sepet, adres, shipping, kupon mobil API'ye gider.
// Browser fetch'i mobil API'de TLS/JA3 fingerprint sorunu yaşadığı için
// kuponstore.com/api/token/proxy.php (generic) ve apply-coupon.php (kupon)
// üzerinden curl ile çağrılır.

// Web checkout URL → Mobil API URL dönüşümü

async function getTrendyolWebToken() {
  try {
    let c = await chrome.cookies.get({ url: "https://tgoyemek.com/api/app-context", name: "tgo-token" }).catch(() => null);
    if (c && c.value) return c.value;
    const s = await chrome.storage.local.get(["tgoWebToken", "trendyolWebToken"]).catch(() => ({}));
    if (s && s.tgoWebToken) return s.tgoWebToken;
    if (s && s.trendyolWebToken) return s.trendyolWebToken;
    c = await chrome.cookies.get({ url: "https://tgoyemek.com", name: "tgo-token" }).catch(() => null);
    if (c && c.value) return c.value;
    c = await chrome.cookies.get({ url: "https://tgoyemek.com", name: "access_token" }).catch(() => null);
    if (c && c.value) return c.value;
    return await getTrendyolToken();
  } catch (e) {
    return await getTrendyolToken();
  }
}

function dhBuildTgoMobileHeaders(token, signals) {
  const devId = generateRandomHex(16);
  const sid = generateUUID();
  const pid = generateUUID();
  const uid = generateRandomHex(16);
  const tyUid = generateUUID();
  const tpaydid = generateUUID();
  const auth = token.toLowerCase().startsWith("bearer ") ? token : "Bearer " + token;

  return {
    Host: "api.tgoapis.com",
    Deviceid: devId,
    "Bff-Token-Validation": "true",
    "X-Features": "OPTIONAL_REBATE;TRENDYOLPAY_ENABLED;MEAL_CART_ENABLED;MEAL_CARD_TRENDYOL_PROMOTION;DELIVERY_FEE_SUMMARY_HIDDEN",
    "X-Application-Id": "5",
    Cl_eligible: "false",
    Sid: sid,
    Pid: pid,
    Build: "2.5.3.335",
    Platform: "Android",
    "Device-Language": "tr",
    Osversion: "9",
    Isemulator: "false",
    "X-Channelid": "4",
    "X-Device-Signals-Payload": signals?.payload || "",
    "X-Device-Signals-Signature": signals?.signature || "",
    Uniqueid: uid,
    Tpaydid: tpaydid,
    "Accept-Language": "tr-TR",
    "X-Storefront-Id": "1",
    Searchsegment: "67",
    Gender: "F",
    "X-Visitor-Type": "4",
    Segments: "140750000_0,410750000_1,365750000_generic_6",
    "App-Name": "TrendyolGo",
    "Lc-Member": "true",
    "Ty-Uniqueid": tyUid,
    "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 9; SM-N935F Build/PQ3A.190605.09261140) TrendyolGo/2.5.3.335",
    Authorization: auth,
    "Content-Type": "application/json; charset=UTF-8",
  };
}

/** Adres sync sonrası saklanan lat/lng/city — sayfa boş koordinat gönderince discovery kırılıyor */
async function resolveTyGeoContext() {
  const out = { lat: 0, lng: 0, cityId: null, districtId: null };
  try {
    const stor = await chrome.storage.local.get([
      "tyAddressPayload",
      "savedAddress",
      "kuponstore_addresses",
    ]);
    const p = stor.tyAddressPayload || {};
    let lat = parseFloat(p.latitude || p.lat) || 0;
    let lng = parseFloat(p.longitude || p.lng || p.lon) || 0;
    let cityId = p.cityId || p.tyCityId || null;
    let districtId = p.districtId || p.tyDistrictId || null;

    if (!(lat && lng) && stor.savedAddress) {
      lat = parseFloat(stor.savedAddress.latitude || stor.savedAddress.lat) || 0;
      lng =
        parseFloat(stor.savedAddress.longitude || stor.savedAddress.lng || stor.savedAddress.lon) ||
        0;
    }
    if (!(lat && lng) && Array.isArray(stor.kuponstore_addresses)) {
      const a =
        stor.kuponstore_addresses.find((x) => x && x.isActive) ||
        stor.kuponstore_addresses[stor.kuponstore_addresses.length - 1];
      if (a) {
        lat = parseFloat(a.latitude || a.lat) || 0;
        lng = parseFloat(a.longitude || a.lng || a.lon) || 0;
      }
    }
    if (!(lat && lng)) {
      try {
        const c = await chrome.cookies.get({
          url: "https://tgoyemek.com/",
          name: "tgo-address",
        });
        if (c && c.value) {
          const raw = decodeURIComponent(c.value);
          const j = JSON.parse(raw);
          lat = parseFloat(j.latitude || j.lat) || 0;
          lng = parseFloat(j.longitude || j.lon || j.lng) || 0;
        }
      } catch (_) {}
    }
    out.lat = lat;
    out.lng = lng;
    out.cityId = cityId;
    out.districtId = districtId;
  } catch (_) {}
  return out;
}

function enrichTyProxyUrlWithGeo(url, geo) {
  if (!url || typeof url !== "string" || !geo || !(geo.lat && geo.lng)) return url;
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return url;
  }
  const hasLatKey =
    u.searchParams.has("latitude") ||
    u.searchParams.has("lat") ||
    /[?&]latitude=/.test(url) ||
    /[?&]lat=/.test(url);
  const hasLngKey =
    u.searchParams.has("longitude") ||
    u.searchParams.has("lng") ||
    u.searchParams.has("lon") ||
    /[?&]longitude=/.test(url) ||
    /[?&]lng=/.test(url) ||
    /[?&]lon=/.test(url);

  // Sadece discovery / filtre / flashsale URL'lerine query lat ekle.
  // Checkout shipping gibi body-only endpoint'lere query param basma.
  const isDiscovery =
    /apidiscovery-santral|web-discovery|apirestaurant|restaurantdetail|web-restaurant|flashsale|suggestions\/|homepage\/|restaurants\/(?:filters|\d+)|collectionView|coupons\?/i.test(
      url,
    );

  if (!hasLatKey && !hasLngKey && !isDiscovery) return url;

  const curLat = parseFloat(u.searchParams.get("latitude") || u.searchParams.get("lat") || "") || 0;
  const curLng =
    parseFloat(
      u.searchParams.get("longitude") ||
        u.searchParams.get("lng") ||
        u.searchParams.get("lon") ||
        "",
    ) || 0;

  // Boş lat/lng VEYA İzmir varsayılanına (38.4/27.08) sapmış istekleri adres koordinatına çek
  const looksEmpty = !curLat || !curLng;
  const looksIzmirDefault =
    Math.abs(curLat - 38.4) < 0.05 && Math.abs(curLng - 27.08) < 0.08;
  const farFromStored =
    curLat &&
    curLng &&
    (Math.abs(curLat - geo.lat) > 0.35 || Math.abs(curLng - geo.lng) > 0.35);

  if (looksEmpty || looksIzmirDefault || (isDiscovery && farFromStored && looksIzmirDefault)) {
    if (u.searchParams.has("latitude") || hasLatKey || isDiscovery) {
      u.searchParams.set("latitude", String(geo.lat));
    }
    if (u.searchParams.has("longitude") || hasLngKey || isDiscovery) {
      u.searchParams.set("longitude", String(geo.lng));
    }
    if (u.searchParams.has("lat") && !u.searchParams.has("latitude")) {
      u.searchParams.set("lat", String(geo.lat));
    }
    if (
      (u.searchParams.has("lng") || u.searchParams.has("lon")) &&
      !u.searchParams.has("longitude")
    ) {
      if (u.searchParams.has("lng")) u.searchParams.set("lng", String(geo.lng));
      if (u.searchParams.has("lon")) u.searchParams.set("lon", String(geo.lng));
    }
  }

  if (geo.cityId != null && geo.districtId != null) {
    const cc = u.searchParams.get("cityCode") || u.searchParams.get("cityId");
    const dd = u.searchParams.get("districtId");
    if (u.searchParams.has("cityCode") && (!cc || cc === "0")) {
      u.searchParams.set("cityCode", String(geo.cityId));
    }
    if (u.searchParams.has("cityId") && (!cc || cc === "0")) {
      u.searchParams.set("cityId", String(geo.cityId));
    }
    if (u.searchParams.has("districtId") && (!dd || dd === "0")) {
      u.searchParams.set("districtId", String(geo.districtId));
    }
  }

  return u.toString();
}

function enrichTyProxyBodyWithGeo(body, geo) {
  if (!geo || !(geo.lat && geo.lng) || body == null) return body;
  let obj = null;
  let asString = typeof body === "string";
  try {
    obj = asString ? JSON.parse(body) : body;
  } catch (_) {
    return body;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return body;

  const curLat = parseFloat(obj.latitude ?? obj.lat ?? "") || 0;
  const curLng = parseFloat(obj.longitude ?? obj.lng ?? obj.lon ?? "") || 0;
  const looksEmpty = !curLat || !curLng;
  const looksIzmirDefault =
    Math.abs(curLat - 38.4) < 0.05 && Math.abs(curLng - 27.08) < 0.08;

  if (looksEmpty || looksIzmirDefault) {
    if ("latitude" in obj || "lat" in obj || looksEmpty) {
      if ("lat" in obj && !("latitude" in obj)) obj.lat = geo.lat;
      else obj.latitude = geo.lat;
    }
    if ("longitude" in obj || "lng" in obj || "lon" in obj || looksEmpty) {
      if ("lon" in obj && !("longitude" in obj) && !("lng" in obj)) obj.lon = geo.lng;
      else if ("lng" in obj && !("longitude" in obj)) obj.lng = geo.lng;
      else obj.longitude = geo.lng;
    }
  }
  return asString ? JSON.stringify(obj) : obj;
}

async function enrichTyProxyRequestGeo(req) {
  if (!req || !req.url) return req;
  const geo = await resolveTyGeoContext();
  if (!(geo.lat && geo.lng)) return req;
  const before = req.url;
  const nextUrl = enrichTyProxyUrlWithGeo(req.url, geo);
  let nextBody = req.body;
  if (
    /shipping|checkout|discovery|flashsale|coupons|carts/i.test(req.url) &&
    req.body != null
  ) {
    nextBody = enrichTyProxyBodyWithGeo(req.body, geo);
  }
  if (nextUrl !== before) {
    console.log(
      "[TY GeoFix] URL lat/lng düzeltildi:",
      before.replace(/^https?:\/\/[^/]+/, ""),
      "→",
      nextUrl.replace(/^https?:\/\/[^/]+/, ""),
    );
  }
  if (nextUrl !== before || nextBody !== req.body) {
    return { ...req, url: nextUrl, body: nextBody };
  }
  return req;
}

async function executeTgoProxyRequest(req) {
  const url = req.url;
  const method = (req.method || "GET").toUpperCase();
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: "https://tgoyemek.com",
    Referer: "https://tgoyemek.com/",
    ...(req.headers || {}),
  };
  const token = (await getTrendyolWebToken()) || (await getTrendyolToken());
  if (token && !headers["Authorization"] && !headers["authorization"]) {
    headers["Authorization"] = /^bearer\s/i.test(token) ? token : "Bearer " + token;
  }
  const fetchOpts = {
    method,
    headers,
    credentials: "include",
  };
  if (method !== "GET" && method !== "HEAD" && req.body != null) {
    fetchOpts.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }
  try {
    const resp = await fetch(url, fetchOpts);
    const text = await resp.text();
    const respHeaders = {};
    resp.headers.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v;
    });
    return {
      success: resp.ok,
      status: resp.status,
      statusText: resp.statusText || "",
      data: text,
      headers: respHeaders,
      error: resp.ok ? null : "HTTP " + resp.status,
    };
  } catch (e) {
    return {
      success: false,
      status: 0,
      data: "",
      error: e?.message || "TGO proxy failed",
    };
  }
}

async function executeTgoPaymentRequest(req) {
  const url = req.url;
  const method = (req.method || "GET").toUpperCase();
  const token = (await getTrendyolWebToken()) || (await getTrendyolToken());
  const auth = /^bearer\s/i.test(token) ? token : "Bearer " + token;
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "x-storefrontid": "1",
    "x-applicationid": "1",
    "x-features": "OPTIONAL_REBATE;PICKUP_FEE_ENABLED;VAS_QUANTITY_ENABLED;MEAL_CART_ENABLED;MEAL_CARD_TRENDYOL_PROMOTION;",
    "accept-language": "tr-TR",
    "x-session-id": "",
    "x-personalization-id": "",
    "x-channelid": "4",
    "app-name": "TrendyolGo",
    "x-supported-payment-options": "MULTINET;SODEXO;EDENRED;ON_DELIVERY;SETCARD;CARD;CASH",
    Authorization: auth,
    ...(req.headers || {}),
  };
  const fetchOpts = {
    method,
    headers,
    credentials: "include",
    cache: "no-store",
  };
  if (method !== "GET" && method !== "HEAD" && req.body != null) {
    fetchOpts.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }
  try {
    const resp = await fetch(url, fetchOpts);
    const text = await resp.text();
    const respHeaders = {};
    resp.headers.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v;
    });
    return {
      success: resp.ok,
      status: resp.status,
      statusText: resp.statusText || "",
      data: text,
      headers: respHeaders,
      error: resp.ok ? null : "HTTP " + resp.status,
    };
  } catch (e) {
    return {
      success: false,
      status: 0,
      data: "",
      error: e?.message || "TGO payment failed",
    };
  }
}

async function executeTgoMobileCartRequest(req) {
  const token = await getTrendyolToken();
  if (!token) return { success: false, status: 401, data: "", error: "No TGO token" };

  let signals = { payload: "", signature: "" };
  try {
    signals = await generateTrendyolDeviceSignals({ version: "2.5.3.335" });
  } catch (_) {}
  const headers = dhBuildTgoMobileHeaders(token, signals);

  const isCodePromotions = req.url.includes("/code-promotions");
  const isCoupons = req.url.includes("/coupons");
  const isCartItems = req.url.includes("/carts/items") || req.url.includes("/carts/multiple/items");
  const isGeneralCart = !isCodePromotions && !isCoupons && !isCartItems;

  if (isGeneralCart) {
    const mobileUrl = toMobileUrl(req.url);
    try {
      const fetchOpts = {
        method: req.method || "GET",
        headers,
      };
      if (req.body && req.method !== "GET" && req.method !== "HEAD") {
        fetchOpts.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      }
      const resp = await fetch(mobileUrl, fetchOpts);
      const text = await resp.text();
      const respHeaders = {};
      resp.headers.forEach((v, k) => {
        respHeaders[k.toLowerCase()] = v;
      });
      if (resp.status === 200 && text) {
        try {
          const mobileData = JSON.parse(text);
          const webData = transformMobileToWebAPI(mobileData, false);
          return { success: true, status: 200, statusText: "OK", data: JSON.stringify(webData), headers: respHeaders };
        } catch (_) {}
      }
      return { success: resp.ok, status: resp.status, statusText: resp.statusText || "", data: text, headers: respHeaders };
    } catch (e) {
      return { success: false, status: 0, data: "", error: e?.message || "Mobile cart fetch failed" };
    }
  }

  // Address and shipping binding before cart mutations:
  try {
    const addrHeaders = { ...headers, "X-Channelid": "3" };
    const addrResp = await fetch(
      "https://api.tgoapis.com/localcommerce-member-zeususer-service/addresses?getCities=false&appName=TrendyolGo&channelId=3",
      { method: "GET", headers: addrHeaders }
    );
    if (addrResp.ok) {
      const addrData = await addrResp.json();
      const addrs = addrData?.addresses || (Array.isArray(addrData) ? addrData : []);
      if (addrs.length > 0) {
        let preferredId = null;
        try {
          const pref = await chrome.storage.local.get(["tyAddressPayload"]);
          preferredId = pref.tyAddressPayload?.newAddressId
            ? String(pref.tyAddressPayload.newAddressId)
            : null;
        } catch (_) {}
        let a = preferredId
          ? addrs.find((x) => String(x.addressId || x.id) === preferredId)
          : null;
        if (!a) a = addrs[addrs.length - 1];
        const addrId = a.addressId || a.id;
        const lat = a.lat || a.latitude || 0;
        const lon = a.lon || a.longitude || 0;
        await fetch("https://api.tgoapis.com/meal-mmcheckout-sfxcarts-santral/shipping", {
          method: "POST",
          headers: { ...headers, "X-Channelid": "3" },
          body: JSON.stringify({ invoiceAddressId: addrId, shippingAddressId: addrId, latitude: lat, longitude: lon }),
        });
      }
    }
  } catch (_) {}

  // Fetch items mutation
  try {
    let fetchUrl = toMobileUrl(req.url);
    let reqMethod = (req.method || "POST").toUpperCase();
    let reqBody = req.body;

    if (reqMethod === "POST" && /\/carts\/items/i.test(fetchUrl) && reqBody) {
      try {
        const bodyObj = typeof reqBody === "string" ? JSON.parse(reqBody) : reqBody;
        if (bodyObj && (bodyObj.quantity === 0 || bodyObj.quantity === "0")) {
          const itemId = bodyObj.itemId || bodyObj.id || bodyObj.cartItemId;
          reqMethod = "DELETE";
          reqBody = null;
          if (itemId && !new RegExp("/carts/items/" + itemId + "(\\?|$)", "i").test(fetchUrl)) {
            fetchUrl = fetchUrl.replace(/\/carts\/items(?=\?|$)/i, "/carts/items/" + itemId);
          }
        }
      } catch (_) {}
    }

    const fetchOpts = {
      method: reqMethod,
      headers,
    };
    if (reqBody != null && reqMethod !== "GET" && reqMethod !== "HEAD") {
      fetchOpts.body = typeof reqBody === "string" ? reqBody : JSON.stringify(reqBody);
    }
    const resp = await fetch(fetchUrl, fetchOpts);
    let text = await resp.text();
    const respHeaders = {};
    resp.headers.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v;
    });

    if (resp.ok) {
      if (!text || !text.trim()) {
        const getCartUrl = "https://api.tgoapis.com/meal-mmcheckout-sfxcarts-santral/carts?appName=TrendyolGo&channelId=4";
        const getResp = await fetch(getCartUrl, { method: "GET", headers });
        if (getResp.ok) text = await getResp.text();
      }
      if (text && text.trim()) {
        try {
          const mobileData = JSON.parse(text);
          const webData = transformMobileToWebAPI(mobileData, false);
          return { success: true, status: 200, statusText: "OK", data: JSON.stringify(webData), headers: respHeaders };
        } catch (_) {}
      }
    }
    return { success: resp.ok, status: resp.status, statusText: resp.statusText || "", data: text, headers: respHeaders };
  } catch (e) {
    return { success: false, status: 0, data: "", error: e?.message || "Mobile cart items failed" };
  }
}

/**
 * Proactive Zeus user completion:
 * Checks GET https://api.tgoapis.com/localcommerce-member-zeususer-service/user?appName=TrendyolGo&channelId=3
 * If firstName, lastName or gender is missing, updates them via POST/PATCH!
 */
async function completeTrendyolUserInfo(tokenOverride) {
  const _setMissingCk = (name) =>
    chrome.cookies.set({
      url: "https://tgoyemek.com",
      name,
      value: "true",
      domain: "tgoyemek.com",
      secure: true,
      httpOnly: false,
      sameSite: "lax",
      path: "/",
    }).catch(() => {});
  await _setMissingCk("tgo-missing-user-info-popup-date");
  await _setMissingCk("tgo-missing-user-info-popup-basket-date");

  const checkoutPaths = ["/odeme", "/odeme-basarili"];
  const mobileCookieNames = [
    "platform",
    "token",
    "mobile-token",
    "channel-id",
    "storefrontId",
    "countryCode",
    "language",
    "AZ_SELECTED",
  ];

  const stor = await chrome.storage.local.get([
    "tyMobileToken",
    "tyToken",
    "trendyolWebToken",
    "tgoWebToken",
    "tgoMobileToken",
    "tyAccountPhone",
  ]);
  let webTok = stor.tgoWebToken || stor.trendyolWebToken || "";
  let mobileTok = stor.tgoMobileToken || stor.tyMobileToken || stor.tyToken || "";
  const primary = tokenOverride || "";
  if (primary) {
    if (primary.length >= 600 || (typeof looksLikeMobileJwt === "function" && looksLikeMobileJwt(primary))) {
      mobileTok = primary;
    } else {
      webTok = primary;
    }
  }
  const tokenToUse = mobileTok || webTok;
  if (!tokenToUse) {
    console.warn("[Trendyol] completeTrendyolUserInfo: token yok");
    return true;
  }

  const mobileCookieValues = {
    platform: "ANDROID",
    token: tokenToUse,
    "mobile-token": tokenToUse,
    "channel-id": "4",
    storefrontId: "1",
    countryCode: "TR",
    language: "tr",
    AZ_SELECTED: "false",
  };
  for (const ckPath of checkoutPaths) {
    for (const ckName of mobileCookieNames) {
      for (const dom of ["tgoyemek.com", ".tgoyemek.com"]) {
        await chrome.cookies.set({
          url: "https://" + dom.replace(/^\./, '') + ckPath,
          name: ckName,
          value: mobileCookieValues[ckName],
          domain: dom,
          secure: true,
          httpOnly: false,
          sameSite: "lax",
          path: ckPath,
        }).catch(() => {});
      }
    }
  }

  const zeusHeaders = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: /^bearer\s/i.test(tokenToUse) ? tokenToUse : "Bearer " + tokenToUse,
    "App-Name": "TrendyolGo",
    "X-Channelid": "3",
    Build: "2.5.3.335",
    Platform: "Android",
    Osversion: "9",
  };

  const zeusUrl = "https://api.tgoapis.com/localcommerce-member-zeususer-service/user?appName=TrendyolGo&channelId=3";

  try {
    const getRes = await fetch(zeusUrl, { method: "GET", headers: zeusHeaders });
    let userData = null;
    if (getRes.ok) {
      userData = await getRes.json().catch(() => null);
    }
    const user = userData && typeof userData === "object" ? userData : {};
    const firstName = user.firstName || "";
    const lastName = user.lastName || "";
    const gender = user.gender || "";

    if (!firstName || !lastName || !gender) {
      const FIRST_NAMES = ["Ali", "Mehmet", "Emre", "Mustafa", "Can", "Burak", "Efe", "Ahmet"];
      const LAST_NAMES = ["Yilmaz", "Kaya", "Demir", "Celik", "Sahin", "Aydin", "Ozdemir"];
      const patchBody = {
        firstName: firstName || FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)],
        lastName: lastName || LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)],
        gender: gender || (Math.random() > 0.5 ? "MALE" : "FEMALE"),
      };

      for (const m of ["POST", "PATCH"]) {
        try {
          const updateRes = await fetch(zeusUrl, {
            method: m,
            headers: zeusHeaders,
            body: JSON.stringify(patchBody),
          });
          if (updateRes.ok || updateRes.status === 200 || updateRes.status === 204) {
            console.log("[Trendyol] Zeus user profile completed successfully with " + m);
            break;
          }
        } catch (_) {}
      }
    } else {
      console.log("[Trendyol] Zeus user profile already complete:", firstName, lastName, gender);
    }
    return true;
  } catch (err) {
    console.warn("[Trendyol] Zeus user service error:", err);
    return false;
  }
}

function toMobileUrl(rawUrl) {
  let u = rawUrl || "";
  // tgoyemek.com/... or /api/... → api.tgoapis.com/...
  u = u.replace(
    /^https?:\/\/(www\.)?tgoyemek\.com(\/api)?\//i,
    "https://api.tgoapis.com/",
  );
  // If relative URL, prepend https://api.tgoapis.com
  if (!/^https?:\/\//i.test(u)) {
    if (!u.startsWith("/")) u = "/" + u;
    u = "https://api.tgoapis.com" + u;
  }
  // web-checkout-apicheckout-santral → meal-mmcheckout-sfxcarts-santral
  u = u.replace(
    "/web-checkout-apicheckout-santral/",
    "/meal-mmcheckout-sfxcarts-santral/",
  );
  // Ensure meal-mmcheckout-sfxcarts-santral prefix if naked /carts
  if (!u.includes("/meal-mmcheckout-sfxcarts-santral/") && u.includes("/carts")) {
    u = u.replace(/\/carts(\/|\?|$)/, "/meal-mmcheckout-sfxcarts-santral/carts$1");
  }
  return u;
}

let _ksMobileShipBoundAt = 0;
async function ksEnsureMobileShipping(token, force) {
  if (!token) return;
  if (!force && Date.now() - _ksMobileShipBoundAt < 45000) return;
  try {
    const deviceId = generateUUID();
    const uniqueId = generateRandomHex(16);
    const tyUniqueId = generateUUID();
    const sessionId = generateUUID();
    const processId = generateUUID();
    const tpaydid = generateUUID();
    let ds = { payload: "", signature: "" };
    try {
      ds = await generateTrendyolDeviceSignals({ version: "2.5.3.335" });
    } catch (_) {}
    const auth = token.toLowerCase().startsWith("bearer ") ? token : "bearer " + token;
    const base = {
      Host: "api.tgoapis.com",
      Deviceid: deviceId,
      "Bff-Token-Validation": "true",
      "X-Features": "OPTIONAL_REBATE;TRENDYOLPAY_ENABLED",
      "X-Application-Id": "5",
      Cl_eligible: "false",
      Sid: sessionId,
      Pid: processId,
      Build: "2.5.3.335",
      Platform: "Android",
      "Device-Language": "tr",
      Osversion: "9",
      Isemulator: "false",
      "X-Channelid": "3",
      Uniqueid: uniqueId,
      Tpaydid: tpaydid,
      "Accept-Language": "tr-TR",
      "X-Storefront-Id": "1",
      Searchsegment: "9",
      Gender: "F",
      "X-Visitor-Type": "4",
      Segments: TY_DISCOUNT_SEGMENTS,
      "App-Name": "TrendyolGo",
      "Lc-Member": "true",
      "Ty-Uniqueid": tyUniqueId,
      "User-Agent":
        "Dalvik/2.1.0 (Linux; U; Android 9; SM-N935F Build/PQ3A.190605.09261140) TrendyolGo/2.5.3.335",
      Authorization: auth,
    };
    if (ds.payload) {
      base["X-Device-Signals-Payload"] = ds.payload;
      base["X-Device-Signals-Signature"] = ds.signature;
    }

    let addressId = null;
    let lat = 0;
    let lon = 0;

    try {
      const addrResp = await fetch(
        "https://api.tgoapis.com/localcommerce-member-zeususer-service/addresses?getCities=false&appName=TrendyolGo&channelId=3",
        { method: "GET", headers: Object.assign({ "Content-Type": "application/json" }, base) },
      );
      if (addrResp.ok) {
        const addrData = await addrResp.json();
        const addrs = addrData?.addresses || (Array.isArray(addrData) ? addrData : []);
        let preferredId = null;
        try {
          const pref = await chrome.storage.local.get(["tyAddressPayload"]);
          preferredId = pref.tyAddressPayload?.newAddressId
            ? String(pref.tyAddressPayload.newAddressId)
            : null;
        } catch (_) {}
        let chosen = null;
        if (preferredId && addrs.length) {
          chosen = addrs.find(
            (a) => String(a.addressId || a.id) === preferredId,
          );
        }
        if (!chosen && addrs.length) chosen = addrs[addrs.length - 1];
        if (chosen) {
          addressId = chosen.addressId || chosen.id;
          lat = chosen.lat || chosen.latitude || 0;
          lon = chosen.lon || chosen.longitude || 0;
        }
      }
    } catch (_) {}

    if (!addressId) {
      try {
        const stor = await chrome.storage.local.get(["tyAddressPayload", "savedAddress", "kuponstore_addresses"]);
        if (stor.tyAddressPayload?.newAddressId) {
          addressId = stor.tyAddressPayload.newAddressId;
          lat = parseFloat(stor.tyAddressPayload.latitude) || 0;
          lon = parseFloat(stor.tyAddressPayload.longitude) || 0;
        } else if (stor.savedAddress?.id || stor.savedAddress?.addressId) {
          addressId = stor.savedAddress.id || stor.savedAddress.addressId;
          lat = parseFloat(stor.savedAddress.latitude || stor.savedAddress.lat) || 0;
          lon = parseFloat(stor.savedAddress.longitude || stor.savedAddress.lon) || 0;
        } else if (Array.isArray(stor.kuponstore_addresses) && stor.kuponstore_addresses.length > 0) {
          const a =
            stor.kuponstore_addresses.find((x) => x && x.isActive) ||
            stor.kuponstore_addresses[stor.kuponstore_addresses.length - 1];
          addressId = a.id || a.addressId;
          lat = parseFloat(a.latitude || a.lat) || 0;
          lon = parseFloat(a.longitude || a.lon) || 0;
        }
      } catch (_) {}
    }

    if (!addressId) return;

    const shipResp = await fetch("https://api.tgoapis.com/meal-mmcheckout-sfxcarts-santral/shipping", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json; charset=UTF-8" }, base),
      body: JSON.stringify({
        invoiceAddressId: addressId,
        shippingAddressId: addressId,
        latitude: lat,
        longitude: lon,
      }),
    });
    if (shipResp.ok) {
      _ksMobileShipBoundAt = Date.now();
      console.log("[TY Proxy v33] Mobil shipping bind başarılı (adres)", addressId);
    }
  } catch (e) {
    console.warn("[TY Proxy v33] Mobil shipping bind hata:", e?.message || e);
  }
}

async function tyClearMobileCartViaProxy(token, logLabel) {
  const delUrl =
    "https://api.tgoapis.com/meal-mmcheckout-sfxcarts-santral/carts?appName=TrendyolGo&channelId=4";
  try {
    const resp = await fetch("https://kuponstore.com/api/token/proxy.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mobile_token: token,
        method: "DELETE",
        url: delUrl,
        body: "",
      }),
    });
    const txt = await resp.text();
    let j = null;
    try {
      j = JSON.parse(txt);
    } catch (_) {}
    const http = j?.http ?? j?.status ?? resp.status;
    console.log(
      "[TY Proxy v12]",
      logLabel || "mobil sepet temizle",
      "→ HTTP",
      http,
    );
    return http;
  } catch (e) {
    console.warn("[TY Proxy v12] mobil sepet temizle hata:", e?.message || e);
    return 0;
  }
}

function buildEmptyWebCartResponse(stor) {
  const addrId = stor?.tyAddressPayload?.newAddressId || null;
  const webData = transformMobileToWebAPI(
    {
      totalProductPrice: 0,
      totalProductPriceDiscounted: 0,
      totalPrice: 0,
      totalProductCount: 0,
      groupedProducts: [],
      summary: [],
      channelSummary: { promotions: [] },
      shippingAddressId: addrId,
      invoiceAddressId: addrId,
    },
    false,
  );
  if (addrId) {
    const n = parseInt(String(addrId), 10);
    webData.shippingAddressId = Number.isFinite(n) ? n : addrId;
    webData.invoiceAddressId = webData.shippingAddressId;
  }
  return JSON.stringify(webData);
}

let _tyPrePaymentMergeInflight = null;
let _tyPayBasketFrozenAt = 0;
let _ksLastPayOptionsOk = "";
let _ksLastPayCartOk = null;
let _ksLastCouponsOk = null;

function ksFrozenOk(data, extra) {
  return Object.assign(
    {
      success: true,
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      data: data == null ? "" : data,
    },
    extra || {},
  );
}

// v32: Ödeme kilidi devre dışı — tüm istekler her zaman doğrudan API'ye gider
function ksFreezePayBasket(reason) {
  // DEVRE DIŞI: console.log("[TY Proxy] sepet kilit devre dışı:", reason || "");
}

function ksPayBasketFrozen() {
  return false;
}

async function runTyPrePaymentMergeCore() {
  if (ksPayBasketFrozen()) {
    console.log("[TY PrePaymentMerge] atlandı (ödeme sepet kilit)");
    return { success: true, skipped: true };
  }
  try {
    const odeme = await chrome.storage.local.get(["tyOdemePageActive"]);
    if (odeme.tyOdemePageActive) {
      console.log("[TY PrePaymentMerge] atlandı (/odeme)");
      return { success: true, skipped: true };
    }
  } catch (_) {}
  const tyToken = await getTrendyolToken();
  if (!tyToken) throw new Error("no_mobil_token");

  try {
    const stor = await chrome.storage.local.get(["tyAddressPayload"]);
    const p = stor.tyAddressPayload;
    if (p && p.latitude && p.longitude) {
      const shipPayload = {
        mobile_token: tyToken,
        method: "POST",
        url: "https://api.tgoapis.com/meal-mmcheckout-sfxcarts-santral/shipping?appName=TrendyolGo&channelId=4",
        body: {
          latitude: parseFloat(p.latitude),
          longitude: parseFloat(p.longitude),
        },
      };
      const shipRes = await fetch(
        "https://kuponstore.com/api/token/proxy.php",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(shipPayload),
        },
      );
      const shipRaw = await shipRes.text();
      let shipJson = null;
      try {
        shipJson = JSON.parse(shipRaw);
      } catch (_) {}
      console.log(
        "[TY PrePaymentMerge] shipping → HTTP",
        shipJson?.http ?? shipRes.status,
      );
    }
  } catch (e) {
    console.warn("[TY PrePaymentMerge] shipping:", e?.message);
  }

  const http = await tyMergeCartViaProxy(tyToken, "SPA /odeme oncesi");
  return { success: true, mergeHttp: http };
}

/** Backend'de guest/web/mobile sepet birleştirme. */
async function tyMergeCartViaProxy(token, logLabel) {
  if (ksPayBasketFrozen()) {
    console.log(
      "[TY Proxy v12]",
      logLabel || "merge",
      "atlandı (ödeme sepet kilit)",
    );
    return 200;
  }
  try {
    const odeme = await chrome.storage.local.get(["tyOdemePageActive"]);
    if (odeme.tyOdemePageActive) {
      console.log(
        "[TY Proxy v12]",
        logLabel || "merge",
        "atlandı (/odeme — sepet korunuyor)",
      );
      return 200;
    }
  } catch (_) {}
  // Merge lokasyonu: sabit 105/15 kullanma — eklenen adresin city/district'i olmali.
  // Aksi halde "Seçtiğiniz bölgeye şu anda hizmet veremiyoruz" gelir.
  let mergeCityId = 0;
  let mergeDistrictId = 0;
  try {
    const locStor = await chrome.storage.local.get([
      "tyAddressPayload",
      "savedAddress",
      "kuponstore_addresses",
    ]);
    const p = locStor.tyAddressPayload || {};
    mergeCityId = parseInt(p.cityId || p.tyCityId || 0, 10) || 0;
    mergeDistrictId = parseInt(p.districtId || p.tyDistrictId || 0, 10) || 0;
    if ((!mergeCityId || !mergeDistrictId) && locStor.savedAddress) {
      mergeCityId =
        mergeCityId ||
        parseInt(locStor.savedAddress.cityId || locStor.savedAddress.tyCityId || 0, 10) ||
        0;
      mergeDistrictId =
        mergeDistrictId ||
        parseInt(
          locStor.savedAddress.districtId || locStor.savedAddress.tyDistrictId || 0,
          10,
        ) ||
        0;
    }
    if ((!mergeCityId || !mergeDistrictId) && Array.isArray(locStor.kuponstore_addresses)) {
      const a =
        locStor.kuponstore_addresses.find((x) => x && x.isActive) ||
        locStor.kuponstore_addresses[0];
      if (a) {
        mergeCityId = mergeCityId || parseInt(a.cityId || a.tyCityId || 0, 10) || 0;
        mergeDistrictId =
          mergeDistrictId || parseInt(a.districtId || a.tyDistrictId || 0, 10) || 0;
      }
    }
  } catch (_) {}
  if (!mergeCityId || !mergeDistrictId) {
    console.warn(
      "[TY Proxy] merge city/district yok — merge atlandı (sabit 105/15 kullanılmıyor)",
    );
    return 200;
  }
  const mergeUrl =
    "https://api.tgoapis.com/meal-mmcheckout-sfxcarts-santral/carts/merge?shouldFetchCart=false&cityId=" +
    encodeURIComponent(String(mergeCityId)) +
    "&districtId=" +
    encodeURIComponent(String(mergeDistrictId));
  console.log("[TY Proxy] merge loc cityId=", mergeCityId, "districtId=", mergeDistrictId);

  // v32: merge — channelId=3, appName yok, tam header seti
  try {
    const mergeDevId = generateUUID();
    const mergeUniqueId = generateRandomHex(16);
    const mergeTyUniqueId = generateUUID();
    const mergeSessionId = generateUUID();
    const mergeProcessId = generateUUID();
    const mergeTpaydid = generateUUID();
    let mergeDS = { payload: "", signature: "" };
    try { mergeDS = await generateTrendyolDeviceSignals({ version: "2.5.3.335" }); } catch (_) {}
    const mergeHeaders = {
      Host: "api.tgoapis.com",
      Deviceid: mergeDevId,
      "Bff-Token-Validation": "true",
      "X-Features": "OPTIONAL_REBATE;TRENDYOLPAY_ENABLED",
      "X-Application-Id": "5",
      Cl_eligible: "false",
      Sid: mergeSessionId,
      Pid: mergeProcessId,
      Build: "2.5.3.335",
      Platform: "Android",
      "Device-Language": "tr",
      Osversion: "9",
      Isemulator: "false",
      "X-Channelid": "3",
      "Content-Type": "application/json",
      Uniqueid: mergeUniqueId,
      Tpaydid: mergeTpaydid,
      "Accept-Language": "tr-TR",
      "X-Storefront-Id": "1",
      Searchsegment: "9",
      Gender: "F",
      "X-Visitor-Type": "4",
      Segments: TY_DISCOUNT_SEGMENTS,
      "App-Name": "TrendyolGo",
      "Lc-Member": "true",
      "Ty-Uniqueid": mergeTyUniqueId,
      "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 9; SM-N935F Build/PQ3A.190605.09261140) TrendyolGo/2.5.3.335",
      Authorization: token.toLowerCase().startsWith("bearer ") ? token : "bearer " + token,
    };
    if (mergeDS.payload) {
      mergeHeaders["X-Device-Signals-Payload"] = mergeDS.payload;
      mergeHeaders["X-Device-Signals-Signature"] = mergeDS.signature;
    }
    const resp = await fetch(mergeUrl, { method: "POST", headers: mergeHeaders });
    console.log("[TY Proxy v12]", logLabel || "merge", "→ HTTP", resp.status, "(direct)");
    return resp.status;
  } catch (e) {
    console.warn("[TY Proxy v12] merge direct hata:", e?.message || e);
    // Fallback: proxy.php üzerinden
    try {
      const resp2 = await fetch("https://kuponstore.com/api/token/proxy.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mobile_token: token,
          method: "POST",
          url: mergeUrl,
          body: "",
        }),
      });
      const txt = await resp2.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (_) {}
      const http = j?.http ?? j?.status ?? resp2.status;
      console.log("[TY Proxy v12]", logLabel || "merge", "→ HTTP", http, "(proxy fallback)");
      return http;
    } catch (e2) {
      console.warn("[TY Proxy v12] merge fallback hata:", e2?.message || e2);
      return 0;
    }
  }
}

/** /odeme: mobil + web sepetini merge et (payment iframe öncesi). */
async function handleTyPrePaymentMerge(sendResponse) {
  try {
    if (!_tyPrePaymentMergeInflight) {
      _tyPrePaymentMergeInflight = runTyPrePaymentMergeCore().finally(() => {
        setTimeout(() => {
          _tyPrePaymentMergeInflight = null;
        }, 300);
      });
    }
    const result = await _tyPrePaymentMergeInflight;
    sendResponse(result);
  } catch (e) {
    console.warn("[TY PrePaymentMerge]", e);
    sendResponse({ success: false, error: e.message || String(e) });
  }
}

// ═════════════════════════════════════════════════════════════════
// proxy — .com/api/trendyol-proxy
// Format: POST { endpoint, method, body, dsToken }
// Yanıt: Trendyol API response doğrudan (JSON)
// ═════════════════════════════════════════════════════════════════
// Uzak proxy URL kaldırıldı — 401 veriyordu (lisans tokeni)
// v26: Tüm API istekleri background'dan doğrudan api.tgoapis.com'a Bearer token ile gider.

/**
 * KuponStore web API proxy — doğrudan api.tgoapis.com'a Bearer token ile fetch
 * uzak proxy kullanılamaz (uzak lisans tokeni, bizim değil).
 * Bunun yerine background'dan doğrudan fetch yapıyoruz.
 */
async function executeDirectTgoApiRequest(url, method, body) {
  // Token al (web token tercih, mobile fallback)
  const stor = await chrome.storage.local.get([
    "trendyolWebToken",
    "tyToken",
    "tyMobileToken",
  ]);
  const token =
    stor.trendyolWebToken || stor.tyMobileToken || stor.tyToken || "";
  if (!token) {
    throw new Error("Token bulunamadı (direct API)");
  }

  const headers = {
    Accept: "application/json, text/plain, */*",
    Authorization: "Bearer " + token,
    Origin: "https://tgoyemek.com",
    Referer: "https://tgoyemek.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
    "sec-ch-ua":
      '"Not)A;Brand";v="8", "Chromium";v="138", "Microsoft Edge";v="138"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  };
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
  }

  const fetchOpts = {
    method: method || "GET",
    headers,
    credentials: "include",
  };
  if (method !== "GET" && method !== "HEAD" && body != null) {
    fetchOpts.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  console.log("[KS Direct API] →", method, url.substring(0, 80));

  const resp = await fetch(url, fetchOpts);
  const text = await resp.text();
  const respHeaders = {};
  resp.headers.forEach((v, k) => {
    respHeaders[k.toLowerCase()] = v;
  });

  console.log("[KS Direct API] ←", resp.status, text.substring(0, 120));

  return {
    success: resp.ok,
    status: resp.status,
    statusText: resp.statusText || "",
    data: text,
    headers: respHeaders,
    error: resp.ok ? null : "HTTP " + resp.status,
  };
}

function collectPayTokenHits(obj, depth, path, out) {
  if (!obj || typeof obj !== "object" || depth > 6) return;
  const keys = Array.isArray(obj) ? obj.map((_, i) => i) : Object.keys(obj);
  for (const k of keys) {
    const v = obj[k];
    const p = path ? path + "." + k : String(k);
    const kn = String(k);
    if (
      typeof v === "string" &&
      v.length >= 20 &&
      /token|paymenturl|sessionid|checkouttoken/i.test(kn)
    ) {
      out.push({ path: p, len: v.length, value: v });
    } else if (v && typeof v === "object") {
      collectPayTokenHits(v, depth + 1, p, out);
    }
  }
}

function applyPayTokenHits(webData, hits) {
  if (!webData || !hits || !hits.length) return;
  for (const h of hits) {
    const last = String(h.path || "").split(".").pop();
    if (last === "requestToken" && !webData.requestToken) {
      webData.requestToken = h.value;
    }
    if (last === "paymentToken" && !webData.paymentToken) {
      webData.paymentToken = h.value;
    }
    if (last === "checkoutToken" && !webData.checkoutToken) {
      webData.checkoutToken = h.value;
    }
    if (last === "paymentSessionId" && !webData.paymentSessionId) {
      webData.paymentSessionId = h.value;
    }
    if (last === "paymentUrl" && !webData.paymentUrl) {
      webData.paymentUrl = h.value;
    }
  }
  if (!webData.requestToken && hits[0] && hits[0].value) {
    webData.requestToken = hits[0].value;
  }
}

function mergeUnknownCartFields(webData, mobileData) {
  if (!webData || !mobileData || typeof mobileData !== "object") return;
  for (const k of Object.keys(mobileData)) {
    if (webData[k] === undefined) webData[k] = mobileData[k];
  }
}

async function tryWebCheckoutPaymentCart(url) {
  try {
    const webTry = await executeDirectTgoApiRequest(url, "GET", null);
    const headers = webTry.headers || { "content-type": "application/json" };
    if (webTry.status === 200 && webTry.data) {
      let j = null;
      try {
        j = JSON.parse(webTry.data);
      } catch (_) {}
      const webJwt = await ksPickWebPayJwt();
      if (j) ksPatchPayCart(j, webJwt);
      console.log(
        "[TY Proxy] payment cart WEB 200 requestToken=" +
          (j && j.requestToken && ksIsWebPayJwt(j.requestToken)
            ? "web jwt len=" + String(j.requestToken).length
            : "YOK"),
      );
      ksFreezePayBasket("payment cart WEB 200");
      const packed = {
        success: true,
        status: 200,
        statusText: "OK",
        headers,
        data: j ? JSON.stringify(j) : webTry.data,
      };
      _ksLastPayCartOk = packed;
      return packed;
    }
    if (webTry.status === 400) {
      console.log(
        "[TY Proxy] payment cart WEB 400 (minimum tutar) — sayfaya iletiliyor",
        String(webTry.data || "").slice(0, 90),
      );
      return {
        success: true,
        status: 400,
        statusText: "Bad Request",
        headers,
        data: webTry.data,
      };
    }
    console.log("[TY Proxy] payment cart WEB HTTP", webTry.status);
    return null;
  } catch (e) {
    console.warn("[TY Proxy] payment cart WEB", e?.message || e);
    return null;
  }
}

function ksPayAuth(tok) {
  if (!tok) return "";
  return /^bearer\s/i.test(tok) ? tok : "bearer " + tok;
}

function ksIsWebPayJwt(tok) {
  const p = decodeJwtPayload(tok);
  if (!p) return false;
  if (p.role === "anon" || String(p.role || "").toLowerCase() === "anonymous") {
    return false;
  }
  if (p.exp && p.exp * 1000 < Date.now()) return false;
  if (p["urn:trendyol:anonid"]) return false;
  const an = String(p.appName || p.applicationName || "")
    .trim()
    .toLowerCase();
  if (an === "trendyolgo") return false;
  if (an && an !== "lc") return false;
  const aud = String(p.aud || "");
  if (/f[VF]cPrDFBdRHEiKvGhIaRugNfvDHP/i.test(aud)) return false;
  return !!(p.userId || p.sub);
}

async function ksPickWebPayJwt() {
  const stor = await chrome.storage.local.get(["trendyolWebToken"]);
  const cands = [];
  if (stor.trendyolWebToken) cands.push(stor.trendyolWebToken);
  try {
    const tgo = await chrome.cookies.get({
      url: "https://tgoyemek.com/",
      name: "tgo-token",
    });
    if (tgo && tgo.value) cands.push(tgo.value);
    const acc = await chrome.cookies.get({
      url: "https://tgoyemek.com/",
      name: "access_token",
    });
    if (acc && acc.value) cands.push(acc.value);
  } catch (_) {}
  for (let i = 0; i < cands.length; i++) {
    if (ksIsWebPayJwt(cands[i])) return cands[i];
  }
  return "";
}

function ksPatchPayCart(obj, webJwt) {
  if (!obj || typeof obj !== "object") return obj;
  // v35: referans gibi — isCheckoutEnabled/isMinBasketMet FORCE ETMİYORUZ (conflict yaratıyor!)
  // if (obj.isCheckoutEnabled === false || obj.isCheckoutEnabled == null) {
  //   obj.isCheckoutEnabled = true;
  // }
  // if (obj.isMinBasketMet === false || obj.isMinBasketMet == null) {
  //   obj.isMinBasketMet = true;
  // }
  if (!obj.preferences || typeof obj.preferences !== "object") {
    obj.preferences = {};
  }
  obj.preferences.smallBasketFeeAccepted = true;
  if (webJwt && ksIsWebPayJwt(webJwt)) {
    if (!obj.requestToken) {
      obj.requestToken = webJwt;
    }
    if (!obj.paymentToken) {
      obj.paymentToken = webJwt;
    }
  }
  return obj;
}

function ksPayJwtAppName(tok) {
  const p = decodeJwtPayload(tok);
  return String((p && (p.appName || p.applicationName)) || "").toLowerCase();
}

function ksPayErrorTitle(text) {
  try {
    const j = JSON.parse(text);
    return (
      (j.errors && j.errors[0] && (j.errors[0].title || j.errors[0].message)) ||
      j.type ||
      ""
    );
  } catch (_) {
    return "";
  }
}

function ksPayOptionsCount(text) {
  try {
    const j = JSON.parse(text);
    const opts =
      (j && j.payment && j.payment.options) ||
      (j && j.json && j.json.options) ||
      (j && j.options);
    return Array.isArray(opts) ? opts.length : 0;
  } catch (_) {
    return 0;
  }
}

function ksNoteHttp(eventType, status, extra) {
  try {
    if (typeof ksTrack !== "function") return;
    if (!(status >= 400) || status === 401 || status === 403) return;
    const key = eventType + ":" + status;
    const now = Date.now();
    const seen = (self.__ksHttpSeen = self.__ksHttpSeen || {});
    if (seen[key] && now - seen[key] < 60000) return;
    seen[key] = now;
    ksTrack(eventType, {
      platform: "trendyol",
      success: false,
      error_code: "http_" + status,
      service: extra && extra.service ? extra.service : null,
      payload: Object.assign({ http: status }, extra || {}),
    });
  } catch (_) {}
}

function ksPayOkResult(raw, isOptions) {
  const data = raw.text || "";
  if (isOptions) {
    const n = ksPayOptionsCount(data);
    console.log("[TY Payment] options n=" + n, "HTTP", raw.status);
    if (raw.status === 200 && n > 0) _ksLastPayOptionsOk = data;
    ksNoteHttp("payment.http", raw.status, { service: "payment", step: "options" });
  }
  return {
    success: true,
    status: raw.status,
    statusText: raw.statusText || (raw.status === 200 ? "OK" : ""),
    data,
    headers: raw.headers,
    error: raw.status >= 200 && raw.status < 300 ? null : "HTTP " + raw.status,
  };
}

function ksPayWebHeaders(tok, method) {
  const headers = {
    Accept: "*/*",
    "accept-language": "tr-TR",
    "x-storefrontid": "1",
    "x-applicationid": "1",
    "x-channelid": "4",
    "x-features":
      "OPTIONAL_REBATE;MEAL_CART_ENABLED;MEAL_CARD_TRENDYOL_PROMOTION;",
    "x-supported-payment-options":
      "MULTINET;SODEXO;EDENRED;ON_DELIVERY;SETCARD",
    Origin: "https://payment.tgoapps.com",
    Referer:
      "https://payment.tgoapps.com/v3/tgo/card-fragment?application-id=1&storefront-id=1&culture=tr-TR&debug=true",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    Authorization: ksPayAuth(tok),
  };
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function ksPayAndroidHeaders(tok, method) {
  const headers = {
    Accept: "*/*",
    "Accept-Language": "tr-TR",
    Authorization: ksPayAuth(tok),
    "App-Name": "TrendyolGo",
    "X-Application-Id": "5",
    "X-Storefront-Id": "1",
    "X-Channelid": "4",
    "X-Features":
      "OPTIONAL_REBATE;TRENDYOLPAY_ENABLED;MEAL_CART_ENABLED;MEAL_CARD_TRENDYOL_PROMOTION;DELIVERY_FEE_SUMMARY_HIDDEN",
    Platform: "Android",
    "Lc-Member": "true",
    Build: "2.5.3.335",
    "User-Agent":
      "Dalvik/2.1.0 (Linux; U; Android 9; Pixel 3 Build/PQ3A.190605.003) TrendyolGo/2.5.3.335",
    "x-supported-payment-options":
      "MULTINET;SODEXO;EDENRED;ON_DELIVERY;SETCARD",
  };
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

async function ksFetchPaymentRaw(url, method, headers, body) {
  const fetchOpts = {
    method,
    headers,
    credentials: "include",
    cache: "no-store",
  };
  if (method !== "GET" && method !== "HEAD" && body != null) {
    fetchOpts.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(url, fetchOpts);
  const text = await res.text();
  const rh = {};
  res.headers.forEach((v, k) => {
    rh[k.toLowerCase()] = v;
  });
  return {
    status: res.status,
    statusText: res.statusText || "",
    text,
    headers: Object.assign({ "content-type": "application/json" }, rh),
  };
}

async function executeKsTgoPaymentRequest(request) {
  const url = request.url || "";
  if (!/^https:\/\/([a-z0-9.-]+\.)?payment\.tgoapps\.com\//i.test(url)) {
    return { success: false, error: "bad_host", status: 0, data: "", headers: {} };
  }
  const method = (request.method || "GET").toUpperCase();
  const isOptions = /\/v3\/payment\/options/i.test(url);
  const webTok = await ksPickWebPayJwt();
  const iframeAuth = String(
    (request.headers &&
      (request.headers.authorization || request.headers.Authorization)) ||
      "",
  ).replace(/^bearer\s+/i, "");
  const tokens = [];
  function addTok(t) {
    const v = String(t || "")
      .replace(/^bearer\s+/i, "")
      .trim();
    if (!v || tokens.indexOf(v) !== -1) return;
    if (!ksIsWebPayJwt(v)) return;
    tokens.push(v);
  }
  addTok(webTok);
  addTok(iframeAuth);
  if (!tokens.length) {
    return {
      success: false,
      status: 401,
      statusText: "Unauthorized",
      data: JSON.stringify({ payment: { options: [] }, message: "no_web_jwt" }),
      headers: { "content-type": "application/json" },
    };
  }

  const profiles = ["web"];
  let last = null;
  const origBody = request.body;

  async function tryOne(tok, profile, m, body) {
    const headers =
      profile === "android"
        ? ksPayAndroidHeaders(tok, m)
        : ksPayWebHeaders(tok, m);
    console.log(
      "[TY Payment] proxy",
      m,
      profile,
      "jwt len=" + tok.length,
      "app=" + (ksPayJwtAppName(tok) || "?"),
    );
    const raw = await ksFetchPaymentRaw(url, m, headers, body);
    console.log(
      "[TY Payment] proxy ←",
      raw.status,
      profile,
      ksPayErrorTitle(raw.text) || String(raw.text).slice(0, 50),
    );
    last = ksPayOkResult(raw, isOptions);
    return raw.status >= 200 && raw.status < 300;
  }

  for (let i = 0; i < tokens.length; i++) {
    for (let p = 0; p < profiles.length; p++) {
      try {
        if (await tryOne(tokens[i], profiles[p], method, origBody)) return last;
      } catch (e) {
        console.warn("[TY Payment] proxy hata", e?.message || e);
      }
    }
  }

  if (
    isOptions &&
    method !== "GET" &&
    _ksLastPayOptionsOk &&
    last &&
    last.status >= 400
  ) {
    console.log(
      "[TY Payment] POST options HTTP",
      last.status,
      "→ son GET options body",
    );
    return {
      success: true,
      status: 200,
      statusText: "OK",
      data: _ksLastPayOptionsOk,
      headers: { "content-type": "application/json" },
    };
  }

  if (isOptions && method === "GET") {
    const postBody = JSON.stringify({
      paymentType: "payWithCard",
      data: { savedCardId: 0, binCode: "" },
    });
    for (let i = 0; i < tokens.length; i++) {
      for (let p = 0; p < profiles.length; p++) {
        try {
          const postOk = await tryOne(
            tokens[i],
            profiles[p],
            "POST",
            postBody,
          );
          if (!postOk) continue;
          const postLast = last;
          if (await tryOne(tokens[i], profiles[p], "GET", null)) return last;
          last = postLast;
          last.status = 200;
          last.statusText = "OK";
          last.error = null;
          return last;
        } catch (e) {
          console.warn("[TY Payment] proxy POST hata", e?.message || e);
        }
      }
    }
  }

  return (
    last || {
      success: false,
      status: 502,
      data: "{}",
      headers: { "content-type": "application/json" },
    }
  );
}

async function handleTyProxyRequest(request, sendResponse) {
  try {
    if (!request.url) throw new Error("URL eksik");

    // 0. Boş/yanlış latitude=&longitude= → saklanan adres koordinatları (bölge hatası)
    request = await enrichTyProxyRequestGeo(request);

    // 1. Payment endpoints -> executeTgoPaymentRequest
    if (request.url.includes("payment.tgoapps.com")) {
      const res = await executeTgoPaymentRequest(request);
      sendResponse(res);
      return;
    }

    // 2. Cart endpoints (/meal-mmcheckout-sfxcarts-santral/carts, /web-checkout-apicheckout-santral/carts, /carts/items, /carts/multiple/items, /code-promotions, /coupons)
    const isCart = request.url.includes("/meal-mmcheckout-sfxcarts-santral/carts") ||
                   request.url.includes("/web-checkout-apicheckout-santral/carts") ||
                   request.url.includes("/carts/items") ||
                   request.url.includes("/carts/multiple/items") ||
                   request.url.includes("/code-promotions") ||
                   request.url.includes("/coupons");
    if (isCart) {
      return handleTyCartItemsRequest(request, sendResponse);
    }

    // 3. User profile endpoint
    if (request.url.includes("web-user-apimemberuser-santral/user") || request.url.includes("zeususer-service/user")) {
      completeTrendyolUserInfo().catch(() => {});
      const res = await executeDirectTgoApiRequest(request.url, request.method || "GET", request.body || null);
      sendResponse(res);
      return;
    }

    // 4. Default proxy -> executeTgoProxyRequest
    const res = await executeTgoProxyRequest(request);
    sendResponse(res);
  } catch (err) {
    sendResponse({ success: false, status: 0, data: "", error: err?.message || "TGO proxy failed" });
  }
}


async function handleTyProxyRequest_OLD_v11(request, sendResponse) {
  console.log("[TY Proxy] Request başladı:", request.url);

  try {
    if (!request.url) {
      throw new Error("URL eksik");
    }

    const tyToken = await getTrendyolToken();

    if (!tyToken) {
      throw new Error("Trendyol token bulunamadı. Lütfen giriş yapın.");
    }

    console.log("[TY Proxy] Token bulundu, uzunluk:", tyToken.length);

    const token = tyToken;

    // Random ID'ler oluştur - tüm isteklerde aynı kullanılacak
    const deviceId = generateUUID();
    const uniqueId = generateRandomHex(16);
    const tyUniqueId = generateUUID();
    const sessionId = generateUUID();
    const processId = generateUUID();
    const tpaydid = generateUUID();

    const segments = TY_DISCOUNT_SEGMENTS;

    // Helper: Header oluştur (her çağrıda YENİ device signals)
    // NOT: api.tgoapis.com isteklerine HİÇBİR cookie gönderilmez — saf bearer auth.
    // Web session cookie'leri (tgo-pid, tgo-sid vb.) mobil API'de gereksiz, hatta backend
    // bunları görünce "web client" diye işaretleyip 401 dönebiliyor. Bu yüzden Cookie header'ı YOK.
    // Her endpoint için channelId/searchsegment/gender farklı olabilir.
    // - Adres listesi: X-Channelid=4, Searchsegment=20, Gender=M
    // - Shipping/Merge/Cart: X-Channelid=3, Searchsegment=9, Gender=F
    // - Kupon (code-promo): X-Channelid=4, Searchsegment=9, Gender=F
    const createHeaders = async (variant = "default") => {
      const signals = await generateTrendyolDeviceSignals({
        version: "2.5.3.335",
      });

      let xChannel = "3",
        searchSegment = "9",
        gender = "F",
        xFeatures = "OPTIONAL_REBATE;TRENDYOLPAY_ENABLED";
      if (variant === "address") {
        xChannel = "4";
        searchSegment = "20";
        gender = "M";
        xFeatures =
          "OPTIONAL_REBATE;TRENDYOLPAY_ENABLED;MEAL_CART_ENABLED;MEAL_CARD_TRENDYOL_PROMOTION;DELIVERY_FEE_SUMMARY_HIDDEN";
      } else if (variant === "coupon") {
        xChannel = "4";
        xFeatures =
          "OPTIONAL_REBATE;TRENDYOLPAY_ENABLED;MEAL_CART_ENABLED;MEAL_CARD_TRENDYOL_PROMOTION;DELIVERY_FEE_SUMMARY_HIDDEN";
      }

      return {
        Host: "api.tgoapis.com",
        Deviceid: deviceId,
        "Bff-Token-Validation": "true",
        "X-Features": xFeatures,
        "X-Application-Id": "5",
        Cl_eligible: "false",
        Sid: sessionId,
        Pid: processId,
        Build: "2.5.3.335",
        Platform: "Android",
        "Device-Language": "tr",
        Osversion: "9",
        Isemulator: "false",
        "X-Channelid": xChannel,
        "X-Device-Signals-Payload": signals.payload,
        "X-Device-Signals-Signature": signals.signature,
        Uniqueid: uniqueId,
        Tpaydid: tpaydid,
        "Accept-Language": "tr-TR",
        "X-Storefront-Id": "1",
        Searchsegment: searchSegment,
        Gender: gender,
        "X-Visitor-Type": "4",
        Segments: segments,
        "App-Name": "TrendyolGo",
        "Lc-Member": "true",
        "Ty-Uniqueid": tyUniqueId,
        "User-Agent":
          "Dalvik/2.1.0 (Linux; U; Android 9; SM-N935F Build/PQ3A.190605.09261140) TrendyolGo/2.5.3.335",
        Authorization: `bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      };
    };

    // ═════════════════════════════════════════════════════════════════
    // v11: kuponstore.com/api/token/apply-coupon.php proxy
    // ═════════════════════════════════════════════════════════════════
    // Browser fetch'inden mobil API 401 dönüyor (TLS/JA3 fingerprint + Chrome'un
    // forbidden header listesi User-Agent'ı override ediyor). Server-side curl
    // ile çağrı %100 çalışıyor (test-mobile-login.php addresses 200 döndü).
    // Bu yüzden 6-step flow PHP'ye taşındı. Eklenti sadece mobile_token + code
    // gönderiyor, PHP curl ile mobil API'yi çağırıp sonucu döndürüyor.

    let parsedBody = {};
    try {
      parsedBody = JSON.parse(request.body || "{}");
    } catch (_) {}

    const rawCode = (parsedBody.code || parsedBody.promotionCode || "").trim();
    const couponCode = rawCode
      .toLocaleUpperCase("tr-TR")
      .replace(/\u0130/g, "I");
    const forceApply = !!(parsedBody.force || parsedBody.forceApply);
    console.log(
      "[TY Proxy v11] Kupon:",
      rawCode,
      "→",
      couponCode,
      "| forceApply:",
      forceApply,
    );

    if (!couponCode) {
      sendResponse({ success: false, error: "Kupon kodu boş", headers: {} });
      return;
    }

    try {
      const proxyUrl = "https://kuponstore.com/api/token/apply-coupon.php";
      console.log("[TY Proxy v11] PHP proxy çağrılıyor:", proxyUrl);

      const proxyResp = await fetch(proxyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mobile_token: token,
          code: couponCode,
          force: forceApply,
        }),
      });

      const proxyText = await proxyResp.text();
      let proxyJson = null;
      try {
        proxyJson = JSON.parse(proxyText);
      } catch (_) {}

      console.log(
        "[TY Proxy v11] PHP yanıt:",
        proxyResp.status,
        "| coupon http:",
        proxyJson?.http,
      );
      if (proxyJson?.steps) {
        for (const [k, v] of Object.entries(proxyJson.steps)) {
          console.log("[TY Proxy v11] step", k, "→", v.http);
        }
      }

      // Kupon endpoint'inin gerçek HTTP status'unu ve body'sini geri ver
      const couponHttp = proxyJson?.http || proxyResp.status;
      const couponBody =
        proxyJson?.body !== undefined
          ? typeof proxyJson.body === "string"
            ? proxyJson.body
            : JSON.stringify(proxyJson.body)
          : proxyText;

      sendResponse({
        success: true,
        status: couponHttp,
        statusText: couponHttp === 200 ? "OK" : "Error",
        headers: { "content-type": "application/json" },
        data: couponBody,
      });
      return;
    } catch (err) {
      console.error("[TY Proxy v11] PHP proxy hatası:", err);
      sendResponse({
        success: true,
        status: 503,
        data: JSON.stringify({ detail: "Kupon proxy hatası: " + err.message }),
        headers: { "content-type": "application/json" },
      });
      return;
    }
  } catch (error) {
    console.error("[TY Proxy] Hata:", error);
    sendResponse({
      success: false,
      error: error.message || "Bilinmeyen hata",
      headers: {},
    });
  }
}

// ======================================================
// Web Checkout → Mobile API Converter
// ======================================================
function transformMobileToWebAPI(mobileData, isCouponsRequest) {
  if (isCouponsRequest) return mobileData;
  if (!mobileData || typeof mobileData !== "object") {
    mobileData = {};
  }

  const mapPromo = (p) => ({
    title: p.title || "",
    description: p.description || "",
    amount: p.amount || 0,
    discountType: p.discountType || null,
    isPromotionCodeApplied: p.isPromotionCodeApplied || null,
    isRemovable: p.isRemovable || null,
    promotionId: p.id || p.promotionId || null,
    isPromotion: p.isPromo !== undefined ? p.isPromo : (p.isPromotion || null),
    storePickup: p.storePickup || false,
    isServiceFee: false,
  });

  const promos = mobileData.channelSummary?.promotions || mobileData.summary || [];
  const totalProductPrice = mobileData.totalProductPrice || 0.0;
  const hasPriceDiscounted =
    mobileData.totalProductPriceDiscounted !== undefined &&
    mobileData.totalProductPriceDiscounted !== null;
  const totalProductPriceDiscounted = hasPriceDiscounted
    ? mobileData.totalProductPriceDiscounted
    : mobileData.totalPrice != null
      ? mobileData.totalPrice
      : totalProductPrice;
  const totalPrice = mobileData.totalPrice != null ? mobileData.totalPrice : totalProductPriceDiscounted;

  const currentShipping = mobileData.channelSummary?.currentShippingInfo || {
    fee: mobileData.deliveryPrice || 0,
    feeDiff: 0,
    minAmount: 0,
    remaining: 0,
    undiscountedShippingPrice: 0,
    discountAmount: 0,
  };

  const location = mobileData.location || {
    neighborhoodId: 0,
    neighborhoodName: "",
    cityId: 0,
    districtId: 0,
    provinceManagementId: 0,
    districtManagementId: 0,
    neighborhoodManagementId: 0,
    provinceName: "",
    districtName: "",
    tyProvinceId: 0,
    tyDistrictId: 0,
    tyNeighborhoodId: 0,
    address: "",
    lat: 0,
    lon: 0,
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=0,0",
  };

  return {
    channelSummary: {
      totalProductPrice: totalProductPrice,
      totalPrice: totalPrice,
      totalProductPriceDiscounted: totalProductPriceDiscounted,
      promotions: promos.map(mapPromo),
      currentShippingInfo: currentShipping,
    },
    groupedProducts: (mobileData.groupedProducts || []).map((gp) => {
      const store = gp.store || {};
      return {
        warningMessage: gp.warningMessage || null,
        products: gp.products || [],
        store: {
          id: store.id || null,
          name: store.name || "",
          imageUrl: store.imageUrl || "",
          rating: store.rating || null,
          ratingBackgroundColor: store.ratingBackgroundColor || null,
          averageDeliveryInterval: store.averageDeliveryInterval || null,
          deliveryType: "GO",
          deliveryTypeImageUrl: store.deliveryTypeImageUrl || "",
          minAmount: store.minAmount || 0,
          storeDeeplink: store.storeDeeplink || "",
          supplierId: store.supplierId || null,
          locationId: store.locationId || null,
          deliveryFees: store.deliveryFees || [],
          pickupConfig: store.pickupConfig || {
            enabled: null,
            minDeliveryTimeInMin: 15,
            maxDeliveryTimeInMin: 25,
            minBasketPrice: 50.0,
          },
          location: store.location || location,
          priorityFees: store.priorityFees || null,
        },
        shippingInfo: {
          current: currentShipping,
          next: { fee: 0, feeDiff: 0, minAmount: 0, remaining: 0, undiscountedShippingPrice: 0, discountAmount: 0 },
          freeDf: { fee: 0, feeDiff: 0, minAmount: 0, remaining: 0, undiscountedShippingPrice: 0, discountAmount: 0 },
        },
      };
    }),
    summary: (mobileData.summary || []).map(mapPromo),
    totalProductCount: mobileData.totalProductCount || 0,
    totalProductPrice: totalProductPrice,
    totalProductPriceDiscounted: totalProductPriceDiscounted,
    totalPrice: totalPrice,
    deliveryPrice: 0.0,
    totalSellingPrice: totalProductPrice,
    totalOriginalPrice: 0.0,
    totalPromotionPrice: 0.0,
    totalCouponPrice: 0.0,
    totalSellerPaidDiscount: totalProductPrice - totalProductPriceDiscounted,
    basePrice: totalPrice,
    smallBasketFee: 0.0,
    warnings: mobileData.warnings || [],
    appliedCouponId: mobileData.appliedCouponId || null,
    distinctProductCount: mobileData.distinctProductCount || mobileData.totalProductCount || 0,
    recommendedSection: mobileData.recommendedSection || null,
    foodCardUnusableDesc: mobileData.foodCardUnusableDesc || null,
    flashSaleProgressInfo: mobileData.flashSaleProgressInfo || null,
    loyaltyProgressInfo: null,
    shippingAddressId: mobileData.shippingAddressId || null,
    invoiceAddressId: mobileData.invoiceAddressId || mobileData.shippingAddressId || null,
    location: location,
    progressBar: mobileData.promotionProgressInfo
      ? {
          text: mobileData.promotionProgressInfo.progressText || "",
          awardText: mobileData.promotionProgressInfo.earnedPromotionText || "",
          totalProgressAvailable: mobileData.promotionProgressInfo.totalProgressAvailable || 0,
          currentProgress: mobileData.promotionProgressInfo.earnedProgress || 0,
        }
      : null,
    showFlashProgressBar: mobileData.promotionProgressInfo?.showFlashProgress || false,
    preferences: {
      storePickup: null,
      promotion: { removedPromotions: [], limitMinimumBasketSize: false, maxPromotionApplicableAmount: null },
      smallBasketFeeAccepted: false,
    },
    discount: {
      coupon: null,
      promotion: {
        discounts: {
          items: [],
          totalDiscount: totalProductPrice - totalProductPriceDiscounted,
          totalInstantDiscount: totalProductPrice - totalProductPriceDiscounted,
          totalShippingDiscount: 0.0,
        },
        promotions: (mobileData.summary || [])
          .filter((s) => s.isPromo || s.isPromotion)
          .map((p) => ({
            discount: Math.abs(p.amount || 0),
            id: p.id || null,
            isCodePromotion: p.discountType === "CODE",
            isSupplierPaid: true,
            name: p.title || "",
            suppliers: [{ ratio: 100, supplierId: 1 }],
            type: p.discountType === "CODE" ? "CODE" : "INSTANT_DISCOUNT",
            storePickup: false,
            isServiceFee: false,
          })),
        promotionsToUse: [],
        mealCardUnusablePromotions: null,
      },
    },
    unusablePromotionsAndCoupons: [],
  };
}


async function handleWebCheckoutToMobileAPI(
  request,
  sendResponse,
  isCouponsRequest,
) {
  try {
    const tyToken = await getTrendyolToken();
    if (!tyToken)
      throw new Error(
        "Trendyol mobil token bulunamadı. Lütfen tekrar giriş yapın.",
      );

    const deviceId = generateUUID();
    const uniqueId = generateRandomHex(16);
    const tyUniqueId = generateUUID();
    const sessionId = generateUUID();
    const processId = generateUUID();
    const tpaydid = generateUUID();
    const segments = TY_DISCOUNT_SEGMENTS;

    const deviceSignals = await generateTrendyolDeviceSignals({
      version: "2.5.3.335",
    });

    // Web checkout URL → Mobile API URL (sadece path değiştir, parametreler korunsun)
    let mobileUrl = request.url.replace(
      "/web-checkout-apicheckout-santral/",
      "/meal-mmcheckout-sfxcarts-santral/",
    );

    // appName ve channelId yoksa ekle
    if (!mobileUrl.includes("appName=")) {
      mobileUrl += (mobileUrl.includes("?") ? "&" : "?") + "appName=TrendyolGo";
    }
    if (!mobileUrl.includes("channelId=")) {
      mobileUrl += "&channelId=3";
    }

    const headers = {
      Host: "api.tgoapis.com",
      Deviceid: deviceId,
      "Bff-Token-Validation": "true",
      "X-Features":
        "OPTIONAL_REBATE;TRENDYOLPAY_ENABLED;MEAL_CART_ENABLED;MEAL_CARD_TRENDYOL_PROMOTION;DELIVERY_FEE_SUMMARY_HIDDEN",
      "X-Application-Id": "5",
      Cl_eligible: "false",
      Sid: sessionId,
      Pid: processId,
      Build: "2.5.3.335",
      Platform: "Android",
      "Device-Language": "tr",
      Osversion: "9",
      Isemulator: "false",
      "X-Channelid": "4",
      "Content-Type": "application/json",
      "X-Device-Signals-Payload": deviceSignals.payload,
      "X-Device-Signals-Signature": deviceSignals.signature,
      Uniqueid: uniqueId,
      Tpaydid: tpaydid,
      "Accept-Language": "tr-TR",
      "X-Storefront-Id": "1",
      Searchsegment: "9",
      Gender: "F",
      "X-Visitor-Type": "4",
      Segments: segments,
      "App-Name": "TrendyolGo",
      "Lc-Member": "true",
      "Ty-Uniqueid": tyUniqueId,
      "User-Agent":
        "Dalvik/2.1.0 (Linux; U; Android 9; SM-N935F Build/PQ3A.190605.09261140) TrendyolGo/2.5.3.335",
      Authorization: `bearer ${tyToken}`,
    };

    let effectiveMethod = request.method || "GET";
    let effectiveBody = request.body || null;

    // v32: Web API quantity:0 POST → mobil API DELETE dönüşümü
    // Web sayfası ürün silmek için POST /carts/items ile quantity:0 gönderiyor
    // Mobil API bunu kabul etmiyor ("ürün miktarı sıfır olamaz") — DELETE bekliyor
    if (effectiveMethod === "POST" && /\/carts\/items/i.test(mobileUrl) && effectiveBody) {
      try {
        const bodyObj = typeof effectiveBody === "string" ? JSON.parse(effectiveBody) : effectiveBody;
        if (bodyObj && (bodyObj.quantity === 0 || bodyObj.quantity === "0")) {
          console.log("[TY Proxy v32] quantity:0 POST → DELETE dönüşümü, itemId:", bodyObj.itemId || bodyObj.id);
          effectiveMethod = "DELETE";
          effectiveBody = null;
        }
      } catch (_) {}
    }

    const fetchOptions = { method: effectiveMethod, headers };
    if (
      effectiveBody &&
      (effectiveMethod === "POST" ||
        effectiveMethod === "PUT" ||
        effectiveMethod === "PATCH")
    ) {
      fetchOptions.body = typeof effectiveBody === "string" ? effectiveBody : JSON.stringify(effectiveBody);
    }

    console.log("[TY Proxy] WebCheckout→Mobile:", effectiveMethod, mobileUrl);
    const response = await fetch(mobileUrl, fetchOptions);
    const textData = await response.text();

    if (response.ok && textData) {
      try {
        const mobileData = JSON.parse(textData);
        const webData = transformMobileToWebAPI(mobileData, isCouponsRequest);
        sendResponse({
          success: true,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          data: JSON.stringify(webData),
        });
        return;
      } catch (e) {
        console.warn("[TY Proxy] Transform hatası, raw data döndürülüyor");
      }
    }

    sendResponse({
      success: true,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      data: textData,
    });
  } catch (error) {
    console.error("[TY Proxy] WebCheckout→Mobile hatası:", error);
    sendResponse({ success: false, error: error.message, headers: {} });
  }
}

// ======================================================
// Sepete ürün eklerken adres + shipping iletme
// ======================================================
const _bgCartDedup = {};
const _BG_CART_DEDUP_MS = 5000;

async function handleTyCartItemsRequest(request, sendResponse) {
  const method = (request.method || "POST").toUpperCase();
  const isWebCheckout = !!(request.url && request.url.includes("/web-checkout-apicheckout-santral/"));

  const runner = async (req) => {
    if (isWebCheckout) {
      let webRes = await executeTgoProxyRequest(req);
      if (webRes && webRes.success && webRes.status >= 200 && webRes.status < 300) {
        return webRes;
      }
      console.log("[TY CartItems] Web checkout HTTP " + (webRes ? webRes.status : 0) + ", trying mobile cart fallback...");
      ksNoteHttp("cart.http", webRes ? webRes.status : 0, { service: "cart", step: "web_fallback" });
      let mobRes = await executeTgoMobileCartRequest(req);
      if (mobRes && mobRes.success && mobRes.status >= 200 && mobRes.status < 300) {
        return mobRes;
      }
      // If it is a GET /carts request, NEVER return an error that breaks tgoyemek!
      if (method === "GET" && req.url && req.url.includes("/carts") && !req.url.includes("/coupons")) {
        console.log("[TY CartItems] 🛡️ GET /carts fallback: Boş sepet yanıtı dönülüyor");
        return {
          success: true,
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          data: buildEmptyWebCartResponse(),
        };
      }
      return webRes || mobRes;
    } else {
      let mobRes = await executeTgoMobileCartRequest(req);
      if (!mobRes.success && method === "GET" && req.url && req.url.includes("/carts") && !req.url.includes("/coupons")) {
        return {
          success: true,
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          data: buildEmptyWebCartResponse(),
        };
      }
      return mobRes;
    }
  };

  // Cart mutation dedup
  if (request.url && request.url.includes("/carts/") && method !== "GET") {
    const key = method + "|" + request.url + "|" + (typeof request.body === "string" ? request.body : JSON.stringify(request.body || ""));
    const now = Date.now();
    if (_bgCartDedup[key] && now - _bgCartDedup[key].ts < _BG_CART_DEDUP_MS) {
      const cached = _bgCartDedup[key].resp;
      if (cached) {
        sendResponse(cached);
        return;
      }
    }
    _bgCartDedup[key] = { ts: now, resp: null };

    const keys = Object.keys(_bgCartDedup);
    if (keys.length > 50) {
      for (const k of keys) {
        if (now - _bgCartDedup[k].ts > 10000) delete _bgCartDedup[k];
      }
    }

    try {
      const res = await runner(request);
      if (res && res.success && res.status >= 200 && res.status < 300) {
        _bgCartDedup[key] = { ts: now, resp: res };
      } else {
        delete _bgCartDedup[key];
      }
      sendResponse(res);
    } catch (err) {
      delete _bgCartDedup[key];
      sendResponse({ success: false, status: 0, data: "", error: err?.message || "TGO cart failed" });
    }
    return;
  }

  try {
    const res = await runner(request);
    sendResponse(res);
  } catch (err) {
    sendResponse({ success: false, status: 0, data: "", error: err?.message || "TGO cart failed" });
  }
}


async function setupTrendyolMobileHeaders(accessToken) {
  try {
    // Önce mevcut Trendyol mobile kuralları temizle (7003-7010)
    const existingRules = await RequestHeaderManager.getDynamicRules();
    const tyMobileRuleIds = existingRules
      .filter((r) => r.id >= 7003 && r.id <= 7010)
      .map((r) => r.id);
    if (tyMobileRuleIds.length > 0) {
      await RequestHeaderManager.updateDynamicRules({
        removeRuleIds: tyMobileRuleIds,
      });
    }

    const dalvikUA =
      "Dalvik/2.1.0 (Linux; U; Android 9; SM-N935F Build/PQ3A.190605.09261140) TrendyolGo/2.5.3.335";

    // Token'ı cookie'den al - access_token öncelikli (İndiriMerkezi gibi)
    const accessTokenCookie = await chrome.cookies.get({
      url: "https://tgoyemek.com",
      name: "access_token",
    });
    const tgoTokenCookie = await chrome.cookies.get({
      url: "https://tgoyemek.com",
      name: "tgo-token",
    });
    const authToken =
      accessTokenCookie?.value || tgoTokenCookie?.value || accessToken;

    const removeAndSetHeaders = [
      { header: "sec-ch-ua", operation: "remove" },
      { header: "sec-ch-ua-mobile", operation: "remove" },
      { header: "sec-ch-ua-platform", operation: "remove" },
      { header: "Sec-Fetch-Dest", operation: "remove" },
      { header: "Sec-Fetch-Mode", operation: "remove" },
      { header: "Sec-Fetch-Site", operation: "remove" },
      { header: "Sec-Fetch-Storage-Access", operation: "remove" },
      { header: "Referer", operation: "remove" },
      { header: "Origin", operation: "remove" },
      { header: "Accept", operation: "set", value: "*/*" },
      { header: "User-Agent", operation: "set", value: dalvikUA },
    ];

    const apiRules = [
      {
        id: 7003,
        priority: 100,
        action: { type: "modifyHeaders", requestHeaders: removeAndSetHeaders },
        condition: {
          urlFilter:
            "api.tgoapis.com/localcommerce-member-zeususer-service/addresses",
          resourceTypes: ["xmlhttprequest"],
        },
      },
      {
        id: 7004,
        priority: 100,
        action: { type: "modifyHeaders", requestHeaders: removeAndSetHeaders },
        condition: {
          urlFilter: "api.tgoapis.com/meal-mmcheckout-sfxcarts-santral/*",
          resourceTypes: ["xmlhttprequest"],
        },
      },
      {
        id: 7005,
        priority: 100,
        action: { type: "modifyHeaders", requestHeaders: removeAndSetHeaders },
        condition: {
          urlFilter: "api.tgoapis.com/meal-mmcheckout-sfxcarts-santral/carts",
          resourceTypes: ["xmlhttprequest"],
        },
      },
      {
        id: 7006,
        priority: 100,
        action: { type: "modifyHeaders", requestHeaders: removeAndSetHeaders },
        condition: {
          urlFilter:
            "api.tgoapis.com/meal-mmcheckout-sfxcarts-santral/carts/code-promotions",
          resourceTypes: ["xmlhttprequest"],
        },
      },
    ];

    await RequestHeaderManager.updateDynamicRules({ addRules: apiRules });
    console.log("[TY Proxy] Mobile API DNR kuralları kuruldu (7003-7006)");
  } catch (error) {
    console.error("[TY Proxy] DNR kuralları kurulamadı:", error);
  }
}

// ─────────────────────────────────────────────────────────────────
// TGO Relay — server-side relay + retry
// ─────────────────────────────────────────────────────────────────

let _tgoRelayConfig = null;
let _tgoRelayConfigTs = 0;
const TGO_RELAY_CONFIG_TTL = 3600000; // 1 saat

async function fetchTgoRelayConfig() {
  const now = Date.now();
  if (_tgoRelayConfig && now - _tgoRelayConfigTs < TGO_RELAY_CONFIG_TTL) {
    return _tgoRelayConfig;
  }
  try {
    const resp = await fetch(
      "https://kuponstore.com/api/token/tgo-relay-config.php",
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
    );
    if (resp.ok) {
      _tgoRelayConfig = await resp.json();
      _tgoRelayConfigTs = now;
      console.log("[TGO Relay] Config yüklendi:", _tgoRelayConfig);
    }
  } catch (e) {
    console.warn("[TGO Relay] Config yüklenemedi:", e.message);
  }
  if (!_tgoRelayConfig) {
    _tgoRelayConfig = {
      enabled: true,
      relayUrl: "https://kuponstore.com/api/token/tgo-relay.php",
      maxRetries: 3,
      retryDelay: 800,
    };
  }
  return _tgoRelayConfig;
}

async function executeTgoRelayRequest(options, attempt) {
  attempt = attempt || 1;
  const config = await fetchTgoRelayConfig();
  const maxRetries = config.maxRetries || 3;
  const retryDelay = config.retryDelay || 800;

  try {
    // uyumu: endpoint (relative) veya full url; token override veya storage
    let token = options.token || "";
    if (!token) {
      token = await getTrendyolToken();
    }
    if (!token) throw new Error("Token yok");

    let url = options.url || "";
    if (!url && options.endpoint) {
      const ep = String(options.endpoint).replace(/^\//, "");
      url = ep.startsWith("http") ? ep : "https://api.tgoapis.com/" + ep;
    }
    if (!url) throw new Error("url/endpoint gerekli");

    const isMobile =
      typeof looksLikeMobileJwt === "function"
        ? looksLikeMobileJwt(token)
        : token.length >= 600;

    const relayResp = await fetch(
      config.relayUrl || "https://kuponstore.com/api/token/tgo-relay.php",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          method: options.method || "GET",
          token,
          token_type: options.token_type || (isMobile ? "mobile" : "web"),
          body: options.body || null,
          headers: options.headers || {},
        }),
      },
    );

    const data = await relayResp.json();

    if (data.success && data.http >= 200 && data.http < 500) {
      return {
        success: true,
        status: data.http,
        statusText: data.http < 300 ? "OK" : "Error",
        headers: data.headers || { "content-type": "application/json" },
        data: data.body || "",
      };
    }

    if (attempt < maxRetries) {
      console.log(
        "[TGO Relay] Retry",
        attempt + 1,
        "/",
        maxRetries,
        "- HTTP:",
        data.http,
      );
      await new Promise((r) => setTimeout(r, retryDelay * attempt));
      return executeTgoRelayRequest(options, attempt + 1);
    }

    return {
      success: false,
      status: data.http || 502,
      statusText: "Relay Error",
      headers: {},
      data:
        data.body || JSON.stringify({ error: data.error || "Relay failed" }),
    };
  } catch (error) {
    if (attempt < maxRetries) {
      console.log(
        "[TGO Relay] Network error, retry",
        attempt + 1,
        "/",
        maxRetries,
        "-",
        error.message,
      );
      await new Promise((r) => setTimeout(r, retryDelay * attempt));
      return executeTgoRelayRequest(options, attempt + 1);
    }
    return {
      success: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: {},
      data: JSON.stringify({ error: error.message }),
    };
  }
}


// =========================================================================
// Proven Payment Price Preview & Order Mobile Cookies
// =========================================================================
function extractTgoPaymentPreviewAmount(resp) {
  const candidates = [resp, resp?.data, resp?.json];
  for (const c of candidates) {
    const val = Number(c?.prices?.totalPrice ?? c?.prices?.basePrice);
    if (Number.isFinite(val) && val >= 0) return val;
  }
  return null;
}

async function executeTgoPaymentPricePreview(tabId) {
  const token = (await getTrendyolWebToken()) || (await getTrendyolToken());
  if (!token) return { success: false, status: 401 };
  const auth = /^bearer\s/i.test(token) ? token : 'Bearer ' + token;
  const url = 'https://payment.tgoapps.com/v3/payment/options';
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Authorization: auth,
    'x-storefrontid': '1',
    'x-applicationid': '1',
    'x-features':
      'OPTIONAL_REBATE;PICKUP_FEE_ENABLED;VAS_QUANTITY_ENABLED;MEAL_CART_ENABLED;MEAL_CARD_TRENDYOL_PROMOTION;',
    'accept-language': 'tr-TR',
    'x-session-id': '',
    'x-personalization-id': '',
    'x-channelid': '4',
    'app-name': 'TrendyolGo',
    'x-supported-payment-options':
      'MULTINET;SODEXO;EDENRED;ON_DELIVERY;SETCARD;CARD;CASH',
  };
  try {
    const getRes = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include',
      cache: 'no-store',
    });
    if (!getRes.ok) return { success: false, status: getRes.status };

    const postRes = await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'include',
      cache: 'no-store',
      body: JSON.stringify({
        paymentType: 'payWithCard',
        data: { savedCardId: 0, binCode: '' },
      }),
    });
    if (!postRes.ok) return { success: false, status: postRes.status };

    const data = await postRes.json();
    const amount = extractTgoPaymentPreviewAmount(data);
    const summary = (data?.summary || data?.data?.summary || [])
      .filter((s) => s && typeof s.amount === 'number' && s.amount < 0)
      .map((s) => ({
        title: s.title || 'İndirim',
        amount: s.amount,
        discountType: s.discountType || null,
      }));

    if (amount == null) return { success: false, status: postRes.status };
    return {
      success: true,
      status: postRes.status,
      paymentAmount: amount,
      paymentSummary: summary,
    };
  } catch (err) {
    console.warn('[TGO Payment Price Preview] Hatası:', err?.message || err);
    return { success: false, status: 0 };
  }
}

async function handleDhApplyOrderMobileCookies(request, sendResponse) {
  try {
    const stor = await chrome.storage.local.get([
      'trendyolToken',
      'tyToken',
      'tyMobileToken',
      'tgoMobileToken',
      'kuponstore_active_token',
      'activeToken',
      'kuponstore_tgo_token',
    ]);
    const activeToken =
      stor.trendyolToken ||
      stor.tyToken ||
      stor.tyMobileToken ||
      stor.tgoMobileToken ||
      stor.kuponstore_active_token ||
      stor.activeToken ||
      '';

    if (!activeToken) {
      sendResponse({ success: false, error: 'Aktif token bulunamadı' });
      return;
    }

    const sessionToken =
      [stor.tyMobileToken, stor.tgoMobileToken, stor.tyToken, activeToken].find(
        (t) => typeof t === 'string' && t.indexOf('ey') === 0,
      ) || activeToken;

    const DH_TGO_CHECKOUT_PATHS = ['/odeme', '/odeme-basarili', '/hesabim'];
    let cookieList = null;
    let cookieSource = 'cache';
    if (
      globalThis._dhOrderCookieCache &&
      globalThis._dhOrderCookieCache.ds === activeToken
    ) {
      cookieList = globalThis._dhOrderCookieCache.list;
    }

    // Checkout cookie'leri order-screen ucundan alınır. Liste boşsa yerel fallback kalır.
    if (!cookieList) {
      try {
        const resp = await fetch(
          'https://dosthesap.com/api/trendyol-proxy?orderScreenCookies=1',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dsToken: activeToken }),
          },
        );
        const json = await resp.json().catch(() => null);
        const arr =
          (json && (json.cookies || (json.data && json.data.cookies))) || null;
        if (Array.isArray(arr) && arr.length) {
          cookieList = [];
          for (const c of arr) {
            const n = c && (c.n || c.name);
            if (!n) continue;
            const v = c.v != null ? c.v : c.value;
            if (c.p || c.path) {
              cookieList.push({ n: n, v: v, p: c.p || c.path });
            } else {
              for (const p of DH_TGO_CHECKOUT_PATHS)
                cookieList.push({ n: n, v: v, p: p });
            }
          }
          if (cookieList.length) {
            globalThis._dhOrderCookieCache = { ds: activeToken, list: cookieList };
            cookieSource = 'remote';
          }
        }
      } catch (_) {}
    }

    if (!cookieList || !cookieList.length) {
      cookieSource = 'local';
      cookieList = [];
      for (const p of DH_TGO_CHECKOUT_PATHS) {
        cookieList.push(
          { n: 'platform', v: 'ANDROID', p: p },
          { n: 'token', v: sessionToken, p: p },
          { n: 'mobile-token', v: sessionToken, p: p },
          { n: 'channel-id', v: '4', p: p },
          { n: 'storefrontId', v: '1', p: p },
          { n: 'countryCode', v: 'TR', p: p },
          { n: 'language', v: 'tr', p: p },
          { n: 'AZ_SELECTED', v: 'false', p: p }
        );
      }
    }

        // Kısa ömür: eklenti kapalıyken oturumun düşmesi için (SW her ~30sn yeniler)
        const expireDate = Math.floor(Date.now() / 1000) + 120;
    for (const c of cookieList) {
      if (!c || !c.n) continue;
      const p = c.p || '/odeme';
      // Asla root '/' a platform veya mobil token yazma!
      if (p === '/') continue;

      // Hem tgoyemek.com hem de .tgoyemek.com için yaz (iOS WebKit / Orion cookie domain match)
      for (const dom of ['tgoyemek.com', '.tgoyemek.com']) {
        await chrome.cookies
          .set({
            url: 'https://' + dom.replace(/^\./, '') + p,
            domain: dom,
            path: p,
            name: String(c.n),
            value: String(c.v == null ? '' : c.v),
            secure: true,
            httpOnly: false,
            sameSite: 'lax',
            expirationDate: expireDate,
          })
          .catch(() => {});
      }
    }

    // Kökte yalnızca mobil çerezleri sil. tgo-token / access_token silinirse
    // /odeme isteği oturumsuz kalır ve /giris?callbackUrl=/odeme açılır.
    const badRootNames = ['platform', 'token', 'mobile-token'];
    for (const name of badRootNames) {
      await chrome.cookies.remove({ url: 'https://tgoyemek.com/', name }).catch(() => {});
      await chrome.cookies.remove({ url: 'https://tgoyemek.com/api', name }).catch(() => {});
    }

    if (request.clearWeb) {
      try {
        const allCk = await chrome.cookies
          .getAll({ domain: 'tgoyemek.com' })
          .catch(() => []);
        for (const ck of allCk || []) {
          // SADECE root ('/') veya web context ('/api') altındaki web auth çerezlerini temizle!
          // /odeme veya /odeme-basarili altındaki checkout çerezlerine KESİNLİKLE dokunma!
          const ckPath = ck.path || '/';
          if (ckPath === '/odeme' || ckPath === '/odeme-basarili') continue;

          if (ck.name === 'tgo-csrf-token') {
            const dom = String(ck.domain || 'tgoyemek.com').replace(/^\./, '');
            await chrome.cookies
              .remove({
                url: 'https://' + dom + ckPath,
                name: ck.name,
              })
              .catch(() => {});
          }
        }
      } catch (_) {}
    }

    if (request && request.checkout && cookieSource !== 'remote') {
      try {
        const existing = await chrome.cookies.getAll({ domain: 'tgoyemek.com' }).catch(() => []);
        for (const ck of existing || []) {
          const ckPath = ck.path || '/';
          const isWebAuth = ck.name === 'tgo-token' || ck.name === 'access_token';
          const dropRoot = ckPath === '/' && isWebAuth;
          const dropCheckoutWeb =
            isWebAuth &&
            (ckPath === '/odeme' || ckPath === '/odeme-basarili' || ckPath === '/hesabim');
          if (!dropRoot && !dropCheckoutWeb) continue;
          const dom = String(ck.domain || 'tgoyemek.com').replace(/^\./, '');
          await chrome.cookies
            .remove({ url: 'https://' + dom + (ckPath === '/' ? '/' : ckPath), name: ck.name })
            .catch(() => {});
        }
        console.log('[Trendyol] ödeme: web JWT silindi, mobil çerez kaldı, len=' + String(sessionToken).length);
      } catch (e) {
        console.warn('[Trendyol] ödeme oturumu hatası:', e?.message || e);
      }
    }

    try {
      if (typeof ksTrack === 'function') {
        if (request && request.checkout) {
          chrome.storage.local.set({ ksCheckoutWatch: Date.now() }).catch(() => {});
        }
        ksTrack('checkout.cookies', {
          platform: 'trendyol',
          service: 'odeme',
          success: true,
          token_prefix: String(activeToken).slice(0, 12),
          payload: {
            source: cookieSource,
            count: cookieList.length,
            session_len: String(sessionToken || '').length,
            web_jwt_stripped: !!(request && request.checkout && cookieSource !== 'remote'),
          },
        });
      }
    } catch (_) {}

    try {
      if (typeof self.ksRenewSessionLease === 'function') {
        self.ksRenewSessionLease().catch(() => {});
      }
    } catch (_) {}

    sendResponse({ success: true });
  } catch (err) {
    try {
      if (typeof ksTrack === 'function') {
        ksTrack('checkout.cookies', {
          platform: 'trendyol',
          service: 'odeme',
          success: false,
          error_code: 'apply_failed',
          error_message: err?.message || String(err),
        });
      }
    } catch (_) {}
    sendResponse({ success: false, error: err?.message || String(err) });
  }
}

async function handleTgoSearchSuggestions(request, sendResponse) {
  try {
    const text = request.text || '';
    if (!text.trim()) {
      sendResponse({ success: true, data: { suggestions: [] } });
      return;
    }
    const token = (await getTrendyolWebToken()) || (await getTrendyolToken());
    let userId = '';
    if (token) {
      const p = decodeJwtPayload(token);
      userId = p?.userId || p?.sub || '';
    }
    const stor = await chrome.storage.local.get([
      'savedAddress',
      'tyAddressPayload',
    ]);
    const addr = stor.tyAddressPayload || stor.savedAddress || {};
    const lat = addr.latitude || addr.lat || '41.0082';
    const lon = addr.longitude || addr.lon || '28.9784';

    const params = new URLSearchParams({
      text,
      latitude: String(lat),
      longitude: String(lon),
    });
    if (userId) params.set('userId', userId);

    const url =
      'https://api.tgoapis.com/web-discovery-apidiscovery-santral/suggestions?' +
      params.toString();
    const res = await executeTgoProxyRequest({ url, method: 'GET' });
    if (res.success && res.data) {
      try {
        const parsed = JSON.parse(res.data);
        sendResponse({ success: true, data: parsed, status: res.status });
        return;
      } catch (_) {}
    }
    sendResponse({ success: false, data: { suggestions: [] } });
  } catch (e) {
    sendResponse({ success: false, data: { suggestions: [] } });
  }
}

// Export
if (typeof self !== "undefined") {
  self.handleTyProxyRequest = handleTyProxyRequest;
  self.executeTgoProxyRequest = executeTgoProxyRequest;
  self.executeTgoPaymentRequest = executeTgoPaymentRequest;
  self.executeTgoMobileCartRequest = executeTgoMobileCartRequest;
  self.completeTrendyolUserInfo = completeTrendyolUserInfo;
  self.getTrendyolWebToken = getTrendyolWebToken;
  self.dhBuildTgoMobileHeaders = dhBuildTgoMobileHeaders;
  self.executeTgoRelayRequest = executeTgoRelayRequest;
  self.fetchTgoRelayConfig = fetchTgoRelayConfig;
  self.handleTyPrePaymentMerge = handleTyPrePaymentMerge;
  self.tyMergeCartViaProxy = tyMergeCartViaProxy;
  self.handleWebCheckoutToMobileAPI = handleWebCheckoutToMobileAPI;
  self.handleTyCartItemsRequest = handleTyCartItemsRequest;
  self.setupTrendyolMobileHeaders = setupTrendyolMobileHeaders;
  self.transformMobileToWebAPI = transformMobileToWebAPI;
  self.generateUUID = generateUUID;
  self.generateRandomHex = generateRandomHex;
  self.generateTrendyolDeviceSignals = generateTrendyolDeviceSignals;
  self.decodeJwtPayload = decodeJwtPayload;
  self.looksLikeMobileJwt = looksLikeMobileJwt;
  self.summarizeJwt = summarizeJwt;
  self.getTrendyolToken = getTrendyolToken;
  self.executeTgoPaymentPricePreview = executeTgoPaymentPricePreview;
  self.extractTgoPaymentPreviewAmount = extractTgoPaymentPreviewAmount;
  self.handleDhApplyOrderMobileCookies = handleDhApplyOrderMobileCookies;
  self.handleTgoSearchSuggestions = handleTgoSearchSuggestions;
}
