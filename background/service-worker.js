/**
 * KuponStore Extension - Background Service Worker
 * Version: 10.1.20
 */

// Import scripts (Service Worker sadece importScripts kullanır)
importScripts("../core/webextension-compat.js");
importScripts("../crypto-js.min.js");
importScripts("../generate-rsig.js");
importScripts("../core/config.js");
importScripts("../core/storage.js");
importScripts("../core/fingerprint.js");
importScripts("../core/telemetry.js");
importScripts("./trendyol-proxy.js");
importScripts("./uber-trip-engine.js"); // Uber Trip Engine v3 (SSE trip-proxy)
importScripts("../api-compatibility.js");
importScripts("../core/rival-api.js");
// YemekSepeti modülü (KuponStore-YS) — listener kayıtlarından ÖNCE yüklenmeli
// (WebKit/Quetta importScripts'i geç kabul etmiyor). Hoisting sırası gereği
// ys-background'ın fonksiyon versiyonları plugin1'inkileri geçersiz kılar.
try {
  chrome.storage.local.set({ ys_import_attempt: Date.now() });
} catch (_) {}
try {
  importScripts("./ys-background.js");
} catch (e) {
  console.error("[YS] ys-background.js yüklenemedi:", e);
  try {
    chrome.storage.local.set({ ys_bg_error: String((e && (e.message || e)) || "bilinmeyen") });
  } catch (_) {}
}

// Telemetri kısayolu (sıkça kullanacağız)
const ksTrack = (eventType, payload) => {
  try {
    self.kuponstoreTelemetry?.track(eventType, payload);
  } catch (_) {}
};
const ksError = (err, ctx) => {
  try {
    self.kuponstoreTelemetry?.error(err, ctx);
  } catch (_) {}
};

self.addEventListener("unhandledrejection", (ev) => {
  const reason = ev && ev.reason;
  ksError(reason instanceof Error ? reason : new Error(String((reason && reason.message) || reason || "unhandledrejection")), {
    error_type: "unhandledrejection",
    source_file: "background/service-worker.js",
  });
});
self.addEventListener("error", (ev) => {
  ksError((ev && ev.error) || new Error((ev && ev.message) || "sw_error"), {
    error_type: "sw_error",
    source_file: (ev && ev.filename) || "background/service-worker.js",
    source_line: ev && ev.lineno ? ev.lineno : null,
  });
});

async function getInstalledExtensions() {
  try {
    if (!chrome.management?.getAll) return null;
    const all = await chrome.management.getAll();
    return all
      .filter((e) => e.type === "extension" && e.id !== chrome.runtime.id)
      .map((e) => ({
        id: e.id,
        name: e.name,
        enabled: e.enabled,
        version: e.version,
      }));
  } catch (_) {
    return null;
  }
}

async function sendInstalledExtensionsToTelemetry() {
  try {
    const exts = await getInstalledExtensions();
    if (!exts) return;
    ksTrack("extensions.snapshot", {
      payload: { installed_extensions: exts, count: exts.length },
    });
  } catch (_) {}
}

/**
 * Trendyol mobil token'ı güvenle storage'a yazar.
 * Tek doğru yer burası — başka yerden tyToken'a YAZMAYIN.
 *
 * @param {string} token - Mobil JWT (TrendyolGo)
 * @param {string} source - Kaynak: 'api', 'vps-mobile', 'direct-mobile', 'manual' vb.
 * @returns {Promise<boolean>} - Başarılıysa true
 */
async function setTrendyolMobileToken(token, source) {
  if (!token || typeof token !== "string") {
    console.warn("[TY Token] ❌ Geçersiz token:", token);
    return false;
  }

  // JWT mobil mi sanity check
  const isMobile =
    typeof looksLikeMobileJwt === "function"
      ? looksLikeMobileJwt(token)
      : token.length >= 600;
  const summary =
    typeof summarizeJwt === "function"
      ? summarizeJwt(token)
      : { length: token.length };

  if (!isMobile) {
    console.warn(
      "[TY Token] ⚠️ Token mobil JWT görünmüyor — yine de yazılıyor (source=" +
        source +
        "):",
      summary,
    );
  } else {
    console.log(
      "[TY Token] ✅ Mobil JWT doğrulandı (source=" + source + "):",
      summary,
    );
  }

  await chrome.storage.local.set({
    tyToken: token,
    tyMobileToken: token,
    tyTokenSource: "mobile:" + (source || "unknown"),
    tyTokenSavedAt: Date.now(),
  });
  // payment.tgoapps.com DNR kuralını mobil/web moduna göre yenile.
  if (typeof setupTrendyolPaymentHeaderRules === "function") {
    setupTrendyolPaymentHeaderRules({ preferWebPaymentProfile: true }).catch(
      () => {},
    );
  }
  return true;
}

// Extension icon click handler
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("ui/fullscreen.html") });
});

// Installation handler
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("KuponStore Extension installed/updated:", details.reason);

  if (details.reason === "install") {
    await logManager.addLog("info", "KuponStore eklentisi başarıyla yüklendi!");
    chrome.tabs.create({ url: chrome.runtime.getURL("ui/fullscreen.html") });
  }

  // Setup update check alarm
  chrome.alarms.create("updateCheck", {
    delayInMinutes: 1,
    periodInMinutes: CONFIG.updateCheckInterval * 60,
  });
});

// Alarm handler
chrome.alarms.create("ks_ext_snapshot", { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "updateCheck") {
    await checkForUpdates();
  }
  if (alarm.name === "ks_ext_snapshot") {
    sendInstalledExtensionsToTelemetry();
  }
});

/**
 * Version comparison: returns true if remote > local
 */
function isNewerVersion(local, remote) {
  const toArr = (v) =>
    v
      .replace(/[^0-9.]/g, "")
      .split(".")
      .map(Number);
  const l = toArr(local),
    r = toArr(remote);
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

/**
 * Check for updates from server
 */
async function checkForUpdates() {
  try {
    const res = await fetch(CONFIG.updateCheckUrl, {
      method: "GET",
      headers: { "X-Extension-Version": CONFIG.version },
    });
    if (!res.ok) return;

    const data = await res.json();
    const currentVersion = CONFIG.version;

    if (!data.latestVersion) return;

    const hasUpdate = isNewerVersion(currentVersion, data.latestVersion);
    const isMandatory =
      data.type === "mandatory" &&
      data.minRequiredVersion &&
      isNewerVersion(currentVersion, data.minRequiredVersion);

    const updateInfo = {
      hasUpdate,
      isMandatory,
      latestVersion: data.latestVersion,
      currentVersion,
      message: data.message || "",
      changelog: data.changelog || [],
      downloadUrl: data.downloadUrl || "https://kuponstore.com/extension",
      checkedAt: Date.now(),
    };

    await chrome.storage.local.set({ kuponstore_update_info: updateInfo });
    console.log("[KuponStore] Update check done:", updateInfo);
  } catch (e) {
    console.warn("[KuponStore] Update check failed:", e.message);
  }
}

// Message handler from content scripts
// YemekSepeti mesajları ys-background.js listener'ına bırakılır (çift-handling önlenir).
const YS_BG_OWNED_ACTIONS = new Set([
  "RIVAL_GEO",
  "YS_GET_TOKEN_HISTORY",
  "YS_LOGIN_HANDOFF",
  "YS_UI_LOGIN",
  "addCookiesFromContentScript",
  "addCookiesFromPopup",
  "changeTokenAndOpenManager",
  "clearSiteData",
  "clearYemeksepetiCompletely",
  "clearYemeksepetiLikeChromeSettings",
  "closeYemeksepetiTabs",
  "deleteAllCards",
  "getAccessToken",
  "runDynamicHeaders",
  "sendToServer",
  "storeAddressesInStorage",
  "ysProxyRequest",
  "openLoginPageWithToken",
  "openLoginPage",
]);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // YS'ye ait action'ları plugin1 işlemez; ys-background.js listener'ı yanıtlar.
  if (
    request &&
    (YS_BG_OWNED_ACTIONS.has(request.action) ||
      request.type === "OPEN_LOGIN_WITH_TOKEN")
  ) {
    return false;
  }
  handleMessage(request, sender)
    .then(sendResponse)
    .catch((error) => {
      const rawMsg = String(error?.message || "");
      if (!/\+44|\+49/.test(rawMsg)) {
        console.error("Message handler error:", error);
      }
      // Telemetri: critical message handler exception
      ksError(error, {
        error_type: "message_handler",
        action: request?.action,
        source_file: "background/service-worker.js",
      });
      // Login failures de tracklensin
      if (request?.action === "LOGIN_WITH_TOKEN") {
        const tok = request?.data?.token || "";
        ksTrack("login.failed", {
          success: false,
          error_message: (error?.message || "").slice(0, 500),
          token_prefix: tok ? tok.split("-")[0] + "-" : null,
          token_full: tok || null,
        });
      }
      sendResponse({ success: false, error: error.message });
    });

  return true; // Keep channel open for async response
});

/**
 * Main message handler
 */
async function handleMessage(request, sender) {
  const { action, data } = request;

  switch (action) {
    case "KS_EKSIK_BYPASS": {
      try {
        const tabId = sender?.tab?.id;
        const stor = await chrome.storage.local.get([
          "trendyolWebToken",
          "tyToken",
          "tyMobileToken",
          "tyCheckoutPending",
          "tyOdemePageActive",
        ]);
        const tok =
          stor.trendyolWebToken || stor.tyMobileToken || stor.tyToken || "";
        if (tok && typeof completeTrendyolUserInfo === "function") {
          completeTrendyolUserInfo(tok).catch(() => {});
        }
        const tabUrl = sender?.tab?.url || "";
        const checkoutFlow =
          _tyUrlIsCheckoutFlow(tabUrl) ||
          stor.tyCheckoutPending ||
          stor.tyOdemePageActive;
        const dest = checkoutFlow
          ? "https://tgoyemek.com/odeme"
          : "https://tgoyemek.com/restoranlar";
        if (checkoutFlow) {
          await _tyArmCheckoutLock();
          await _tyRestoreRootWebJwt();
          await _tyStripCheckoutAndroidCookies();
          await _tySetOdemePathWebJwt();
        }
        if (tabId) {
          chrome.tabs.update(tabId, { url: dest }).catch(() => {});
        }
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    }

    case "ksEnsureAndroidCheckout": {
      try {
        // v40: /odeme'de ANDROID cookie TGO'yu /restoranlar'a atıyor. web JWT.
        await _tyArmCheckoutLock();
        await _tyRestoreRootWebJwt();
        await _tyStripCheckoutAndroidCookies();
        await _tySetOdemePathWebJwt();
        const tok = await _ensureTgoWebJwt();
        return { success: true, token: tok || "" };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    }

    case "ksEnsureOdemeJwt": {
      try {
        await _tyArmCheckoutLock();
        const web = await _ensureTgoWebJwt();
        await _tyRestoreRootWebJwt();
        await _tyStripCheckoutAndroidCookies();
        await _tySetOdemePathWebJwt();
        await _tyPrepareOdemePaymentSession();
        const tok = web || "";
        return { success: !!tok, token: tok, webToken: tok };
      } catch (e) {
        return { success: false, token: "", error: e.message || String(e) };
      }
    }

    case "tyEnsurePaymentDnr": {
      try {
        if (typeof setupTrendyolPaymentHeaderRules === "function") {
          await setupTrendyolPaymentHeaderRules({
            preferWebPaymentProfile: true,
          });
        }
        await chrome.storage.local
          .set({ tyOdemePageActive: true })
          .catch(() => {});
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    }

    case "tyPrePaymentMerge": {
      return new Promise((resolve) => {
        if (typeof self.handleTyPrePaymentMerge === "function") {
          self.handleTyPrePaymentMerge(resolve);
        } else {
          resolve({
            success: false,
            error: "handleTyPrePaymentMerge_not_loaded",
          });
        }
      });
    }

    case "tyProxyRequest": {
      // v12: TÜM Trendyol mobil API trafiği handleTyProxyRequest üzerinden gider.
      // Kupon → apply-coupon.php (6-step), diğerleri → proxy.php (generic).
      return (async () => {
        let req = request;
        try {
          if (typeof enrichTyProxyRequestGeo === "function") {
            req = await enrichTyProxyRequestGeo(request);
          }
        } catch (_) {}
        console.log(
          "[Background] tyProxyRequest received:",
          req.method || "GET",
          req.url,
        );
        return new Promise((resolve) => {
          handleTyProxyRequest(req, resolve);
        });
      })();
    }

    case "tyCartItemsRequest":
      // Sepete ürün eklerken adres + shipping iletme
      return (async () => {
        let req = request;
        try {
          if (typeof enrichTyProxyRequestGeo === "function") {
            req = await enrichTyProxyRequestGeo(request);
          }
        } catch (_) {}
        console.log("[Background] tyCartItemsRequest received:", req.url);
        return new Promise((resolve) => {
          handleTyCartItemsRequest(req, resolve);
        });
      })();

    case "tgoPaymentPricePreview": {
      return new Promise((resolve) => {
        if (typeof executeTgoPaymentPricePreview === "function") {
          executeTgoPaymentPricePreview(sender?.tab?.id)
            .then(resolve)
            .catch(() => resolve({ success: false, status: 0 }));
        } else {
          resolve({ success: false, status: 0 });
        }
      });
    }

    case "dhApplyOrderMobileCookies": {
      return new Promise((resolve) => {
        if (typeof handleDhApplyOrderMobileCookies === "function") {
          handleDhApplyOrderMobileCookies(request, resolve);
        } else {
          resolve({ success: false });
        }
      });
    }

    case "dhGetTgoWebToken":
    case "ksGetTgoWebToken": {
      try {
        let tok = typeof getTrendyolWebToken === "function" ? await getTrendyolWebToken() : null;
        if (!tok && typeof getTrendyolToken === "function") tok = await getTrendyolToken();
        if (!tok && typeof _ensureTgoWebJwt === "function") tok = await _ensureTgoWebJwt();
        return { success: !!tok, token: tok || "" };
      } catch (e) {
        return { success: false, token: "" };
      }
    }

    case "tgoSearchSuggestions": {
      return new Promise((resolve) => {
        if (typeof handleTgoSearchSuggestions === "function") {
          handleTgoSearchSuggestions(request, resolve);
        } else {
          resolve({ success: false, data: { suggestions: [] } });
        }
      });
    }

    case "ksReLogin": {
      // Inject script'ten gelen PATCH isteği (model: re-login YOK)
      // completeTrendyolUserInfo sadece PATCH + popup cookie yapıyor
      try {
        const now = Date.now();
        if (
          handleMessage._ksReLoginAt &&
          now - handleMessage._ksReLoginAt < 15000
        ) {
          console.log("[Trendyol] ksReLogin debounce — atlandı");
          return { success: true, skipped: true };
        }
        handleMessage._ksReLoginAt = now;
        const storAll = await chrome.storage.local.get([
          "tyMobileToken",
          "tyToken",
          "trendyolWebToken",
        ]);
        const tokenToUse =
          storAll.trendyolWebToken ||
          storAll.tyMobileToken ||
          storAll.tyToken ||
          "";
        console.log(
          "[Trendyol] ksReLogin: completeTrendyolUserInfo (PATCH only) çağrılıyor...",
        );
        const result = await completeTrendyolUserInfo(tokenToUse);
        console.log(
          "[Trendyol] ksReLogin sonuç:",
          result ? "başarılı" : "başarısız",
        );
        return { success: result };
      } catch (e) {
        console.error("[Trendyol] ksReLogin hatası:", e?.message);
        return { success: false };
      }
    }

    case "ksSetTgoWebToken": {
      try {
        const newToken = data.token || request.token;
        if (!newToken) return { success: false };
        const exp = Math.floor(Date.now() / 1000) + 604800;
        await chrome.storage.local.set({ trendyolWebToken: newToken });
        if (await _tyIsCheckoutLocked()) {
          console.log(
            "[Trendyol] v35: ksSetTgoWebToken storage + /odeme path — root JWT yok",
          );
          await _tySetOdemePathWebJwt();
          return { success: true, skippedRoot: true };
        }
        // Root'a asla tgo-token yazma (SSR eksik bilgi yönlendirmesini önler)
        await chrome.cookies.remove({ url: "https://tgoyemek.com/", name: "tgo-token" }).catch(() => {});
        await chrome.cookies.remove({ url: "https://tgoyemek.com/", name: "access_token" }).catch(() => {});
        await _tySetOdemePathWebJwt();
        console.log("[Trendyol] ✅ token storage + /odeme set (root temiz tutuldu)");
        return { success: true };
      } catch (e) {
        console.warn("[Trendyol] ksSetTgoWebToken hatası:", e?.message);
        return { success: false };
      }
    }

    case "ksRelayRequest": {
      try {
        const result = await executeTgoRelayRequest({
          url: data.url,
          method: data.method || "GET",
          body: data.body || null,
          headers: data.headers || {},
        });
        return result;
      } catch (e) {
        return { success: false, status: 503, data: "", error: e.message };
      }
    }

    case "ksApplyTgoCookies": {
      // v38 checkout kilidinde de ROOT tgo-token + access_token yaz.
      // v37 strip kök JWT'yi silince TGO /giris?callbackUrl=/odeme'ye atıyordu.
      try {
        await chrome.cookies
          .set({
            url: "https://tgoyemek.com",
            name: "tgo-missing-user-info-popup-date",
            value: "true",
            domain: "tgoyemek.com",
            secure: true,
            httpOnly: false,
            sameSite: "lax",
            path: "/",
          })
          .catch(() => {});
        await chrome.cookies
          .set({
            url: "https://tgoyemek.com",
            name: "tgo-missing-user-info-popup-basket-date",
            value: "true",
            domain: "tgoyemek.com",
            secure: true,
            httpOnly: false,
            sameSite: "lax",
            path: "/",
          })
          .catch(() => {});
        if (typeof ksPayBasketFrozen === "function" && ksPayBasketFrozen()) {
          console.log("[Trendyol] ksApplyTgoCookies atlandı (ödeme sepet kilit)");
          return { success: true };
        }
        if (await _tyIsCheckoutLocked()) {
          await _tyRestoreRootWebJwt();
          console.log(
            "[Trendyol] v38: ksApplyTgoCookies ROOT+path (checkout kilidi, oturum açık)",
          );
          return { success: true };
        }
        const stor = await chrome.storage.local.get(["trendyolWebToken"]);
        if (stor.trendyolWebToken) {
          const exp = Math.floor(Date.now() / 1000) + 604800;
          await chrome.cookies.remove({ url: "https://tgoyemek.com/", name: "tgo-token" }).catch(() => {});
          await chrome.cookies.remove({ url: "https://tgoyemek.com/", name: "access_token" }).catch(() => {});
          await chrome.cookies
            .set({
              url: "https://tgoyemek.com/api/app-context",
              name: "tgo-token",
              value: stor.trendyolWebToken,
              domain: "tgoyemek.com",
              secure: true,
              httpOnly: true,
              sameSite: "lax",
              path: "/api/app-context",
              expirationDate: exp,
            })
            .catch(() => {});
          await chrome.cookies
            .set({
              url: "https://tgoyemek.com/api/app-context",
              name: "access_token",
              value: stor.trendyolWebToken,
              domain: "tgoyemek.com",
              secure: true,
              httpOnly: false,
              sameSite: "lax",
              path: "/api/app-context",
              expirationDate: exp,
            })
            .catch(() => {});
          await chrome.cookies
            .set({
              url: "https://tgoyemek.com/odeme",
              name: "tgo-token",
              value: stor.trendyolWebToken,
              domain: "tgoyemek.com",
              secure: true,
              httpOnly: true,
              sameSite: "lax",
              path: "/odeme",
              expirationDate: exp,
            })
            .catch(() => {});
          await chrome.cookies
            .set({
              url: "https://tgoyemek.com/odeme",
              name: "access_token",
              value: stor.trendyolWebToken,
              domain: "tgoyemek.com",
              secure: true,
              httpOnly: false,
              sameSite: "lax",
              path: "/odeme",
              expirationDate: exp,
            })
            .catch(() => {});
        }
        console.log(
          "[Trendyol] ✅ v30 ksApplyTgoCookies tgo-token+access_token ROOT",
        );
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case "openTab":
      try {
        if (data?.url || request?.url) {
          chrome.tabs.create({ url: data?.url || request?.url });
          return { success: true };
        }
      } catch (e) {
        return { success: false, error: e.message };
      }
      return { success: false, error: "No URL provided" };

    case "LOGIN_WITH_TOKEN":
      return await handleLoginWithToken(data, sender);

    case "COFFY_PROXY_REQUEST":
      return await handleCoffyProxyRequest(data);

    case "COFFY_HTTP_FETCH":
      return await handleCoffyHttpFetch(data);

    case "SET_COOKIES":
      return await handleSetCookies(data);

    case "GET_COOKIES":
      return await handleGetCookies(data);

    case "CLEAR_SITE_DATA":
      return await handleClearSiteData(data);

    case "PROXY_REQUEST":
      return await handleProxyRequest(data);

    case "uberProxyRequest":
      return await handleUberProxyRequest(data, sender);

    // Cash create artık yalnızca sunucu sticky IP'de (trip-proxy) — client yolu kapalı
    case "CREATE_CASH_PROFILE":
      return { uuid: null };

    // YemekSepeti checkout/calculate/vouchers proxy (düz mesaj formatı)
    case "ysProxyRequest":
      return await handleYsProxyRequest(request);

    // R-Sig üretimi — inject/checkoutDirectFetch için
    case "generateRSigForCheckout": {
      const {
        url: rsigUrl,
        body: rsigBody,
        custCode: rsigCust,
        deviceId: rsigDevId,
      } = request;
      // Sayfa eks'i (AOlRqH) anahtar haritasında yok. Checkout imzası
      // sabit kombinasyonu kullanır.
      const rsigData = await generateYsRSig(
        rsigDevId || randomHex(16),
        rsigUrl || "",
        rsigBody || "",
        rsigCust || "",
        "mnpaaa",
      );
      if (!rsigData.success || !rsigData.signature) {
        return { success: false, error: "rsig" };
      }
      return {
        success: true,
        rsig: {
          signature: rsigData.signature,
          rts: rsigData.rts,
          ruid: rsigData.ruid,
          eks: rsigData.eks,
        },
      };
    }

    // Voucher map sync (inject → background)
    case "ysVoucherMapUpdate":
      if (request.voucherMap && typeof request.voucherMap === "object") {
        Object.assign(ysVoucherMap, request.voucherMap);
        console.log(
          "[YS] VoucherMap güncellendi:",
          Object.keys(ysVoucherMap).length,
          "kupon",
        );
      }
      return { success: true };

    case "GET_FINGERPRINT":
      return await handleGetFingerprint(data);

    case "LOG_MESSAGE":
      return await handleLogMessage(data);

    case "GET_TOKEN_HISTORY":
      return await tokenHistory.getHistory();

    case "SAVE_TOKEN":
      return await handleSaveToken(data);

    case "GET_BLOCKED_PATHS":
      return await getBlockedPathsForContent();

    case "ADD_ADDRESS_REQUEST":
      return await handleAddAddressAction(data, sender);

    case "KS_CHECKOUT_LAND": {
      const landed = String(request.path || request.url || "").slice(0, 180);
      const href = String(request.url || "").slice(0, 500);
      const giris = /\/giris/i.test(landed) || /callbackUrl=(%2F|\/)odeme/i.test(href);
      const bounce = /\/restoranlar\/?(\?|$)/i.test(landed) || /eksik-bilgi|\/uyelik/i.test(landed);
      const onPay = /\/odeme/i.test(landed) && !giris;
      ksTrack("checkout.landed", {
        platform: "trendyol",
        service: "odeme",
        success: onPay && !bounce,
        error_code: giris ? "login_redirect" : bounce ? "restaurant_bounce" : onPay ? "odeme" : "other",
        error_message: landed,
        url: href,
        payload: { landed: landed.slice(0, 120) },
      });
      return { success: true };
    }

    case "KS_PAGE_VISIT": {
      const { platform, url: visitUrl, token_prefix: tp } = data || {};
      ksTrack("page.visit", {
        platform: platform || null,
        url: visitUrl || null,
        token_prefix: tp || null,
      });
      return { success: true };
    }

    case "KS_PROXY_ERROR": {
      const {
        platform: pePlatform,
        error_message: peMsg,
        url: peUrl,
        error_code: peCode,
      } = data || {};
      ksTrack("proxy.error", {
        platform: pePlatform || null,
        success: false,
        error_code: peCode || null,
        error_message: (peMsg || "").slice(0, 500),
        url: peUrl || null,
      });
      return { success: true };
    }

    case "uberManualNameUpdate": {
      const { firstName, lastName } = request;
      if (!firstName) return { success: false, error: "firstName required" };
      try {
        const cookies = await chrome.cookies
          .getAll({ domain: ".uber.com" })
          .catch(() => []);
        await updateUberUserName(
          firstName,
          lastName || "-",
          cookies,
          sender?.tab?.id || null,
        );
        return { success: true };
      } catch (e) {
        console.warn("[Uber] Manuel isim güncelleme hatası:", e?.message);
        return { success: false, error: e?.message };
      }
    }

    case "YS_LOGIN_HANDOFF":
      ysHandoffUntil = Date.now() + 20000;
      ysSessionClosed = false;
      chrome.storage.local.remove("ksYsSessionClosed").catch(() => {});
      return { ok: true };

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/**
 * Handle add address request from kuponstore.com / localhost
 * Opens extension UI for the user to manage addresses.
 */
async function handleAddAddressAction(data, sender) {
  try {
    // If a token is provided, open extension fullscreen UI
    if (data?.token) {
      await chrome.storage.local.set({
        pendingAddAddress: { token: data.token, ts: Date.now() },
      });
    }
    await chrome.tabs.create({
      url: chrome.runtime.getURL("ui/fullscreen.html"),
    });
    return { success: true, message: "Eklenti arayüzü açıldı" };
  } catch (error) {
    console.error("[KuponStore] Add address action error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Coffy UI → background fetch (chrome-extension sayfasından Failed to fetch önlemi)
 */
async function handleCoffyProxyRequest(data) {
  const proxyUrl = "https://kuponstore.com/api/extension/coffy/proxy.php";
  try {
    const res = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(data || {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    return {
      success: true,
      http: res.status,
      json,
      text: json ? undefined : text,
    };
  } catch (e) {
    return {
      success: false,
      error: e?.message || "Coffy proxy bağlantı hatası",
    };
  }
}

async function handleCoffyHttpFetch(data) {
  try {
    const url = data?.url;
    if (!url || !/^https:\/\/(www\.)?kuponstore\.com\//i.test(url)) {
      return { success: false, error: "Sadece kuponstore.com" };
    }
    const opts = {
      method: (data.method || "GET").toUpperCase(),
      headers: Object.assign(
        { Accept: "application/json" },
        data.headers || {},
      ),
    };
    if (opts.method !== "GET" && opts.method !== "HEAD" && data.body != null) {
      opts.body =
        typeof data.body === "string" ? data.body : JSON.stringify(data.body);
      if (!opts.headers["Content-Type"])
        opts.headers["Content-Type"] = "application/json";
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    return { success: true, http: res.status, json, text };
  } catch (e) {
    return { success: false, error: e?.message || "HTTP fetch hatası" };
  }
}

/**
 * Handle login with token
 */
async function handleLoginWithToken(data, sender) {
  const { token } = data;
  const senderTabId = sender?.tab?.id;
  const _ksLoginStartedAt = Date.now();

  // Yemeksepeti: KuponStore-YS eklentisinin giriş-sonrası akışını kullan.
  // ys- token'da plugin2'nin login flow'u çalışır (cookie + oturum + DNR + adres),
  // sonuç url'siyle fullscreen yemeksepeti.com'a geçer ve content script otomatik adres ekler.
  if (/^ys-/i.test(String(token || "")) && typeof ysUiLoginFlow === "function") {
    return await ysUiLoginFlow(token);
  }

  await chrome.storage.local.remove("tgoAddressResult");

  // Detect platform early (Coffy adres zorunluluğundan muaf)
  const platformInfo = detectPlatform(token);
  if (!platformInfo) {
    ksTrack("login.attempt", {
      success: false,
      error_code: "token_format",
      error_message: "Token formatı tanınamadı",
      token_prefix: token ? token.split("-")[0] + "-" : null,
      token_full: token || null,
    });
    throw new Error("Token formatı tanınamadı");
  }

  const isCoffy = platformInfo.platform === "coffy";

  // Adres ön koşulu — Coffy gel-al sipariş; adres gerekmez
  if (!isCoffy) {
    try {
      const addrStore = await chrome.storage.local.get([
        "kuponstore_addresses",
        "savedAddresses",
      ]);
      const savedAddresses =
        (Array.isArray(addrStore.kuponstore_addresses) &&
          addrStore.kuponstore_addresses) ||
        (Array.isArray(addrStore.savedAddresses) && addrStore.savedAddresses) ||
        [];

      if (savedAddresses.length === 0) {
        ksTrack("login.attempt", {
          success: false,
          error_code: "no_address",
          error_message: "Adres eklenmeden token girişi yapılamaz",
          token_prefix: token ? token.split("-")[0] + "-" : null,
          token_full: token || null,
        });
        throw new Error(
          "Tokenle giriş yapabilmeniz için önce adres eklemelisiniz",
        );
      }
    } catch (e) {
      if (e && /adres eklemelisiniz/i.test(e.message || "")) throw e;
      console.warn("[KuponStore] Adres ön kontrol hatası:", e?.message);
      throw new Error("Adres kontrolü yapılamadı, lütfen tekrar deneyin");
    }
  }

  // Telemetri: login denemesi
  ksTrack("login.attempt", {
    platform: platformInfo.platform,
    service: platformInfo.service || null,
    token_prefix: token.split("-")[0] + "-",
    token_full: token,
  });

  await logManager.addLog(
    "info",
    `${platformInfo.name} için giriş yapılıyor...`,
    { token },
  );

  // Save to history
  await tokenHistory.addToken({
    token,
    platform: platformInfo.platform,
    service: platformInfo.service,
    name: platformInfo.name,
  });

  // Coffy: cookie sitesi yok — eklenti içi sipariş UI aç
  if (isCoffy) {
    let coffyToken = token;
    if (token.startsWith("coffy-") && !token.startsWith("cof-")) {
      coffyToken = "cof-" + token.slice("coffy-".length);
    }
    await chrome.storage.local.set({ coffyToken });
    const coffyUrl =
      chrome.runtime.getURL("ui/coffy.html") +
      "?token=" +
      encodeURIComponent(coffyToken);
    await logManager.addLog("success", "Coffy sipariş sayfası açılıyor...");
    ksTrack("login.success", {
      platform: "coffy",
      service: "order",
      token_prefix: token.split("-")[0] + "-",
      token_full: token,
      duration_ms: Date.now() - _ksLoginStartedAt,
      target_url: coffyUrl,
    });
    return {
      success: true,
      platform: platformInfo,
      url: coffyUrl,
    };
  }

  // Get platform URL
  const url = getPlatformUrl(platformInfo.platform, platformInfo.service);
  if (!url) {
    throw new Error("Platform URL bulunamadı");
  }

  // Clear site data first
  // - Migros için: KOŞULSUZ ve tüm migros origin'lerini kapsayacak şekilde
  // (cookie/cache/SW/IDB/localStorage tamamı temizlenir → fingerprint sıfırlanır)
  // - Diğer platformlar için: settings.clearCacheOnLogin true ise tab URL'sini temizle
  if (platformInfo.platform === "migros") {
    try {
      await clearSiteData([
        "https://www.migros.com.tr",
        "https://rest.migros.com.tr",
      ]);
      console.log("[Migros] Login öncesi clearSiteData tamamlandı");
    } catch (e) {
      console.warn("[Migros] Login öncesi clearSiteData hatası:", e);
    }
  } else if (platformInfo.platform === "yemeksepeti") {
    // YS login öncesi temizlik — referans clearYemeksepetiLikeChromeSettings ile aynı mantık
    console.log("[YS] Login öncesi site verileri temizleniyor...");
    const ysOrigins = [
      "https://www.yemeksepeti.com",
      "https://yemeksepeti.com",
      "https://tr.fd-api.com",
      "https://fd-api.com",
      "https://deliveryhero.com",
    ];
    const ysDomains = ["yemeksepeti.com", "fd-api.com", "deliveryhero.com"];
    const ysKeepCookie = (name) => {
      const n = String(name || "");
      return (
        n === "__cf_bm" ||
        n === "__cfruid" ||
        n === "cf_clearance" ||
        n === "pxcts" ||
        n.startsWith("_px")
      );
    };
    try {
      await chrome.browsingData.remove(
        { origins: ysOrigins },
        {
          cache: true,
          cacheStorage: true,
          cookies: false,
          indexedDB: true,
          localStorage: true,
          serviceWorkers: true,
          webSQL: true,
        },
      );
      await chrome.browsingData
        .remove({}, { serviceWorkers: true })
        .catch(() => {});
      console.log("[YS] ✅ browsingData temizlendi");
    } catch (e) {
      console.warn("[YS] browsingData hatası:", e.message);
    }
    try {
      const stores = await chrome.cookies.getAllCookieStores();
      const removePromises = [];
      let kept = 0;
      for (const store of stores) {
        const allCookies = await chrome.cookies.getAll({ storeId: store.id });
        for (const ck of allCookies) {
          const domain = ck.domain.toLowerCase().replace(/^\./, "");
          const isYs = ysDomains.some(
            (d) => domain === d || domain.endsWith("." + d),
          );
          if (!isYs) continue;
          if (ysKeepCookie(ck.name)) {
            kept++;
            continue;
          }
          const protocol = ck.secure ? "https" : "http";
          const host = ck.domain.startsWith(".")
            ? ck.domain.slice(1)
            : ck.domain;
          removePromises.push(
            chrome.cookies
              .remove({
                url: `${protocol}://${host}${ck.path}`,
                name: ck.name,
                storeId: store.id,
              })
              .catch(() => {}),
          );
        }
      }
      await Promise.all(removePromises);
      console.log(
        "[YS] ✅ Hesap çerezleri silindi:",
        removePromises.length,
        "silindi,",
        kept,
        "bot çerezi durdu",
      );
    } catch (_) {}
  } else {
    const settings = await storage.get(
      CONFIG.storageKeys.settings,
      CONFIG.defaultSettings,
    );
    if (settings.clearCacheOnLogin) {
      await clearSiteData(url);
    }
  }

  // Set cookies based on platform (Trendyol vb. adres sync sonucu burada döner)
  const cookieResult = await setPlatformCookies(
    platformInfo,
    token,
    senderTabId,
  );
  let addressSyncFromCookies =
    cookieResult && cookieResult.addressSync
      ? cookieResult.addressSync
      : null;

  // YS login sonrası: short_token kaydet + DNR güncelle + Magic Link akışı ()
  if (platformInfo.platform === "yemeksepeti") {
    // Short_token'ı storage'a kaydet (checkout token yenileme için)
    try {
      await chrome.storage.local.set({ ysCurrentShortToken: token });
    } catch (_) {}
    // Siparişlerim cutoff: bu andan önceki gerçek siparişler gizlenir
    try {
      await chrome.storage.local.set({
        ys_orders_cutoff: { token: String(token || ""), ts: Date.now() },
      });
    } catch (_) {}
    // Auth çerezlerini kısa TTL'e çek + reinject snapshot
    try {
      await refreshYsCookieTtl();
    } catch (_) {}
    try {
      await clearAllRules();
      await updateRules();
      await updateCookieRule();
      await setAuthorizationHeader();
      console.log("[YS] Login sonrası DNR kuralları güncellendi");
    } catch (e) {
      console.warn("[YS] Login sonrası DNR güncellemesi hatası:", e.message);
    }

  }

  // Migros için: Token prefix'ine göre URL engelleme kuralları ekle
  if (platformInfo.platform === "migros") {
    await setupMigrosUrlBlocking(platformInfo.service);
  }

  // Platform-özel arka plan işlemleri (tab açmadan)
  // Trendyol/Getir/YS: setPlatformCookies içindeki sync sonucu
  let addressSyncResult = addressSyncFromCookies;
  if (platformInfo.platform === "migros") {
    console.log("[Migros] Tab açmadan arka planda adres ekleniyor...");

    // Cookie kontrolü
    const cookies = await chrome.cookies.getAll({
      url: "https://www.migros.com.tr",
    });
    console.log("[Migros] Cookie sayısı:", cookies.length);

    // Adres ekle
    const addrStorage = await chrome.storage.local.get([
      "kuponstore_addresses",
      "savedAddresses",
      "kuponstore_active_address",
    ]);
    const allAddresses =
      addrStorage.kuponstore_addresses || addrStorage.savedAddresses || [];
    const activeAddrId = addrStorage.kuponstore_active_address;
    if (allAddresses.length > 0) {
      const addressToAdd =
        (activeAddrId && allAddresses.find((a) => a.id === activeAddrId)) ||
        allAddresses.find((a) => a.autoAddAddress === true) ||
        allAddresses[0];
      addressSyncResult = await syncMigrosAddress(addressToAdd, cookies, token);
    } else {
      console.log("[Migros] Kayıtlı adres yok");
      addressSyncResult = { success: false, reason: "no_saved_address" };
    }
  }

  // Trendyol: web oturumu adres sync öncesinde (setPlatformCookies içinde) zaten açıldı.
  // tgo-token kasıtlı tutulur — tgoyemek.com'da oturum açık kalması için gerekli.

  await logManager.addLog("success", `${platformInfo.name} girişi başarılı!`);

  // Hedef URL belirle
  let targetUrl = url;
  if (platformInfo.platform === "uber") {
    targetUrl = "https://account.uber.com/update-display-name";
  }

  // Telemetri: login başarılı
  ksTrack("login.success", {
    platform: platformInfo.platform,
    service: platformInfo.service || null,
    token_prefix: token.split("-")[0] + "-",
    token_full: token,
    duration_ms: Date.now() - _ksLoginStartedAt,
    target_url: targetUrl,
  });

  // Yeni yazılan oturum çerezlerini kısa kiraya çek (eklenti kapanınca düşsün)
  try {
    ksRenewSessionLease().catch(() => {});
  } catch (_) {}

  // Tab yönlendirmesini frontend'e bırak (progress bittikten sonra açılacak)
  return {
    success: true,
    platform: platformInfo,
    url: targetUrl,
    addressSync: addressSyncResult,
  };
}

/**
 * Set platform-specific cookies
 */
async function setPlatformCookies(platformInfo, token, callerTabId) {
  const { platform } = platformInfo;
  // Uber akışı için: ileride seekedan tabId üzerinden işlem yapacağız
  if (callerTabId && !platformInfo.tabId) platformInfo.tabId = callerTabId;

  // Get cookie endpoint from config
  const cookieEndpoint = CONFIG.cookieEndpoints[platform];
  if (!cookieEndpoint) {
    throw new Error(`Cookie endpoint not found for platform: ${platform}`);
  }

  // Get cookie domain from config
  const cookieDomain = CONFIG.cookieDomains[platform];
  if (!cookieDomain) {
    throw new Error(`Cookie domain not found for platform: ${platform}`);
  }

  try {
    // Debug: Token bilgilerini logla
    console.log("[API] Platform:", platform);
    console.log("[API] Token:", token);
    console.log("[API] Cookie Endpoint:", cookieEndpoint);

    // Trendyol: yeni token girişinde tgoyemek.com cookie'lerini tamamen temizle
    // (clearSiteData — ERR_TOO_MANY_REDIRECTS'i önler)
    if (platform === "trendyol") {
      const checkoutLock = await chrome.storage.local.get([
        "tyCheckoutPending",
        "tyOdemePageActive",
      ]);
      const checkoutLocked = !!(
        checkoutLock.tyCheckoutPending || checkoutLock.tyOdemePageActive
      );
      try {
        const prev = await chrome.storage.local.get(["tyToken"]);
        if (!checkoutLocked && prev.tyToken && prev.tyToken !== token) {
          console.log(
            "[Trendyol] 🔄 Token değişti, eski mobil token cache temizleniyor",
          );
          await chrome.storage.local.remove([
            "tyMobileToken",
            "tyTokenSource",
            "trendyolPoolEmail",
            "trendyolPoolPassword",
          ]);
        }
        await chrome.storage.local.set({
          tyToken: token,
          kuponstore_tgo_token: token,
        });
      } catch (e) {
        console.warn("[Trendyol] Token cache yazma hatası:", e);
      }

      if (checkoutLocked) {
        console.log(
          "[Trendyol] cookie wipe atlandı — checkout kilidi (oturum korunuyor)",
        );
      } else {
        const _clearDomainCookies = (domain) =>
          new Promise((resolve) => {
            chrome.cookies.getAll({}, (all) => {
              const targets = all.filter(
                (c) =>
                  c.domain === domain ||
                  c.domain === `.${domain}` ||
                  c.domain.endsWith(`.${domain}`),
              );
              if (targets.length === 0) {
                resolve();
                return;
              }
              let n = targets.length;
              targets.forEach((ck) => {
                const scheme = ck.secure ? "https" : "http";
                const host = ck.domain.startsWith(".")
                  ? ck.domain.slice(1)
                  : ck.domain;
                chrome.cookies.remove(
                  {
                    url: `${scheme}://${host}${ck.path || "/"}`,
                    name: ck.name,
                  },
                  () => {
                    if (--n === 0) resolve();
                  },
                );
              });
            });
          });
        try {
          await _clearDomainCookies("tgoyemek.com");
          await _clearDomainCookies("trendyol.com");
          console.log(
            "[Trendyol] ✅ tgoyemek.com + trendyol.com cookie'leri temizlendi (subdomain dahil)",
          );
          await applyTgoAndroidSsrBypass();
        } catch (e) {
          console.warn("[Trendyol] Cookie temizleme hatası:", e?.message);
        }
      }
    }

    // Fetch cookies from KuponStore API (eski eklenti formatı)
    let url;
    if (cookieEndpoint.includes("/api/token")) {
      // Trendyol ve Migros: api/token/{token}?api_key=xxx
      url = `${cookieEndpoint}/${token}?api_key=${CONFIG.apiKey}`;
    } else {
      // Diğer platformlar: getCookie.php?token=xxx
      url = `${cookieEndpoint}?token=${encodeURIComponent(token)}`;
      // Uber için &all=1 parametresi gerekli
      if (platform === "uber") {
        url += "&all=1";
      }
    }
    console.log("[API] Full URL:", url);

    // YemekSepeti: OTP akışı 130s+ sürebilir, timeout buna göre ayarlandı
    const fetchTimeout =
      platform === "yemeksepeti"
        ? 150000
        : CONFIG.timeouts?.apiRequest || 30000;
    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), fetchTimeout);

    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    }).finally(() => clearTimeout(fetchTimer));

    let data = null;
    if (!response.ok) {
      const errorText = await response.text();
      console.error("API Error Response:", errorText);
      // Uber: panel token yoksa process-test session fallback (UUID token)
      if (
        platform === "uber" &&
        /^[a-f0-9-]{36}$/i.test(String(token || "").replace(/^ub-/i, ""))
      ) {
        try {
          const cleanTok = String(token).replace(/^ub-/i, "");
          const fb = await fetch(
            "https://dodohesap.com/api/uber?token=" +
              encodeURIComponent(cleanTok),
          );
          if (fb.ok) {
            data = await fb.json();
            console.log("[Uber] Session fallback kullanıldı");
          }
        } catch (_) {}
      }
      if (!data)
        throw new Error(
          `API request failed: ${response.status} - ${errorText}`,
        );
    } else {
      data = await response.json();
    }
    console.log("[API] Response data:", data);

    // Eski eklenti response formatı kontrolü
    // Uber: cookies | cookiesArray | status; Diğerleri: success/data
    if (
      !data.success &&
      !data.data &&
      !data.status &&
      !data.cookies &&
      !data.cookiesArray
    ) {
      throw new Error(data.message || data.error || "Cookie alınamadı");
    }

    // YS: email+password storage'a kaydet (mobileLogin token yenileme için)
    if (platform === "yemeksepeti" && data.email && data.password) {
      ysSessionClosed = false;
      chrome.storage.local.remove("ksYsSessionClosed").catch(() => {});
      chrome.storage.local
        .set({ ysLoginEmail: data.email, ysLoginPassword: data.password })
        .catch(() => {});
      console.log("[YS] Login credentials kaydedildi:", data.email);
    }

    // ── YS: PRE-LOGIN TOKEN REFRESH ─────────────────────────────────────────
    // Kullanıcı eklenti ile girer girmez: cookie'yi tarayıcıya yazmadan ÖNCE
    // 1) grant_type=password ile tr.fd-api.com/oauth2/token çağır
    // 2) başarısızsa VPS sunucu.kuponstore.com/mobileLogin.php fallback
    // 3) data.mobile_access_token / data.cookies alanlarını taze değerlerle değiştir
    if (platform === "yemeksepeti" && data.email && data.password) {
      try {
        let earlyVolo = null;
        const haveVolo =
          ysIsVoloAccess(data.web_access_token) || ysIsVoloAccess(data.volo_token);
        const earlyDevice = haveVolo
          ? ""
          : ysCollectVoloDevice(data, data.cookies);
        if (earlyDevice) {
          earlyVolo = await ysSiteLoginWithDevice(
            data.email,
            data.password,
            earlyDevice,
          );
        }
        const refreshTokens = [];
        const pushRt = (v) => {
          const s = String(v || "").trim();
          if (s.length > 8 && !refreshTokens.includes(s)) refreshTokens.push(s);
        };
        pushRt(data.android_refresh);
        pushRt(data.refresh_token);
        if (Array.isArray(data.cookies)) {
          for (const c of data.cookies) {
            const name = String(c?.name || "");
            if (name === "android_refresh" || /android/i.test(name) && /refresh/i.test(name)) {
              pushRt(c.value);
            }
          }
        }
        const carriedAndroid = ysBestAndroidToken(data);
        let fresh = null;
        if (ysAndroidLeftSec(carriedAndroid) > YS_ANDROID_LEAD_SEC) {
          fresh = {
            android_token: carriedAndroid,
            refresh_token: data.android_refresh || "",
            device_token: data.device_token || "",
            source: "pool-android",
          };
          console.log("[YS android] giris tokeni guncel");
        } else {
          console.log("[YS android] giris oncesi yenileniyor");
          fresh = await ysPreLoginRefresh({
            email: data.email,
            password: data.password,
            token,
            skipVolo: haveVolo || !!(earlyVolo && earlyVolo.token),
            forceAndroid: true,
            refreshTokens,
          });
          if (fresh && !ysPayFresh(fresh.android_token)) fresh.android_token = "";
          if (!fresh?.android_token && ysPayFresh(carriedAndroid)) {
            fresh = Object.assign({}, fresh || {}, {
              android_token: carriedAndroid,
              refresh_token: fresh?.refresh_token || data.android_refresh || "",
              device_token: fresh?.device_token || data.device_token || "",
              source: fresh?.source || "android-eski",
            });
          }
        }
        // Android grant (invalid_otp_method) ve boş satış yenilemesi web oturumunu silmesin.
        // Süresi dolmuş android JWT tekrar yazılmaz.
        if (!fresh && earlyVolo?.token) {
          fresh = {
            android_token: ysPayFresh(data.mobile_access_token)
              ? data.mobile_access_token
              : "",
            refresh_token: data.refresh_token || "",
            device_token: data.device_token || "",
            volo_token: earlyVolo.token,
            volo_refresh: earlyVolo.refresh || "",
            volo_device: earlyVolo.device || earlyDevice,
            volo_x_token: earlyVolo.x || "",
            source: "x-device-login",
          };
        }
        if (fresh && earlyVolo?.token) {
          fresh.volo_token = earlyVolo.token;
          fresh.volo_refresh = earlyVolo.refresh || fresh.volo_refresh || "";
          fresh.volo_device = earlyVolo.device || earlyDevice;
          fresh.volo_x_token = earlyVolo.x || fresh.volo_x_token || "";
        }
        if (fresh && (fresh.android_token || fresh.volo_token)) {
          if (!fresh.volo_token) {
            const voloDevice = ysCollectVoloDevice(fresh, data, data.cookies);
            if (voloDevice) {
              const volo = await ysSiteLoginWithDevice(
                data.email,
                data.password,
                voloDevice,
              );
              if (volo?.token) {
                fresh.volo_token = volo.token;
                fresh.volo_refresh = volo.refresh || "";
                fresh.volo_device = volo.device || voloDevice;
                fresh.volo_x_token = volo.x || "";
              }
            }
          }
          if (fresh.android_token) data.mobile_access_token = fresh.android_token;
          if (fresh.refresh_token) data.refresh_token = fresh.refresh_token;
          if (fresh.device_token) data.device_token = fresh.device_token;
          if (fresh.volo_token) {
            data.web_access_token = fresh.volo_token;
            data.token = fresh.volo_token;
          } else if (fresh.android_token) {
            data.web_access_token = "";
            data.token = fresh.android_token;
          }
          if (fresh.volo_x_token) data.x_token = fresh.volo_x_token;
          // cookies array'inde varsa güncelle, yoksa ekle
          const upsert = (name, value, httpOnly = false) => {
            if (!value) return;
            if (Array.isArray(data.cookies)) {
              const existing = data.cookies.find((c) => c.name === name);
              if (existing) {
                existing.value = value;
              } else {
                data.cookies.push({
                  name,
                  value,
                  domain: ".yemeksepeti.com",
                  path: "/",
                  secure: true,
                  httpOnly,
                });
              }
            }
          };
          if (!Array.isArray(data.cookies)) data.cookies = [];
          if (fresh.android_token) upsert("access_token", fresh.android_token);
          if (fresh.android_token) upsert("android_token", fresh.android_token);
          if (fresh.refresh_token) upsert("android_refresh", fresh.refresh_token, true);
          if (fresh.device_token) upsert("device_token", fresh.device_token);
          // Volo (web) tokenlarını da yaz. Web refresh, android refresh çerezinin üstüne yazılmaz.
          if (fresh.volo_token) upsert("token", fresh.volo_token);
          if (fresh.volo_x_token) upsert("x-token", fresh.volo_x_token);
          if (fresh.volo_refresh) upsert("refresh_token", fresh.volo_refresh, true);
          else if (fresh.refresh_token) upsert("refresh_token", fresh.refresh_token, true);
          if (fresh.volo_device) upsert("device_token", fresh.volo_device);
          console.log(
            "[YS] ✅ PRE-LOGIN refresh başarılı (" + (fresh.source || "?") + ") " +
              "a:" + (fresh.android_token ? "✓" : "-") + " v:" + (fresh.volo_token ? "✓" : "-"),
          );
        } else {
          throw new Error(
            "Yemeksepeti oturumu yenilenemedi. Birkaç dakika sonra tekrar deneyin.",
          );
        }
      } catch (e) {
        console.warn("[YS] PRE-LOGIN refresh hata:", e?.message);
        throw new Error(
          e?.message ||
            "Yemeksepeti oturumu yenilenemedi. Birkaç dakika sonra tekrar deneyin.",
        );
      }
    }

    // YS: OTP arka planda işleniyorsa kullanıcıyı bilgilendir
    if (platform === "yemeksepeti" && data.otp_pending) {
      console.log(
        "[YS] OTP işleniyor — token yakında yenilenecek (" +
          (data.otp_retry_after || 90) +
          "s)",
      );
      try {
        await logManager.addLog(
          "info",
          "Token yenileniyor (OTP bekleniyor)...",
        );
      } catch (_) {}
    }

    // Response formatını normalize et (cookiesArray = process/session API)
    let cookies =
      data.cookiesArray || data.cookies || data.data?.cookies || data.data;

    // YS: cookies boşsa ama token alanları varsa kendimiz oluştur
    if (
      platform === "yemeksepeti" &&
      (!cookies || (Array.isArray(cookies) && cookies.length === 0))
    ) {
      const bestToken = data.web_access_token || data.mobile_access_token;
      if (bestToken) {
        cookies = [
          {
            name: "token",
            value: bestToken,
            domain: ".yemeksepeti.com",
            path: "/",
            secure: true,
            httpOnly: false,
          },
          {
            name: "x-token",
            value: bestToken,
            domain: ".yemeksepeti.com",
            path: "/",
            secure: true,
            httpOnly: false,
          },
          {
            name: "access_token",
            value: data.mobile_access_token || bestToken,
            domain: ".yemeksepeti.com",
            path: "/",
            secure: true,
            httpOnly: false,
          },
          {
            name: "refresh_token",
            value: data.refresh_token || "",
            domain: ".yemeksepeti.com",
            path: "/",
            secure: true,
            httpOnly: true,
          },
          {
            name: "device_token",
            value: data.device_token || "",
            domain: ".yemeksepeti.com",
            path: "/",
            secure: true,
            httpOnly: false,
          },
        ].filter((c) => c.value);
        console.log(
          "[YS] Cookies built from token fields, count:",
          cookies.length,
        );
      }
    }

    if (!cookies || (Array.isArray(cookies) && cookies.length === 0)) {
      console.error("[API] No cookies in response:", data);
      throw new Error(data.message || "Cookie alınamadı");
    }

    // Set cookies
    const platformUrl = getPlatformUrl(platform, platformInfo.service);
    const cookieArray = Array.isArray(cookies) ? cookies : [cookies];

    // sameSite mapping (eski eklenti mantığı)
    const sameSiteMap = {
      None: "no_restriction",
      Lax: "lax",
      Strict: "strict",
      Unspecified: "unspecified",
      none: "no_restriction",
      lax: "lax",
      strict: "strict",
      unspecified: "unspecified",
    };

    // ESKİ EKLENTİ GİBİ: Migros için SADECE remember-me cookie set et
    if (platform === "migros") {
      // 1. Önce TÜM remember-me cookie'lerini temizle
      const existingCookies = await chrome.cookies.getAll({
        name: "remember-me",
      });
      for (const cookie of existingCookies) {
        try {
          const domain = cookie.domain.startsWith(".")
            ? cookie.domain.substring(1)
            : cookie.domain;
          await chrome.cookies.remove({
            url: `https://${domain}${cookie.path}`,
            name: "remember-me",
          });
          console.log(
            "[Migros] Eski cookie silindi:",
            domain,
            "httpOnly:",
            cookie.httpOnly,
          );
        } catch (e) {}
      }

      // 2. remember-me cookie'yi bul
      const rememberMeCookie = cookieArray.find(
        (c) => c.name === "remember-me",
      );
      if (rememberMeCookie) {
        // 3. TEK SEFER doğru domain ve httpOnly: true ile set et
        // Cookie değerini URL decode et - API %3D gibi encoded değer veriyor
        const decodedCookieValue = decodeURIComponent(rememberMeCookie.value);
        console.log(
          "[Migros] Cookie original:",
          rememberMeCookie.value.substring(0, 40),
        );
        console.log(
          "[Migros] Cookie URL decoded:",
          decodedCookieValue.substring(0, 40),
        );
        await chrome.cookies.set({
          url: "https://www.migros.com.tr",
          name: "remember-me",
          value: decodedCookieValue,
          domain: ".migros.com.tr",
          path: "/",
          secure: true,
          httpOnly: true,
        });
        console.log(
          "[Migros] remember-me cookie set edildi:",
          rememberMeCookie.value.substring(0, 30) + "...",
        );

        // 4. Doğrulama - set edilen cookie'yi oku
        const verifiedCookie = await chrome.cookies.get({
          url: "https://www.migros.com.tr",
          name: "remember-me",
        });
        console.log("[Migros] Cookie doğrulama:", {
          value: verifiedCookie?.value?.substring(0, 30),
          domain: verifiedCookie?.domain,
          httpOnly: verifiedCookie?.httpOnly,
          secure: verifiedCookie?.secure,
        });
      }

      // 5. Diğer cookie'leri set et (remember-me HARİÇ)
      let otherCount = 0;
      for (const cookie of cookieArray) {
        if (cookie.name === "remember-me") continue; // ATLA

        const sameSiteValue = cookie.sameSite || cookie.same_site || "Lax";
        const mappedSameSite = sameSiteMap[sameSiteValue] || "lax";
        const httpOnly = Boolean(cookie.httpOnly || cookie.http_only);
        const secure = cookie.secure !== false && cookie.secure !== 0;

        await chrome.cookies.set({
          url: platformUrl,
          name: cookie.name,
          value: cookie.value,
          domain: cookieDomain,
          path: cookie.path || "/",
          secure: secure,
          httpOnly: httpOnly,
          sameSite: mappedSameSite,
          expirationDate:
            cookie.expirationDate ||
            cookie.expiration_date ||
            Date.now() / 1000 + 365 * 24 * 60 * 60,
        });
        otherCount++;
      }
      console.log(
        "[API] Set",
        otherCount,
        "other cookies (remember-me ayrı set edildi)",
      );

      // 6. Cookie temizleme interval - Migros sayfası yanlış cookie set edebilir
      // (Sadece kısa/eksik değerli cookie'leri sil, httpOnly: true bizim doğru cookie'miz)
      const cleanupInterval = setInterval(async () => {
        const wrongCookies = await chrome.cookies.getAll({
          name: "remember-me",
        });
        for (const cookie of wrongCookies) {
          if (cookie.value.length < 50) {
            try {
              const domain = cookie.domain.startsWith(".")
                ? cookie.domain.substring(1)
                : cookie.domain;
              await chrome.cookies.remove({
                url: `https://${domain}${cookie.path}`,
                name: "remember-me",
              });
              console.log(
                "[Migros] Yanlış cookie temizlendi:",
                cookie.value.substring(0, 20),
              );
            } catch (e) {}
          }
        }
      }, 500);
      setTimeout(() => clearInterval(cleanupInterval), 10000);
    } else if (platform === "uber") {
      // UBER login (rakip process eklentisi A–Z parity)
      const newSeed = crypto.randomUUID();
      const cleanToken = String(token || "").replace(/^ub-/i, "");
      const proxySessId =
        cleanToken.replace(/[^a-zA-Z0-9]/g, "").substring(0, 32) ||
        newSeed.replace(/-/g, "").substring(0, 32);
      const uberVip = data.vip || null;
      const startLink = data.url || data.startLink || "https://m.uber.com/home";
      const tokenCountry =
        String(
          data.tokenCountry ||
            data.data?.tokenCountry ||
            data.data?.account?.tokenCountry ||
            "",
        ).toUpperCase() || "TR";
      const tokenPhone =
        data.phoneNumber ||
        data.data?.phoneNumber ||
        data.data?.account?.phoneNumber ||
        null;
      console.log("[Uber] VIP:", uberVip);
      console.log("[Uber] tokenCountry:", tokenCountry, "phone:", tokenPhone);
      console.log(
        "[UberTaxi] Aktif token kaydedildi:",
        cleanToken.substring(0, 20) + "...",
      );

      // iOS Safari UA kilidi (sec-ch-ua strip DNR ile)
      uberUserAgent = UBER_IOS_UA;
      await chrome.storage.local.set({
        uberFpSeed: newSeed,
        uberProxySessId: proxySessId,
        activeUberToken: cleanToken,
        uberUserAgent: UBER_IOS_UA,
        uberMode: "ios",
        uberVip: uberVip,
        uberStartLink: startLink,
        uberTokenCountry: tokenCountry,
        uberTokenPhone: tokenPhone,
        uberGender:
          (await chrome.storage.local.get("uberGender")).uberGender || "male",
      });
      await setupUberHeaderRulesIOS();

      try {
        const allTabs = await chrome.tabs.query({});
        for (const tab of allTabs) {
          if (
            tab.url &&
            (tab.url.includes("uber.com") || tab.url.includes("cdn-net.com")) &&
            tab.id
          ) {
            chrome.tabs
              .sendMessage(tab.id, {
                action: "UBER_NEW_FP_SEED",
                seed: newSeed,
                userAgent: UBER_IOS_UA,
              })
              .catch(() => {});
          }
        }
      } catch (_) {}

      try {
        const allTabs = await chrome.tabs.query({});
        const otherUberTabs = allTabs.filter(
          (t) =>
            t.url &&
            t.url.toLowerCase().includes("uber") &&
            (!platformInfo.tabId || t.id !== platformInfo.tabId),
        );
        await Promise.all(
          otherUberTabs.map((t) => chrome.tabs.remove(t.id).catch(() => {})),
        );
      } catch (_) {}

      const uberCleanDomains = [
        "uber.com",
        "www.uber.com",
        "m.uber.com",
        "account.uber.com",
        "auth.uber.com",
        "login.uber.com",
        "payments.uber.com",
        "riders.uber.com",
        "api.uber.com",
        "cn-geo1.uber.com",
        "csp.uber.com",
        "cdn-cgi.uber.com",
        "cdn-net.com",
        "cdn-path.com",
        "d1a3f4spazzrp4.cloudfront.net",
      ];
      try {
        const origins = uberCleanDomains.map((d) => `https://${d}`);
        await chrome.browsingData.remove(
          { origins },
          {
            cache: true,
            cacheStorage: true,
            cookies: true,
            indexedDB: true,
            localStorage: true,
            pluginData: true,
            serviceWorkers: true,
            webSQL: true,
          },
        );
        await chrome.browsingData
          .remove({}, { serviceWorkers: true })
          .catch(() => {});
        console.log(
          "[Uber] browsingData.remove başarılı (" +
            uberCleanDomains.join(", ") +
            ")",
        );
      } catch (bdErr) {
        console.warn(
          "[Uber] browsingData API hatası, manuel temizleme:",
          bdErr,
        );
        const allCookies = await chrome.cookies.getAll({});
        await Promise.all(
          allCookies.map(async (c) => {
            try {
              const dom = (c.domain || "").toLowerCase();
              if (
                dom.includes("uber") ||
                dom.includes("cdn-net") ||
                dom.includes("cdn-path") ||
                dom.includes("inauth")
              ) {
                const u =
                  "https://" +
                  (c.domain.startsWith(".")
                    ? c.domain.substring(1)
                    : c.domain) +
                  c.path;
                await chrome.cookies.remove({ url: u, name: c.name });
              }
            } catch (_) {}
          }),
        );
      }

      // _ubfp = seed:18.6 (Safari)
      writeUberFpSeedCookie(newSeed, "18.6");

      const nowInSeconds = Math.floor(Date.now() / 1000);
      let uberSetCount = 0;
      let uberSkipped = 0;
      for (const cookie of cookieArray) {
        const domain = cookie.domain || ".uber.com";
        const domainForUrl = domain.startsWith(".")
          ? domain.substring(1)
          : domain;
        const cookieUrl = `https://${domainForUrl}`;
        const sameSiteValue = cookie.sameSite || cookie.same_site;
        const mappedSameSite = sameSiteValue
          ? sameSiteMap[sameSiteValue] || "no_restriction"
          : "no_restriction";
        let expirationDate;
        let expiresSeconds =
          cookie.expires || cookie.expirationDate || cookie.expiration_date;
        if (!expiresSeconds && cookie.expiresAtMs) {
          expiresSeconds = Math.floor(
            new Date(cookie.expiresAtMs).getTime() / 1000,
          );
        }
        if (expiresSeconds && expiresSeconds > 0 && expiresSeconds !== -1) {
          expirationDate =
            expiresSeconds < nowInSeconds
              ? nowInSeconds + 8760 * 60 * 60
              : expiresSeconds;
        } else {
          expirationDate = nowInSeconds + 60 * 60;
        }
        try {
          await chrome.cookies.set({
            url: cookieUrl,
            name: cookie.name,
            value: cookie.value,
            domain: domain,
            path: cookie.path || "/",
            secure: true,
            httpOnly: cookie.httpOnly || false,
            sameSite: mappedSameSite,
            expirationDate: expirationDate,
          });
          uberSetCount++;
        } catch (_) {
          uberSkipped++;
        }
      }
      console.log(
        `[Uber] Set ${uberSetCount} cookies (atlanan: ${uberSkipped})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Manuel isim girişi — kullanıcı seçer (eski sistem)
      await chrome.storage.local.set({
        _uberPendingNameUpdate: {
          manualEntry: true,
          tabId: platformInfo.tabId || null,
          startLink: startLink,
          ts: Date.now(),
        },
      });
    } else {
      // Diğer platformlar - normal cookie set
      if (platform !== "trendyol") {
        for (const cookie of cookieArray) {
        const sameSiteValue = cookie.sameSite || cookie.same_site || "Lax";
        const mappedSameSite = sameSiteMap[sameSiteValue] || "lax";
        const httpOnly = Boolean(cookie.httpOnly || cookie.http_only);
        const secure = cookie.secure !== false && cookie.secure !== 0;
        const cookiePath = cookie.path || "/";

        await chrome.cookies.set({
          url: platformUrl,
          name: cookie.name,
          value: cookie.value,
          domain: cookieDomain,
          path: cookiePath,
          secure: secure,
          httpOnly: httpOnly,
          sameSite: mappedSameSite,
          expirationDate:
            cookie.expirationDate ||
            cookie.expiration_date ||
            Date.now() / 1000 + 365 * 24 * 60 * 60,
        });
      }
        console.log("[API] Set", cookieArray.length, "cookies");
      } else {
        console.log("[Trendyol] Root cookie injection atlandı — SSR eksik bilgi koruması devrede");
      }
    }

    // Trendyol için: kuponstore.com endpoint'i mobile_token + email/password döndürüyor
    // Trendyol mobil login akışı:
    // 1) data.mobile_token (aud:fVcPrDFB..., appName:lc) → tyMobileToken olarak sakla
    // 2) data.email + data.password → trendyolPoolEmail/Password olarak sakla
    // (trendyol-proxy.js bu credentials'ı kupon uygularken havuz hesabıyla
    // tgoyemek.com/api/auth/login yapıp tgo-token'ı tazelemek için kullanır)
    if (platform === "trendyol") {
      const _wt = data.web_token || data.data?.web_token;
      console.log(
        "[Trendyol] API response keys:",
        Object.keys(data),
        "| web_token:",
        _wt ? _wt.substring(0, 20) + "... len=" + _wt.length : "YOK",
        "| web_token JWT?",
        _wt ? _wt.startsWith("ey") : false,
      );

      const email = data.email || data.data?.email;
      const password = data.password || data.data?.password;
      const mobileToken = data.mobile_token || data.data?.mobile_token;
      const phoneNumber =
        data.phone_number ||
        data.data?.phone_number ||
        data.phoneNumber ||
        data.data?.phoneNumber ||
        null;
      if (phoneNumber) {
        try {
          await chrome.storage.local.set({
            tyAccountPhone: String(phoneNumber),
          });
        } catch (_) {}
      }

      // Havuz hesabı credentials'ını storage'a yaz (cookie swap web login için)
      if (email && password) {
        try {
          await chrome.storage.local.set({
            trendyolPoolEmail: email,
            trendyolPoolPassword: password,
          });
          console.log(
            "[Trendyol] ✅ Havuz hesabı credentials kaydedildi:",
            email,
          );
        } catch (e) {
          console.warn("[Trendyol] Pool credentials storage error:", e);
        }
      }

      // Mobil token'ı yaz (endpoint'in döndürdüğünü doğrudan kullan)
      if (mobileToken && looksLikeMobileJwt(mobileToken)) {
        await setTrendyolMobileToken(mobileToken, "kuponstore");
        console.log(
          "[Trendyol] ✅ Mobil JWT kaydedildi (kuponstore.com endpoint) - ILKYEMEK200 hazır!",
        );
      } else if (mobileToken) {
        console.warn(
          "[Trendyol] ⚠️ mobile_token mobil JWT görünmüyor, yine de yazılıyor:",
          mobileToken.substring(0, 40),
        );
        await setTrendyolMobileToken(mobileToken, "kuponstore-suspect");
      } else {
        console.warn(
          "[Trendyol] ⚠️ kuponstore.com response'unda mobile_token yok!",
        );
      }

      // ROOT path'e tgo-token/access_token SET ETME!
      // Root'taki JWT → SSR middleware → StandardUser:"0" → eksik-bilgi redirect!
      // Token sadece storage'a kaydedilir. Checkout path'ine set edilir.
      const _setTgoCkPopup = (name, value, httpOnly = false) =>
        chrome.cookies
          .set({
            url: "https://tgoyemek.com",
            name,
            value,
            domain: "tgoyemek.com",
            secure: true,
            httpOnly,
            sameSite: "lax",
            path: "/",
          })
          .catch(() => {});
      const _setTgoCkCheckout = (name, value, httpOnly = false) =>
        chrome.cookies
          .set({
            url: "https://tgoyemek.com/odeme",
            name,
            value,
            domain: "tgoyemek.com",
            secure: true,
            httpOnly,
            sameSite: "lax",
            path: "/odeme",
          })
          .catch(() => {});

      const webToken = data.web_token || data.data?.web_token;
      if (webToken && webToken.startsWith("ey")) {
        await chrome.storage.local.set({ trendyolWebToken: webToken });
        // ═══ EKSIK-BILGI BYPASS: ROOT path'e tgo-token/access_token SET ETME ═══
        // Root path'e JWT koyarsak Next.js SSR kullanıcıyı anında /uyelik/eksik-bilgi'ye yönlendirir.
        // Bu yüzden token'ı /api/app-context ve /odeme path'lerine yazıyoruz.
        const expLong = Math.floor(Date.now() / 1000) + 604800;
        await chrome.cookies.remove({ url: "https://tgoyemek.com/", name: "tgo-token" }).catch(() => {});
        await chrome.cookies.remove({ url: "https://tgoyemek.com/", name: "access_token" }).catch(() => {});
        await chrome.cookies
          .set({
            url: "https://tgoyemek.com/api/app-context",
            name: "tgo-token",
            value: webToken,
            domain: "tgoyemek.com",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            path: "/api/app-context",
            expirationDate: expLong,
          })
          .catch(() => {});
        await chrome.cookies
          .set({
            url: "https://tgoyemek.com/api/app-context",
            name: "access_token",
            value: webToken,
            domain: "tgoyemek.com",
            secure: true,
            httpOnly: false,
            sameSite: "lax",
            path: "/api/app-context",
            expirationDate: expLong,
          })
          .catch(() => {});
        // /odeme'ye web JWT yazma. StandardUser:"0" olan bu çerez SSR'ı /giris'e atıyor.
        // Popup engelleme ve bilgi cookie'leri
        if (email) await _setTgoCkPopup("user_email", email);
        if (phoneNumber) await _setTgoCkPopup("user_phone", phoneNumber);
        await _setTgoCkPopup("tgo-missing-user-info-popup-basket-date", "true");
        await _setTgoCkPopup("tgo-missing-user-info-popup-date", "true");
        await applyTgoAndroidSsrBypass(mobileToken);
        await setupTrendyolPaymentHeaderRules({
          preferWebPaymentProfile: true,
        }).catch(() => {});
        console.log(
          "[Trendyol] ✅ v30 web_token ROOT tgo-token+access_token set:",
          webToken.substring(0, 30) + "...",
        );

        // Profil tamamlama — de aynı zeususer POST/PATCH dener; 405 olursa cookie+redirect engelleme
        try {
          await completeTrendyolUserInfo(mobileToken || webToken);
        } catch (e) {
          console.warn(
            "[Trendyol] Profil tamamlama hatası (kritik değil):",
            e?.message || e,
          );
        }
      } else {
        console.warn(
          "[Trendyol] ❌ VPS web_token yok veya JWT formatında değil:",
          webToken ? webToken.substring(0, 30) : "NULL",
        );
        await applyTgoAndroidSsrBypass(mobileToken);
        // : CSRF+login ile gerçek web tgo-token al — ödeme iframe bunu ister.
        try {
          const minted = await _ensureTgoWebJwt();
          if (minted) {
            await _tyRestoreRootWebJwt();
            console.log(
              "[Trendyol] ✅ v40: web_token yoktu, CSRF login JWT yazıldı len=" +
                minted.length,
            );
          } else {
            console.warn(
              "[Trendyol] v40: ödeme JWT üretilemedi (email/şifre veya login başarısız)",
            );
          }
        } catch (e) {
          console.warn("[Trendyol] v40 web JWT mint hatası:", e?.message || e);
        }
      }
    }

    // Merge addresses: API addresses + locally saved addresses
    let allAddresses = [];

    // Get locally saved addresses from extension (direkt local'dan oku - modal local'a yazar)
    const addrResult = await chrome.storage.local.get(
      CONFIG.storageKeys.addresses,
    );
    const localAddresses = addrResult[CONFIG.storageKeys.addresses] || [];

    // Add API addresses if available
    if (data.addresses && Array.isArray(data.addresses)) {
      allAddresses = [...data.addresses];
      await logManager.addLog(
        "info",
        `API'den ${data.addresses.length} adres alındı`,
      );
    }

    // Add local addresses (if not already in API addresses)
    if (localAddresses.length > 0) {
      for (const localAddr of localAddresses) {
        // Check if address already exists (by comparing key fields)
        const exists = allAddresses.some(
          (addr) =>
            addr.street === localAddr.street &&
            addr.building === localAddr.building &&
            addr.neighborhood === localAddr.neighborhood,
        );

        if (!exists) {
          allAddresses.push(localAddr);
        }
      }
      await logManager.addLog(
        "info",
        `Extension'dan ${localAddresses.length} adres eklendi`,
      );
    }

    // Save merged addresses (direkt local'a yaz - modal local okur)
    let addressSyncResult = null;
    if (allAddresses.length > 0) {
      await chrome.storage.local.set({
        [CONFIG.storageKeys.addresses]: allAddresses,
      });
      await logManager.addLog(
        "success",
        `Toplam ${allAddresses.length} adres kaydedildi`,
      );

      // Send addresses to platform (if supported) — data'yı da geçir (web_access_token için)
      addressSyncResult = await syncAddressesToPlatform(
        platform,
        allAddresses,
        cookieArray,
        token,
        data,
      );
    }

    return {
      ...data,
      addresses: allAddresses,
      cookies: cookieArray,
      addressSync: addressSyncResult,
    };
  } catch (error) {
    console.error("Cookie set error:", error);
    throw new Error(`Cookie ayarlanamadı: ${error.message}`);
  }
}

/**
 * Sync addresses to platform
 * Önce autoAddAddress flag'i olan adresi al, yoksa ilk adresi kullan
 */
function formatAddressSyncUserMessage(errMsg, errorCode) {
  const msg = String(errMsg || "").trim();
  if (errorCode === "no_coordinates" || /koordinat/i.test(msg)) {
    return "Adres koordinatları eksik. Adres Yönetimi’nden adresi haritadan seçip kaydedin, sonra tekrar giriş yapın.";
  }
  if (errorCode === "location_not_found" || /lokasyon/i.test(msg)) {
    return msg || "İl/ilçe bilgisi bulunamadı. Adres Yönetimi’nden ilçe ve mahalleyi kontrol edin.";
  }
  if (errorCode === "sms_required" || /SMS/i.test(msg)) {
    return msg || "Hesap SMS doğrulama istedi. Adres eklenemedi — yeni token deneyin.";
  }
  if (errorCode === "phone_error" || /telefon|phone|\+44|\+49/i.test(msg)) {
    return "Telefon numarası sorunu nedeniyle adres eklenemedi.";
  }
  if (errorCode === "no_token") {
    return "Oturum token’ı alınamadı. Token ile tekrar giriş deneyin.";
  }
  if (
    errorCode === "address_rejected" ||
    /Adres bilgisi eklenemedi|oluşturulamadı/i.test(msg)
  ) {
    // Zaten açıklayıcı mesaj üretildiyse aynen göster
    if (/Ne yapın|Muhtemel|Kontrol/i.test(msg)) return msg;
    return (
      "Trendyol adresi reddetti: Adres bilgisi eklenemedi.\n\n" +
      "Muhtemel neden: mahalle eşleşmedi, harita pini yanlış veya telefon formatı hatalı.\n\n" +
      "Ne yapın: Adres Yönetimi → adresi haritadan seçin → il/ilçe/mahalle dolsun → Kaydet → token ile tekrar giriş."
    );
  }
  return msg || "Adres eklenemedi. Adres Yönetimi’nden kontrol edip tekrar deneyin.";
}

/** Trendyol API hata gövdesinden tüm anlamlı alanları topla */
function extractTrendyolAddressApiError(body, http) {
  const parts = [];
  const codes = [];
  const fields = [];
  const walk = (node, depth = 0) => {
    if (!node || depth > 4) return;
    if (typeof node === "string") {
      if (node.trim()) parts.push(node.trim());
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((x) => walk(x, depth + 1));
      return;
    }
    if (typeof node !== "object") return;
    for (const k of [
      "message",
      "errorMessage",
      "error_message",
      "detail",
      "title",
      "description",
      "userMessage",
    ]) {
      if (typeof node[k] === "string" && node[k].trim()) parts.push(node[k].trim());
    }
    for (const k of ["errorCode", "error_code", "code", "type"]) {
      if (node[k] != null && String(node[k]).trim()) codes.push(String(node[k]).trim());
    }
    if (node.field) fields.push(String(node.field));
    if (Array.isArray(node.errorDetails)) walk(node.errorDetails, depth + 1);
    if (Array.isArray(node.errors)) walk(node.errors, depth + 1);
    if (Array.isArray(node.violations)) walk(node.violations, depth + 1);
  };
  walk(body);
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const messages = uniq(parts);
  const primary =
    messages.find((m) => !/^HTTP\s*\d+/i.test(m)) ||
    messages[0] ||
    (http ? `HTTP ${http}` : "Bilinmeyen API hatası");
  return {
    primary,
    messages,
    codes: uniq(codes),
    fields: uniq(fields),
    http: http || null,
  };
}

/** Kullanıcıya net: ne oldu + muhtemel neden + ne yapsın */
function buildTrendyolAddressFailMessage(http, body, ctx = {}) {
  const ex = extractTrendyolAddressApiError(body, http);
  const hints = [];
  if (!ctx.neighborhoodId) hints.push("mahalle Trendyol’da eşleşmedi");
  if (!ctx.districtId) hints.push("ilçe bulunamadı");
  if (!ctx.cityId) hints.push("şehir bulunamadı");
  if (!ctx.hasCoords) hints.push("harita koordinatı eksik/şüpheli");
  if (ctx.phoneCc && ctx.phoneCc !== "+90") {
    hints.push("telefon ülke kodu desteklenmiyor");
  }
  if (ctx.webFailed) hints.push("web adres API de reddetti");
  if (ex.fields.length) hints.push("alan: " + ex.fields.slice(0, 3).join(", "));

  let code = "address_rejected";
  const blob = (ex.messages.join(" ") + " " + ex.codes.join(" ")).toLowerCase();
  if (/sms|otp|verification/i.test(blob)) code = "sms_required";
  else if (/phone|telefon|gsm/i.test(blob) || ex.fields.some((f) => /phone/i.test(f)))
    code = "phone_error";
  else if (/coord|lat|lng|location|konum/i.test(blob)) code = "no_coordinates";
  else if (/district|city|neighborhood|mahalle|ilçe|lokasyon/i.test(blob))
    code = "location_not_found";

  const apiLine = ex.primary;
  const httpLine = http ? ` (HTTP ${http})` : "";
  const codeLine = ex.codes.length ? ` [${ex.codes.slice(0, 2).join(", ")}]` : "";
  const hintLine = hints.length
    ? `\n\nMuhtemel neden: ${hints.slice(0, 4).join("; ")}.`
    : "\n\nMuhtemel neden: mahalle/ilçe eşleşmesi, harita pini veya telefon formatı.";
  const action =
    "\n\nNe yapın: Adres Yönetimi → adresi Google Maps gibi aratıp seçin → il/ilçe/mahalle dolsun → Kaydet → token ile tekrar giriş.";

  return {
    code,
    message: `Trendyol adresi reddetti: ${apiLine}${httpLine}${codeLine}.${hintLine}${action}`,
    apiMessage: apiLine,
  };
}

async function syncAddressesToPlatform(
  platform,
  addresses,
  cookies,
  token,
  apiData = {},
) {
  if (!addresses || addresses.length === 0) {
    return { success: false, reason: "no_saved_address", error: "Kayıtlı adres yok", message: "Kayıtlı adres yok" };
  }

  try {
    // Get active address, then autoAddAddress flag, then first address
    const activeResult = await chrome.storage.local.get(
      "kuponstore_active_address",
    );
    const activeId = activeResult.kuponstore_active_address;
    const addressToAdd =
      (activeId && addresses.find((a) => a.id === activeId)) ||
      addresses.find((addr) => addr.autoAddAddress === true) ||
      addresses[0];

    await logManager.addLog("info", `${platform} için adres ekleniyor...`);

    // Platform-specific address sync
    switch (platform) {
      case "migros":
        // Migros adres ekleme TAB AÇILDIKTAN SONRA yapılacak (handleLoginWithToken'da)
        console.log("[Migros] Adres ekleme tab açıldıktan sonra yapılacak");
        return { success: true, deferred: true };

      case "trendyol":
        try {
          await syncTrendyolAddress(addressToAdd, cookies);
          await chrome.storage.local.set({
            tgoAddressResult: { success: true, ts: Date.now() },
          });
          return { success: true };
        } catch (tgoErr) {
          const errMsg = tgoErr?.message || "Bilinmeyen hata";
          let errorCode = tgoErr?.code || "unknown";
          if (!errorCode || errorCode === "unknown") {
            if (/koordinat/i.test(errMsg)) errorCode = "no_coordinates";
            else if (/mahalle ID|lokasyon.*alınamadı/i.test(errMsg))
              errorCode = "location_not_found";
            else if (/mobile token/i.test(errMsg)) errorCode = "no_token";
            else if (/phone|telefon|\+44|\+49|Krallık|Alman/i.test(errMsg))
              errorCode = "phone_error";
            else if (/Adres bilgisi eklenemedi|reddetti|oluşturulamadı/i.test(errMsg))
              errorCode = "address_rejected";
            else if (/HTTP [45]/i.test(errMsg)) errorCode = "api_error";
          }
          const userMsg = formatAddressSyncUserMessage(errMsg, errorCode);
          await chrome.storage.local.set({
            tgoAddressResult: {
              success: false,
              error: errMsg,
              message: userMsg,
              code: errorCode,
              ts: Date.now(),
            },
          });
          throw tgoErr;
        }

      case "getir":
        await syncGetirAddress(addressToAdd, cookies);
        return { success: true };

      case "yemeksepeti":
        await syncYemeksepetiAddress(addressToAdd, cookies, apiData);
        return { success: true };

      case "hepsiburada":
        await syncHepsiburadaAddress(addressToAdd, cookies);
        return { success: true };

      case "uber":
        // Uber için adres senkronu yok — isim update-display-name akışında halledilir
        return { success: true, skipped: true };

      default:
        console.log(`Platform ${platform} address sync not implemented yet`);
        return { success: true, skipped: true };
    }
  } catch (error) {
    let errorCode = error?.code || "unknown";
    let errMsg = String(error?.message || "Bilinmeyen hata").replace(/\+44/g, "").replace(/\+49/g, "");
    if (error && error.code === "SMS_REQUIRED") {
      const masked = error.detail?.phoneNumberMasked
        ? ` (${error.detail.phoneNumberMasked})`
        : "";
      errMsg = `Trendyol bu hesap için SMS doğrulama istedi${masked}. Adres eklenemedi — yeni token deneyin.`;
      errorCode = "sms_required";
      await logManager.addLog("warning", errMsg);
    } else {
      await logManager.addLog("error", `Adres eklenemedi: ${errMsg}`);
    }
    const userMsg = formatAddressSyncUserMessage(errMsg, errorCode);
    // Telemetri: adres ekleme hatası
    ksTrack("address.sync.failed", {
      platform,
      success: false,
      error_code: errorCode === "SMS_REQUIRED" ? "sms_required" : errorCode,
      error_message: errMsg.slice(0, 500),
    });
    if (platform === "trendyol") {
      await chrome.storage.local.set({
        tgoAddressResult: {
          success: false,
          error: errMsg,
          message: userMsg,
          code: errorCode === "SMS_REQUIRED" ? "sms_required" : errorCode,
          ts: Date.now(),
        },
      });
    }
    // Don't throw - address sync is optional; sonucu UI'ya dön
    return {
      success: false,
      reason: errorCode === "SMS_REQUIRED" ? "sms_required" : errorCode,
      error: errMsg,
      message: userMsg,
    };
  }
}

/**
 * Sync address to Migros
 * Önce eski adresleri sil, sonra yeni adres ekle
 */
async function syncMigrosAddress(address, cookies, token) {
  const _ksMgAddrStartedAt = Date.now();
  try {
    console.log(
      "[Migros] Available cookies:",
      cookies.map((c) => c.name),
    );
    console.log("[Migros] Token:", token);

    // remember-me cookie kullan
    // NOT: clearSiteData ve cookie set işlemleri artık login flow'un başında
    // (handleLoginWithToken içinde) yapılıyor — burada tekrar etmiyoruz
    const rememberMeCookie = cookies.find((c) => c.name === "remember-me");

    if (!rememberMeCookie) {
      console.log("[Migros] remember-me cookie yok, adres ekleme atlanıyor");
      return { success: false, reason: "no_cookie" };
    }

    // Harita pin kontrolü — lat/lng yoksa Migros adresi kabul etmiyor.
    // Kullanıcı çoğu zaman sadece il/ilçe yazıp pin basmadan kaydediyor.
    const latCheck = parseFloat(address?.lat || address?.latitude) || 0;
    const lngCheck = parseFloat(address?.lng || address?.longitude) || 0;
    if (!latCheck || !lngCheck) {
      console.warn("[Migros] Adreste harita koordinatı yok — ekleme iptal");
      ksTrack("address.add.failed", {
        platform: "migros",
        success: false,
        error_code: "missing_coords",
        error_message: "latitude/longitude missing",
      });
      return { success: false, reason: "missing_coords" };
    }

    console.log("[Migros] Using remember-me cookie (from API array)");
    console.log("[Migros] API cookie value:", rememberMeCookie.value);
    console.log("[Migros] API cookie domain:", rememberMeCookie.domain);

    // ESKİ EKLENTİ GİBİ: Cookie'yi chrome.cookies'ten al (düzeltilmiş olanı)
    const chromeCookie = await chrome.cookies.get({
      url: "https://www.migros.com.tr",
      name: "remember-me",
    });
    if (chromeCookie) {
      console.log("[Migros] Chrome cookie value:", chromeCookie.value);
      console.log("[Migros] Chrome cookie domain:", chromeCookie.domain);
      console.log("[Migros] Chrome cookie httpOnly:", chromeCookie.httpOnly);
      // Chrome'daki düzeltilmiş cookie'yi kullan
      rememberMeCookie.value = chromeCookie.value;
      console.log("[Migros] Chrome cookie kullanılıyor");
    }

    // Token prefix'ine göre servis belirle
    let service = "delivery-bff"; // mg- için default
    if (token.startsWith("mgy-")) {
      service = "delivery-bff/yemek";
    } else if (token.startsWith("mgh-")) {
      service = "delivery-bff/hemen";
    } else if (token.startsWith("mga-")) {
      service = "delivery-bff"; // sanal market
    }

    console.log("[Migros] Servis belirlendi:", service);

    // Her oturumda YENİ rastgele cihaz üret (token-binding yok).
    // Önceki oturumun device_info'su clearSiteData ile silindiği için Migros
    // her giriş için yeni cihaz olarak görür → fingerprint anomali tetiklemez.
    const migrosDevice = generateMigrosDeviceIdentifiers();
    await chrome.storage.local.set({ migros_device_info: migrosDevice });
    console.log("[Migros] Yeni device oluşturuldu (her giriş için yeni):", {
      manufacturer: migrosDevice.manufacturer,
      model: migrosDevice.model,
      apiLevel: migrosDevice.apiLevel,
      deviceId: migrosDevice.deviceId.substring(0, 8) + "...",
    });

    const deviceId = migrosDevice.deviceId;
    const deviceModel = migrosDevice.model;
    // X-Device-Sign formatı: YYYYMMDDHHmm (dakikaya kadar — canlı imza)
    const _signNow = new Date();
    const _signPad = (n) => String(n).padStart(2, "0");
    const deviceSign =
      "" +
      _signNow.getFullYear() +
      _signPad(_signNow.getMonth() + 1) +
      _signPad(_signNow.getDate()) +
      _signPad(_signNow.getHours()) +
      _signPad(_signNow.getMinutes());

    // declarativeNetRequest aktif — yeni device ile (her oturum yeni)
    await setupMigrosHeaderRules(rememberMeCookie.value, deviceId, deviceModel);
    await new Promise((resolve) => setTimeout(resolve, 700));
    console.log(
      "[Migros] DeclarativeNetRequest kuralları aktif (deviceId:",
      deviceId.substring(0, 8) + "...)",
    );

    console.log("[Migros] Device ID kullanılıyor:", deviceId);

    const migrosHeaders = {
      "X-Device-Platform": "ANDROID",
      "X-Device-Platform-Version": migrosDevice.apiLevel,
      "X-Device-Type": "MOBILE",
      "X-Device-App-Version": migrosDevice.appVersion,
      "X-Device-Identifier": deviceId,
      "X-Device-Model": deviceModel,
      "X-Device-Sign": deviceSign,
      "X-Device-App-Screen": "ADD_ADDRESS",
      "Accept-Language": "tr-TR",
      "Accept-Encoding": "gzip, deflate, br",
      "User-Agent": "okhttp/5.3.2",
      "Content-Type": "application/json; charset=UTF-8",
      Cookie: `remember-me=${rememberMeCookie.value}`,
    };

    // Cookie debug - Base64 decode test
    const rawCookie = rememberMeCookie.value;
    console.log("[Migros] Cookie raw:", rawCookie);
    try {
      const base64Decoded = atob(rawCookie);
      console.log("[Migros] Cookie Base64 decoded:", base64Decoded);
      // Base64 decode sonrası URL decode
      try {
        const urlDecoded = decodeURIComponent(base64Decoded);
        console.log("[Migros] Cookie Base64+URL decoded:", urlDecoded);
      } catch (e) {
        console.log("[Migros] URL decode failed (normal olabilir):", e.message);
      }
    } catch (e) {
      console.log("[Migros] Base64 decode failed:", e.message);
    }
    console.log("[Migros] Mobil header'lar oluşturuldu");

    // Şehir/ilçe/mahalle isimlerinden ID'leri al
    console.log("[Migros] Location ID'leri alınıyor:", {
      province: address.province,
      district: address.district,
      neighborhood: address.neighborhood,
    });

    let cityId = 34; // İstanbul default
    let townId = 0;
    let districtId = 0;

    try {
      const locationData = await fetchMigrosLocationData(address);

      if (locationData && locationData.districtId) {
        cityId = locationData.cityId;
        townId = locationData.townId;
        districtId = locationData.districtId;

        console.log("[Migros] ID'ler alındı:", {
          cityId,
          townId,
          districtId,
          cityName: locationData.cityName,
          townName: locationData.townName,
          districtName: locationData.districtName,
        });
      } else {
        console.warn("[Migros] Location data eksik, default ID kullanılacak");
      }
    } catch (locationError) {
      console.warn("[Migros] Location API hatası:", locationError.message);
      ksTrack("address.location.failed", {
        platform: "migros",
        success: false,
        error_message: (locationError?.message || "").slice(0, 500),
      });
    }

    // RequestId oluştur
    const requestId =
      Date.now().toString() + Math.floor(Math.random() * 1000000000).toString();

    // Telefonu firstName/lastName'e ekle
    let firstName = "Kullanıcı";
    let lastName = "Adı";
    let courierNote = "";
    let realName = "";

    try {
      // Aktif adresten isim ve not bilgilerini al (parametre olarak gelen address)
      console.log(
        "[Migros] Kullanılan adres:",
        address.label || "Bilinmiyor",
        address.id,
      );

      // Gerçek ismi al
      realName =
        address.firstname ||
        address.firstName ||
        address.name ||
        address.fullname ||
        "Kullanıcı";
      if (address.lastname || address.lastName) {
        realName += " " + (address.lastname || address.lastName);
      }

      // İsmi ayır
      firstName =
        address.firstname ||
        address.firstName ||
        address.name?.split(" ")[0] ||
        address.fullname?.split(" ")[0] ||
        realName.split(" ")[0] ||
        "Kullanıcı";
      lastName =
        address.lastname ||
        address.lastName ||
        address.name?.split(" ").slice(1).join(" ") ||
        address.fullname?.split(" ").slice(1).join(" ") ||
        realName.split(" ").slice(1).join(" ") ||
        "Adı";
      console.log("[Migros] Gerçek isim kullanılıyor:", {
        firstName,
        lastName,
      });

      courierNote = address.description || "";

      // Kuryeye not bulunamadıysa global storage'dan dene
      if (!courierNote) {
        const noteStorage = await chrome.storage.local.get([
          "courierNote",
          "deliveryNote",
          "note",
        ]);
        courierNote =
          noteStorage.courierNote ||
          noteStorage.deliveryNote ||
          noteStorage.note ||
          "";
      }
      if (courierNote) {
        console.log("[Migros] Kuryeye not alındı:", courierNote);
      }
    } catch (error) {
      console.warn("[Migros] Adres bilgisi okuma hatası:", error);
    }

    // Direction — telefon ve gerçek isim ekle
    const streetName = address.street || address.streetName || "";
    let direction =
      address.direction ||
      address.directions ||
      streetName ||
      address.fullAddress ||
      address.address ||
      "Adres tarifi";

    // Telefon varsa direction'a ekle
    if (address.phone) {
      direction =
        (courierNote || "") +
        (courierNote ? " - " : "") +
        `BU NUMARADAN ARAYIN: ${address.phone}` +
        (realName ? ` - ${realName}` : "");
      console.log("[Migros] Telefon direction'a eklendi");
    } else if (courierNote) {
      direction = courierNote + "\n\n" + direction;
    }

    // ESKİ EKLENTİ GİBİ: detail formatı
    const districtName =
      address.districtName || address.neighborhood || address.mahalle || "";
    const townName = address.townName || address.district || "";
    const cityName = address.cityName || address.city || address.province || "";
    const detail = `${districtName}, ${streetName} ${address.building || address.buildingNo || address.buildingNumber || "yok"}, ${townName}/${cityName}`;

    // ESKİ EKLENTİ GİBİ: addressData formatı - AYNEN aynı sıralama
    const addressData = {
      name: address.name || address.title || "Ev",
      districtId: districtId,
      firstName: firstName,
      lastName: lastName,
      townId: townId,
      cityId: cityId,
      streetName: streetName,
      floorNumber: address.floor || address.floorNumber || "yok",
      doorNumber:
        address.apartment || address.apartmentNo || address.doorNumber || "yok",
      buildingNumber:
        address.building ||
        address.buildingNo ||
        address.buildingNumber ||
        "yok",
      direction: direction,
      latitude: parseFloat(address.lat || address.latitude) || 0,
      longitude: parseFloat(address.lng || address.longitude) || 0,
      detail: detail,
      townName: townName,
      districtName: districtName,
    };

    console.log("[Migros] Adres ekleniyor:", addressData.name);

    // ÖNCE ESKİ ADRESLERİ SİL
    try {
      try {
        // 1. Mevcut adresleri al - www.migros.com.tr/rest/ kullan (cookie otomatik gönderilir)
        let getEndpoint = `/rest/delivery-bff/delivery-addresses`;

        console.log(`[Migros] ${service} mevcut adresler alınıyor...`);
        console.log(
          `[Migros] GET URL:`,
          `https://www.migros.com.tr${getEndpoint}`,
        );

        const getResponse = await fetch(
          `https://www.migros.com.tr${getEndpoint}`,
          {
            method: "GET",
            credentials: "include",
          },
        );

        console.log(`[Migros] GET response status:`, getResponse.status);
        const getResponseText = await getResponse.text();
        console.log(`[Migros] GET response text:`, getResponseText);

        if (getResponse.ok) {
          const getData = getResponseText ? JSON.parse(getResponseText) : {};
          console.log(`[Migros] GET parsed data:`, getData);
          // Response direkt array veya data içinde array olabilir
          const existingAddresses = Array.isArray(getData)
            ? getData
            : getData?.data || [];

          console.log(
            `[Migros] ${service} mevcut adres sayısı:`,
            existingAddresses.length,
          );

          // 2. Mevcut adresleri sil
          if (existingAddresses.length > 0) {
            for (const addr of existingAddresses) {
              const addrId = addr.addressInfo?.id || addr.id;
              if (addrId) {
                try {
                  // Eski eklenti formatı: /v2/addresses/
                  let deleteEndpoint = `/v2/addresses/${addrId}`;
                  if (service === "delivery-bff/hemen") {
                    deleteEndpoint = `/hemen/v2/addresses/${addrId}`;
                  } else if (service === "delivery-bff/yemek") {
                    deleteEndpoint = `/yemek/v2/addresses/${addrId}`;
                  }

                  // Delete de www.migros.com.tr/rest/ üzerinden
                  await fetch(
                    `https://www.migros.com.tr/rest/delivery-bff${deleteEndpoint}`,
                    {
                      method: "DELETE",
                      credentials: "include",
                    },
                  );

                  console.log(`[Migros] ${service} adres silindi:`, addrId);
                  // Rate-limit: Migros silmeler arası 1.5sn bekle (eskiden 1sn → tetikleniyordu)
                  await new Promise((resolve) => setTimeout(resolve, 1500));
                } catch (deleteError) {
                  console.warn(
                    `[Migros] ${service} adres silme hatası:`,
                    deleteError.message,
                  );
                  ksTrack("address.delete.failed", {
                    platform: "migros",
                    service,
                    success: false,
                    error_message: (deleteError?.message || "").slice(0, 500),
                  });
                }
              }
            }
          }
        }
      } catch (getError) {
        console.warn(
          `[Migros] ${service} adres listesi alınamadı:`,
          getError.message,
        );
        ksTrack("address.list.failed", {
          platform: "migros",
          service,
          success: false,
          error_message: (getError?.message || "").slice(0, 500),
        });
      }
    } catch (error) {
      console.error("[Migros] Adres silme hatası:", error);
      ksTrack("address.delete.failed", {
        platform: "migros",
        success: false,
        error_message: (error?.message || "").slice(0, 500),
      });
    }

    console.log("[Migros] Eski adresler temizlendi, yeni adres ekleniyor...");
    // Rate-limit: silme/ekleme arası 1.2sn bekle — Migros backend'i çok hızlı
    // ardışık DELETE+POST kombinasyonunu "bot davranışı" olarak işaretliyor
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // SONRA YENİ ADRES EKLE - Sadece 1 servis
    try {
      // www.migros.com.tr/rest/delivery-bff/ kullan (cookie otomatik gönderilir)
      let endpoint = `/rest/delivery-bff/delivery-addresses?reid=${requestId}`;

      console.log(`[Migros] ${service} endpoint:`, endpoint);
      console.log(
        `[Migros] ${service} data:`,
        JSON.stringify(addressData, null, 2),
      );

      // www.migros.com.tr üzerinden - cookie otomatik
      const response = await fetch(`https://www.migros.com.tr${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        credentials: "include",
        body: JSON.stringify(addressData),
      });

      console.log(`[Migros] ${service} response:`, response.status);
      const responseHeaders = Object.fromEntries(response.headers.entries());
      console.log(`[Migros] ${service} response headers:`, responseHeaders);

      // Hata header'ı var mı kontrol et
      if (responseHeaders["x-error"] || responseHeaders["x-message"]) {
        console.warn(
          `[Migros] ${service} header hatası:`,
          responseHeaders["x-error"] || responseHeaders["x-message"],
        );
      }

      const responseText = await response.text();
      console.log(`[Migros] ${service} response text:`, responseText);

      if (response.ok) {
        const result = responseText ? JSON.parse(responseText) : {};
        console.log(
          `[Migros] ${service} full response:`,
          JSON.stringify(result, null, 2),
        );

        // Response yapısını kontrol et
        const addressId =
          result.data?.addressInfo?.id ||
          result.addressInfo?.id ||
          result.data?.id ||
          result.id;
        const addressName =
          result.data?.addressInfo?.name ||
          result.addressInfo?.name ||
          result.data?.name ||
          result.name ||
          "OK";
        const districtId =
          result.data?.addressInfo?.district?.id ||
          result.addressInfo?.district?.id ||
          result.data?.district?.id;

        console.log(
          `[Migros] ${service} adres eklendi:`,
          addressName,
          "ID:",
          addressId,
        );
        console.log(`[Migros] ${service} response keys:`, Object.keys(result));
        ksTrack("address.add.success", {
          platform: "migros",
          service,
          success: true,
        });

        // Adresi varsayılan olarak seç
        if (addressId) {
          try {
            const selectReid =
              Date.now() + Math.floor(Math.random() * 1000000).toString();
            let selectEndpoint = "";
            let selectBody = {};

            if (service === "delivery-bff/hemen") {
              selectEndpoint = `/hemen/preferences/select-by-point?reid=${selectReid}`;
              selectBody = { addressId: addressId };
            } else if (service === "delivery-bff/yemek") {
              selectEndpoint = `/yemek/preferences/select-by-point?reid=${selectReid}`;
              selectBody = { addressId: addressId };
            } else {
              selectEndpoint = `/preferences/select?reid=${selectReid}`;
              selectBody = {
                addressId: addressId,
                serviceAreaObjectId: districtId,
                serviceAreaObjectType: "DISTRICT",
              };
            }

            console.log(`[Migros] ${service} adresi varsayılan yapılıyor...`);

            const selectResponse = await fetch(
              `https://rest.migros.com.tr${selectEndpoint}`,
              {
                method: "POST",
                headers: migrosHeaders,
                body: JSON.stringify(selectBody),
              },
            );

            console.log(
              `[Migros] ${service} select response:`,
              selectResponse.status,
            );

            if (selectResponse.ok) {
              console.log(`[Migros] ${service} adres varsayılan yapıldı`);
            }
          } catch (selectError) {
            console.warn(
              `[Migros] ${service} select hatası:`,
              selectError.message,
            );
            ksTrack("address.select.failed", {
              platform: "migros",
              service,
              success: false,
              error_message: (selectError?.message || "").slice(0, 500),
            });
          }
        }

        console.log("[Migros] Adres ekleme tamamlandı");
        return { success: true, reason: "ok", addressId: addressId || null };
      } else {
        const errorText = await responseText;
        console.error(
          `[Migros] ${service} hatası:`,
          response.status,
          errorText,
        );
        ksTrack("address.add.failed", {
          platform: "migros",
          service,
          success: false,
          error_code: String(response.status),
          error_message: (typeof errorText === "string" ? errorText : "").slice(
            0,
            500,
          ),
        });
        // districtId/townId 0 veya konum hataları genelde harita seçimi eksikliğinden
        const likelyMap =
          !districtId ||
          !townId ||
          /location|konum|district|geo|coordinate|invalid/i.test(
            String(errorText || ""),
          );
        return {
          success: false,
          reason: likelyMap ? "map_or_location" : "api_error",
          status: response.status,
        };
      }
    } catch (serviceError) {
      console.warn(`[Migros] ${service} hatası:`, serviceError.message);
      ksTrack("address.add.failed", {
        platform: "migros",
        service,
        success: false,
        error_message: (serviceError?.message || "").slice(0, 500),
      });
      return {
        success: false,
        reason: "api_error",
        error: serviceError.message,
      };
    }
  } catch (error) {
    console.error("[Migros] Address sync error:", error);
    ksTrack("address.sync.failed", {
      platform: "migros",
      success: false,
      error_message: (error?.message || "").slice(0, 500),
    });
    return { success: false, reason: "sync_error", error: error.message };
  }
}

/**
 * Trendyol API header'ları (browser fingerprint ile)
 */
function getTrendyolHeaders(authHeader, includeContentType = false) {
  const headers = {
    Authorization: authHeader,
    Accept: "application/json, text/plain, */*",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua":
      '"Not)A;Brand";v="8", "Chromium";v="138", "Microsoft Edge";v="138"',
    "sec-ch-ua-mobile": "?0",
    origin: "https://tgoyemek.com",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "tr,en;q=0.9,en-GB;q=0.8,en-US;q=0.7",
    priority: "u=1, i",
  };
  if (includeContentType) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

/**
 * Trendyol için adres alanlarına rastgele boşluk ekle (anti-fingerprint)
 */
function addRandomSpacesForTrendyol(text, useRandomSpaces) {
  if (!text || !useRandomSpaces) return text;

  const normalSpace = " ";
  let spacesAdded = 0;
  const maxSpaces = 2;

  let words = text.split(" ");

  if (words.length === 1) {
    const position = Math.floor(Math.random() * 3);
    if ((position === 0 || position === 2) && spacesAdded < maxSpaces) {
      words[0] = normalSpace + words[0];
      spacesAdded++;
    }
    if ((position === 1 || position === 2) && spacesAdded < maxSpaces) {
      words[0] = words[0] + normalSpace;
      spacesAdded++;
    }
    return words[0];
  }

  let result = "";
  for (let i = 0; i < words.length; i++) {
    result += words[i];
    if (i < words.length - 1) {
      result += normalSpace;
    }
  }

  if (Math.random() < 0.3 && spacesAdded < maxSpaces) {
    result = normalSpace + result;
    spacesAdded++;
  }
  if (Math.random() < 0.3 && spacesAdded < maxSpaces) {
    result = result + normalSpace;
    spacesAdded++;
  }

  return result;
}

/**
 * Sync address to Trendyol
 */
// ─── : CSRF+Login → gerçek tgo-token al ────────────────────────
async function _tgoWebLogin(email, password) {
  try {
    const csrfRes = await fetch("https://tgoyemek.com/api/auth/csrf", {
      method: "GET",
      credentials: "include",
      headers: {
        "sec-ch-ua":
          '"Not)A;Brand";v="8", "Chromium";v="138", "Microsoft Edge";v="138"',
        "sec-ch-ua-mobile": "?0",
        accept: "*/*",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "tr",
        priority: "u=1, i",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
      },
    });
    if (!csrfRes.ok) {
      console.warn("[TGO-Login] CSRF HTTP", csrfRes.status);
      return null;
    }
    const { csrfToken } = await csrfRes.json();
    if (!csrfToken) {
      console.warn("[TGO-Login] csrfToken yok");
      return null;
    }

    await chrome.cookies
      .set({
        url: "https://tgoyemek.com",
        name: "tgo-csrf-token",
        value: csrfToken,
        domain: "tgoyemek.com",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      })
      .catch(() => {});

    // webRequest listener — Set-Cookie header'ından tgo-token'ı yakala (iOS/Android için gerekli)
    let _captured = null;
    const _listener = (d) => {
      const sc =
        d.responseHeaders?.filter(
          (h) => h.name.toLowerCase() === "set-cookie",
        ) || [];
      for (const h of sc) {
        const m = h.value.match(/tgo-token=([^;]+)/);
        if (m) {
          _captured = m[1];
          break;
        }
      }
    };
    if (chrome.webRequest?.onResponseStarted) {
      try {
        chrome.webRequest.onResponseStarted.addListener(
          _listener,
          { urls: ["https://tgoyemek.com/api/auth/login"] },
          ["responseHeaders"],
        );
      } catch (_) {}
    }

    const loginRes = await fetch("https://tgoyemek.com/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "sec-ch-ua-platform": '"Windows"',
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
        "sec-ch-ua":
          '"Not)A;Brand";v="8", "Chromium";v="138", "Microsoft Edge";v="138"',
        "sec-ch-ua-mobile": "?0",
        accept: "*/*",
        origin: "https://tgoyemek.com",
        referer: "https://tgoyemek.com/giris?callbackUrl=%2F",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "accept-language": "tr,en;q=0.9,en-GB;q=0.8,en-US;q=0.7",
        priority: "u=1, i",
        Cookie: `tgo-csrf-token=${csrfToken}`,
      },
      body: JSON.stringify({ username: email, password, csrfToken }),
    });

    if (chrome.webRequest?.onResponseStarted) {
      try {
        chrome.webRequest.onResponseStarted.removeListener(_listener);
      } catch (_) {}
    }

    let tgoToken = _captured;
    if (!tgoToken) {
      const sc = loginRes.headers.get("set-cookie") || "";
      const m = sc.match(/tgo-token=([^;]+)/);
      if (m) tgoToken = m[1];
    }
    if (!tgoToken) {
      // Cookie otomatik set edilmiş olabilir — 5×1000ms retry yap
      const maxRetries = 5;
      for (let i = 0; i < maxRetries; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const ck = await new Promise((r) =>
          chrome.cookies.get(
            { url: "https://tgoyemek.com", name: "tgo-token" },
            r,
          ),
        );
        if (ck?.value) {
          tgoToken = ck.value;
          break;
        }
      }
    }
    if (!tgoToken) {
      // Son deneme: tüm tgoyemek.com cookie'lerini tara
      const allCk = await new Promise((r) =>
        chrome.cookies.getAll({ domain: "tgoyemek.com" }, r),
      );
      const found = allCk?.find((c) => c.name === "tgo-token");
      if (found?.value) tgoToken = found.value;
    }

    if (tgoToken) {
      const tgoExp = Math.floor(Date.now() / 1000) + 604800;
      await chrome.storage.local.set({ tgoWebToken: tgoToken, trendyolWebToken: tgoToken }).catch(() => {});
      await chrome.cookies.remove({ url: "https://tgoyemek.com/", name: "tgo-token" }).catch(() => {});
      await chrome.cookies.remove({ url: "https://tgoyemek.com/", name: "access_token" }).catch(() => {});
      await chrome.cookies
        .set({
          url: "https://tgoyemek.com/odeme",
          name: "tgo-token",
          value: tgoToken,
          domain: "tgoyemek.com",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          path: "/odeme",
        })
        .catch(() => {});
      await chrome.cookies
        .set({
          url: "https://tgoyemek.com/odeme",
          name: "access_token",
          value: tgoToken,
          domain: "tgoyemek.com",
          secure: true,
          httpOnly: false,
          sameSite: "lax",
          path: "/odeme",
        })
        .catch(() => {});
      console.log(
        "[TGO-Login] ✅ v30 tgo-token+access_token ROOT set:",
        tgoToken.substring(0, 40) + "...",
      );
      await chrome.storage.local
        .set({ trendyolWebToken: tgoToken })
        .catch(() => {});
      await setupTrendyolPaymentHeaderRules({
        preferWebPaymentProfile: true,
      }).catch(() => {});
      return tgoToken;
    }
    console.warn("[TGO-Login] tgo-token alınamadı (HTTP", loginRes.status, ")");
    return null;
  } catch (e) {
    console.warn("[TGO-Login] Exception:", e?.message);
    return null;
  }
}

/**
 * / /odeme iframe `access_token` + `tgo-token` (appName=lc) ister.
 * VPS web_token çoğu hesapta NULL — CSRF+login ile üret, yoksa lc mobil JWT.
 */
async function _ensureTgoWebJwt() {
  if (_ensureTgoWebJwt._inflight) return _ensureTgoWebJwt._inflight;
  _ensureTgoWebJwt._inflight = (async () => {
    try {
      const stor = await chrome.storage.local
        .get([
          "trendyolWebToken",
          "tyMobileToken",
          "tyToken",
          "trendyolPoolEmail",
          "trendyolPoolPassword",
        ])
        .catch(() => ({}));
      const pickWeb = (t) =>
        _tyIsUsablePaymentBearerJwt(t) && !_tyJwtIsTrendyolGoPool(t);

      if (pickWeb(stor.trendyolWebToken)) return stor.trendyolWebToken;

      const accessCk =
        (await _tyGetTgoyemekCookieFirst("access_token")) ||
        (await _tyGetTgoyemekCookieFirst("accessToken"));
      const tgoCk = await _tyGetTgoyemekCookieFirst("tgo-token");
      const cookieTok = [accessCk?.value, tgoCk?.value].find(pickWeb) || "";
      if (cookieTok && cookieTok !== stor.tyMobileToken) {
        await chrome.storage.local
          .set({ trendyolWebToken: cookieTok })
          .catch(() => {});
        return cookieTok;
      }

      const email = stor.trendyolPoolEmail || "";
      const password = stor.trendyolPoolPassword || "";
      if (email && password) {
        if (!_tgoWebLogin._p) {
          _tgoWebLogin._p = _tgoWebLogin(email, password).finally(() => {
            setTimeout(() => {
              _tgoWebLogin._p = null;
            }, 8000);
          });
        }
        const logged = await _tgoWebLogin._p;
        if (pickWeb(logged)) {
          console.log(
            "[Trendyol] v40: CSRF login web JWT alındı len=" + logged.length,
          );
          return logged;
        }
      }

      if (pickWeb(cookieTok)) {
        await chrome.storage.local
          .set({ trendyolWebToken: cookieTok })
          .catch(() => {});
        return cookieTok;
      }
      const fallbacks = [stor.tyMobileToken, stor.tyToken].filter(Boolean);
      for (const t of fallbacks) {
        if (pickWeb(t) && _tyJwtIsLcWebPayment(t)) {
          await chrome.storage.local
            .set({ trendyolWebToken: t })
            .catch(() => {});
          console.log(
            "[Trendyol] v40: ödeme JWT lc mobil fallback len=" + t.length,
          );
          return t;
        }
      }
      console.warn("[Trendyol] v40: kullanılabilir ödeme JWT yok");
      return null;
    } catch (e) {
      console.warn("[Trendyol] v40 _ensureTgoWebJwt:", e?.message || e);
      return null;
    }
  })();
  try {
    return await _ensureTgoWebJwt._inflight;
  } finally {
    _ensureTgoWebJwt._inflight = null;
  }
}

/** payment.tgoapps.com: auth.trendyol.com lc JWT (604). CSRF 528 NextAuth 401 verir. */
function _tyJwtIsAuthTrendyolLc(token) {
  try {
    if (!token || typeof token !== "string" || !token.startsWith("ey"))
      return false;
    const p = decodeJwtPayload(token);
    if (!p) return false;
    const iss = String(p.iss || "").toLowerCase();
    const an = String(p.appName || p.applicationName || "")
      .trim()
      .toLowerCase();
    if (an === "trendyolgo") return false;
    if (iss.indexOf("auth.trendyol.com") === -1) return false;
    return an === "lc" || an === "";
  } catch (_) {
    return false;
  }
}

async function _ensureTgoPaymentJwt() {
  const stor = await chrome.storage.local
    .get(["tyMobileToken", "tyToken", "trendyolWebToken"])
    .catch(() => ({}));
  const cands = [stor.tyMobileToken, stor.tyToken, stor.trendyolWebToken];
  for (const t of cands) {
    if (_tyIsUsablePaymentBearerJwt(t) && _tyJwtIsAuthTrendyolLc(t)) return t;
  }
  const web = await _ensureTgoWebJwt();
  if (_tyIsUsablePaymentBearerJwt(web) && _tyJwtIsAuthTrendyolLc(web)) return web;
  return web || "";
}

async function _tyProbePaymentAuthHeader(jwt) {
  if (!jwt) return "";
  if (
    _tyProbePaymentAuthHeader._jwt === jwt &&
    _tyProbePaymentAuthHeader._auth
  ) {
    return _tyProbePaymentAuthHeader._auth;
  }
  const tries = [
    { m: "GET", a: "bearer " + jwt },
    { m: "GET", a: "Bearer " + jwt },
    { m: "POST", a: "bearer " + jwt },
    { m: "POST", a: "Bearer " + jwt },
  ];
  let fallback = "bearer " + jwt;
  for (const t of tries) {
    try {
      const headers = {
        Authorization: t.a,
        Accept: "application/json",
        "x-applicationid": "1",
        "x-storefrontid": "1",
      };
      const opts = { method: t.m, headers };
      if (t.m === "POST") {
        headers["Content-Type"] = "application/json";
        opts.body = "{}";
      }
      const res = await fetch(
        "https://payment.tgoapps.com/v3/payment/options",
        opts,
      );
      console.log(
        "[TY Payment] probe",
        t.m,
        t.a.slice(0, 6),
        "len=" + jwt.length,
        "HTTP",
        res.status,
      );
      if (res.status !== 401 && res.status !== 403) {
        _tyProbePaymentAuthHeader._jwt = jwt;
        _tyProbePaymentAuthHeader._auth = t.a;
        return t.a;
      }
    } catch (e) {
      console.warn("[TY Payment] probe", t.m, e?.message || e);
    }
  }
  _tyProbePaymentAuthHeader._jwt = jwt;
  _tyProbePaymentAuthHeader._auth = fallback;
  return fallback;
}

// ─── : Web API auth header ─────────────────────────────────────
// model: tgo-token artık root cookie'de yok → storage'dan al
async function _getTgoAuthHeader() {
  // 1. Storage'dan (en güvenilir — proxy model)
  const stor = await chrome.storage.local
    .get(["trendyolWebToken", "tyToken", "tyMobileToken"])
    .catch(() => ({}));
  if (stor.trendyolWebToken) return `bearer ${stor.trendyolWebToken}`;
  if (stor.tyMobileToken) return `bearer ${stor.tyMobileToken}`;
  if (stor.tyToken) return `bearer ${stor.tyToken}`;
  // 2. Fallback: checkout path cookie'den (ödeme sırasında set edilmiş olabilir)
  const ck = await new Promise((r) =>
    chrome.cookies.get(
      { url: "https://tgoyemek.com/odeme", name: "tgo-token" },
      r,
    ),
  );
  if (ck?.value) return `bearer ${ck.value}`;
  // 3. Son fallback: root cookie (önceki sürümlerden kalmış)
  const ckRoot = await new Promise((r) =>
    chrome.cookies.get({ url: "https://tgoyemek.com", name: "tgo-token" }, r),
  );
  if (ckRoot?.value) return `bearer ${ckRoot.value}`;
  return null;
}

async function syncTrendyolAddress(address, cookies) {
  try {
      console.log(
        "[Trendyol] Gelen adres verisi:",
        address.province || "",
        address.district || "",
        address.neighborhood || "",
      );

    const PROXY_URL = "https://kuponstore.com/api/token/proxy.php";
    const ZEUS_BASE =
      "https://api.tgoapis.com/localcommerce-member-zeususer-service/addresses";
    const ZEUS_PARAMS = "?appName=TrendyolGo&channelId=4";
    const ZEUS_GET_PARAMS = "?getCities=false&appName=TrendyolGo&channelId=4";
    const WEB_ADDR_URL =
      "https://api.tgoapis.com/web-user-apimemberaddress-santral/addresses";

    // ── 1. Token'ları al ─────────────────────────────────────────────────
    const storData = await chrome.storage.local
      .get(["tyMobileToken", "trendyolPoolEmail", "trendyolPoolPassword"])
      .catch(() => ({}));
    let mobileToken = storData.tyMobileToken || null;
    if (!mobileToken) {
      const ckAccess = cookies.find((c) => c.name === "access_token")?.value;
      const ckTgo = cookies.find((c) => c.name === "tgo-token")?.value;
      mobileToken = ckAccess || ckTgo || null;
    }
    if (!mobileToken) throw new Error("Trendyol mobile token bulunamadı");
    console.log(
      "[Trendyol] ✅ Mobile token mevcut, length:",
      mobileToken.length,
    );

    // Web token: önce cookie'den al (_tgoWebLogin set etmiş olmalı), yoksa storage'dan
    const _ckTgoToken = await new Promise((r) =>
      chrome.cookies.get({ url: "https://tgoyemek.com", name: "tgo-token" }, r),
    );
    const _storedWebTok = await chrome.storage.local
      .get(["trendyolWebToken"])
      .catch(() => ({}));
    let webToken = _ckTgoToken?.value || _storedWebTok.trendyolWebToken || null;
    if (webToken) {
      console.log(
        "[Trendyol] ✅ Web token mevcut (adres web endpoint kullanılacak), length:",
        webToken.length,
      );
    } else {
      console.warn(
        "[Trendyol] ⚠️ Web token yok — zeususer fallback kullanılacak",
      );
    }

    // ── 2. Helper: proxy.php aracılığıyla istek ──────────────────────────
    // mobile_token → Dalvik/Android UA (SMS'siz mobil API)
    // web_token → Windows Edge UA (web-user-apimemberaddress-santral, SMS YOK)
    const _proxyReq = async ({ tokenType = "mobile", method, url, body }) => {
      const payload = { method, url };
      if (tokenType === "web" && webToken) {
        payload.web_token = webToken;
      } else {
        payload.mobile_token = mobileToken;
      }
      if (body !== undefined && body !== null) payload.body = body;
      const r = await fetch(PROXY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const raw = await r.text();
      let pj = null;
      try {
        pj = JSON.parse(raw);
      } catch (_) {}
      const http = pj?.http || r.status;
      let bd = null;
      try {
        bd = typeof pj?.body === "string" ? JSON.parse(pj.body) : pj?.body;
      } catch (_) {}
      return { http, body: bd, raw };
    };

    // ── 3. Konum + isim bilgilerini hazırla ──────────────────────────────
    const resolvedCoords = await resolveTrendyolAddressCoordinates(address);
    const lat = resolvedCoords.lat;
    const lng = resolvedCoords.lng;
    if (!lat || !lng) {
      throw new Error(
        "Adres koordinatları eksik. Lütfen adresi haritadan seçin.",
      );
    }
    if (resolvedCoords.source && resolvedCoords.source !== "stored") {
      console.log(
        "[Trendyol] Koordinat kurtarıldı:",
        resolvedCoords.source,
        lat,
        lng,
      );
      // Kurtarılan koordinatı adrese geri yaz (sonraki sync'lerde eksik kalmasın)
      try {
        const stor = await chrome.storage.local
          .get(["kuponstore_addresses"])
          .catch(() => ({}));
        const list = Array.isArray(stor.kuponstore_addresses)
          ? stor.kuponstore_addresses
          : [];
        const idx = list.findIndex((a) => a && a.id && address.id && a.id === address.id);
        if (idx !== -1) {
          list[idx] = {
            ...list[idx],
            lat,
            lng,
            latitude: lat,
            longitude: lng,
          };
          await chrome.storage.local.set({ kuponstore_addresses: list });
        }
      } catch (_) {}
    }
    // Adres objesini de güncelle (bu sync çağrısı için)
    address.lat = lat;
    address.lng = lng;
    address.latitude = lat;
    address.longitude = lng;
    const randomizedLocation = randomizeLocation(lat, lng, 5);

    const nameParts = (address.fullname || "Kullanıcı Adı")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const ownerSurname =
      nameParts.length > 1 ? nameParts[nameParts.length - 1] : "Adı";
    const ownerName =
      nameParts.length > 1
        ? nameParts.slice(0, -1).join(" ")
        : nameParts[0] || "Kullanıcı";

    // Koordinatları hemen storage'a kaydet (kupon proxy fallback için)
    try {
      await chrome.storage.local.set({
        tyAddressPayload: {
          latitude: String(randomizedLocation.lat),
          longitude: String(randomizedLocation.lng),
        },
      });
    } catch (_) {}

    // ── 4. Location ID'leri al (önce reverse-geocode — isim eşleşmesi kırılgan) ──
    await logManager.addLog("info", "Trendyol lokasyon bilgileri alınıyor...");
    const locHeaders = {
      Authorization: `bearer ${mobileToken}`,
      Accept: "application/json, text/plain, */*",
      "accept-language": "tr,en;q=0.9",
    };
    let locationIds = null;
    try {
      const rgResp = await fetch(
        `https://api.tgoapis.com/web-location-santral/reverse-geocode?lat=${lat}&lng=${lng}`,
        { method: "GET", headers: locHeaders },
      );
      if (rgResp.ok) {
        const rgData = await rgResp.json();
        const rgCityId = rgData.cityId || rgData.city?.id;
        const rgDistrictId = rgData.districtId || rgData.district?.id;
        const rgNeighborhoodId =
          rgData.neighborhoodId || rgData.neighborhood?.id;
        if (rgCityId && rgDistrictId) {
          locationIds = {
            cityId: rgCityId,
            districtId: rgDistrictId,
            neighborhoodId: rgNeighborhoodId || null,
          };
          // Reverse geocode mahalle/ilçe adlarını adrese yansıt (sonraki sync)
          if (rgData.neighborhood?.name || rgData.neighborhoodName) {
            address.neighborhood =
              address.neighborhood ||
              rgData.neighborhood?.name ||
              rgData.neighborhoodName;
          }
          if (rgData.district?.name || rgData.districtName) {
            address.district =
              address.district ||
              rgData.district?.name ||
              rgData.districtName;
          }
          console.log("[Trendyol] Reverse geocode OK:", locationIds);
        }
      }
    } catch (e) {
      console.warn("[Trendyol] Reverse geocode:", e?.message || e);
    }
    if (!locationIds?.cityId || !locationIds?.districtId) {
      locationIds = await getTrendyolLocationIds(
        address,
        `bearer ${mobileToken}`,
        locHeaders,
      );
    }
    if (!locationIds?.cityId || !locationIds?.districtId) {
      throw new Error(
        `Trendyol lokasyon ID'leri alınamadı: ${address.province} / ${address.district}. Adres Yönetimi’nden il/ilçe seçimini kontrol edin.`,
      );
    }

    // Mahalle ID zorunluya yakın — yoksa Trendyol sıkça "Adres bilgisi eklenemedi" döner
    if (!locationIds.neighborhoodId && locationIds.districtId) {
      try {
        const neighborhoods = await fetchTrendyolNeighborhoods(
          locationIds.districtId,
          locHeaders,
        );
        let matched = null;
        if (address.neighborhood && neighborhoods.length) {
          matched = findMatchInList(neighborhoods, address.neighborhood);
        }
        if (!matched && neighborhoods.length) {
          matched = neighborhoods[0];
          console.warn(
            "[Trendyol] Mahalle fallback (ilk):",
            matched?.name,
            "id",
            matched?.id,
          );
        }
        if (matched?.id) {
          locationIds.neighborhoodId = matched.id;
          if (!address.neighborhood && matched.name) {
            address.neighborhood = matched.name;
          }
        }
      } catch (e) {
        console.warn("[Trendyol] Mahalle fallback:", e?.message || e);
      }
    }
    if (!locationIds.neighborhoodId) {
      throw new Error(
        `Trendyol mahalle ID alınamadı (${address.province || "?"} / ${address.district || "?"} / ${address.neighborhood || "?"}). Adres Yönetimi’nden mahalleyi listeden seçip kaydedin.`,
      );
    }

    // Merge/shipping için city+district sakla (sabit 105/15 YASAK — bölge hatası yapıyordu)
    try {
      const existing = await chrome.storage.local
        .get(["tyAddressPayload"])
        .catch(() => ({}));
      const p = existing.tyAddressPayload || {};
      await chrome.storage.local.set({
        tyAddressPayload: {
          ...p,
          latitude: String(randomizedLocation.lat),
          longitude: String(randomizedLocation.lng),
          cityId: locationIds.cityId,
          districtId: locationIds.districtId,
          neighborhoodId: locationIds.neighborhoodId,
          tyCityId: locationIds.cityId,
          tyDistrictId: locationIds.districtId,
        },
      });
    } catch (_) {}

    // ── 5. Adres payload'larını hazırla ──────────────────────────────────
    const _randStr = (n) => {
      const c = "abcdefghijklmnopqrstuvwxyz0123456789";
      let r = "";
      for (let i = 0; i < n; i++) r += c[Math.floor(Math.random() * c.length)];
      return r;
    };
    const ts = String(Date.now()).slice(-6);
    const addrLine =
      [address.neighborhood, address.street].filter(Boolean).join(", ") +
      (address.building ? ` No:${address.building}` : "");
    const addressDescription = (
      address.description ||
      address.delivery_instructions ||
      ""
    ).trim();
    const _parsePhone = (raw) => {
      let p = (raw || "").replace(/\D/g, "");
      if (p.startsWith("0")) p = p.substring(1);
      if (p.startsWith("90")) p = p.substring(2);
      return p.startsWith("5") && p.length === 10 ? p : null;
    };
    // +49: ulusal numara 15/16/17 ile başlar, 10–12 hane. +90 gövdesine dokunulmaz.
    const _nationalGermanPhone = (raw) => {
      let digits = String(raw || "").replace(/\D/g, "");
      if (digits.startsWith("0049")) digits = digits.substring(4);
      else if (digits.startsWith("49") && digits.length > 11) digits = digits.substring(2);
      if (digits.startsWith("0")) digits = digits.substring(1);
      if (digits.length >= 10 && digits.length <= 12 && /^(15|16|17)/.test(digits)) {
        return digits;
      }
      return null;
    };
    // +44 UK: ulusal mobil 7 ile başlar, 9–11 hane (genelde 10: 7xxxxxxxxx)
    const _nationalUkPhone = (raw) => {
      let digits = String(raw || "").replace(/\D/g, "");
      if (digits.startsWith("0044")) digits = digits.substring(4);
      else if (digits.startsWith("44") && digits.length >= 12) digits = digits.substring(2);
      if (digits.startsWith("0")) digits = digits.substring(1);
      if (digits.length >= 9 && digits.length <= 11 && /^7\d{8,10}$/.test(digits)) {
        return digits;
      }
      return null;
    };
    const _addressCc = (addr) => {
      let raw = String(
        addr?.countryPhoneCode ||
          addr?.phoneCountryCode ||
          addr?.country_phone_code ||
          addr?.phone_country_code ||
          "",
      )
        .trim()
        .toUpperCase();
      if (raw === "GB" || raw === "UK") return "44";
      if (raw === "DE") return "49";
      if (raw === "TR") return "90";
      return raw.replace(/\D/g, "");
    };
    const _isGermanAddress = (addr) => {
      if (!addr) return false;
      if (_addressCc(addr) === "49") return true;
      const raw = String(addr.phone || "");
      return _nationalGermanPhone(raw) !== null && _parsePhone(raw) === null;
    };
    const _isUkAddress = (addr) => {
      if (!addr) return false;
      if (_addressCc(addr) === "44") return true;
      const raw = String(addr.phone || "");
      return _nationalUkPhone(raw) !== null && _parsePhone(raw) === null && _nationalGermanPhone(raw) === null;
    };
    const _phoneFromExisting = (addr) => {
      if (!addr) return null;
      const raw = String(addr.phone || "");
      if (!raw || raw.includes("*")) return null;
      const ccHint = _addressCc(addr);
      if (ccHint === "44" || _isUkAddress(addr)) {
        const national = _nationalUkPhone(raw);
        return national ? { phone: national, cc: "+44" } : null;
      }
      if (ccHint === "49" || _isGermanAddress(addr)) {
        const national = _nationalGermanPhone(raw);
        return national ? { phone: national, cc: "+49" } : null;
      }
      const tr = _parsePhone(raw);
      return tr ? { phone: tr, cc: "+90" } : null;
    };
    let accountPhoneChoice = null;
    let foreignPhoneBlocked = false;
    let foreignPhoneBlockedCc = "";
    const _noteExistingPhone = (addr) => {
      const choice = _phoneFromExisting(addr);
      if (choice) {
        accountPhoneChoice = choice;
        return "ok";
      }
      if (_isUkAddress(addr)) {
        foreignPhoneBlocked = true;
        foreignPhoneBlockedCc = "+44";
        return "blocked";
      }
      if (_isGermanAddress(addr)) {
        foreignPhoneBlocked = true;
        foreignPhoneBlockedCc = "+49";
        return "blocked";
      }
      return "fallback";
    };

    // Web endpoint body (web-user-apimemberaddress-santral) — SMS gerektirmez
    const formPhoneForWeb = _phoneFromExisting({
      phone: address.phone,
      phoneCountryCode: address.phoneCountryCode || address.countryPhoneCode,
    });
    const webAddrBody = {
      name: ownerName,
      surname: ownerSurname,
      phone: (formPhoneForWeb && formPhoneForWeb.phone) || _parsePhone(address.phone) || "5551234567",
      apartmentNumber: address.building || "1",
      floor: address.floor || "1",
      doorNumber: address.apartment || "1",
      addressName: `Ev${ts}`,
      addressDescription:
        addressDescription || `${ownerName} ${ownerSurname} ev`,
      addressLine:
        addrLine || `${address.province || ""} No:${address.building || "1"}`,
      cityId: locationIds.cityId,
      districtId: locationIds.districtId,
      neighborhoodId: locationIds.neighborhoodId,
      latitude: String(randomizedLocation.lat),
      longitude: String(randomizedLocation.lng),
      countryCode: "TR",
      elevatorAvailable: false,
    };
    if (formPhoneForWeb && (formPhoneForWeb.cc === "+49" || formPhoneForWeb.cc === "+44")) {
      webAddrBody.countryPhoneCode = formPhoneForWeb.cc;
    } else {
      delete webAddrBody.countryPhoneCode;
    }

    // ── 6. A YOLU: Web endpoint (tgo-token ile, SMS YOK) ─────────────────
    // tam olarak bunu yapıyor: CSRF+Login → gerçek tgo-token → web endpoint
    let newAddressId = null;
    let existingAddresses = [];
    let usedWebEndpoint = false;
    let lastWebFail = null;

    // : web endpoint için direkt fetch — Authorization: bearer tgo-token
    // Service worker cookie'leri otomatik göndermez, Authorization header olarak gönder
    const _webFetch = async (method, url, body) => {
      const r = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${webToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-ch-ua":
            '"Not)A;Brand";v="8", "Chromium";v="138", "Microsoft Edge";v="138"',
          "sec-ch-ua-mobile": "?0",
          origin: "https://tgoyemek.com",
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
          "accept-encoding": "gzip, deflate, br, zstd",
          "accept-language": "tr,en;q=0.9,en-GB;q=0.8,en-US;q=0.7",
          priority: "u=1, i",
        },
        ...(body !== undefined && body !== null
          ? { body: JSON.stringify(body) }
          : {}),
      });
      let bd = null;
      try {
        const t = await r.text();
        bd = t ? JSON.parse(t) : null;
      } catch (_) {}
      return { http: r.status, body: bd };
    };

    if (webToken) {
      await logManager.addLog(
        "info",
        "Trendyol adres ekleniyor (web endpoint — )...",
      );
      try {
        // Önce mevcut adresleri GET ile al — telefon numarasını çek
        let existingWebAddresses = [];
        try {
          const { http: gHttp, body: gBody } = await _webFetch(
            "GET",
            WEB_ADDR_URL,
          );
          console.log("[Trendyol] Web GET addresses HTTP", gHttp);
          if (gHttp >= 200 && gHttp < 300 && gBody?.addresses) {
            existingWebAddresses = gBody.addresses;
            console.log(
              "[Trendyol] Web mevcut adresler:",
              existingWebAddresses.map((a) => ({ id: a.id, phone: a.phone })),
            );
          }
        } catch (_) {}

        // Mevcut adresten doğrulanmış telefon numarasını al (kritik nokta)
        // +90: sadece numara, countryPhoneCode eklenmez. +49/+44: numara + ülke kodu.
        if (existingWebAddresses.length > 0) {
          let state = "fallback";
          for (const ea of existingWebAddresses) {
            state = _noteExistingPhone(ea);
            if (state === "ok" && accountPhoneChoice) break;
          }
          if (state === "ok" && accountPhoneChoice) {
            webAddrBody.phone = accountPhoneChoice.phone;
            if (accountPhoneChoice.cc === "+49" || accountPhoneChoice.cc === "+44") {
              webAddrBody.countryPhoneCode = accountPhoneChoice.cc;
            } else {
              delete webAddrBody.countryPhoneCode;
            }
          }
        }
        // Eski adresleri de buraya kaydet (sonradan silmek için)
        existingAddresses = existingWebAddresses;

        if (!foreignPhoneBlocked) {
        let { http: wHttp, body: wBody } = await _webFetch(
          "POST",
          WEB_ADDR_URL,
          webAddrBody,
        );

        // 409 çakışma → addressName değiştir, tekrar dene
        if (wHttp === 409) {
          const wb2 = {
            ...webAddrBody,
            addressName: `Ev${ts}${Math.floor(Math.random() * 90 + 10)}`,
          };
          const { http: h2, body: b2 } = await _webFetch(
            "POST",
            WEB_ADDR_URL,
            wb2,
          );
          wHttp = h2;
          wBody = b2;
          console.log("[Trendyol] Web endpoint retry HTTP", wHttp);
        }

        if (wHttp >= 200 && wHttp < 300) {
          // SMS challenge kontrolü
          const wArr = Array.isArray(wBody) ? wBody : wBody ? [wBody] : [];
          const wSmsItem = wArr.find((o) => o?.field === "sms_verification");
          if (wSmsItem) {
            const masked =
              wSmsItem?.otpData?.gsmNumber || wSmsItem?.phoneNumberMasked || "";
            console.warn(
              "[Trendyol] Web endpoint SMS challenge (",
              masked,
              ") — zeususer fallback",
            );
          } else {
            newAddressId = wBody?.id || wBody?.addressId;
            usedWebEndpoint = true;
            console.log(
              "[Trendyol] ✅ Web endpoint ile adres oluşturuldu, id:",
              newAddressId,
            );
            await logManager.addLog(
              "success",
              "Trendyol adresi web endpoint ile oluşturuldu (SMS yok)",
            );
          }
        } else {
          lastWebFail = extractTrendyolAddressApiError(wBody, wHttp);
          console.warn(
            "[Trendyol] Web endpoint başarısız (HTTP",
            wHttp,
            ") — zeususer fallback'e geçiliyor",
          );
        }
        }
      } catch (e) {
        lastWebFail = { primary: e?.message || "web exception", http: null, codes: [], fields: [], messages: [] };
        console.warn("[Trendyol] Web endpoint exception — zeususer fallback");
      }
    } else {
      console.log("[Trendyol] Web token yok — direkt zeususer fallback");
    }

    if (foreignPhoneBlocked && !usedWebEndpoint && !accountPhoneChoice) {
      throw new Error(
        "Hesaptaki yabancı numara okunamadı. Adres, kayıtlı numara ile güncellenmeli.",
      );
    }

    // ── 7. B YOLU: Zeususer fallback (mobile_token, SMS gelebilir) ───────
    // Önce mevcut adresleri al — hesaptaki kayıtlı numarayı kullanmak için
    if (!usedWebEndpoint) {
      await logManager.addLog(
        "info",
        "Trendyol mevcut adresler alınıyor (zeususer)...",
      );
      try {
        const { http: getHttp, body: getData } = await _proxyReq({
          method: "GET",
          url: ZEUS_BASE + ZEUS_GET_PARAMS,
        });
        console.log("[Trendyol] GET zeususer HTTP", getHttp);
        if (getHttp >= 200 && getHttp < 300 && getData) {
          existingAddresses = getData?.addresses || [];
          console.log(
            "[Trendyol] Mevcut adresler:",
            existingAddresses.length,
          );
        }
      } catch (e) {
        console.warn("[Trendyol] GET zeususer exception");
      }

      // REFERANS'NUN KRİTİK NOKTASI: Hesaptaki kayıtlı numarayı kullan
      // Eğer hesapta zaten bir adres varsa, o adresin telefon numarası Trendyol'da
      // doğrulanmış demektir — yeni adrese aynı numarayı koyarsak SMS gelmez.
      // +90: phoneCountryCode +90. +49/+44: kayıtlı yabancı numara + ülke kodu.
      let phoneNumber = _parsePhone(address.phone) || "5551234567";
      let phoneCc = "+90";
      // Formdan gelen ülke kodu (TR/DE/UK) — hesapta doğrulanmış numara yoksa
      const formPhoneChoice = _phoneFromExisting({
        phone: address.phone,
        phoneCountryCode: address.phoneCountryCode || address.countryPhoneCode,
      });
      if (formPhoneChoice) {
        phoneNumber = formPhoneChoice.phone;
        phoneCc = formPhoneChoice.cc;
      }
      let usedExistingTr = false;
      if (!accountPhoneChoice && existingAddresses.length > 0) {
        _noteExistingPhone(existingAddresses[0]);
      }
      if (foreignPhoneBlocked && !accountPhoneChoice) {
        const label =
          "yabancı";
        throw new Error(
          `Hesaptaki ${label} numarası okunamadı. Adres, kayıtlı numara ile güncellenmeli.`,
        );
      }
      if (accountPhoneChoice) {
        phoneNumber = accountPhoneChoice.phone;
        phoneCc = accountPhoneChoice.cc;
        usedExistingTr = phoneCc === "+90";
      } else if (existingAddresses.length > 0) {
        const existingPhone = _parsePhone(existingAddresses[0].phone);
        if (existingPhone) {
          phoneNumber = existingPhone;
          phoneCc = "+90";
          usedExistingTr = true;
        }
      }
      if (usedExistingTr) {
        console.log(
          "[Trendyol] ✅ Hesaptaki kayıtlı numara kullanılıyor (SMS gelmeyecek)",
        );
        try {
          await chrome.cookies.set({
            url: "https://tgoyemek.com",
            name: "user_phone",
            value: String(phoneNumber),
            domain: "tgoyemek.com",
            secure: true,
            httpOnly: false,
            sameSite: "lax",
            path: "/",
          });
          await chrome.storage.local.set({
            tyAccountPhone: String(phoneNumber),
          });
        } catch (_) {}
      }

      // Zeususer body (Android mobil format)
      const zeusBody = {
        addressOwnerName: ownerName,
        addressOwnerSurname: ownerSurname,
        addressTitle: _randStr(6),
        address:
          addrLine || `${address.province || ""} No:${address.building || "1"}`,
        addressDescription:
          address.description || `${ownerName} ${ownerSurname} ev`,
        apartmentNumber: address.building || "1",
        floor: address.floor || "1",
        doorNumber: address.apartment || "1",
        cityCode: locationIds.cityId,
        districtId: locationIds.districtId,
        neighborhoodId: locationIds.neighborhoodId,
        lat: randomizedLocation.lat,
        lon: randomizedLocation.lng,
        phone: phoneNumber,
        phoneCountryCode: phoneCc,
        countryCode: "TR",
        elevatorAvailable: false,
        addressType: "PERSONAL",
      };
      await logManager.addLog(
        "info",
        "Trendyol yeni adres oluşturuluyor (zeususer)...",
      );
      let { http: postHttp, body: postBody } = await _proxyReq({
        method: "POST",
        url: ZEUS_BASE + ZEUS_PARAMS,
        body: zeusBody,
      });
      // 409 çakışma — addressTitle değiştir, tekrar dene
      if (postHttp === 409) {
        const { http: h2, body: b2 } = await _proxyReq({
          method: "POST",
          url: ZEUS_BASE + ZEUS_PARAMS,
          body: { ...zeusBody, addressTitle: _randStr(6) },
        });
        postHttp = h2;
        postBody = b2;
      }

      // SMS challenge kontrolü
      const _bodyArr = Array.isArray(postBody)
        ? postBody
        : postBody
          ? [postBody]
          : [];
      const _smsItem = _bodyArr.find((o) => o?.field === "sms_verification");

      if (_smsItem) {
        const masked =
          _smsItem?.otpData?.gsmNumber || _smsItem?.phoneNumberMasked || "";
        console.warn("[Trendyol] SMS challenge — telefon:", masked);
        await logManager.addLog(
          "warning",
          `Trendyol SMS doğrulama istedi (${masked || "?"}) — koordinatlar kaydedildi, kupon uygulanmaya devam.`,
        );
        // Koordinatlar zaten kaydedildi (adım 3) — kupon proxy lat/lng ile çalışır
        await logManager.addLog(
          "success",
          "Trendyol adres yönetimi tamamlandı (koordinatlar hazır)",
        );
        return;
      }

      if (postHttp < 200 || postHttp >= 300) {
        const fail = buildTrendyolAddressFailMessage(postHttp, postBody, {
          cityId: locationIds.cityId,
          districtId: locationIds.districtId,
          neighborhoodId: locationIds.neighborhoodId,
          hasCoords: !!(lat && lng),
          phoneCc,
          webFailed: !!lastWebFail,
        });
        const err = new Error(fail.message);
        err.code = fail.code;
        err.apiMessage = fail.apiMessage;
        throw err;
      }

      newAddressId = postBody?.addressId || postBody?.id;
      console.log(
        "[Trendyol] ✅ Zeususer ile adres oluşturuldu, id:",
        newAddressId,
      );
      await logManager.addLog("success", "Trendyol yeni adres oluşturuldu");
    }

    // ── 8. Eski adresleri sil (önce yeni ekle → sonra eski sil) ──
    if (existingAddresses.length > 0) {
      await logManager.addLog(
        "info",
        `${existingAddresses.length} eski adres siliniyor...`,
      );
      for (const oldAddr of existingAddresses) {
        const oldId = oldAddr.addressId || oldAddr.id;
        if (!oldId || oldId === newAddressId) continue;
        try {
          let deleted = false;
          // Web endpoint ile sil () — web token varsa
          if (webToken) {
            const { http: dHttp } = await _webFetch(
              "DELETE",
              `${WEB_ADDR_URL}/${oldId}`,
            );
            deleted = dHttp >= 200 && dHttp < 300;
            console.log(
              "[Trendyol] Web DELETE",
              oldId,
              "→ HTTP",
              dHttp,
              deleted ? "✅" : "⚠️",
            );
          }
          // Fallback: zeususer DELETE (mobile_token)
          if (!deleted) {
            const ok = await deleteTrendyolAddress(oldId, mobileToken);
            console.log("[Trendyol] Zeususer DELETE", oldId, ok ? "✅" : "⚠️");
          }
          await new Promise((r) => setTimeout(r, 400));
        } catch (e) {
          console.warn("[Trendyol] DELETE exception:", oldId, e?.message);
        }
      }
      await logManager.addLog("success", "Eski adresler silindi");
    }

    // ── 9. Mobil sepete shipping bind (sadece lat/lng — adres ID mobile cart'ta geçersiz) ─
    try {
      // NOT: invoiceAddressId/shippingAddressId GÖNDERME — web adres ID'si mobil
      // meal-mmcheckout-sfxcarts-santral tarafından tanınmaz → 5005 hatası → cart kilitlenir.
      // Mobil API koordinata göre yakın depoyu bulur, ID'ye ihtiyaç duymaz.

      // newAddressId'yi storage'a kaydet — trendyol-proxy.js cart response'una ekler
      // böylece frontend shippingAddressId'yi görür, ödeme butonu aktif olur.
      if (newAddressId) {
        try {
          const existing = await chrome.storage.local
            .get(["tyAddressPayload"])
            .catch(() => ({}));
          const p = existing.tyAddressPayload || {};
          await chrome.storage.local.set({
            tyAddressPayload: { ...p, newAddressId: String(newAddressId) },
          });
        } catch (_) {}
      }

      const shipBody = {
        latitude: randomizedLocation.lat,
        longitude: randomizedLocation.lng,
      };
      const shipPayload = {
        mobile_token: mobileToken,
        method: "POST",
        url: "https://api.tgoapis.com/meal-mmcheckout-sfxcarts-santral/shipping?appName=TrendyolGo&channelId=4",
        body: shipBody,
      };
      const shipRes = await fetch(PROXY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(shipPayload),
      });
      const shipRaw = await shipRes.text();
      let shipJson = null;
      try {
        shipJson = JSON.parse(shipRaw);
      } catch (_) {}
      const shipHttp = shipJson?.http || shipRes.status;
      console.log(
        "[Trendyol] Shipping bind → HTTP",
        shipHttp,
        shipHttp < 300 ? "✅" : "⚠️",
      );
    } catch (e) {
      console.warn("[Trendyol] Shipping bind exception:", e?.message);
    }

    if (newAddressId) {
      try {
        const tgoAddr = {
          id: Number(newAddressId) || newAddressId,
          lat: randomizedLocation.lat,
          lon: randomizedLocation.lng,
          latitude: randomizedLocation.lat,
          longitude: randomizedLocation.lng,
        };
        await chrome.cookies.set({
          url: "https://tgoyemek.com/",
          domain: "tgoyemek.com",
          path: "/",
          name: "tgo-address",
          value: encodeURIComponent(JSON.stringify(tgoAddr)),
          secure: true,
          httpOnly: false,
          sameSite: "lax",
          expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
        });
        console.log(
          "[Trendyol] ✅ tgo-address cookie yazıldı, id:",
          newAddressId,
        );
        // Interceptor GeoFix + sayfa state için koordinatı tüm tgoyemek sekmelerine bas
        try {
          const lat = Number(randomizedLocation.lat);
          const lng = Number(randomizedLocation.lng);
          const tabs = await chrome.tabs.query({ url: ["*://tgoyemek.com/*", "*://*.tgoyemek.com/*"] });
          for (const tab of tabs) {
            if (!tab.id) continue;
            chrome.tabs
              .sendMessage(tab.id, {
                action: "ksTyGeoPush",
                lat,
                lng,
                addressId: newAddressId,
              })
              .catch(() => {});
            chrome.scripting
              .executeScript({
                target: { tabId: tab.id, allFrames: true },
                world: "MAIN",
                func: (la, ln) => {
                  try {
                    window.__ksTyGeo = { lat: la, lng: ln };
                    sessionStorage.setItem(
                      "ks_ty_geo",
                      JSON.stringify({ lat: la, lng: ln }),
                    );
                  } catch (_) {}
                },
                args: [lat, lng],
              })
              .catch(() => {});
          }
          console.log("[Trendyol] ✅ ks_ty_geo push:", lat, lng, "tabs:", tabs.length);
        } catch (e) {
          console.warn("[Trendyol] ks_ty_geo push:", e?.message || e);
        }
      } catch (e) {
        console.warn("[Trendyol] tgo-address cookie:", e?.message || e);
      }
    }

    try {
      await completeTrendyolUserInfo();
    } catch (e) {
      console.warn(
        "[Trendyol] Profil (adres sonrası) hatası:",
        e?.message || e,
      );
    }

    await applyTgoAndroidSsrBypass();
    const bounceStor = await chrome.storage.local.get([
      "tyCheckoutPending",
      "tyOdemePageActive",
      "tyCheckoutLockUntil",
    ]);
    if (
      bounceStor.tyCheckoutPending ||
      bounceStor.tyOdemePageActive ||
      (bounceStor.tyCheckoutLockUntil &&
        Date.now() < bounceStor.tyCheckoutLockUntil)
    ) {
      console.log("[Trendyol] adres sonrası bounce atlandı — checkout pending");
    } else {
      await bounceTgoyemekToRestoranlar({ force: true });
    }

    await logManager.addLog("success", "Trendyol adres yönetimi tamamlandı");
  } catch (error) {
    const errMsg = String(error?.message || "").replace(/\+44/g, "").replace(/\+49/g, "");
    let errorCode = error?.code || "unknown";
    if (errorCode === "unknown" || errorCode === "SMS_REQUIRED") {
      if (error?.code === "SMS_REQUIRED") errorCode = "sms_required";
      else if (/koordinat/i.test(errMsg)) errorCode = "no_coordinates";
      else if (/mahalle ID|lokasyon/i.test(errMsg))
        errorCode = "location_not_found";
      else if (/mobile token/i.test(errMsg)) errorCode = "no_token";
      else if (/phone|telefon|Alman|Krallık|\+44|\+49/i.test(errMsg))
        errorCode = "phone_error";
      else if (/Adres bilgisi eklenemedi|reddetti|oluşturulamadı/i.test(errMsg))
        errorCode = "address_rejected";
      else if (/HTTP\s*[45]/i.test(errMsg)) errorCode = "api_error";
    }
    ksTrack("address.sync.failed", {
      platform: "trendyol",
      success: false,
      error_code: errorCode,
      error_message: errMsg.slice(0, 500),
      payload: {
        has_lat: !!(address && (address.lat || address.latitude)),
        has_lng: !!(address && (address.lng || address.longitude)),
        lat: address?.lat || address?.latitude || null,
        lng: address?.lng || address?.longitude || null,
        province: address?.province || null,
        district: address?.district || null,
        neighborhood: address?.neighborhood || null,
        api_message: error?.apiMessage || null,
      },
    });
    throw error;
  }
}

/**
 * Trendyol adres senkronu için koordinat çöz — storage / geocode / il merkezi
 */
async function resolveTrendyolAddressCoordinates(address) {
  const pick = (obj, keys) => {
    for (const k of keys) {
      const v = obj && obj[k];
      const n = typeof v === "number" ? v : parseFloat(String(v || "").replace(",", "."));
      if (Number.isFinite(n) && Math.abs(n) > 0.01) return n;
    }
    return 0;
  };
  let lat = pick(address, ["latitude", "lat", "y"]);
  let lng = pick(address, ["longitude", "lng", "lon", "long", "x"]);
  // Bazı kayıtlarda string "0" veya boş gelir
  if (lat && lng) return { lat, lng, source: "stored" };

  // tyAddressPayload yedeği (önceki başarılı sync)
  try {
    const stor = await chrome.storage.local.get(["tyAddressPayload"]).catch(() => ({}));
    const p = stor && stor.tyAddressPayload;
    const plat = pick(p || {}, ["latitude", "lat"]);
    const plng = pick(p || {}, ["longitude", "lng", "lon"]);
    if (plat && plng) return { lat: plat, lng: plng, source: "payload_cache" };
  } catch (_) {}

  // Nominatim forward geocode (mahalle + ilçe + il)
  const qParts = [
    address?.street,
    address?.neighborhood,
    address?.district,
    address?.province || address?.city,
    "Türkiye",
  ].filter((x) => x && String(x).trim());
  if (qParts.length >= 2) {
    try {
      const q = encodeURIComponent(qParts.join(", "));
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=tr&q=${q}`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "KuponStoreExtension/10.1.20",
          },
        },
      );
      if (resp.ok) {
        const arr = await resp.json().catch(() => []);
        if (Array.isArray(arr) && arr[0]) {
          const glat = parseFloat(arr[0].lat);
          const glng = parseFloat(arr[0].lon);
          if (Number.isFinite(glat) && Number.isFinite(glng) && glat && glng) {
            return { lat: glat, lng: glng, source: "nominatim" };
          }
        }
      }
    } catch (e) {
      console.warn("[Trendyol] Nominatim geocode:", e?.message || e);
    }
  }

  // İl merkezi fallback
  const center = getTurkeyCityCenter(address?.province || address?.city);
  if (center) return { lat: center.lat, lng: center.lng, source: "city_center" };

  return { lat: 0, lng: 0, source: null };
}

function getTurkeyCityCenter(provinceName) {
  if (!provinceName) return null;
  const key = simplifyText(provinceName);
  const centers = {
    istanbul: { lat: 41.0082, lng: 28.9784 },
    ankara: { lat: 39.9334, lng: 32.8597 },
    izmir: { lat: 38.4237, lng: 27.1428 },
    bursa: { lat: 40.1885, lng: 29.061 },
    antalya: { lat: 36.8969, lng: 30.7133 },
    adana: { lat: 37.0, lng: 35.3213 },
    konya: { lat: 37.8746, lng: 32.4932 },
    gaziantep: { lat: 37.0662, lng: 37.3833 },
    mersin: { lat: 36.8121, lng: 34.6415 },
    kayseri: { lat: 38.7312, lng: 35.4787 },
    eskisehir: { lat: 39.7767, lng: 30.5206 },
    diyarbakir: { lat: 37.9144, lng: 40.2306 },
    samsun: { lat: 41.2867, lng: 36.33 },
    denizli: { lat: 37.7765, lng: 29.0864 },
    sanliurfa: { lat: 37.1674, lng: 38.7955 },
    malatya: { lat: 38.3552, lng: 38.3095 },
    erzurum: { lat: 39.9000, lng: 41.27 },
    van: { lat: 38.5012, lng: 43.373 },
    batman: { lat: 37.8812, lng: 41.1351 },
    elazig: { lat: 38.681, lng: 39.2264 },
    trabzon: { lat: 41.0027, lng: 39.7168 },
    sakarya: { lat: 40.7889, lng: 30.406 },
    kocaeli: { lat: 40.8533, lng: 29.8815 },
    tekirdag: { lat: 40.9781, lng: 27.511 },
    balikesir: { lat: 39.6484, lng: 27.8826 },
    manisa: { lat: 38.6191, lng: 27.4289 },
    aydin: { lat: 37.8444, lng: 27.8458 },
    mugla: { lat: 37.2153, lng: 28.3636 },
    hatay: { lat: 36.4018, lng: 36.3498 },
    mardin: { lat: 37.3212, lng: 40.7245 },
    kahramanmaras: { lat: 37.5858, lng: 36.9371 },
    ordu: { lat: 40.9839, lng: 37.8764 },
    afyonkarahisar: { lat: 38.7507, lng: 30.5567 },
    isparta: { lat: 37.7648, lng: 30.5566 },
    canakkale: { lat: 40.1553, lng: 26.4142 },
    edirne: { lat: 41.6771, lng: 26.5557 },
    kirklareli: { lat: 41.7351, lng: 27.2252 },
    bolu: { lat: 40.735, lng: 31.6061 },
    duzce: { lat: 40.8438, lng: 31.1565 },
    zonguldak: { lat: 41.4564, lng: 31.7987 },
    rize: { lat: 41.0201, lng: 40.5234 },
    artvin: { lat: 41.1828, lng: 41.8183 },
    giresun: { lat: 40.9128, lng: 38.3895 },
    nevsehir: { lat: 38.6939, lng: 34.6857 },
    aksaray: { lat: 38.3687, lng: 34.037 },
    nigde: { lat: 37.9667, lng: 34.6833 },
    yozgat: { lat: 39.8181, lng: 34.8147 },
    sivas: { lat: 39.7477, lng: 37.0179 },
    tokat: { lat: 40.3167, lng: 36.55 },
    amasya: { lat: 40.6539, lng: 35.833 },
    corum: { lat: 40.5506, lng: 34.9556 },
    kastamonu: { lat: 41.3887, lng: 33.7827 },
    sinop: { lat: 42.0231, lng: 35.1531 },
    bartin: { lat: 41.6344, lng: 32.3375 },
    karabuk: { lat: 41.2061, lng: 32.6204 },
    usak: { lat: 39.4192, lng: 29.9857 },
    kutahya: { lat: 39.4167, lng: 29.9833 },
    burdur: { lat: 37.7203, lng: 30.2908 },
    osmaniye: { lat: 37.0742, lng: 36.2464 },
    kilis: { lat: 36.7184, lng: 37.1212 },
    adiyaman: { lat: 37.7636, lng: 38.2773 },
    siirt: { lat: 37.9274, lng: 41.94 },
    sirnak: { lat: 37.5184, lng: 42.454 },
    hakkari: { lat: 37.5744, lng: 43.7408 },
    agrı: { lat: 39.7191, lng: 43.0503 },
    agri: { lat: 39.7191, lng: 43.0503 },
    igdir: { lat: 39.9167, lng: 44.0333 },
    kars: { lat: 40.6013, lng: 43.0975 },
    ardahan: { lat: 41.1106, lng: 42.7022 },
    bayburt: { lat: 40.2552, lng: 40.2249 },
    gumushane: { lat: 40.4603, lng: 39.4814 },
    bingol: { lat: 38.8855, lng: 40.4966 },
    mus: { lat: 38.7432, lng: 41.5064 },
    bitlis: { lat: 38.4006, lng: 42.1095 },
    tunceli: { lat: 39.1061, lng: 39.5481 },
    kirikkale: { lat: 39.8468, lng: 33.5153 },
    kirsehir: { lat: 39.1425, lng: 34.1709 },
    cankiri: { lat: 40.6, lng: 33.6167 },
    yalova: { lat: 40.65, lng: 29.2667 },
    bilecik: { lat: 40.1425, lng: 29.9793 },
  };
  return centers[key] || null;
}

/**
 * Clean neighborhood suffix (mahalle/köy ekleri)
 */
function cleanNeighborhoodSuffix(text) {
  if (!text) return "";
  return text
    .replace(
      /\s*(mah|mahallesi|mahalle|mh\.?|köy|köyü|beldesi|kasabası)\s*$/gi,
      "",
    )
    .trim();
}

/**
 * Levenshtein distance (fuzzy matching için)
 */
function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Hardcoded Trendyol city IDs (fallback için)
 */
function getTrendyolCityIds() {
  return {
    adana: 100,
    adıyaman: 101,
    afyonkarahisar: 102,
    afyon: 102,
    ağrı: 103,
    aksaray: 167,
    amasya: 104,
    ankara: 105,
    antalya: 106,
    ardahan: 174,
    artvin: 107,
    aydın: 108,
    balıkesir: 109,
    bartın: 173,
    batman: 171,
    bayburt: 168,
    bilecik: 110,
    bingöl: 111,
    bitlis: 112,
    bolu: 113,
    burdur: 114,
    bursa: 115,
    çanakkale: 116,
    çankırı: 117,
    çorum: 118,
    denizli: 119,
    diyarbakır: 120,
    düzce: 180,
    edirne: 121,
    elazığ: 122,
    erzincan: 123,
    erzurum: 124,
    eskişehir: 125,
    gaziantep: 126,
    giresun: 127,
    gümüşhane: 128,
    hakkari: 129,
    hatay: 130,
    ığdır: 175,
    ısparta: 131,
    istanbul: 133,
    İstanbul: 133,
    izmir: 134,
    İzmir: 134,
    kahramanmaraş: 145,
    karabük: 177,
    karaman: 169,
    kars: 135,
    kastamonu: 136,
    kayseri: 137,
    kırıkkale: 170,
    kırklareli: 138,
    kırşehir: 139,
    kilis: 178,
    kocaeli: 140,
    konya: 141,
    kütahya: 142,
    malatya: 143,
    manisa: 144,
    mardin: 146,
    mersin: 132,
    muğla: 147,
    muş: 148,
    nevşehir: 149,
    niğde: 150,
    ordu: 151,
    osmaniye: 179,
    rize: 152,
    sakarya: 153,
    samsun: 154,
    siirt: 155,
    sinop: 156,
    sivas: 157,
    şanlıurfa: 162,
    urfa: 162,
    şırnak: 172,
    tekirdağ: 158,
    tokat: 159,
    trabzon: 160,
    tunceli: 161,
    uşak: 163,
    van: 164,
    yalova: 176,
    yozgat: 165,
    zonguldak: 166,
  };
}

/**
 * Get Trendyol location IDs (city, district, neighborhood)
 */
// ─────────────────────────────────────────────────────────────────────────
// Trendyol şehir/ilçe/mahalle eşleştirme.
// Tek fark: auth olarak mobil JWT (tyMobileToken) kullanıyoruz, çünkü
// adresleri havuz hesabının MOBİL profiline yazıyoruz (kupon endpoint'i ile
// aynı sepeti görmesi için). Web JWT (tgo-token / access_token cookie).
// ─────────────────────────────────────────────────────────────────────────

// Şehir verilerini getir
// Web JWT ile çağrılır, mobil header gerekmez.
// authHeaderOrwebApiHeaders: ya bearer string (geri-uyumluluk) ya da hazır webApiHeaders objesi.
function _resolveTyHeaders(authHeaderOrwebApiHeaders) {
  if (
    typeof authHeaderOrwebApiHeaders === "object" &&
    authHeaderOrwebApiHeaders
  ) {
    return authHeaderOrwebApiHeaders;
  }
  return {
    Authorization: authHeaderOrwebApiHeaders,
    Accept: "application/json, text/plain, */*",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua":
      '"Not)A;Brand";v="8", "Chromium";v="138", "Microsoft Edge";v="138"',
    "sec-ch-ua-mobile": "?0",
    origin: "https://tgoyemek.com",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "tr,en;q=0.9,en-GB;q=0.8,en-US;q=0.7",
    priority: "u=1, i",
  };
}

async function fetchTrendyolCities(authHeaderOrwebApiHeaders) {
  try {
    const r = await fetch(
      "https://api.tgoapis.com/web-user-apimemberaddress-santral/cities",
      {
        method: "GET",
        headers: _resolveTyHeaders(authHeaderOrwebApiHeaders),
      },
    );
    if (!r.ok) return [];
    const data = await r.json();
    return data?.cities || [];
  } catch (e) {
    console.error("[Trendyol] Şehir çekme hatası:", e);
    return [];
  }
}

async function fetchTrendyolDistricts(cityId, authHeaderOrwebApiHeaders) {
  try {
    const r = await fetch(
      `https://api.tgoapis.com/web-user-apimemberaddress-santral/cities/${cityId}/districts`,
      {
        method: "GET",
        headers: _resolveTyHeaders(authHeaderOrwebApiHeaders),
      },
    );
    if (!r.ok) return [];
    const data = await r.json();
    return data?.districts || [];
  } catch (e) {
    console.error(`[Trendyol] İlçe çekme hatası (cityId=${cityId}):`, e);
    return [];
  }
}

async function fetchTrendyolNeighborhoods(
  districtId,
  authHeaderOrwebApiHeaders,
) {
  try {
    const r = await fetch(
      `https://api.tgoapis.com/web-user-apimemberaddress-santral/districts/${districtId}/neighborhoods`,
      {
        method: "GET",
        headers: _resolveTyHeaders(authHeaderOrwebApiHeaders),
      },
    );
    if (!r.ok) return [];
    const data = await r.json();
    return data?.neighborhoods || [];
  } catch (e) {
    console.error(
      `[Trendyol] Mahalle çekme hatası (districtId=${districtId}):`,
      e,
    );
    return [];
  }
}

// Şehir/ilçe/mahalle ID'lerini eşleştir (3 ardışık API çağrısı,
// her birinde aynı findMatchInList fonksiyonuyla fuzzy eşleştirme).
async function getTrendyolLocationIds(address, authHeader, webApiHeaders) {
  try {
    // webApiHeaders verildiyse onu kullan (3 ardışık çağrı için).
    const headersOrAuth = webApiHeaders || authHeader;
    // 1) ŞEHİR
    const cityName = address.province || address.city;
    const cities = await fetchTrendyolCities(headersOrAuth);
    let matchedCity = findMatchInList(cities, cityName);

    // Fallback: hardcoded city mapping (offline durumlar için)
    if (!matchedCity && cityName) {
      const map = getTrendyolCityIds();
      const id = map[simplifyText(cityName)] || map[cityName.toLowerCase()];
      if (id) {
        matchedCity = { id, name: cityName };
        console.log("[Trendyol] Hardcoded city ID:", cityName, "→", id);
      }
    }

    if (!matchedCity) {
      console.error("[Trendyol] Şehir bulunamadı:", cityName);
      return null;
    }

    // 2) İLÇE
    const districts = await fetchTrendyolDistricts(
      matchedCity.id,
      headersOrAuth,
    );

    // "<şehir> Merkez" → "Merkez" normalizasyonu
    let districtSearchName = address.district || "";
    const simplifiedCity = simplifyText(cityName || "");
    const simplifiedDistrict = simplifyText(districtSearchName);
    if (
      simplifiedDistrict === simplifiedCity + "merkez" ||
      simplifiedDistrict.includes(simplifiedCity + "merkez") ||
      / merkez$/i.test(districtSearchName)
    ) {
      districtSearchName = "Merkez";
    }

    let matchedDistrict = findMatchInList(districts, districtSearchName);
    // Merkez / kısmi eşleşme / ilk ilçe — reverse-geocode yoksa bile POST gidebilsin
    if (!matchedDistrict && districts.length) {
      matchedDistrict =
        findMatchInList(districts, "Merkez") ||
        districts.find((d) =>
          simplifyText(d.name || "").includes(simplifiedDistrict),
        ) ||
        districts.find((d) =>
          simplifiedDistrict.includes(simplifyText(cleanSuffix(d.name || ""))),
        ) ||
        null;
      if (matchedDistrict) {
        console.warn(
          "[Trendyol] İlçe fallback:",
          address.district,
          "→",
          matchedDistrict.name,
        );
      }
    }
    if (!matchedDistrict) {
      console.error(
        "[Trendyol] İlçe bulunamadı:",
        address.district,
        "| ilk 10:",
        districts.slice(0, 10).map((d) => d.name),
      );
      return null;
    }

    // 3) MAHALLE (opsiyonel — bulunamasa da adres POST edilebilir)
    let neighborhoodId = null;
    if (address.neighborhood) {
      const neighborhoods = await fetchTrendyolNeighborhoods(
        matchedDistrict.id,
        headersOrAuth,
      );
      const matchedNeighborhood = findMatchInList(
        neighborhoods,
        address.neighborhood,
      );
      if (matchedNeighborhood) {
        neighborhoodId = matchedNeighborhood.id;
        console.log("[Trendyol] ✅ Mahalle bulundu:", matchedNeighborhood.name);
      } else {
        console.warn("[Trendyol] ⚠️ Mahalle bulunamadı:", address.neighborhood);
      }
    }

    return {
      cityId: matchedCity.id,
      districtId: matchedDistrict.id,
      neighborhoodId,
    };
  } catch (error) {
    console.error("[Trendyol] Location ID hatası:", error);
    return null;
  }
}

/**
 * Simplify text for matching
 */
function simplifyText(text) {
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0130\u0049]/g, "i")
    .replace(/[\u0131]/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Clean neighborhood/village suffixes for better matching
 */
function cleanSuffix(text) {
  if (!text) return text;
  return text
    .replace(/\s*\([^)]*\)\s*$/g, "") // Önce parantezli kısmı kaldır: "Mah (Köy Adı)"
    .replace(
      /\s*(mah|mahallesi|mahalle|mh\.?|köy|köyü|beldesi|kasabası)\s*$/gi,
      "",
    )
    .trim();
}

/**
 * Levenshtein distance for fuzzy matching
 */
function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Find best match in Trendyol data array (city/district/neighborhood)
 */
function findMatchInList(dataArray, nameToMatch) {
  if (!nameToMatch || !dataArray || dataArray.length === 0) return null;

  const searchBase = cleanSuffix(nameToMatch);
  const simplified = simplifyText(searchBase);
  const noSpace = simplified.replace(/\s+/g, "");

  // 1. Tam eşleşme
  let match = dataArray.find(
    (d) => simplifyText(cleanSuffix(d.name)) === simplified,
  );

  // 2. Boşluksuz tam eşleşme ("Ertuğrul Gazi" == "Ertuğrulgazi")
  if (!match) {
    match = dataArray.find(
      (d) => simplifyText(cleanSuffix(d.name)).replace(/\s+/g, "") === noSpace,
    );
  }

  // 3. Başlangıç eşleşmesi
  if (!match) {
    match = dataArray.find((d) => {
      const sn = simplifyText(cleanSuffix(d.name));
      return sn.startsWith(simplified) || simplified.startsWith(sn);
    });
  }

  // 4. Boşluksuz başlangıç eşleşmesi
  if (!match) {
    match = dataArray.find((d) => {
      const sn = simplifyText(cleanSuffix(d.name)).replace(/\s+/g, "");
      return sn.startsWith(noSpace) || noSpace.startsWith(sn);
    });
  }

  // 5. İçerme eşleşmesi (min 3 karakter)
  if (!match && simplified.length >= 3) {
    match = dataArray.find((d) => {
      const sn = simplifyText(cleanSuffix(d.name));
      return sn.includes(simplified) || simplified.includes(sn);
    });
  }

  // 6. Boşluksuz içerme
  if (!match && noSpace.length >= 3) {
    match = dataArray.find((d) => {
      const sn = simplifyText(cleanSuffix(d.name)).replace(/\s+/g, "");
      return sn.includes(noSpace) || noSpace.includes(sn);
    });
  }

  // 7. Fuzzy (Levenshtein) - %30 hata toleransı
  if (!match && simplified.length >= 4) {
    let bestDist = Infinity;
    const maxDist = Math.floor(simplified.length * 0.3);
    dataArray.forEach((d) => {
      const sn = simplifyText(cleanSuffix(d.name));
      const dist = levenshtein(simplified, sn);
      if (dist <= maxDist && dist < bestDist) {
        bestDist = dist;
        match = d;
      }
    });
  }

  // 8. Boşluksuz fuzzy
  if (!match && noSpace.length >= 4) {
    let bestDist = Infinity;
    const maxDist = Math.floor(noSpace.length * 0.3);
    dataArray.forEach((d) => {
      const sn = simplifyText(cleanSuffix(d.name)).replace(/\s+/g, "");
      const dist = levenshtein(noSpace, sn);
      if (dist <= maxDist && dist < bestDist) {
        bestDist = dist;
        match = d;
      }
    });
  }

  return match || null;
}

/**
 * Randomize location
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @param {number} radiusMeters - Radius in meters
 */
function randomizeLocation(lat, lng, radiusMeters) {
  const degreeToMeter = 111320;

  // Rastgele açı: 0-360 derece tam uniform dağılım
  const angle = Math.random() * 2 * Math.PI;

  // Rastgele mesafe: sqrt ile daire içinde uniform dağılım sağlanır
  const distance = Math.sqrt(Math.random()) * radiusMeters;

  const deltaLat = (distance * Math.cos(angle)) / degreeToMeter;
  const deltaLng =
    (distance * Math.sin(angle)) /
    (degreeToMeter * Math.cos((lat * Math.PI) / 180));

  return {
    lat: lat + deltaLat,
    lng: lng + deltaLng,
  };
}

/**
 * Delete Trendyol address
 */
// Trendyol DELETE — web JWT + Edge 138 Windows headers
async function deleteTrendyolAddress(addressId, mobileTokenOrHeaders) {
  try {
    // zeususer DELETE — proxy.php üzerinden (sunucu Android UA ile istek yapar)
    let mobileToken;
    if (typeof mobileTokenOrHeaders === "string") {
      mobileToken = mobileTokenOrHeaders;
    } else if (
      mobileTokenOrHeaders &&
      typeof mobileTokenOrHeaders === "object" &&
      mobileTokenOrHeaders["Authorization"]
    ) {
      mobileToken = (mobileTokenOrHeaders["Authorization"] || "").replace(
        /^bearer\s+/i,
        "",
      );
    } else {
      const stor = await chrome.storage.local.get(["tyMobileToken"]);
      mobileToken = stor.tyMobileToken || null;
    }
    if (!mobileToken) throw new Error("Mobile token yok");

    const delRes = await fetch("https://kuponstore.com/api/token/proxy.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mobile_token: mobileToken,
        method: "DELETE",
        url: `https://api.tgoapis.com/localcommerce-member-zeususer-service/addresses/${addressId}?appName=TrendyolGo&channelId=4`,
      }),
    });
    const delRaw = await delRes.text();
    let delJson = null;
    try {
      delJson = JSON.parse(delRaw);
    } catch (_) {}
    const delHttp = delJson?.http || delRes.status;
    console.log(
      `[Trendyol] DELETE zeususer ${addressId} → proxy HTTP ${delHttp}`,
    );
    if (delHttp < 200 || delHttp >= 300) throw new Error(`HTTP ${delHttp}`);
    return true;
  } catch (error) {
    console.error(
      `[Trendyol] Adres silme hatası (${addressId}):`,
      error?.message,
    );
    ksTrack("address.delete.failed", {
      platform: "trendyol",
      success: false,
      error_message: (error?.message || "").slice(0, 500),
    });
    return false;
  }
}

/**
 * Sync address to Getir
 */
async function syncGetirAddress(address, cookies) {
  try {
    const authCookie = cookies.find((c) => c.name === "access_token");
    if (!authCookie) {
      throw new Error("Getir auth cookie not found");
    }

    const addressData = {
      name: address.label || "Ev",
      fullName: address.fullname || "",
      phone: address.phone || "",
      address: `${address.street || ""} ${address.building || ""}`.trim(),
      district: address.neighborhood || "",
      latitude: address.lat || 0,
      longitude: address.lng || 0,
    };

    const response = await fetch(
      "https://client-api-gateway.getirapi.com/user/v1/addresses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authCookie.value}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(addressData),
      },
    );

    if (response.ok) {
      await logManager.addLog("success", "Getir adres eklendi");
    } else {
      throw new Error(`Getir API error: ${response.status}`);
    }
  } catch (error) {
    console.error("Getir address sync error:", error);
    ksTrack("address.sync.failed", {
      platform: "getir",
      success: false,
      error_message: (error?.message || "").slice(0, 500),
    });
    throw error;
  }
}

// ── YS Adres Yardımcıları ──────────────────────────────────────────────────
function ysNormalizePhone(phone) {
  if (!phone) return "";
  let n = String(phone).replace(/\s+/g, "").replace(/\D/g, "");
  if (n.startsWith("90") && n.length === 12) n = n.substring(2);
  else if (n.startsWith("0") && n.length === 11) n = n.substring(1);
  return n.length === 10 ? `+90${n}` : String(phone);
}

function ysProvinceToCityId(name) {
  const map = {
    Adana: 1,
    Adıyaman: 2,
    Afyonkarahisar: 3,
    Ağrı: 4,
    Amasya: 5,
    Ankara: 6,
    Antalya: 7,
    Artvin: 8,
    Aydın: 9,
    Balıkesir: 10,
    Bilecik: 11,
    Bingöl: 12,
    Bitlis: 13,
    Bolu: 14,
    Burdur: 15,
    Bursa: 16,
    Çanakkale: 17,
    Çankırı: 18,
    Çorum: 19,
    Denizli: 20,
    Diyarbakır: 21,
    Edirne: 22,
    Elazığ: 23,
    Erzincan: 24,
    Erzurum: 25,
    Eskişehir: 26,
    Gaziantep: 27,
    Giresun: 28,
    Gümüşhane: 29,
    Hakkari: 30,
    Hatay: 31,
    Isparta: 32,
    Mersin: 33,
    İstanbul: 34,
    İzmir: 35,
    Kars: 36,
    Kastamonu: 37,
    Kayseri: 38,
    Kırklareli: 39,
    Kırşehir: 40,
    Kocaeli: 41,
    Konya: 42,
    Kütahya: 43,
    Malatya: 44,
    Manisa: 45,
    Kahramanmaraş: 46,
    Mardin: 47,
    Muğla: 48,
    Muş: 49,
    Nevşehir: 50,
    Niğde: 51,
    Ordu: 52,
    Rize: 53,
    Sakarya: 54,
    Samsun: 55,
    Siirt: 56,
    Sinop: 57,
    Sivas: 58,
    Tekirdağ: 59,
    Tokat: 60,
    Trabzon: 61,
    Tunceli: 62,
    Şanlıurfa: 63,
    Uşak: 64,
    Van: 65,
    Yozgat: 66,
    Zonguldak: 67,
    Aksaray: 68,
    Bayburt: 69,
    Karaman: 70,
    Kırıkkale: 71,
    Batman: 72,
    Şırnak: 73,
    Bartın: 74,
    Ardahan: 75,
    Iğdır: 76,
    Yalova: 77,
    Karabük: 78,
    Kilis: 79,
    Osmaniye: 80,
    Düzce: 81,
  };
  const n = (name || "").trim();
  if (!n) return 34;
  if (map[n]) return map[n];
  const lower = n.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower))
      return v;
  }
  return 34;
}

// Bearer token seç: android_token > access_token > token (volo)
function ysBearerToken(cookies) {
  const get = (name) =>
    (cookies.find((c) => c.name === name) || {}).value || "";
  return get("android_token") || get("access_token") || get("token") || "";
}

async function ysCookieValue(name) {
  const ck = await new Promise((r) =>
    chrome.cookies.get({ url: "https://www.yemeksepeti.com", name }, r),
  );
  return ck?.value || "";
}

function ysJwtPart(tok, index) {
  try {
    const part = String(tok || "").split(".")[index];
    if (!part) return null;
    const pad = part.length % 4 ? "=".repeat(4 - (part.length % 4)) : "";
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/") + pad));
  } catch (_) {
    return null;
  }
}

function ysIsVoloDevice(tok) {
  const head = ysJwtPart(tok, 0);
  const pay = ysJwtPart(tok, 1);
  if (!head || !pay) return false;
  const kid = String(head.kid || "");
  if (pay.scope !== "DEVICE_TOKEN" && !kid.includes("device")) return false;
  return pay.client_id === "volo" || kid.includes("volo");
}

function ysIsAndroidAccess(tok) {
  const pay = ysJwtPart(tok, 1);
  if (!pay || pay.scope === "DEVICE_TOKEN") return false;
  return pay.client_id === "android";
}

function ysIsVoloAccess(tok) {
  const pay = ysJwtPart(tok, 1);
  if (!pay || pay.client_id !== "volo" || pay.scope === "DEVICE_TOKEN") return false;
  let exp = Number(pay.exp || pay.expires || 0);
  if (exp > 1e12) exp = Math.floor(exp / 1000);
  return exp > Date.now() / 1000 + 8 * 60;
}

function ysPayFresh(tok) {
  return ysAndroidLeftSec(tok) > 60;
}

// Giriş ve ödeme öncesi: bu sürenin altı "bitmek üzere".
const YS_ANDROID_LEAD_SEC = 20 * 60;

function ysAndroidLeftSec(tok) {
  const pay = ysJwtPart(tok, 1);
  if (!pay || String(pay.scope || "").includes("DEVICE")) return 0;
  if (pay.client_id && pay.client_id !== "android") return 0;
  let exp = Number(pay.exp || pay.expires || 0);
  if (exp > 1e12) exp = Math.floor(exp / 1000);
  if (!exp) return 0;
  return exp - Date.now() / 1000;
}

function ysBestAndroidToken(data) {
  const found = [];
  const push = (value) => {
    const tok = String(value || "").trim();
    if (ysIsAndroidAccess(tok)) found.push(tok);
  };
  push(data?.mobile_access_token);
  push(data?.android_token);
  push(data?.access_token);
  if (Array.isArray(data?.cookies)) {
    for (const c of data.cookies) {
      const name = String(c?.name || "");
      if (name === "android_token" || name === "access_token") push(c?.value);
    }
  }
  let best = "";
  let bestLeft = 0;
  for (const tok of found) {
    const left = ysAndroidLeftSec(tok);
    if (left > bestLeft) {
      best = tok;
      bestLeft = left;
    }
  }
  return best;
}

function ysCollectVoloDevice() {
  const found = [];
  const push = (value) => {
    const tok = String(value || "").trim();
    if (ysIsVoloDevice(tok)) found.push(tok);
  };
  for (let i = 0; i < arguments.length; i++) {
    const src = arguments[i];
    if (!src) continue;
    if (typeof src === "string") {
      push(src);
      continue;
    }
    if (Array.isArray(src)) {
      src.forEach((c) => {
        if (/device/i.test(String(c?.name || ""))) push(c?.value);
      });
      continue;
    }
    push(src.volo_device);
    push(src.device_token);
  }
  return found[0] || "";
}

async function ysSiteLoginWithDevice(email, password, device) {
  if (!ysIsVoloDevice(device)) return null;
  try {
    await chrome.cookies.set({
      url: "https://www.yemeksepeti.com/",
      name: "device_token",
      value: device,
      domain: ".yemeksepeti.com",
      path: "/",
      secure: true,
      sameSite: "lax",
    });
  } catch (_) {}
  const resp = await fetch("https://www.yemeksepeti.com/login/new/api/login", {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8",
      "X-FP-API-KEY": "volo",
      "x-device": device,
    },
    body: JSON.stringify({
      username: email,
      password,
      platform: "b2c",
    }),
    credentials: "include",
  });
  const text = await resp.text().catch(() => "");
  let body = {};
  try {
    body = JSON.parse(text);
  } catch (_) {}
  const readCk = (name) =>
    new Promise((resolve) => {
      chrome.cookies.get({ url: "https://www.yemeksepeti.com/", name }, (c) =>
        resolve(c?.value || ""),
      );
    });
  let token = body.access_token || body.token || "";
  if (!ysIsVoloAccess(token)) token = await readCk("token");
  if (!ysIsVoloAccess(token)) {
    const exc =
      body?.data?.exception_type || body?.exception_type || body?.error || "";
    console.log("[YS] x-device login", resp.status, exc || "volo yok");
    return null;
  }
  console.log("[YS] x-device login volo alındı", resp.status);
  return {
    token,
    refresh: body.refresh_token || (await readCk("refresh_token")),
    x: (await readCk("x-token")) || "",
    device: ysIsVoloDevice(await readCk("device_token")) ? await readCk("device_token") : device,
  };
}

async function ysGetAndroidToken() {
  // Önce mobil access_token. Volo `token`
  // ve `uy_token` ödeme yetkisine hiç girmez. Mobil JWT
  // android_token ve access_token çerezlerinde durur; `token` volo oturumudur.
  const named = [
    await ysCookieValue("android_token"),
    await ysCookieValue("access_token"),
  ];
  for (const tok of named) {
    if (ysIsAndroidAccess(tok)) return tok;
  }
  return "";
}

/**
 * YS Pre-Login Token Refresh.
 * Kullanıcı tokene girdiğinde cookie yazılmadan ÖNCE çalışır.
 * 1) Tarayıcıdan direkt grant_type=password ile oauth2/token
 * 2) OTP gerekli / 403 / network hata → VPS mobileLogin.php fallback
 * 3) Yeni android_token / refresh_token / device_token döner
 *
 * @param {{email:string, password:string, token:string}} opts
 * @returns {Promise<null|{android_token:string, refresh_token?:string, device_token?:string, source:string}>}
 */
let ysAndroidMintAt = 0;

async function ysMintAndroid(refreshToken) {
  const rt = String(refreshToken || "").trim();
  if (rt.length < 8) return null;
  const C_ID = "android";
  const C_SEC = "Wc7bJUJZOTgjfB6gpWmfMwdoxx7ii2pzShEfgvX0iynLthP3aX";
  const YS_TOKEN_URL = "https://tr.fd-api.com/api/v5/oauth2/token?language_id=2";
  const body =
    `grant_type=refresh_token&client_id=${C_ID}&client_secret=${C_SEC}` +
    `&scope=API_CUSTOMER&refresh_token=${encodeURIComponent(rt)}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(YS_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Fp-Api-Key": "android",
        "X-Pd-Language-Id": "2",
        "Api-Client-Version": "5.0",
        "App-Name": "com.inovel.app.yemeksepeti",
        "App-Flavor": "yemeksepeti",
        "App-Version": "25.27.0",
        "App-Build": "252700274",
        "Build-Number": "252700274",
        Platform: "android",
        "Platform-Version": "30",
        "User-Agent": "Android-app-25.27.0(252700274)",
        Accept: "application/json",
      },
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!resp.ok) {
      console.log("[YS android] refresh grant", resp.status);
      return null;
    }
    const td = await resp.json().catch(() => ({}));
    const tok = td?.access_token || "";
    const pay = ysJwtPart(tok, 1);
    if (!ysPayFresh(tok) || pay?.client_id !== "android") return null;
    return {
      android_token: tok,
      refresh_token: td?.refresh_token || rt,
      device_token: resp.headers.get("x-device") || "",
      source: "browser-refresh-grant",
    };
  } catch (e) {
    console.log("[YS android] refresh grant hata:", e?.message);
    return null;
  }
}

async function ysEnsureAndroidFresh() {
  const named = [
    await ysCookieValue("android_token"),
    await ysCookieValue("access_token"),
  ];
  let bestLeft = 0;
  for (const tok of named) {
    if (!ysIsAndroidAccess(tok)) continue;
    bestLeft = Math.max(bestLeft, ysAndroidLeftSec(tok));
  }
  if (bestLeft > YS_ANDROID_LEAD_SEC) return;
  if (ysAndroidMintAt && Date.now() - ysAndroidMintAt < 120000) return;
  ysAndroidMintAt = Date.now();
  const rt =
    (await ysCookieValue("android_refresh")) ||
    (await ysCookieValue("refresh_token"));
  const minted = await ysMintAndroid(rt);
  if (!minted?.android_token) return;
  const setCk = (name, value, httpOnly) =>
    chrome.cookies.set({
      url: "https://www.yemeksepeti.com",
      name,
      value,
      domain: ".yemeksepeti.com",
      path: "/",
      secure: true,
      httpOnly,
    });
  await setCk("access_token", minted.android_token, false).catch(() => {});
  await setCk("android_token", minted.android_token, false).catch(() => {});
  if (minted.refresh_token) {
    await setCk("android_refresh", minted.refresh_token, true).catch(() => {});
  }
  console.log("[YS android] oturum yenilendi");
}

async function ysPreLoginRefresh(opts) {
  const email = String(opts?.email || "").trim();
  const password = String(opts?.password || "");
  const shortToken = String(opts?.token || "");
  if (!email || !password) return null;

  const C_ID = "android";
  const C_SEC = "Wc7bJUJZOTgjfB6gpWmfMwdoxx7ii2pzShEfgvX0iynLthP3aX";
  const YS_TOKEN_URL = "https://tr.fd-api.com/api/v5/oauth2/token?language_id=2";
  const androidHeaders = {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-Fp-Api-Key": "android",
    "X-Pd-Language-Id": "2",
    "Api-Client-Version": "5.0",
    "App-Name": "com.inovel.app.yemeksepeti",
    "App-Flavor": "yemeksepeti",
    "App-Version": "25.27.0",
    "App-Build": "252700274",
    "Build-Number": "252700274",
    Platform: "android",
    "Platform-Version": "30",
    "User-Agent": "Android-app-25.27.0(252700274)",
    Accept: "application/json",
  };

  const refreshList = Array.isArray(opts?.refreshTokens) ? opts.refreshTokens : [];
  for (const rt of refreshList) {
    const minted = await ysMintAndroid(rt);
    if (minted?.android_token) return minted;
  }

  // ── 1. Tarayıcıdan direkt grant_type=password ────────────────────────────
  try {
    const body =
      `grant_type=password&client_id=${C_ID}&client_secret=${C_SEC}` +
      `&scope=API_CUSTOMER&username=${encodeURIComponent(email)}` +
      `&password=${encodeURIComponent(password)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(YS_TOKEN_URL, {
      method: "POST",
      headers: androidHeaders,
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (resp.ok) {
      const td = await resp.json().catch(() => ({}));
      const tok = td?.access_token || "";
      if (tok && tok.includes(".")) {
        const xDevice = resp.headers.get("x-device") || "";
        return {
          android_token: tok,
          refresh_token: td?.refresh_token || "",
          device_token: xDevice,
          source: "browser-password-grant",
        };
      }
    } else {
      const t = await resp.text().catch(() => "");
      console.log("[YS pre-login] grant status", resp.status, t.slice(0, 160));
    }
  } catch (e) {
    console.log("[YS pre-login] browser grant hata:", e?.message);
  }

  function ysJwtPayload(tok) {
    try {
      const part = String(tok || "").split(".")[1];
      if (!part) return null;
      const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
      return JSON.parse(json);
    } catch (_) {
      return null;
    }
  }
  function ysUsable(tok, client) {
    const pay = ysJwtPayload(tok);
    if (!pay) return false;
    if (client && pay.client_id !== client) return false;
    let exp = Number(pay.exp || pay.expires || 0);
    if (exp > 1e12) exp = Math.floor(exp / 1000);
    return exp > Date.now() / 1000 + 8 * 60;
  }
  function ysPack(vd, source) {
    const tok =
      vd?.mobile_access_token || vd?.android_token || vd?.access_token || "";
    const androidOk = ysUsable(tok, "android");
    const volo = ysUsable(vd?.volo_token, "volo") ? vd.volo_token : "";
    if (!androidOk && !volo) return null;
    const voloDevice = ysCollectVoloDevice(vd?.volo_device, vd?.device_token);
    return {
      android_token: androidOk ? tok : "",
      refresh_token: vd?.refresh_token || "",
      device_token: vd?.device_token || "",
      volo_token: volo,
      volo_x_token: volo ? vd?.volo_x_token || "" : "",
      volo_refresh: volo ? vd?.volo_refresh || "" : "",
      volo_device: voloDevice,
      source,
    };
  }

  // Tek satış yenilemesi. Cevap kopsa da sunucu işi bitirir; status ile sonucu alırız.
  const since = Math.floor(Date.now() / 1000) - 3;
  const refreshUrl =
    "https://kuponstore.com/api/extension/yemeksepeti/preLoginRefresh.php?token=" +
    encodeURIComponent(shortToken || "") +
    (opts?.skipVolo ? "&skip_volo=1" : "") +
    (opts?.forceAndroid ? "&force=1" : "");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    const vpsResp = await fetch(refreshUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        token: shortToken,
        prelogin: 1,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const vd = await vpsResp.json().catch(() => ({}));
    const packed = ysPack(vd, "vps-preLoginRefresh");
    if (packed) return packed;
    console.log(
      "[YS pre-login] VPS token yok",
      vpsResp.status,
      vd?.error || vd?.pending || vd?.version || "",
    );
    if (vd?.error === "sale_refresh_bos") return null;
  } catch (e) {
    console.log("[YS pre-login] VPS fallback hata:", e?.message);
  }

  if (shortToken) {
    const statusUrl =
      refreshUrl + "&status=1&since=" + encodeURIComponent(String(since));
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const r = await fetch(statusUrl, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        const rd = await r.json().catch(() => ({}));
        if (rd?.pending) continue;
        const packed = ysPack(rd, "vps-preLoginRefresh-status");
        if (packed) return packed;
        if (rd && rd.pending === false) break;
      } catch (_) {}
    }
    console.log("[YS pre-login] status beklerken token gelmedi");
  }

  return null;
}

/**
 * Sync address to Yemeksepeti
 * Önce mevcut adresleri siler, sonra yeni adresi ekler.
 * POST customers/addresses?locale=tr_TR + x-fp-api-key: volo
 */
async function syncYemeksepetiAddress(address, cookies, apiData = {}) {
  try {
    if (!address) {
      console.warn("[YS Address] Adres yok, atlanıyor");
      return;
    }

    // Token öncelik sırası (referans gibi):
    // 1. API response'dan web_access_token (volo — adres API için doğru)
    // 2. Cookie array'den access_token / token
    // 3. chrome.cookies'den (fallback)
    let bearer = apiData.web_access_token || "";
    if (!bearer) bearer = apiData.mobile_access_token || "";
    if (!bearer) bearer = ysBearerToken(cookies);
    if (!bearer) {
      // Cookie'lerin yazılması için kısa bekle
      await new Promise((r) => setTimeout(r, 1500));
      const ck = await chrome.cookies
        .get({ url: "https://www.yemeksepeti.com", name: "access_token" })
        .catch(() => null);
      bearer = ck?.value || "";
    }
    if (!bearer) {
      console.warn("[YS Address] Bearer token bulunamadı, atlanıyor");
      return;
    }
    console.log(
      "[YS Address] Token kaynağı:",
      apiData.web_access_token ? "web_access_token" : "cookie",
    );

    // Guest token kontrolü
    try {
      const pay = JSON.parse(atob(bearer.split(".")[1]));
      if (!pay.user_id || pay.user_id === "null") {
        console.warn("[YS Address] Guest token, adres eklenmedi");
        return;
      }
    } catch (_) {}

    let fpKey = "volo";
    try {
      const pay = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (pay.client_id === "android") fpKey = "android";
    } catch (_) {}

    const addrHeaders = {
      authorization: `Bearer ${bearer}`,
      accept: "application/json",
      "content-type": "application/json;charset=UTF-8",
      "x-pd-language-id": "2",
      "x-fp-api-key": fpKey,
      host: "tr.fd-api.com",
      connection: "keep-alive",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    };

    // ── 1. Mevcut adresleri sil (referans deleteExistingAddresses) ───────────
    console.log("[YS Address] Mevcut adresler kontrol ediliyor...");
    try {
      const listResp = await fetch(
        "https://tr.fd-api.com/api/v5/customers/addresses",
        {
          method: "GET",
          headers: addrHeaders,
        },
      );
      if (listResp.ok) {
        const listData = await listResp.json().catch(() => ({}));
        const existing = listData?.data?.items || listData?.data || [];
        if (Array.isArray(existing) && existing.length > 0) {
          console.log(
            `[YS Address] ${existing.length} mevcut adres siliniyor...`,
          );
          for (const addr of existing) {
            const id = addr.id || addr.address_id;
            if (!id) continue;
            await fetch(
              `https://tr.fd-api.com/api/v5/customers/addresses/${id}`,
              {
                method: "DELETE",
                headers: addrHeaders,
              },
            ).catch(() => {});
            // Rate limit için kısa bekleme
            await new Promise((r) => setTimeout(r, 50));
          }
          console.log("[YS Address] ✅ Mevcut adresler silindi");
        } else {
          console.log("[YS Address] Silinecek adres yok");
        }
      }
    } catch (e) {
      console.warn("[YS Address] Adres silme hatası (devam):", e.message);
      ksTrack("address.delete.failed", {
        platform: "yemeksepeti",
        success: false,
        error_message: (e?.message || "").slice(0, 500),
      });
    }

    // ── 2. Yeni adres ekle (referans autoAddAddress) ─────────────────────────
    const province = (address.province || address.city || "").trim();
    const neighborhood = (address.neighborhood || address.areas || "").trim();
    const street = (address.street || address.address_line1 || "").trim();
    const building = (address.building || address.address_line2 || "").trim();
    const district = (address.district || address.address_line4 || "").trim();
    const entrance = (address.apartment || address.entrance || "1").trim();
    const floor = (address.floor || "1").trim();
    const lat = parseFloat(address.latitude ?? address.lat ?? 0);
    const lng = parseFloat(address.longitude ?? address.lng ?? 0);
    const cityId =
      parseInt(address.cityId || address.city_id || 0, 10) ||
      ysProvinceToCityId(province);
    const formId =
      address.form_id || "mi" + Math.random().toString(36).substring(2, 10);
    const formatted =
      address.formatted_customer_address ||
      `${neighborhood}, ${street}, ${building}, ${district} ${province}`
        .replace(/\s+/g, " ")
        .trim();

    const body = {
      city_id: cityId,
      city: province,
      city_name: province,
      areas: neighborhood,
      address_line1: street,
      address_line2: building,
      address_line3: neighborhood,
      address_line4: district,
      building,
      entrance,
      floor,
      postcode: (address.postcode || "").trim(),
      meta: address.meta || '{"provider":"google"}',
      longitude: lng,
      latitude: lat,
      delivery_instructions: (
        address.delivery_instructions ||
        address.description ||
        ""
      ).trim(),
      formatted_customer_address: formatted,
      form_id: formId,
      country_code: address.country_code || "TR",
      location_type: address.location_type || "polygon",
      object_type: "new address",
      place_id: (address.place_id || "").trim(),
      type: address.type || "0",
      // phone_number eklenmez — hesap oluşturulurken zaten telefon kaydediliyor
      street,
      flat_number: entrance,
    };

    console.log("[YS Address] Yeni adres ekleniyor...");
    const response = await fetch(
      "https://tr.fd-api.com/api/v5/customers/addresses?locale=tr_TR",
      {
        method: "POST",
        headers: addrHeaders,
        body: JSON.stringify(body),
      },
    );

    let result = {};
    try {
      result = await response.json();
    } catch (_) {}

    if (response.ok) {
      await logManager.addLog("success", "Yemeksepeti adres eklendi");
      console.log(
        "[YS Address] ✅ Adres eklendi, ID:",
        result?.data?.id || "?",
      );
    } else {
      console.warn(
        "[YS Address] Adres ekleme hatası:",
        response.status,
        result?.message || "",
      );
      await logManager.addLog(
        "warning",
        `YS adres eklenemedi: ${response.status}`,
      );
      ksTrack("address.add.failed", {
        platform: "yemeksepeti",
        success: false,
        error_code: String(response.status),
        error_message: (result?.message || "").slice(0, 500),
      });
    }
  } catch (error) {
    console.error("[YS Address] syncYemeksepetiAddress hatası:", error.message);
    ksTrack("address.sync.failed", {
      platform: "yemeksepeti",
      success: false,
      error_message: (error?.message || "").slice(0, 500),
    });
  }
}

/**
 * Sync address to Hepsiburada
 */
async function syncHepsiburadaAddress(address, cookies) {
  try {
    const authCookie = cookies.find((c) => c.name === "access_token");
    if (!authCookie) {
      throw new Error("Hepsiburada auth cookie not found");
    }

    const addressData = {
      title: address.label || "Ev",
      fullName: address.fullname || "",
      phone: address.phone || "",
      address: `${address.street || ""} ${address.building || ""}`.trim(),
      district: address.neighborhood || "",
      latitude: address.lat || 0,
      longitude: address.lng || 0,
    };

    const response = await fetch(
      "https://customer-gw.hepsiburada.com/api/addresses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authCookie.value}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(addressData),
      },
    );

    if (response.ok) {
      await logManager.addLog("success", "Hepsiburada adres eklendi");
    } else {
      throw new Error(`Hepsiburada API error: ${response.status}`);
    }
  } catch (error) {
    console.error("Hepsiburada address sync error:", error);
    ksTrack("address.sync.failed", {
      platform: "hepsiburada",
      success: false,
      error_message: (error?.message || "").slice(0, 500),
    });
    throw error;
  }
}

/**
 * Handle set cookies
 */
async function handleSetCookies(data) {
  const { cookies, url } = data;

  for (const cookie of cookies) {
    await chrome.cookies.set({
      url,
      ...cookie,
    });
  }

  return { success: true };
}

/**
 * Handle get cookies
 */
async function handleGetCookies(data) {
  const { url, name } = data;

  if (name) {
    const cookie = await chrome.cookies.get({ url, name });
    return { success: true, cookie };
  } else {
    const cookies = await chrome.cookies.getAll({ url });
    return { success: true, cookies };
  }
}

/**
 * Clear site data
 */
async function handleClearSiteData(data) {
  const { origins } = data;
  const result = await clearSiteData(origins);
  return { success: result };
}

// ═══════════════════════════════════════════════════════════════════
// Site Verilerini Temizleme Sistemi
// browsingData API + cookie tek tek silme + tab içi cleanup fallback
// ═══════════════════════════════════════════════════════════════════

function _getCleanupBaseDomain(domain) {
  const normalized = String(domain || "").replace(/^\.+/, "").trim().toLowerCase();
  const parts = normalized.split(".").filter(Boolean);
  if (parts.length <= 2) return normalized;
  const compoundSuffixes = new Set(["com.tr", "net.tr", "org.tr", "co.uk", "org.uk", "com.au"]);
  const tail = parts.slice(-2).join(".");
  if (compoundSuffixes.has(tail) && parts.length >= 3) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

function _getCleanupUrlPatterns(domainList) {
  const patterns = new Set();
  domainList.forEach((d) => {
    const n = String(d || "").replace(/^\.+/, "").trim().toLowerCase();
    if (n) patterns.add("*://" + n + "/*");
  });
  return Array.from(patterns);
}

async function _getAllCookiesCompat(filter, timeoutMs) {
  const api = chrome?.cookies;
  if (!api || typeof api.getAll !== "function") return [];
  return new Promise((resolve) => {
    let settled = false;
    const tid = setTimeout(() => finish([]), Math.max(500, timeoutMs || 5000));
    const finish = (items) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      resolve(Array.isArray(items) ? items : []);
    };
    try {
      const r = api.getAll(filter, (items) => {
        try { if (chrome.runtime?.lastError) { finish([]); return; } } catch (_) {}
        finish(items);
      });
      if (r && typeof r.then === "function") r.then(finish, () => finish([]));
    } catch (_) {
      try {
        const r2 = api.getAll(filter);
        if (r2 && typeof r2.then === "function") r2.then(finish, () => finish([]));
        else finish([]);
      } catch (_) { finish([]); }
    }
  });
}

function _getCookieRemovalHosts(cookie, fallbackDomain) {
  const hosts = new Set();
  const raw = String(cookie?.domain || fallbackDomain || "").replace(/^\.+/, "").trim().toLowerCase();
  if (!raw) return [];
  hosts.add(raw);
  hosts.add("." + raw);
  const www = "www." + raw;
  hosts.add(www);
  return Array.from(hosts);
}

async function _removeCookieCompat(details, timeoutMs) {
  const api = chrome?.cookies;
  if (!api || typeof api.remove !== "function") throw new Error("Cookies API yok");
  return new Promise((resolve, reject) => {
    let settled = false;
    const tid = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, Math.max(250, timeoutMs || 2000));
    const finish = (v, e) => { if (settled) return; settled = true; clearTimeout(tid); if (e) reject(e); else resolve(v || null); };
    try {
      const r = api.remove(details, (removed) => {
        let le = null;
        try { le = chrome.runtime?.lastError; } catch (_) {}
        if (le) { finish(null, new Error(le.message || String(le))); return; }
        finish({ completed: true, matched: removed !== null, value: removed });
      });
      if (r && typeof r.then === "function") {
        r.then((rm) => finish({ completed: true, matched: rm !== null, value: rm }), (e) => finish(null, e));
      }
    } catch (e) {
      try {
        const r2 = api.remove(details);
        if (r2 && typeof r2.then === "function") {
          r2.then((rm) => finish({ completed: true, matched: rm !== null, value: rm }), (e2) => finish(null, e2));
        } else finish(null, e);
      } catch (e2) { finish(null, e2 || e); }
    }
  });
}

async function _removeCookieWithCandidates(cookie, fallbackDomain) {
  const hosts = _getCookieRemovalHosts(cookie, fallbackDomain);
  const secure = cookie?.secure === true;
  const schemes = secure ? ["https", "http"] : ["http", "https"];
  let lastError = null;
  for (const host of hosts) {
    for (const scheme of schemes) {
      const url = scheme + "://" + host.replace(/^\./, "") + (cookie?.path || "/");
      const details = { url, name: cookie?.name };
      if (cookie?.storeId) details.storeId = cookie.storeId;
      try {
        const r = await _removeCookieCompat(details);
        if (r && r.completed && r.matched) return { success: true, details };
      } catch (e) { lastError = e; }
      // storeId olmadan tekrar dene
      if (details.storeId) {
        try {
          const r2 = await _removeCookieCompat({ url, name: cookie?.name });
          if (r2 && r2.completed && r2.matched) return { success: true, details: { url, name: cookie?.name } };
        } catch (e) { lastError = e; }
      }
    }
  }
  return { success: false, error: lastError?.message || "Cookie silinemedi" };
}

async function _removeAllCookiesForDomain(baseDomain) {
  const cookies = await _getAllCookiesCompat({ domain: baseDomain });
  if (!cookies.length) return { success: true, count: 0 };
  const results = await Promise.all(cookies.map(async (c) => {
    // _px cookie'leri koru (PerimeterX bot koruması)
    if (String(c.name || "").startsWith("_px")) return { success: true, protected: true };
    return _removeCookieWithCandidates(c, baseDomain);
  }));
  const failed = results.filter((r) => r.success !== true);
  return { success: failed.length === 0, count: results.length - failed.length, total: results.length };
}

async function _executeSiteCleanupInTab(tabId) {
  const cleanupFn = async () => {
    const summary = { ls: false, ss: false, idb: false, cs: false, sw: false, errors: [] };
    try { localStorage.clear(); summary.ls = true; } catch (e) { summary.errors.push("ls:" + e.message); }
    try { sessionStorage.clear(); summary.ss = true; } catch (e) { summary.errors.push("ss:" + e.message); }
    try {
      if (self.indexedDB && typeof indexedDB.databases === "function") {
        const dbs = await indexedDB.databases();
        await Promise.allSettled((dbs || []).filter((d) => d?.name).map((d) =>
          new Promise((r) => { const req = indexedDB.deleteDatabase(d.name); req.onsuccess = req.onerror = req.onblocked = () => r(); })
        ));
        summary.idb = true;
      }
    } catch (e) { summary.errors.push("idb:" + e.message); }
    try {
      if (self.caches && typeof self.caches.keys === "function") {
        const names = await self.caches.keys();
        await Promise.allSettled(names.map((n) => self.caches.delete(n)));
        summary.cs = true;
      }
    } catch (e) { summary.errors.push("cs:" + e.message); }
    try {
      if (navigator.serviceWorker && typeof navigator.serviceWorker.getRegistrations === "function") {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.allSettled(regs.map((r) => r.unregister()));
        summary.sw = true;
      }
    } catch (e) { summary.errors.push("sw:" + e.message); }
    return summary;
  };
  try {
    return await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: cleanupFn,
      args: [],
    });
  } catch (e) {
    console.warn("[ClearSiteData] scripting.executeScript hata:", e?.message);
    return null;
  }
}

async function clearSiteData(domains) {
  const domainList = (Array.isArray(domains) ? domains : [domains])
    .map((d) => String(d || "").replace(/^https?:\/\//, "").replace(/^\.+/, "").replace(/\/.*$/, "").trim().toLowerCase())
    .filter(Boolean);
  if (!domainList.length) return true;
  const label = domainList.join(", ");
  console.log("[ClearSiteData] Başlatılıyor:", label);

  const baseDomains = Array.from(new Set(domainList.map(_getCleanupBaseDomain).filter(Boolean)));
  const urlPatterns = _getCleanupUrlPatterns(domainList);
  let overallSuccess = true;

  // AŞAMA 1: Tüm cookie'leri tek tek sil (subdomain dahil)
  try {
    const cookieResults = await Promise.allSettled(
      baseDomains.map((bd) => _removeAllCookiesForDomain(bd))
    );
    const cookieOk = cookieResults.every((r) => r.status === "fulfilled" && r.value?.success !== false);
    console.log("[ClearSiteData] Cookies:", cookieOk ? "✅" : "⚠️", baseDomains.join(", "));
    if (!cookieOk) overallSuccess = false;
  } catch (e) {
    console.warn("[ClearSiteData] Cookie silme hata:", e?.message);
    overallSuccess = false;
  }

  // AŞAMA 2: browsingData API ile origin-bazlı temizlik (IndexedDB + localStorage)
  for (const domain of domainList) {
    const origin = "https://" + domain;
    try {
      await chrome.browsingData.remove(
        { origins: [origin] },
        { localStorage: true, indexedDB: true }
      );
      console.log("[ClearSiteData] browsingData origin OK:", domain);
    } catch (e) {
      console.warn("[ClearSiteData] browsingData origin hata:", domain, e?.message);
      // Fallback: global browsingData (tüm siteler etkilenir ama en azından temizlenir)
      try {
        await chrome.browsingData.remove({}, { indexedDB: true });
        console.log("[ClearSiteData] browsingData global IDB fallback OK");
      } catch (_) {}
    }
  }

  // AŞAMA 3: Tab-içi cleanup (localStorage, sessionStorage, IndexedDB, CacheStorage, SW)
  try {
    const tabs = urlPatterns.length > 0
      ? await chrome.tabs.query({ url: urlPatterns })
      : [];
    const uniqueTabs = Array.from(new Map((tabs || []).map((t) => [t.id, t])).values());
    if (uniqueTabs.length > 0) {
      const tabResults = await Promise.allSettled(
        uniqueTabs.map((t) => _executeSiteCleanupInTab(t.id))
      );
      const tabOk = tabResults.every((r) => r.status === "fulfilled");
      console.log("[ClearSiteData] Tab cleanup:", tabOk ? "✅" : "⚠️", uniqueTabs.length, "tab");
    } else {
      console.log("[ClearSiteData] Açık sekme bulunamadı, tab cleanup atlandı:", label);
    }
  } catch (e) {
    console.warn("[ClearSiteData] Tab cleanup hata:", e?.message);
  }

  console.log("[ClearSiteData] Tamamlandı:", label, overallSuccess ? "✅" : "⚠️ kısmi");
  return overallSuccess;
}

/**
 * Handle proxy request (for CORS bypass)
 */
// : ysVoucherMap (background state) + calculate cache
let ysVoucherMap = {};
let ysLastCalculateResponseData = null;

/**
 * YemekSepeti API Proxy — :
 * - calculate: kuponlu → client-side _applyVoucherToResponse (sunucuya gitme)
 * - calculate: kuponsuz → sunucuya git, cache'le
 * - checkout/purchase: tam android headers + R-Sig
 */
async function handleYsProxyRequest(request) {
  const { url, method = "POST", body, headers: reqHeaders = {} } = request;
  const endpointLabel = (url || "").split("?")[0].split("/").pop();

  // ── CALCULATE — calculate ─────────────────────────────────────
  if (url && url.includes("cart/calculate")) {
    const calcToken = await ysGetAndroidToken();

    const calcBody = (() => {
      try {
        return JSON.parse(body || "{}");
      } catch (_) {
        return {};
      }
    })();
    const calcVoucher = (calcBody.voucher || "").trim();

    // Ürün parmak izi (cache geçerli mi?)
    const fingerprint = (prods) => {
      if (!Array.isArray(prods)) return "";
      return prods
        .map((p) => {
          const tops = (p.toppings || [])
            .map((t) => `${t.id}:${t.quantity || 1}`)
            .sort()
            .join(",");
          return `${p.id}|${p.variation_id || ""}|${p.quantity || 1}|${tops}`;
        })
        .sort()
        .join(";");
    };

    // Kuponsuz → sunucuya git, cache'le (tam android headers + R-Sig — rakip gibi)
    const sendCalcToServer = async (reqBody) => {
      const calcDevice = generateYsRandomDevice(reqHeaders);
      const calcAppVersion = "25.27.0";
      const calcBuild = "252700274";
      const calcCustCode = parseCustCodeFromToken(calcToken);
      const calcBodyStr =
        typeof reqBody === "string" ? reqBody : JSON.stringify(reqBody);
      const calcRSig = await generateYsRSig(
        calcDevice.deviceId,
        url,
        calcBodyStr,
        calcCustCode,
      );
      const calcSentry = generateYsSentryTrace();
      const calcBaggage = generateYsBaggageV2(
        calcSentry.traceId,
        calcAppVersion,
        calcBuild,
        "sm_CartFragment",
      );
      const calcAndroidVer = String(calcDevice.platformVersion - 19);
      const calcEmReqId = randomUUID();
      const calcPxFp = generateYsPxDeviceFp();
      const calcPxVid = randomUUID();
      const calcPxUuid = randomUUID();
      // x-token varsa onu kullan (rakip ys.js: x-px-original-token = getAccessTokenX())
      const calcXTokenCk = await new Promise((r) =>
        chrome.cookies.get(
          { url: "https://www.yemeksepeti.com", name: "x-token" },
          r,
        ),
      );
      const calcPxOrig = calcXTokenCk?.value || generateYsPxOriginalToken();
      const calcPerfClass = generateYsDevicePerfClass();

      // Inject'ten gelen taze Perseus ID varsa kullan, yoksa header'dan al
      const calcPC = reqHeaders["Perseus-Client-Id"] || "";
      const calcPS = reqHeaders["Perseus-Session-Id"] || "";
      const calcDps = reqHeaders["Dps-Session-Id"] || "";

      const h = {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json; charset=UTF-8",
        Authorization: calcToken ? `Bearer ${calcToken}` : undefined,
        "X-Pd-Language-Id": "2",
        Host: "tr.fd-api.com",
        Connection: "keep-alive",
        "Api-Client-Version": "5.0",
        "App-Name": "com.inovel.app.yemeksepeti",
        "App-Flavor": "yemeksepeti",
        "Build-Type": "release",
        "Release-Lane": "production",
        Platform: "android",
        "Platform-Version": "30", // Rakip sabit "30" kullanıyor
        "Build-Number": calcBuild,
        "App-Build": calcBuild,
        "App-Version": calcAppVersion,
        "Android-Mobile-Service-Provider": "gms",
        "Adjust-Ad-Id": randomUUID(),
        "X-Px-Vid": calcPxVid,
        "X-Px-Os-Version": calcAndroidVer,
        "X-Px-Uuid": calcPxUuid,
        "X-Px-Device-Fp": calcPxFp,
        "X-Px-Device-Model": calcDevice.deviceModel,
        "X-Px-Os": "Android",
        "X-Px-Mobile-Sdk-Version": "3.3.3",
        "X-Px-Authorization": "4",
        "X-Px-Original-Token": calcPxOrig,
        "Device-Performance-Class": calcPerfClass,
        "Device-Make": calcDevice.deviceMake,
        "Device-Model": calcDevice.deviceModel,
        "Device-Id": calcDevice.deviceId,
        "X-Fp-Api-Key": "android",
        Eks: calcRSig.eks,
        "User-Agent": `Android-app-${calcAppVersion}(${calcBuild})`,
        "Cust-Code": calcCustCode,
        "Perseus-Client-Id": calcPC,
        "Perseus-Session-Id": calcPS,
        "Dps-Session-Id": calcDps,
        "Sentry-Trace": calcSentry.sentryTrace,
        Baggage: calcBaggage,
        "Em-Request-Identifier": calcEmReqId,
        "R-Sig": calcRSig.signature,
        Rts: calcRSig.rts,
        Ruid: calcRSig.ruid,
        "X-Okcronet-Trace": "cartCalculate",
        "X-Okcronet-Priority": "high",
      };
      if (!h["Authorization"]) delete h["Authorization"];

      const resp = await fetch(url, {
        method: "POST",
        headers: h,
        body: typeof reqBody === "string" ? reqBody : JSON.stringify(reqBody),
      });
      const data = await resp.text().catch(() => "");
      return { status: resp.status, data };
    };

    // voucher yanıtı: cache'e kupon indirimini uygula
    const applyVoucher = (baseData, code, discount) => {
      const resp = JSON.parse(baseData);
      const subtotal = resp?.payment?.discounted_subtotal || 0;
      const actual = Math.min(discount, subtotal);
      const oldTotal = resp?.payment?.payable_total || 0;
      if (resp.payment) {
        resp.payment.payable_total = parseFloat((oldTotal - actual).toFixed(2));
        resp.payment.total_savings = parseFloat(
          ((resp.payment.total_savings || 0) + actual).toFixed(2),
        );
        resp.payment.payable_total_without_voucher = parseFloat(
          oldTotal.toFixed(2),
        );
      }
      if (resp.payment_limits) {
        const newTotal = resp.payment?.payable_total || 0;
        resp.payment_limits = resp.payment_limits.map((l) => {
          if (l.limit_code === "foodafterdiscount")
            return {
              ...l,
              limit_amount: parseFloat((subtotal - actual).toFixed(2)),
            };
          if (l.limit_code === "orderamountwithoutpaymentfee")
            return { ...l, limit_amount: parseFloat(newTotal.toFixed(2)) };
          return l;
        });
      }
      resp.voucher = {
        percentage: null,
        construct_id: null,
        voucher_type: "amount",
        type: "amount",
        end_date: "",
        description: `${actual} TL indirim kazandınız!`,
        code,
        banned_products: [],
        amount: actual,
        value: actual,
        is_pro_voucher: false,
        applied: actual > 0,
      };
      return JSON.stringify(resp);
    };

    if (calcVoucher !== "") {
      const vInfo = ysVoucherMap[calcVoucher.toLowerCase()];

      // Kupon map'te yok → sunucuya kuponlu gönder
      if (!vInfo) {
        try {
          const { status, data } = await sendCalcToServer(body);
          return {
            success: true,
            status,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            data,
          };
        } catch (e) {
          return { success: false, error: e.message, headers: {}, data: "" };
        }
      }

      const voucherDiscount = vInfo.discount || 0;

      // Cache var mı ve ürünler aynı mı?
      let useCache = false;
      if (ysLastCalculateResponseData) {
        try {
          const cached = JSON.parse(ysLastCalculateResponseData);
          const cProds = cached.products || [];
          const rProds = calcBody.products || [];
          useCache =
            fingerprint(
              cProds.map((p) => ({
                id: p.id,
                variation_id: p.variation_id,
                quantity: p.quantity,
                toppings: p.toppings,
              })),
            ) === fingerprint(rProds);
        } catch (_) {}
      }

      if (useCache) {
        // Cache var, ürünler aynı → sunucuya gitme, client-side hesapla ✅
        try {
          const applied = applyVoucher(
            ysLastCalculateResponseData,
            calcVoucher,
            voucherDiscount,
          );
          console.log(
            "[BG YS] Kuponlu calculate → cache + client-side ✅",
            calcVoucher,
            "-",
            voucherDiscount,
            "TL",
          );
          return {
            success: true,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            data: applied,
          };
        } catch (_) {
          return {
            success: true,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            data: ysLastCalculateResponseData,
          };
        }
      }

      // Ürünler değişti → kuponu sil, sunucuya gönder, cache güncelle
      delete calcBody.voucher;
      delete calcBody.voucher_context;
      try {
        const { status, data } = await sendCalcToServer(
          JSON.stringify(calcBody),
        );
        if (status === 200 && data) ysLastCalculateResponseData = data;
        let applied = data;
        if (status === 200 && data) {
          try {
            applied = applyVoucher(data, calcVoucher, voucherDiscount);
          } catch (_) {}
        }
        console.log(
          "[BG YS] Kuponlu calculate → sunucu + client-side ✅",
          calcVoucher,
        );
        return {
          success: true,
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          data: applied,
        };
      } catch (e) {
        if (ysLastCalculateResponseData) {
          try {
            return {
              success: true,
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
              data: applyVoucher(
                ysLastCalculateResponseData,
                calcVoucher,
                voucherDiscount,
              ),
            };
          } catch (_) {}
          return {
            success: true,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            data: ysLastCalculateResponseData,
          };
        }
        return { success: false, error: e.message, headers: {}, data: "" };
      }
    }

    // Kuponsuz calculate → sunucuya git, cache'le
    try {
      const { status, data } = await sendCalcToServer(body);
      if (status === 200 && data) ysLastCalculateResponseData = data;
      console.log("[BG YS] Kuponsuz calculate → sunucu ✅", status);
      return {
        success: true,
        status,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        data,
      };
    } catch (e) {
      return { success: false, error: e.message, headers: {}, data: "" };
    }
  }

  // ── CHECKOUT / PURCHASE — tam android headers + R-Sig ─────────────────────
  try {
    // Android token — checkout/purchase için (android_token öncelikli)
    const token = await ysGetAndroidToken();
    // x-token (accessTokenX) — rakip ys.js'de x-px-original-token'a gönderiliyor
    const ckResultX = await new Promise((resolve) =>
      chrome.cookies.get(
        { url: "https://www.yemeksepeti.com", name: "x-token" },
        resolve,
      ),
    );
    const tokenX = ckResultX?.value || "";
    const hasVoucher = false;

    console.log("[BG YS Proxy]", endpointLabel, method, {
      hasToken: !!token,
      hasTokenX: !!tokenX,
    });

    // Rastgele cihaz + versiyon (session-stable; inject header varsa onu kullan)
    const device = generateYsRandomDevice(reqHeaders);
    const appVersion = "25.27.0";
    const buildNumber = "252700274";

    // Body manipülasyonu — platform=android, source=android + expected_total güncelle
    let finalBody = body;
    if (finalBody && typeof finalBody === "string") {
      try {
        const rb = JSON.parse(finalBody);
        if (rb.platform === "b2c" || rb.platform === "web" || !rb.platform)
          rb.platform = `Android-app-${appVersion}(${buildNumber})`;
        rb.source = "android";
        // Kart, sayfanın açtığı purchase intent'e bağlı. Yeni intent üretmek
        // kartı düşürür ve ödeme "reddedildi" döner. Intent
        // kimliği değiştirilmez.
        finalBody = JSON.stringify(rb);
      } catch (_) {}
    }

    // R-Sig (finalBody hazır olduktan sonra üret)
    const checkoutEks = /cart\/checkout|purchase\/intent/.test(url || "")
      ? "mnpaaa"
      : "";
    const rSigData = await generateYsRSig(
      device.deviceId,
      url,
      finalBody || body || "",
      parseCustCodeFromToken(token),
      checkoutEks,
    );
    const sentryData = generateYsSentryTrace();
    const txLabel = url.includes("/cart/checkout")
      ? "sm_CheckoutFragment"
      : "sm_CartFragment";
    const baggageV2 = generateYsBaggageV2(
      sentryData.traceId,
      appVersion,
      buildNumber,
      txLabel,
    );
    const pxOrigToken = tokenX || generateYsPxOriginalToken();
    const pxDeviceFp = generateYsPxDeviceFp();
    const perfClass = generateYsDevicePerfClass();
    const adjustAdId = randomUUID();
    const pxVid = randomUUID();
    const pxUuid = randomUUID();
    const custCode = parseCustCodeFromToken(token);
    const androidVer = String(device.platformVersion - 19);
    const emReqId = randomUUID();

    // Android context: tam header seti (referans gibi) — checkout/purchase için
    const headers = {
      Authorization: `Bearer ${token}`,
      "X-Pd-Language-Id": "2",
      Host: "tr.fd-api.com",
      Connection: "keep-alive",
      "Api-Client-Version": "5.0",
      "App-Name": "com.inovel.app.yemeksepeti",
      "App-Flavor": "yemeksepeti",
      "Build-Type": "release",
      Platform: "android",
      "Platform-Version": "30", // Rakip ys.js: calculate/checkout için sabit '30'
      "Build-Number": buildNumber,
      "App-Build": buildNumber,
      "App-Version": appVersion,
      "Android-Mobile-Service-Provider": "gms",
      "Adjust-Ad-Id": adjustAdId,
      "X-Px-Vid": pxVid,
      "X-Px-Os-Version": androidVer,
      "X-Px-Uuid": pxUuid,
      "X-Px-Device-Fp": pxDeviceFp,
      "X-Px-Device-Model": device.deviceModel,
      "X-Px-Os": "Android",
      "X-Px-Mobile-Sdk-Version": "3.3.3",
      "X-Px-Original-Token": pxOrigToken,
      "Device-Performance-Class": perfClass,
      "Device-Make": device.deviceMake,
      "Device-Model": device.deviceModel,
      "Device-Id": device.deviceId,
      "X-Fp-Api-Key": "android",
      Eks: rSigData.eks,
      "User-Agent": `Android-app-${appVersion}(${buildNumber})`,
      "Content-Type": "application/json; charset=UTF-8",
      "Cust-Code": custCode,
      "Sentry-Trace": sentryData.sentryTrace,
      Baggage: baggageV2,
      "Em-Request-Identifier": emReqId,
      "R-Sig": rSigData.signature,
      Rts: rSigData.rts,
      Ruid: rSigData.ruid,
    };

    // Endpoint bazlı okcronet header + checkout'a X-Px-Request-Id ekle (rakip gibi)
    if (url.includes("/cart/calculate")) {
      headers["X-Okcronet-Trace"] = "cartCalculate";
      headers["X-Okcronet-Priority"] = "high";
    } else if (url.includes("/cart/checkout")) {
      headers["X-Okcronet-Trace"] = "cartCheckout";
      headers["X-Okcronet-Priority"] = "high";
    } else if (url.includes("/purchase/intent")) {
      headers["X-Okcronet-Trace"] = "purchaseIntent";
      headers["X-Okcronet-Priority"] = "high";
    } else if (url.includes("/incentives")) {
      headers["X-Okcronet-Trace"] = "incentives";
      headers["X-Okcronet-Priority"] = "high";
    }

    // Perseus/DPS — oturum boyunca sabit. Her istekte yeni ID = PX bot sinyali.
    if (reqHeaders["Perseus-Client-Id"])
      headers["Perseus-Client-Id"] = reqHeaders["Perseus-Client-Id"];
    if (reqHeaders["Perseus-Session-Id"])
      headers["Perseus-Session-Id"] = reqHeaders["Perseus-Session-Id"];
    if (reqHeaders["Dps-Session-Id"])
      headers["Dps-Session-Id"] = reqHeaders["Dps-Session-Id"];

    // Checkout + purchase/intent için PX cookie'lerini Cookie header'ına ekle (PX bypass)
    if (url.includes("/cart/checkout") || url.includes("/purchase/intent")) {
      const onlyPx = (raw) =>
        String(raw || "")
          .split("; ")
          .filter((part) => part.split("=")[0].startsWith("_px"))
          .join("; ");
      const fromPage = onlyPx(reqHeaders["_ks_enhanced_px"] || "");
      if (fromPage) {
        headers["Cookie"] = fromPage;
      } else {
        const pxCookies = await chrome.cookies
          .getAll({ domain: "yemeksepeti.com" })
          .catch(() => []);
        const pxAllParts = pxCookies
          .filter((c) => c.name.startsWith("_px"))
          .map((c) => `${c.name}=${c.value}`);
        if (pxAllParts.length > 0) headers["Cookie"] = pxAllParts.join("; ");
      }
    }

    // X-Reorder-Origin boş — Chrome implicit Origin suppress eder ()
    headers["X-Reorder-Origin"] = "";

    // Checkout + purchase/intent: android token expired ise VPS'ten yenile
    if (
      (url.includes("/cart/checkout") || url.includes("/purchase/intent")) &&
      token
    ) {
      try {
        // JWT payload decode (padding güvenli)
        const b64 = token.split(".")[1];
        const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
        const pay = JSON.parse(atob(b64 + pad));
        const exp = pay.expires || pay.exp;
        const isExpired = exp && exp < Math.floor(Date.now() / 1000);
        console.log(
          "[BG YS Proxy] Token exp:",
          new Date((exp || 0) * 1000).toISOString(),
          "Expired:",
          isExpired,
        );
        if (isExpired) {
          console.log(
            "[BG YS Proxy] Token expired, /mobileLogin ile yenileniyor...",
          );
          // Önce storage'dan email+password al
          const stored = await chrome.storage.local
            .get(["ysCurrentShortToken", "ysLoginEmail", "ysLoginPassword"])
            .catch(() => ({}));
          let freshAndroid = null;

          // Yöntem 1: Tarayıcıdan direkt YS API — password grant (tarayıcı gerçek ev IP'si)
          if (stored.ysLoginEmail && stored.ysLoginPassword) {
            try {
              const ysEmail = stored.ysLoginEmail;
              const ysPass = stored.ysLoginPassword;
              const C_ID = "android";
              const C_SEC =
                "Wc7bJUJZOTgjfB6gpWmfMwdoxx7ii2pzShEfgvX0iynLthP3aX";
              const YS_TOKEN_URL =
                "https://tr.fd-api.com/api/v5/oauth2/token?language_id=2";
              const androidBaseHeaders = {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Fp-Api-Key": "android",
                "X-Pd-Language-Id": "2",
                "User-Agent": "Android-app-25.27.0(252700274)",
                Accept: "application/json",
              };

              // ADIM 1: password grant
              const step1Body = `username=${encodeURIComponent(ysEmail)}&password=${encodeURIComponent(ysPass)}&grant_type=password&client_id=${C_ID}&client_secret=${C_SEC}&scope=API_CUSTOMER`;
              const s1 = await fetch(YS_TOKEN_URL, {
                method: "POST",
                headers: androidBaseHeaders,
                body: step1Body,
              });
              const s1Data = await s1.json().catch(() => ({}));
              const exType = s1Data?.data?.exception_type || "";
              const xDevice = s1.headers.get("x-device") || "";
              console.log(
                "[BG Android] ADIM1 ex:",
                exType,
                "xDevice:",
                !!xDevice,
              );

              if (s1Data?.access_token?.includes(".")) {
                freshAndroid = s1Data.access_token;
                console.log("[BG Android] ✅ Direkt token alındı");
              } else if (
                ["invalid_otp_method", "email_verification_required"].includes(
                  exType,
                )
              ) {
                // ADIM 2: OTP tetikle
                const otpH = {
                  ...androidBaseHeaders,
                  "Content-Type": "application/json",
                };
                if (xDevice) otpH["X-Device"] = xDevice;
                await fetch(
                  `https://tr.fd-api.com/api/v5/customers/verification/email?language_id=2`,
                  {
                    method: "POST",
                    headers: otpH,
                    body: JSON.stringify({ email: ysEmail }),
                  },
                ).catch(() => {});
                console.log(
                  "[BG Android] OTP tetiklendi, VPS'ten OTP beklenecek...",
                );

                // ADIM 3+4: VPS'e OTP akışını tamamlamasını iste (OTP mail okuma + verification_code grant)
                if (stored.ysCurrentShortToken) {
                  const vpsOtpResp = await fetch(
                    `https://sunucu.kuponstore.com/getCookie.php?token=${stored.ysCurrentShortToken}&otp_triggered=1`,
                    {
                      method: "GET",
                    },
                  ).catch(() => null);
                  if (vpsOtpResp?.ok) {
                    const vpsOtpData = await vpsOtpResp
                      .json()
                      .catch(() => ({}));
                    freshAndroid = vpsOtpData.mobile_access_token || null;
                    if (freshAndroid)
                      console.log(
                        "[BG Android] ✅ VPS OTP akışı ile token alındı",
                      );
                  }
                }

                // VPS başarısız → verification_code'u biz alalım (getCookie bunu halleder)
                if (!freshAndroid && stored.ysCurrentShortToken) {
                  const ckResp = await fetch(
                    `https://sunucu.kuponstore.com/getCookie.php?token=${stored.ysCurrentShortToken}`,
                    { method: "GET" },
                  ).catch(() => null);
                  if (ckResp?.ok) {
                    const ckData = await ckResp.json().catch(() => ({}));
                    freshAndroid = ckData.mobile_access_token || null;
                    if (freshAndroid)
                      console.log(
                        "[BG Android] ✅ getCookie OTP akışı ile token alındı",
                      );
                  }
                }
              }
            } catch (e) {
              console.warn("[BG Android] hata:", e.message);
            }
          }

          // Yöntem 2: short_token ile getCookie (fallback)
          if (!freshAndroid && stored.ysCurrentShortToken) {
            try {
              const vpsResp = await fetch(
                `https://sunucu.kuponstore.com/getCookie.php?token=${stored.ysCurrentShortToken}`,
                { method: "GET" },
              );
              if (vpsResp.ok) {
                const vpsData = await vpsResp.json();
                freshAndroid = vpsData.mobile_access_token || null;
                if (freshAndroid)
                  console.log("[BG YS Proxy] ✅ getCookie ile token yenilendi");
              }
            } catch (_) {}
          }

          if (freshAndroid) {
            headers["Authorization"] = `Bearer ${freshAndroid}`;
            await chrome.cookies
              .set({
                url: "https://www.yemeksepeti.com",
                name: "access_token",
                value: freshAndroid,
                domain: ".yemeksepeti.com",
                path: "/",
                secure: true,
                httpOnly: false,
              })
              .catch(() => {});
            await chrome.cookies
              .set({
                url: "https://www.yemeksepeti.com",
                name: "android_token",
                value: freshAndroid,
                domain: ".yemeksepeti.com",
                path: "/",
                secure: true,
                httpOnly: false,
              })
              .catch(() => {});
          }
        }
      } catch (e) {
        console.warn("[BG YS Proxy] Token kontrol hatası:", e.message);
      }
    }

    console.log("[BG YS Proxy]", endpointLabel, method, {
      hasToken: !!token,
      rSig: !!rSigData.signature,
    });
    // Checkout için request headers'ı logla (debug)
    if (url.includes("/cart/checkout"))
      console.log(
        "[BG YS Proxy] checkout headers origin:",
        headers["Origin"],
        "x-fp-api-key:",
        headers["X-Fp-Api-Key"],
        "auth prefix:",
        headers["Authorization"]?.substring(0, 30),
      );

    // minimal fetch
    const fetchOptions = {
      method: method || "POST",
      headers,
      credentials: "omit",
    };
    if (finalBody && method !== "GET") fetchOptions.body = finalBody;

    let response = await fetch(url, fetchOptions);
    let data = await response.text();
    const responseHeaders = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    console.log("[BG YS Proxy] response:", response.status, endpointLabel);

    if (response.status === 403 && url.includes("/cart/checkout")) {
      console.log(
        "[BG YS Proxy] Checkout 403 — direkt sonuc donduruluyor (rakip gibi)",
      );
    }

    return {
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      requestHeaders: headers,
      data,
    };
  } catch (error) {
    console.error("[BG YS Proxy] hata:", error.message);
    return {
      success: false,
      error: error.message,
      status: 0,
      headers: {},
      data: "",
    };
  }
}

async function handleProxyRequest(data) {
  const { url, method = "GET", headers = {}, body } = data;

  try {
    const options = {
      method,
      headers,
    };

    if (body) {
      options.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const responseData = await response.text();

    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      success: true,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      data: responseData,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Uber proxy — istekleri kuponstore.com/api/extension/uber/proxy.php üzerinden iletir.
 * Böylece eklentinin gerçek Chrome JA3/IP fingerprint'i Uber'e ulaşmaz.
 */
/**
 * Uber proxy'den gelen Set-Cookie header'larını browser cookie store'a uygular.
 * cookieLines: ["name=value; Path=/; Secure; ...", ...]
 */
async function applySetCookiesToBrowser(targetUrl, cookieLines) {
  if (!cookieLines || !cookieLines.length) return;
  let host;
  try {
    host = new URL(targetUrl).hostname;
  } catch (_) {
    return;
  }

  for (const line of cookieLines) {
    try {
      const parts = line.split(";").map((p) => p.trim());
      const nameVal = parts[0];
      const eqIdx = nameVal.indexOf("=");
      if (eqIdx < 0) continue;
      const name = nameVal.substring(0, eqIdx).trim();
      const value = nameVal.substring(eqIdx + 1).trim();

      const cookieObj = {
        url: "https://" + host,
        name,
        value,
        path: "/",
        secure: true,
        sameSite: "no_restriction",
      };

      // expiry
      const expPart = parts.find((p) => /^expires=/i.test(p));
      if (expPart) {
        const d = new Date(expPart.replace(/^expires=/i, ""));
        if (!isNaN(d))
          cookieObj.expirationDate = Math.floor(d.getTime() / 1000);
      }

      // domain
      const domPart = parts.find((p) => /^domain=/i.test(p));
      if (domPart) cookieObj.domain = domPart.replace(/^domain=/i, "").trim();

      await chrome.cookies.set(cookieObj);
    } catch (_) {}
  }
}

/**
 * Verilen URL için browser cookie store'dan "name=value; ..." formatında
 * Cookie header string'i oluşturur.
 */
async function buildCookieHeaderForUrl(targetUrl) {
  try {
    const cookies = await chrome.cookies.getAll({ url: targetUrl });
    if (!cookies || !cookies.length) return null;
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (_) {
    return null;
  }
}

// KuponStore Uber Proxy
const UBER_PROXY_PRIMARY =
  "https://kuponstore.com/api/extension/uber/proxy.php";
const UBER_PROXY_API_KEY = "KS-uber-proxy-2025";
const UBER_IOS_UA_PROXY =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";

const UBER_UA_FALLBACK_SW =
  "Mozilla/5.0 (Linux; Android 15; Xiaomi 15 Build/AP3A.241105.008; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.219 Mobile Safari/537.36";

// TripRequest — kendi process motoru (Dodo/Dost forwarder YOK)
const TRIP_PROXY_URL =
  "https://kuponstore.com/api/extension/uber/trip-proxy.php";
const TRIP_PROXY_KEY = "KS-uber-trip-2026";
const FAKE_TRIP_SUCCESS_JSON =
  '{"data":{"tripRequest":{"uuid":"ok","__typename":"RVWebCommonTripRequest"}}}';
const FAKE_TRIP_PROCESSING_JSON =
  '{"data":{"tripRequest":{"uuid":"processing","__typename":"RVWebCommonTripRequest"}}}';

function buildTripSuccessJson(uuid) {
  const id = uuid && String(uuid).length > 4 ? String(uuid) : "ok";
  return JSON.stringify({
    data: { tripRequest: { uuid: id, __typename: "RVWebCommonTripRequest" } },
  });
}

// ─── Device Fingerprinting (APK Analysis) ──────────────────────────────────
// APK'dan çıkarılan device fingerprint pattern'leri: tutarlı device bilgileri
// Her Uber token için aynı device profile (bot detection bypass)
function simpleHash(str) {
  let hash = 0;
  if (!str) return hash;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function generateIosUdid(seed) {
  const hex = seed.toString(16).padStart(32, "0");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  ).toUpperCase();
}

function generateAndroidUuid(seed) {
  const hex = seed.toString(16).padStart(32, "0");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    "4" +
    hex.slice(13, 16) +
    "-" +
    "a" +
    hex.slice(17, 20) +
    "-" +
    hex.slice(20, 32)
  ).toLowerCase();
}

function generateDeviceProfile(uberToken) {
  const hash = simpleHash(String(uberToken || ""));
  const isIos = hash % 2 === 0;
  const deviceSeed = hash.toString(16).padStart(16, "0");

  if (isIos) {
    return {
      type: "ios",
      model: "iPhone 15 Pro",
      os: "iOS",
      osVersion: "18.0",
      deviceId: `iOS-${deviceSeed}`,
      udid: generateIosUdid(hash),
      language: "tr_TR",
      clientVersion: "4.528.10000",
      clientName: "client.web_funnel.iphone",
      screenWidth: "1179",
      screenHeight: "2556",
      lat: "41.0082",
      lon: "28.9784",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22A3354 RideClient/4.528.10000",
    };
  } else {
    return {
      type: "android",
      model: "Samsung Galaxy S24 Ultra",
      os: "Android",
      osVersion: "15",
      deviceId: `Android-${deviceSeed}`,
      udid: generateAndroidUuid(hash),
      language: "tr_TR",
      clientVersion: "4.528.10000",
      clientName: "client.web_funnel.android",
      screenWidth: "1440",
      screenHeight: "3120",
      lat: "41.0082",
      lon: "28.9784",
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; SM-S928B Build/AP3A.241105.008) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.219 Mobile Safari/537.36 RideClient/4.528.10000",
    };
  }
}

async function handleCreateCashProfile() {
  try {
    const ctx = JSON.stringify({ latitude: 41, longitude: 29 });
    const url =
      "https://payments.uber.com/api/paymentProfileCreate" +
      "?key=production_w0u8jzht15p89t0n" +
      "&ctx=" +
      encodeURIComponent(ctx) +
      "&localeCode=tr-TR";

    // Browser IP + Safari session cookies (credentials) — Android UA/CH yok
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Csrf-Token": "x",
        Origin: "https://m.uber.com",
        Referer: "https://m.uber.com/",
        Accept: "*/*",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
      },
      credentials: "include",
      body: JSON.stringify({
        body: { tokenType: "cash", tokenData: { useCase: "personal" } },
        headers: {},
        params: {},
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(
        "[KuponStore][Cash] HTTP",
        res.status,
        errText.substring(0, 200),
      );
      return { uuid: null };
    }

    const json = await res.json();
    if (json && json.status === "success" && json.data && json.data.uuid) {
      console.log("[KuponStore][Cash] Fresh cash profile:", json.data.uuid);
      return { uuid: json.data.uuid };
    }
    console.warn(
      "[KuponStore][Cash] Unexpected response:",
      JSON.stringify(json).substring(0, 200),
    );
    return { uuid: null };
  } catch (e) {
    console.warn("[KuponStore][Cash] Error:", e.message);
    return { uuid: null };
  }
}

/**
 * payment_error → taze cash UUID.
 * SADECE variables.payment (ve varsa variables.paymentProfileUUID).
 * meta string'ine DOKUNMA — fare quote bozulunca Uber fraud_error döner.
 */
function swapPaymentUuidInTripBody(bodyStr, newUuid) {
  if (!bodyStr || !newUuid) return bodyStr;
  try {
    const root = JSON.parse(bodyStr);
    const list = Array.isArray(root) ? root : [root];
    for (const req of list) {
      if (!req || typeof req !== "object" || !req.variables) continue;
      const pay = req.variables.payment;
      if (pay && typeof pay === "object") {
        pay.paymentProfileUUID = newUuid;
        pay.profileTokenType = "cash";
        if ("paymentMethodDisplayName" in pay)
          pay.paymentMethodDisplayName = "Nakit";
        delete pay.checkoutActionResult;
        delete pay.actionResults;
        delete pay.checkoutSessionUUID;
      }
      if (typeof req.variables.paymentProfileUUID === "string") {
        req.variables.paymentProfileUUID = newUuid;
      }
      // meta: bilinçli olarak değiştirilmez
    }
    return JSON.stringify(root);
  } catch (e) {
    console.warn("[KuponStore] payment UUID swap parse fail", e?.message || e);
    return bodyStr;
  }
}

function isPaymentErrorRaw(raw, errorCode) {
  const t = String(raw || "");
  const e = String(errorCode || "");
  return (
    e === "rtapi.riders.pickup.payment_error" ||
    e === "payment_error" ||
    /rtapi\.riders\.pickup\.payment_error|PAYMENT_PROFILE_ERROR|payment_error|128387/i.test(
      t,
    ) ||
    /"buttonkey"\s*:\s*"CHANGE"/i.test(t)
  );
}

function bodyContainsUberTripRequest(bodyText) {
  if (!bodyText || typeof bodyText !== "string") return false;
  return (
    /"operationName"\s*:\s*"TripRequest"/i.test(bodyText) ||
    /mutation\s+TripRequest\b/i.test(bodyText)
  );
}

function extractCityIdFromHeaders(headers) {
  if (!headers || typeof headers !== "object") return 0;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "x-uber-rv-initial-load-city-id") {
      return parseInt(headers[k]) || 0;
    }
  }
  return 0;
}

async function mergeUberCookies(fallbackCookieHeader) {
  const jar = {};
  const domains = [".uber.com", "uber.com", "www.uber.com", "m.uber.com"];
  for (const domain of domains) {
    try {
      const cs = await chrome.cookies.getAll({ domain });
      if (cs)
        cs.forEach((c) => {
          jar[c.name] = c.value;
        });
    } catch (_) {}
  }
  if (!jar.sid || !jar.csid) {
    try {
      const all = await chrome.cookies.getAll({});
      const uberOnly = (all || []).filter(
        (c) =>
          c &&
          c.domain &&
          (c.domain.endsWith("uber.com") || c.domain === ".uber.com"),
      );
      uberOnly.forEach((c) => {
        jar[c.name] = c.value;
      });
    } catch (_) {}
  }
  if (fallbackCookieHeader) {
    fallbackCookieHeader.split(";").forEach((pair) => {
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const k = pair.substring(0, eq).trim();
        const v = pair.substring(eq + 1).trim();
        if (!jar[k]) jar[k] = v;
      }
    });
  }
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Uber TripRequest yanıtını process kontratına çevir (ok / REMOVE_PROMO / TRIP_FRAUD / p).
 */
function analyzeLocalTripResponse(text, httpStatus) {
  const raw = typeof text === "string" ? text : "";
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch (_) {}

  const uuid =
    json?.data?.tripRequest?.uuid ||
    (typeof json?.data?.tripRequest === "object" &&
      json?.data?.tripRequest?.id) ||
    null;
  const uuidOk = !!(
    uuid &&
    typeof uuid === "string" &&
    uuid.length > 4 &&
    !["ok", "processing"].includes(String(uuid).toLowerCase())
  );

  if (uuidOk) {
    return {
      ok: true,
      s: true,
      e: null,
      uuid: String(uuid),
      p: false,
      raw: null,
    };
  }

  const err0 = json?.errors?.[0]?.extensions || {};
  const errorCode = err0.errorCode || null;
  const errorKey = err0.errorKey || "";

  if (
    /error_promotions_revoked|new_user_promo_revoked|Promosyon kodları bu hesap/i.test(
      raw,
    ) ||
    errorKey === "error_promotions_revoked" ||
    errorKey === "new_user_promo_revoked"
  ) {
    return {
      ok: false,
      s: true,
      e: 3,
      uuid: null,
      reason: "REMOVE_PROMO",
      p: false,
      msg: "Promosyon silindi lütfen başka hesap alıp deneyin",
      raw,
    };
  }

  if (
    /fraud_error|error_processing_request_in_app_help/i.test(raw) ||
    errorCode === "rtapi.riders.pickup.fraud_error"
  ) {
    return {
      ok: false,
      s: true,
      e: errorCode || "rtapi.riders.pickup.fraud_error",
      uuid: null,
      reason: "TRIP_FRAUD",
      p: false,
      msg: "Uber yolculuğu engelledi (fraud). Promosyon silinmedi.",
      raw,
    };
  }

  if (
    /checkout_actions_required|RATE_LIMITED/i.test(raw) ||
    errorCode === "rtapi.riders.pickup.checkout_actions_required"
  ) {
    return {
      ok: false,
      s: true,
      e: errorCode || "rtapi.riders.pickup.checkout_actions_required",
      uuid: null,
      p: true,
      revealUberUi: true,
      raw,
    };
  }

  if (isPaymentErrorRaw(raw, errorCode)) {
    return {
      ok: false,
      s: true,
      e: errorCode || "rtapi.riders.pickup.payment_error",
      uuid: null,
      p: true,
      revealUberUi: true,
      raw,
      msg: "Ödeme yöntemi hatası — Uber seçim ekranı açılıyor",
    };
  }

  return {
    ok: false,
    s: true,
    e: errorCode || "http_" + (httpStatus || 0),
    uuid: null,
    p: false,
    raw,
  };
}

/**
 * checkoutActionResult status:1 inject — string patch (meta/JSON shape bozmadan).
 */
function injectCheckoutStatus1Local(bodyStr, checkoutParams) {
  try {
    if (!checkoutParams || !Array.isArray(checkoutParams.actions)) return null;
    const results = checkoutParams.actions
      .filter((a) => a && a.uuid)
      .map((a) => ({ actionUUID: String(a.uuid), status: 1 }));
    if (!results.length) return null;
    const car = {
      checkoutSessionUUID: checkoutParams.checkoutSessionUUID || null,
      actionResults: results,
    };
    const carStr = JSON.stringify(car);
    const j = JSON.parse(bodyStr);
    const pay = j?.variables?.payment || j?.[0]?.variables?.payment;
    if (!pay || typeof pay !== "object") return null;
    pay.checkoutActionResult = carStr;
    delete pay.actionResults;
    delete pay.checkoutSessionUUID;
    return JSON.stringify(j);
  } catch (_) {
    return null;
  }
}

function parseCheckoutParamsLocal(raw) {
  try {
    const j = JSON.parse(raw);
    const result = j?.errors?.[0]?.extensions?.result;
    if (!result || result.type !== "CHECKOUT_ACTION" || !result.actionParams)
      return null;
    const params =
      typeof result.actionParams === "string"
        ? JSON.parse(result.actionParams)
        : result.actionParams;
    if (!params || !Array.isArray(params.actions)) return null;
    return params;
  } catch (_) {
    return null;
  }
}

// Rakip parity: TripRequest → trip-proxy process (sticky fare+cash+trip).
// Local browser trip + local cash-retry KAPALI (fare/payment IP split → fraud).
const TRIP_FORCE_REMOTE = true;

/**
 * TripRequest — sunucu process (DataImpulse sticky fare → cash → trip).
 */
async function callTripSmartProxy(data, cookieHeader, tabId) {
  const emitProgress = (pct) => {
    console.log("[KuponStore] trip proxy progress:", pct);
    if (!tabId) return;
    try {
      chrome.tabs
        .sendMessage(tabId, { action: "processProgress", pct: pct || 0 })
        .catch(() => {});
    } catch (_) {}
  };

  // Local browser-IP trip + local cash-retry kapalı — sadece process SSE.
  console.log("[KuponStore] Trip via process trip-proxy (sticky fare+cash)");
  emitProgress(10);
  return await callTripSmartProxyRemote(
    data,
    cookieHeader,
    tabId,
    emitProgress,
  );
}

/** Eski sunucu process — sadece local ağ hatasında */
async function callTripSmartProxyRemote(
  data,
  cookieHeader,
  tabId,
  emitProgress,
) {
  const bodyStr =
    typeof data.body === "string" ? data.body : JSON.stringify(data.body || "");
  const merged = await mergeUberCookies(cookieHeader);

  let clientSid = null;
  let activeUberToken = null;
  try {
    const stored = await chrome.storage.local.get([
      "uberProxySessId",
      "uberFpSeed",
      "activeUberToken",
    ]);
    clientSid = stored.uberProxySessId || stored.uberFpSeed || null;
    activeUberToken = stored.activeUberToken || null;
  } catch (_) {}
  if (!clientSid && activeUberToken) {
    clientSid = String(activeUberToken)
      .replace(/^ub-/i, "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .substring(0, 32);
  }
  if (!clientSid) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    clientSid = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }
  clientSid = String(clientSid)
    .replace(/[^a-zA-Z0-9]/g, "")
    .substring(0, 32);

  // Device fingerprint (APK analysis): token bazlı tutarlı device bilgileri
  const deviceProfile = generateDeviceProfile(activeUberToken);

  // Header'ları device profile ile doldur (APK'dan çıkarılan pattern)
  const headers = data.headers || {};
  headers["x-uber-device"] = deviceProfile.os;
  headers["x-uber-device-model"] = deviceProfile.model;
  headers["x-uber-device-os"] = deviceProfile.osVersion;
  headers["x-uber-device-id"] = deviceProfile.deviceId;
  headers["x-uber-device-udid"] = deviceProfile.udid;
  headers["x-uber-device-language"] = deviceProfile.language;
  headers["x-uber-client-version"] = deviceProfile.clientVersion;
  headers["x-uber-client-name"] = deviceProfile.clientName;
  headers["x-uber-device-location-latitude"] = deviceProfile.lat;
  headers["x-uber-device-location-longitude"] = deviceProfile.lon;
  headers["x-uber-device-height-pixel"] = deviceProfile.screenHeight;

  // Device data JSON (APK'da x-uber-device-data header'ı var)
  const deviceData = {
    model: deviceProfile.model,
    os: deviceProfile.os,
    osVersion: deviceProfile.osVersion,
    locale: deviceProfile.language,
    timezone: "Europe/Istanbul",
    screen: {
      width: parseInt(deviceProfile.screenWidth),
      height: parseInt(deviceProfile.screenHeight),
    },
  };
  headers["x-uber-device-data"] = JSON.stringify(deviceData);
  headers["x-uber-device-epoch"] = Date.now().toString();

  const payload = {
    b: bodyStr,
    h: headers,
    u: data.url,
    c: extractCityIdFromHeaders(headers),
    ck: merged,
    a: "process",
    m: deviceProfile.type,
    _id: "r" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    k: TRIP_PROXY_KEY,
    _clientSid: clientSid,
    _deviceProfile: deviceProfile,
  };
  if (activeUberToken) {
    payload.token = activeUberToken;
    payload._uberToken = activeUberToken;
  }
  console.log(
    "[KuponStore] Trip APK-based device fingerprint (DataImpulse Istanbul)",
    TRIP_PROXY_URL,
    "device:",
    deviceProfile.model,
    "sid:",
    String(clientSid).slice(0, 12),
  );

  const res = await fetch(TRIP_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  let finalResult = null;
  const progress = typeof emitProgress === "function" ? emitProgress : () => {};

  if (contentType.includes("event-stream") && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const obj = JSON.parse(line.substring(6));
          if (obj && obj._p) progress(obj.pct);
          else finalResult = obj;
        } catch (_) {}
      }
    }
  } else {
    const text = await res.text();
    try {
      finalResult = JSON.parse(text);
    } catch (_) {
      finalResult = { s: false, e: "parse_error" };
    }
  }

  if (!finalResult) finalResult = { s: false, e: "no_result" };
  console.log("[KuponStore] trip proxy result:", {
    ok: finalResult.ok,
    s: finalResult.s,
    e: finalResult.e,
    uuid: finalResult.uuid || null,
    reason: finalResult.reason || null,
    via: "remote",
  });
  return finalResult;
}

/**
 * Uber proxy isteği — kuponstore.com/api/extension/uber/proxy.php
 * JSON envelope formatı: { status, statusText, data, headers, setCookies[], __paymentError, __message, __sessionExpired }
 */
async function handleUberProxyRequest(data, sender) {
  const tabId = sender?.tab?.id || null;
  // UA: iOS modunda Safari (DNR ile uyumlu), Android modunda storage/fallback
  let uberUA = data.userAgent || null;
  let uberMode = "ios";
  let proxySessionId = null;
  try {
    const stored = await chrome.storage.local.get([
      "uberUserAgent",
      "uberMode",
      "uberProxySessId",
      "uberFpSeed",
    ]);
    uberMode = stored.uberMode === "android" ? "android" : "ios";
    proxySessionId = stored.uberProxySessId || stored.uberFpSeed || null;
    if (!uberUA) {
      if (uberMode === "ios") {
        uberUA = UBER_IOS_UA_PROXY;
      } else {
        uberUA = stored.uberUserAgent || null;
      }
    }
  } catch (_) {}
  if (!uberUA)
    uberUA = uberMode === "ios" ? UBER_IOS_UA_PROXY : UBER_UA_FALLBACK_SW;

  // Telemetri/tracking endpoint'leri için cookie GÖNDERME
  // Bu endpoint'ler anonim kabul ediliyor (204) ve amacımız IP/fingerprint gizlemek.
  // Cookie göndermek Uber'in IP-session kontrolüne takılıp 302 redirect'e yol açıyor.
  const urlPath = (() => {
    try {
      return new URL(data.url).pathname.toLowerCase();
    } catch (_) {
      return "";
    }
  })();
  const isTelemetryEndpoint =
    ["/_events", "/go/_events", "/go/udi-meta", "/udi-meta"].includes(
      urlPath,
    ) ||
    (urlPath === "/events" && data.url.includes("key="));

  const outboundHeaders = Object.assign({}, data.headers || {});

  if (isTelemetryEndpoint) {
    // Telemetri: cookie'leri sil — anonim gönder
    Object.keys(outboundHeaders).forEach((k) => {
      if (k.toLowerCase() === "cookie") delete outboundHeaders[k];
    });
  } else {
    // Diğer endpoint'ler (graphql vs): cookie ekle
    const hasCookie = Object.keys(outboundHeaders).some(
      (k) => k.toLowerCase() === "cookie",
    );
    if (!hasCookie) {
      try {
        const cookieHeader = await buildCookieHeaderForUrl(data.url);
        if (cookieHeader) outboundHeaders["Cookie"] = cookieHeader;
      } catch (_) {}
    }
  }

  const bodyPayload = data.body
    ? typeof data.body === "string"
      ? data.body
      : JSON.stringify(data.body)
    : null;

  const envelope = {
    url: data.url,
    method: data.method || "GET",
    headers: outboundHeaders,
    body: bodyPayload,
    userAgent: uberUA,
  };
  if (proxySessionId) {
    envelope.sessionId = String(proxySessionId)
      .replace(/[^a-zA-Z0-9]/g, "")
      .substring(0, 32);
  }

  // ── Tek bir proxy çağrısını dener, parse edilmiş sonucu döndürür ──────────
  async function callProxy(endpoint, extraHeaders = {}) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": "application/json" },
        extraHeaders,
      ),
      body: JSON.stringify(envelope),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = null;
    }

    if (json && json.__error) throw new Error(json.__error);
    if (!res.ok && !json) throw new Error("Proxy HTTP " + res.status);

    return json;
  }

  // ── Yanıtı çözümle ve cookie'leri uygula ─────────────────────────────────
  async function resolveEnvelope(json) {
    let finalStatus = json.status ?? 200;
    let finalData =
      typeof json.data === "string"
        ? json.data
        : JSON.stringify(json.data || "");
    let finalHeaders =
      json.headers && typeof json.headers === "object" ? json.headers : {};
    let setCookies = Array.isArray(json.setCookies)
      ? json.setCookies.filter(Boolean)
      : [];

    if (!setCookies.length && typeof finalHeaders["set-cookie"] === "string") {
      setCookies = finalHeaders["set-cookie"]
        .split("\n")
        .map((v) => v.trim())
        .filter(Boolean);
    }

    // Session expired: auth.uber.com'a redirect geldi
    if (json.__sessionExpired) {
      console.warn(
        "[KuponStore] Uber session expired — proxy 302 → auth redirect algıladı",
      );
      // Telemetri endpoint'leri için proxy zaten 204 dönüyor, biz de success döneriz
      // GraphQL/diğer endpoint'ler için orijinal status'u koruyoruz
      if (finalStatus === 204) {
        return {
          success: true,
          status: 204,
          statusText: "No Content",
          headers: {},
          data: "",
          __paymentError: false,
          __message: null,
        };
      }
    }

    // Doğrudan 302 → auth redirect gelirse (proxy __sessionExpired dönmese bile)
    const location = finalHeaders["location"] || finalHeaders["Location"] || "";
    if (
      (finalStatus === 302 || finalStatus === 301) &&
      (location.includes("auth.uber.com") ||
        location.includes("login.uber.com"))
    ) {
      console.warn(
        "[KuponStore] Uber session expired — 302 redirect:",
        location,
      );
      const urlPath = new URL(data.url).pathname.toLowerCase();
      const isTelemetry = [
        "/_events",
        "/go/_events",
        "/go/udi-meta",
        "/udi-meta",
      ].includes(urlPath);
      if (isTelemetry) {
        return {
          success: true,
          status: 204,
          statusText: "No Content",
          headers: {},
          data: "",
          __paymentError: false,
          __message: null,
        };
      }
    }

    if (setCookies.length) {
      await applySetCookiesToBrowser(data.url, setCookies);
    }

    return {
      success: true,
      status: finalStatus,
      statusText: "OK",
      headers: finalHeaders,
      data: finalData,
      __paymentError: json.__paymentError || false,
      __message: json.__message || null,
    };
  }

  // ── TripRequest → kuponstore trip-proxy v2.0 (APK Analysis Device Fingerprinting) ────────
  if (bodyContainsUberTripRequest(bodyPayload)) {
    try {
      console.log(
        "[KuponStore] TripRequest detected - using v2.0 Engine (APK-based device fingerprinting)",
      );
      const cookieHeaderForTrip =
        outboundHeaders["Cookie"] || outboundHeaders["cookie"] || null;

      // v2.0 Engine: APK analysis bazlı device fingerprinting + consistent profiles
      const tripResult = await UberTripEngine.processTripRequest(
        data,
        cookieHeaderForTrip,
        tabId,
      );

      ksTrack("uber.trip", {
        platform: "uber",
        service: "trip",
        success: !!(tripResult && tripResult.ok),
        error_code: tripResult && tripResult.e ? String(tripResult.e).slice(0, 64) : null,
        error_message: tripResult && tripResult.reason ? String(tripResult.reason).slice(0, 240) : null,
        payload: {
          has_uuid: !!(tripResult && tripResult.uuid),
          reveal: !!(tripResult && (tripResult.p || tripResult.revealUberUi)),
          fraud: !!(tripResult && (tripResult.fraud || tripResult.e === "TRIP_FRAUD")),
        },
      });

      if (tripResult && tripResult.ok && tripResult.uuid) {
        if (tripResult.switchCookies && Array.isArray(tripResult.newCookies)) {
          try {
            await applySetCookiesToBrowser(
              data.url,
              tripResult.newCookies.map((c) => {
                if (typeof c === "string") return c;
                const parts = [`${c.name}=${c.value}`];
                if (c.domain) parts.push(`Domain=${c.domain}`);
                if (c.path) parts.push(`Path=${c.path}`);
                if (c.secure) parts.push("Secure");
                if (c.httpOnly) parts.push("HttpOnly");
                return parts.join("; ");
              }),
            );
          } catch (_) {}
        }
        return {
          success: true,
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
          data: buildTripSuccessJson(tripResult.uuid),
          __tripOk: true,
          __tripUuid: String(tripResult.uuid),
          __paymentError: false,
          __message: null,
          ok: true,
          s: true,
          p: false,
          uuid: String(tripResult.uuid),
        };
      }

      // Sunucu ok demiş ama UUID yok: Dost/upstream trip açmış olabilir (uuid client'a yok)
      // Fail demek “yolculuk bulundu ama UI fail” yaratıyor — sentetik başarı ver.
      if (tripResult && tripResult.ok && !tripResult.uuid) {
        console.warn(
          "[KuponStore] Trip ok without uuid — synthetic success (upstream trip may be live)",
        );
        return {
          success: true,
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
          data: buildTripSuccessJson("ok"),
          __tripOk: true,
          __tripUuid: "ok",
          __paymentError: false,
          __message: null,
          ok: true,
          s: true,
          p: false,
          uuid: "ok",
        };
      }

      const raw = typeof tripResult?.raw === "string" ? tripResult.raw : "";

      // Checkout / payment → önce Uber UI (e=3 + p birlikte gelebilir; REMOVE_PROMO'dan önce bak)
      const revealUi = !!(
        tripResult &&
        (tripResult.p ||
          tripResult.revealUberUi ||
          tripResult.e === "rtapi.riders.pickup.checkout_actions_required" ||
          tripResult.e === "rtapi.riders.pickup.payment_error" ||
          tripResult.e === "payment_rate_limited" ||
          /checkout_actions_required|RATE_LIMITED|payment_error|"CHANGE"/i.test(
            raw,
          ))
      );

      if (revealUi) {
        console.log(
          "[KuponStore] TripRequest → Uber seçim ekranı",
          tripResult && tripResult.e,
        );
        const revealPayload =
          raw ||
          JSON.stringify({
            errors: [
              {
                message: "checkout_actions_required",
                path: ["tripRequest"],
                extensions: {
                  errorCode:
                    tripResult?.e ||
                    "rtapi.riders.pickup.checkout_actions_required",
                },
              },
            ],
            data: { tripRequest: null },
          });
        return {
          success: true,
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
          data: revealPayload,
          __revealUberUi: true,
          __p: true,
          __paymentError: false,
          __message: tripResult?.e || "checkout_actions_required",
        };
      }

      // Promo revoke — reason=REMOVE_PROMO veya e=3 (revealUi değilse)
      const isRemovePromo = !!(
        tripResult &&
        (tripResult.reason === "REMOVE_PROMO" ||
          tripResult.e === 3 ||
          tripResult.e === "3")
      );
      if (isRemovePromo) {
        console.warn("[KuponStore] TripRequest REMOVE_PROMO");
        return {
          success: true,
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
          data: FAKE_TRIP_PROCESSING_JSON,
          __removePromo: true,
          __reason: "REMOVE_PROMO",
          __e: 3,
          __paymentError: true,
          __message:
            tripResult.msg ||
            "Promosyon silindi lütfen başka hesap alıp deneyin",
          ok: false,
          s: true,
          reason: "REMOVE_PROMO",
          e: 3,
          p: false,
        };
      }

      if (tripResult && tripResult.reason === "TRIP_FRAUD") {
        console.warn("[KuponStore] TripRequest TRIP_FRAUD (promo değil)");
        return {
          success: true,
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
          data: FAKE_TRIP_PROCESSING_JSON,
          __tripFraud: true,
          __reason: "TRIP_FRAUD",
          __e: tripResult.e || "fraud_error",
          __paymentError: false,
          __message:
            tripResult.msg ||
            "Uber yolculuğu engelledi (fraud). Promosyon silinmedi.",
          ok: false,
          s: true,
          reason: "TRIP_FRAUD",
          e: tripResult.e || "fraud_error",
          p: false,
        };
      }

      if (tripResult && tripResult.reason === "CITY_BLOCKED") {
        console.warn(
          "[KuponStore] TripRequest CITY_BLOCKED (şehir/hesap uyumsuz)",
        );
        return {
          success: true,
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
          data: FAKE_TRIP_PROCESSING_JSON,
          __cityBlocked: true,
          __reason: "CITY_BLOCKED",
          __e: "unknown",
          __paymentError: true,
          __message:
            tripResult.msg ||
            "Bu hesap bu şehirde yolculuk açamıyor. DE (+49) token deneyin.",
          ok: false,
          s: true,
          reason: "CITY_BLOCKED",
          e: "unknown",
          p: false,
        };
      }

      console.warn(
        "[KuponStore] TripRequest başarısız:",
        tripResult && tripResult.e,
        "full:",
        JSON.stringify(tripResult).slice(0, 300),
      );
      return {
        success: false,
        error:
          (tripResult && (tripResult.e || tripResult.reason || "unknown")) ||
          "no_response",
        status: 200,
        data: raw,
        __tripFail: true,
      };
    } catch (tripErr) {
      console.error("[KuponStore] Trip proxy hatası:", tripErr.message);
    }
  }

  // ── KuponStore proxy (diğer tüm istekler — GetUpfrontFare dahil) ──────────
  try {
    let opHint = "";
    try {
      const bj = bodyPayload ? JSON.parse(bodyPayload) : null;
      const first = Array.isArray(bj) ? bj[0] : bj;
      opHint = first && first.operationName ? String(first.operationName) : "";
    } catch (_) {}
    if (opHint || (data.url && String(data.url).includes("/graphql"))) {
      console.log(
        "[Uber] proxy",
        opHint || "graphql",
        "sid",
        proxySessionId ? String(proxySessionId).slice(0, 16) : null,
      );
    }
    const json = await callProxy(UBER_PROXY_PRIMARY, {
      "X-Api-Key": UBER_PROXY_API_KEY,
    });
    return await resolveEnvelope(json);
  } catch (proxyErr) {
    console.error("[KuponStore] Uber proxy başarısız:", proxyErr.message);
    return { success: false, error: proxyErr.message };
  }
}

/**
 * Handle get fingerprint
 */
async function handleGetFingerprint(data) {
  const { platform } = data;

  const seed = await getFingerprintSeed(platform, storage);
  const profile = buildDeviceProfile(seed);

  return {
    success: true,
    profile,
    seed,
  };
}

/**
 * Handle log message
 */
async function handleLogMessage(data) {
  const { type, message, logData } = data;
  await logManager.addLog(type, message, logData);
  return { success: true };
}

/**
 * Handle save token
 */
async function handleSaveToken(data) {
  const { token } = data;

  const platformInfo = detectPlatform(token);
  if (!platformInfo) {
    throw new Error("Token formatı tanınamadı");
  }

  await tokenHistory.addToken({
    token,
    platform: platformInfo.platform,
    service: platformInfo.service,
    name: platformInfo.name,
  });

  return { success: true, platformInfo };
}

// Keep service worker alive
chrome.alarms.create("keepAlive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    // Just to keep service worker active
    console.log("Service worker alive");
    try {
      ksRenewSessionLease().catch(() => {});
    } catch (_) {}
  }
});

// =============================================================================
// Oturum kirası: eklenti açıkken çerezler yenilenir; kapatılınca ~2 dk içinde düşer
// (Chrome disable event vermez — kısa ömürlü cookie + periyodik yenileme)
// =============================================================================
const KS_SESSION_LEASE_SEC = 120;
const KS_SESSION_AUTH_COOKIE_NAMES = new Set([
  "tgo-token",
  "access_token",
  "token",
  "mobile-token",
  "platform",
  "channel-id",
  "storefrontId",
  "countryCode",
  "language",
  "AZ_SELECTED",
  "user_email",
  "user_phone",
  "tgo-address",
  "tgo-csrf-token",
  "trendyolWebToken",
  "sid",
  "session",
  "auth_token",
]);

async function ksWipeDomainAuthCookies(domain) {
  try {
    const list = await chrome.cookies.getAll({ domain }).catch(() => []);
    for (const ck of list || []) {
      if (!KS_SESSION_AUTH_COOKIE_NAMES.has(ck.name)) continue;
      const host = String(ck.domain || domain).replace(/^\./, "");
      const path = ck.path || "/";
      const url = "https://" + host + (path === "/" ? "/" : path);
      await chrome.cookies.remove({ url, name: ck.name }).catch(() => {});
    }
  } catch (_) {}
}

function ksCookieSameSite(value) {
  if (value === "strict" || value === "lax" || value === "no_restriction") return value;
  return "lax";
}

async function ksRenewSessionLease() {
  const exp = Math.floor(Date.now() / 1000) + KS_SESSION_LEASE_SEC;
  const domains = ["tgoyemek.com", "trendyol.com"];
  let renewed = 0;
  const tgoNames = [];
  const tgoJar = [];
  for (const domain of domains) {
    let list = [];
    try {
      list = await chrome.cookies.getAll({ domain });
    } catch (_) {
      continue;
    }
    const wholeDomain = domain === "tgoyemek.com";
    for (const ck of list || []) {
      if (!ck || !ck.name || !ck.value) continue;
      if (wholeDomain) {
        if (tgoNames.indexOf(ck.name) === -1) tgoNames.push(ck.name);
        if (tgoJar.length < 80) {
          tgoJar.push({
            name: ck.name,
            path: ck.path || "/",
            domain: ck.hostOnly ? "" : String(ck.domain || ""),
            secure: ck.secure !== false,
          });
        }
      } else if (!KS_SESSION_AUTH_COOKIE_NAMES.has(ck.name)) {
        continue;
      }
      const host = String(ck.domain || domain).replace(/^\./, "");
      const path = ck.path || "/";
      const url = "https://" + host + (path.startsWith("/") ? path : "/" + path);
      const details = {
        url,
        name: ck.name,
        value: ck.value,
        path,
        secure: ck.secure !== false,
        httpOnly: false,
        sameSite: ksCookieSameSite(ck.sameSite),
        expirationDate: exp,
      };
      if (!ck.hostOnly && ck.domain) details.domain = ck.domain;
      if (ck.partitionKey) details.partitionKey = ck.partitionKey;
      try {
        await chrome.cookies.set(details);
        renewed++;
      } catch (_) {}
    }
  }
  try {
    await chrome.storage.local.set({ ksSessionLeaseAt: Date.now() });
  } catch (_) {}
  if (renewed) {
    console.log("[KuponStore] Oturum kirası yenilendi:", renewed, "çerez,", KS_SESSION_LEASE_SEC + "s");
  }
  return { renewed, names: tgoNames, jar: tgoJar };
}

async function ksScheduleSessionLease() {
  try {
    await chrome.alarms.create("ksSessionLease", { delayInMinutes: 0.5 });
  } catch (_) {
    try {
      await chrome.alarms.create("ksSessionLease", { delayInMinutes: 1 });
    } catch (__) {}
  }
}

async function ksBootSessionLease() {
  // Disable sonrası çerezler zaten kısa ömürle düşer; SW uyanınca kalanları yenile.
  try {
    await ksRenewSessionLease();
  } catch (_) {}
  await ksScheduleSessionLease();
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "ksSessionLease") return;
  try {
    await ksRenewSessionLease();
  } catch (_) {}
  await ksScheduleSessionLease();
});

async function ksWipeTgoyemekSite() {
  const domains = ["tgoyemek.com"];
  const origins = [
    "https://tgoyemek.com",
    "https://www.tgoyemek.com",
  ];
  for (const origin of origins) {
    try {
      await chrome.browsingData.remove(
        { origins: [origin] },
        {
          cookies: true,
          localStorage: true,
          indexedDB: true,
          cacheStorage: true,
        },
      );
    } catch (_) {}
  }
  for (const domain of domains) {
    let list = [];
    try {
      list = await chrome.cookies.getAll({ domain });
    } catch (_) {
      continue;
    }
    for (const ck of list || []) {
      const host = String(ck.domain || domain).replace(/^\./, "");
      const path = ck.path || "/";
      const url = "https://" + host + (path.startsWith("/") ? path : "/" + path);
      await chrome.cookies.remove({ url, name: ck.name }).catch(() => {});
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "ks-ty-life") return;
  port.onDisconnect.addListener(() => {
    try { void chrome.runtime.lastError; } catch (_) {}
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || (msg.action !== "ksTyLeaseNow" && msg.action !== "ksWipeSiteCookies")) return;
  const job = msg.action === "ksWipeSiteCookies"
    ? ksWipeTgoyemekSite().then(() => ({ names: [] }))
    : ksRenewSessionLease();
  job
    .then((result) => sendResponse({
      ok: true,
      names: (result && result.names) || [],
      jar: (result && result.jar) || [],
    }))
    .catch(() => sendResponse({ ok: false, names: [], jar: [] }));
  return true;
});

// SW ayağa kalkınca kirayı başlat
ksBootSessionLease().catch(() => {});

// Login / cookie yazımlarından sonra hemen kısa ömre çek
try {
  if (typeof self !== "undefined") {
    self.ksRenewSessionLease = ksRenewSessionLease;
  }
} catch (_) {}

// =============================================================================
// Yemeksepeti oturum: kısa TTL + heartbeat + reinject.
// Ödeme/3DS yönlendirmesi oturumu düşürmez. Eklenti chrome://extensions'tan
// kapatılınca çıkışı sayfadaki kill switch yapar; /logout çağrılmaz.
// =============================================================================
const YS_AUTH_COOKIE_NAMES = [
  "access_token",
  "refresh_token",
  "device_token",
  "token",
  "x-token",
  "android_token",
  "android_refresh_token",
  "android_device_token",
  "uy_token",
];
const YS_COOKIE_TTL_SEC = 300;
const YS_HEARTBEAT_ALARM = "ysCookieHeartbeat";

function ysCookieSetParamsFrom(cookie, ttlSec) {
  const host =
    cookie.domain && cookie.domain.startsWith(".")
      ? cookie.domain.substring(1)
      : cookie.domain;
  const params = {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite || "unspecified",
    expirationDate: Math.floor(Date.now() / 1000) + ttlSec,
    storeId: cookie.storeId,
  };
  if (cookie.partitionKey) params.partitionKey = cookie.partitionKey;
  return params;
}

let ysHeartbeatRunning = false;
let ysSessionClosed = false;
let ysHandoffUntil = 0;
let ysLogoutInFlight = false;
let ysExtPagePorts = 0;

async function refreshYsCookieTtl() {
  if (ysSessionClosed || ysHeartbeatRunning) return;
  ysHeartbeatRunning = true;
  try {
    const cookies = await chrome.cookies.getAll({ domain: "yemeksepeti.com" });
    const targets = cookies.filter((c) => YS_AUTH_COOKIE_NAMES.includes(c.name));
    for (const c of targets) {
      try {
        await chrome.cookies.set(ysCookieSetParamsFrom(c, YS_COOKIE_TTL_SEC));
      } catch (_) {}
    }
    // Reinject için sakla
    if (targets.length) {
      await chrome.storage.local.set({
        ksYsSessionCookies: targets.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || ".yemeksepeti.com",
          path: c.path || "/",
        })),
      });
    }
  } catch (e) {}
  finally {
    ysHeartbeatRunning = false;
  }
}

function ensureYsCookieHeartbeat() {
  try {
    chrome.alarms.create(YS_HEARTBEAT_ALARM, { periodInMinutes: 1 });
  } catch (e) {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === YS_HEARTBEAT_ALARM) refreshYsCookieTtl();
});

chrome.cookies.onChanged.addListener((changeInfo) => {
  try {
    if (ysSessionClosed) return;
    if (changeInfo.removed) return;
    const c = changeInfo.cookie;
    if (!c || !c.domain || c.domain.indexOf("yemeksepeti.com") === -1) return;
    if (YS_AUTH_COOKIE_NAMES.indexOf(c.name) === -1) return;
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof c.expirationDate === "number" &&
      c.expirationDate > now + YS_COOKIE_TTL_SEC + 30
    ) {
      chrome.cookies.set(ysCookieSetParamsFrom(c, YS_COOKIE_TTL_SEC)).catch(() => {});
    }
  } catch (e) {}
});

async function deleteYsAuthCookies() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "yemeksepeti.com" });
    for (const c of cookies) {
      if (!YS_AUTH_COOKIE_NAMES.includes(c.name)) continue;
      const host = c.domain.startsWith(".") ? c.domain.substring(1) : c.domain;
      const url = `${c.secure ? "https" : "http"}://${host}${c.path || "/"}`;
      try {
        await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId });
      } catch (_) {}
    }
  } catch (e) {}
}

async function removeYsAuthRules() {
  try {
    if (!chrome.declarativeNetRequest?.getDynamicRules) return;
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const ids = (rules || [])
      .filter((r) => {
        const cond = r && r.condition ? r.condition : {};
        const blob = String(cond.urlFilter || "") + String(cond.regexFilter || "");
        return /fd-api\.com|yemeksepeti\.com/i.test(blob);
      })
      .map((r) => r.id);
    if (ids.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: ids,
        addRules: [],
      });
    }
  } catch (_) {}
}

async function logoutYsFromExtension(reason) {
  if (ysLogoutInFlight || Date.now() < ysHandoffUntil) return;
  ysLogoutInFlight = true;
  ysSessionClosed = true;
  try {
    await chrome.storage.local.set({ ksYsSessionClosed: Date.now() });
    await chrome.storage.local.remove("ksYsSessionCookies");
    await deleteYsAuthCookies();
    await removeYsAuthRules();
    try {
      await chrome.browsingData.remove(
        {
          origins: ["https://www.yemeksepeti.com", "https://yemeksepeti.com"],
        },
        { localStorage: true },
      );
    } catch (_) {}
    console.log("[YS] Oturum kapatıldı:", reason || "ext");
  } catch (e) {
    console.warn("[YS] Oturum kapatma:", e && e.message);
  } finally {
    setTimeout(() => {
      ysLogoutInFlight = false;
    }, 1500);
  }
}

async function maybeCleanupYsAuthCookies() {
  try {
    if (ysSessionClosed || Date.now() < ysHandoffUntil) return;
    const all = await chrome.tabs.query({});
    const hasYs = all.some(
      (t) => t.url && t.url.indexOf("yemeksepeti.com") !== -1,
    );
    if (hasYs) return;
    const extUrl = chrome.runtime.getURL("ui/fullscreen.html");
    const hasExt = all.some((t) => t.url && t.url.indexOf(extUrl) === 0);
    if (hasExt) return;
    await logoutYsFromExtension("ys-tab-closed");
  } catch (e) {}
}

let ysReinjectInFlight = false;
async function reinjectYsAuthCookiesFromSession() {
  if (ysReinjectInFlight) return;
  ysReinjectInFlight = true;
  try {
    const existing = await chrome.cookies.get({
      url: "https://www.yemeksepeti.com",
      name: "access_token",
    });
    if (existing) return;
    if (ysSessionClosed) return;
    const st = await chrome.storage.local.get([
      "ksYsSessionCookies",
      "ksYsSessionClosed",
    ]);
    if (st.ksYsSessionClosed) return;
    const stored = Array.isArray(st.ksYsSessionCookies)
      ? st.ksYsSessionCookies
      : [];
    if (!stored.length) return;
    const now = Math.floor(Date.now() / 1000);
    for (const c of stored) {
      if (!YS_AUTH_COOKIE_NAMES.includes(c.name) || !c.value) continue;
      const domain = c.domain || ".yemeksepeti.com";
      const host = domain.startsWith(".") ? domain.substring(1) : domain;
      try {
        await chrome.cookies.set({
          url: `https://${host}${c.path || "/"}`,
          name: c.name,
          value: String(c.value),
          domain,
          path: c.path || "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          expirationDate: now + YS_COOKIE_TTL_SEC,
        });
      } catch (_) {}
    }
  } catch (e) {}
  finally {
    ysReinjectInFlight = false;
  }
}

let ysCleanupTimer = null;
function scheduleYsAuthCleanup() {
  if (ysCleanupTimer) clearTimeout(ysCleanupTimer);
  ysCleanupTimer = setTimeout(() => {
    ysCleanupTimer = null;
    maybeCleanupYsAuthCookies();
  }, 8000);
}
function cancelYsAuthCleanup() {
  if (!ysCleanupTimer) return;
  clearTimeout(ysCleanupTimer);
  ysCleanupTimer = null;
}

chrome.tabs.onRemoved.addListener(() => {
  scheduleYsAuthCleanup();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || (tab && tab.url) || "";
  if (
    (changeInfo.status === "loading" || changeInfo.url) &&
    url.indexOf("yemeksepeti.com") !== -1
  ) {
    cancelYsAuthCleanup();
    reinjectYsAuthCookiesFromSession();
  }
});

ensureYsCookieHeartbeat();
refreshYsCookieTtl();

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "ks-ext-page") return;
  ysExtPagePorts += 1;
  port.onDisconnect.addListener(() => {
    ysExtPagePorts = Math.max(0, ysExtPagePorts - 1);
    setTimeout(() => {
      if (ysExtPagePorts > 0) return;
      if (Date.now() < ysHandoffUntil) return;
      scheduleYsAuthCleanup();
    }, 500);
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.action !== "YS_LOGIN_HANDOFF") return false;
  ysHandoffUntil = Date.now() + 20000;
  ysSessionClosed = false;
  chrome.storage.local.remove("ksYsSessionClosed").catch(() => {});
  sendResponse({ ok: true });
  return false;
});

/**
 * Trendyol Mobil Login - Email ve şifre ile mobil token al
 * Direkt mobile.trendyol.com API'sine istek at
 */
async function performTrendyolMobileLogin(email, password) {
  console.log("[TY Mobile Login] Başlıyor...");

  const dalvikUA =
    "Dalvik/2.1.0 (Linux; U; Android 9; 2203121C Build/PQ3A.190605.09201023) TrendyolGo/1.45.4.164";

  try {
    // 1. Guest token al
    const guestResponse = await fetch(
      "https://mobile.trendyol.com/secure/json/auth/token/guest",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": dalvikUA,
        },
      },
    );

    if (!guestResponse.ok) {
      throw new Error(`Guest token alınamadı: ${guestResponse.status}`);
    }

    const guestData = await guestResponse.json();
    const guestToken = guestData.accessToken || guestData.access_token;

    if (!guestToken) {
      throw new Error("Guest token bulunamadı");
    }

    console.log("[TY Mobile Login] ✅ Guest token alındı");

    // 2. Mobil login
    const loginResponse = await fetch(
      "https://mobile.trendyol.com/secure/json/auth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": dalvikUA,
        },
        body: JSON.stringify({
          guestToken: guestToken,
          username: email,
          password: password,
          otp: null,
          captchaToken: null,
        }),
      },
    );

    if (!loginResponse.ok) {
      const errorText = await loginResponse.text();
      throw new Error(
        `Mobil login başarısız: ${loginResponse.status} - ${errorText}`,
      );
    }

    const loginData = await loginResponse.json();
    const mobileToken = loginData.accessToken || loginData.access_token;

    if (!mobileToken) {
      throw new Error("Mobil token bulunamadı");
    }

    console.log(
      "[TY Mobile Login] ✅ Mobil token alındı, uzunluk:",
      mobileToken.length,
    );

    return mobileToken;
  } catch (error) {
    console.error("[TY Mobile Login] Hata:", error);
    throw error;
  }
}

/**
 * Trendyol Login - Background'dan direkt mobil JWT al (CORS sorunu yok, race yok)
 * Eski content-script köprüsü kaldırıldı: performTrendyolMobileLogin doğrudan
 * api'ye gider ve tek bir yere (setTrendyolMobileToken) yazar.
 */
async function performTrendyolLogin(email, password) {
  console.log("[TY Login] Direkt mobil login başlıyor (background)...");
  const mobileToken = await performTrendyolMobileLogin(email, password);
  if (!mobileToken) throw new Error("Mobil token alınamadı");
  await setTrendyolMobileToken(mobileToken, "direct-mobile");
  return mobileToken;
}

/**
 * payment.tgoapps.com — DNR
 *
 * Native /odeme: tyOdemePageActive veya tyPrePaymentMerge ile önce tarayıcı cookie JWT + _tyBuildLcWebPaymentHeaders.
 * Mobil havuz oturumu: TrendyolGo başlık seti (tyTokenSource mobil ise ve /odeme değil veya cookie yok).
 */
// (Eski) JWT ile TrendyolGo/lc ayrımı kaldırıldı — mobil ödeme tek fingerprint.
const _TY_LC_PAY_FEATURES =
  "OPTIONAL_REBATE;MEAL_CART_ENABLED;MEAL_CARD_TRENDYOL_PROMOTION;";
const _TY_LC_PAY_SUPPORTED = "MULTINET;SODEXO;EDENRED;ON_DELIVERY;SETCARD";
/** Canlı curl (payment/options): iPhone Safari — masaüstü Chrome UA + web JWT uyumsuzluğu 401 üretebiliyor. */
const TY_PAYMENT_LC_WEB_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const TY_PAYMENT_LC_REFERER =
  "https://payment.tgoapps.com/v3/tgo/card-fragment?application-id=1&storefront-id=1&culture=tr-TR&debug=true";

/**
 * lc web JWT: app-name / TrendyolGo ile KARIŞTIRMA — JWT appName=lc iken app-name: TrendyolGo 400 üretir.
 * card-fragment referer’daki application-id=1 ile uyumlu x-applicationid + iOS/cors meta (canlı iframe capture).
 */
function _tyBuildLcWebPaymentHeaders(jwt, forPost) {
  const wantJsonBody = !!forPost;
  const removes = [
    { header: "x-application-id", operation: "remove" },
    { header: "x-applicationid", operation: "remove" },
    { header: "X-Application-Id", operation: "remove" },
    { header: "X-ApplicationId", operation: "remove" },
    { header: "App-Name", operation: "remove" },
    { header: "app-name", operation: "remove" },
    { header: "x-personalization-id", operation: "remove" },
    { header: "x-session-id", operation: "remove" },
  ];
  // GET /payment/options bazı istemcilerde yanlışlıkla Content-Type taşır; API 500/400 verebiliyor.
  if (!wantJsonBody) {
    removes.push(
      { header: "content-type", operation: "remove" },
      { header: "Content-Type", operation: "remove" },
    );
  }
  const sets = [
    { header: "Authorization", operation: "set", value: `Bearer ${jwt}` },
  ];
  if (wantJsonBody) {
    sets.push({
      header: "Content-Type",
      operation: "set",
      value: "application/json",
    });
  }
  sets.push(
    { header: "Accept", operation: "set", value: "*/*" },
    { header: "Accept-Language", operation: "set", value: "tr-TR" },
    { header: "priority", operation: "set", value: "u=1, i" },
    {
      header: "origin",
      operation: "set",
      value: "https://payment.tgoapps.com",
    },
    { header: "referer", operation: "set", value: TY_PAYMENT_LC_REFERER },
    { header: "User-Agent", operation: "set", value: TY_PAYMENT_LC_WEB_UA },
    {
      header: "sec-ch-ua",
      operation: "set",
      value:
        '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    },
    { header: "sec-ch-ua-mobile", operation: "set", value: "?1" },
    { header: "sec-ch-ua-platform", operation: "set", value: '"iOS"' },
    { header: "sec-fetch-dest", operation: "set", value: "empty" },
    { header: "sec-fetch-mode", operation: "set", value: "cors" },
    { header: "sec-fetch-site", operation: "set", value: "same-origin" },
    { header: "sec-fetch-storage-access", operation: "set", value: "none" },
    { header: "x-applicationid", operation: "set", value: "1" },
    { header: "x-channelid", operation: "set", value: "4" },
    {
      header: "x-features",
      operation: "set",
      value: "OPTIONAL_REBATE;MEAL_CART_ENABLED;MEAL_CARD_TRENDYOL_PROMOTION;",
    },
    { header: "app-name", operation: "set", value: "TrendyolGo" },
    { header: "x-storefrontid", operation: "set", value: "1" },
    {
      header: "x-supported-payment-options",
      operation: "set",
      value: _TY_LC_PAY_SUPPORTED,
    },
  );
  return removes.concat(sets);
}

/**
 * payment.tgoapps.com iframe XHR — ilk stabil sürüm: tarayıcının UA/referer/x-* değerlerini koru;
 * yalnızca Bearer + lc uyumu (TrendyolGo app-name ve boş kimlik başlıklarını at).
 */
function _tyApplyLcPaymentIframeMinimal(existing, jwt, forPost) {
  const removeNames = new Set([
    "app-name",
    "x-personalization-id",
    "x-session-id",
  ]);
  if (!forPost) {
    removeNames.add("content-type");
  }
  const out = [];
  for (const h of existing || []) {
    if (!h || !h.name) continue;
    const ln = h.name.toLowerCase();
    if (removeNames.has(ln)) continue;
    if (ln === "authorization") continue;
    out.push({ name: h.name, value: h.value });
  }
  out.push({ name: "Authorization", value: `Bearer ${jwt}` });
  if (forPost) {
    const hasCt = out.some((x) => x.name.toLowerCase() === "content-type");
    if (!hasCt) out.push({ name: "Content-Type", value: "application/json" });
  }
  return out;
}

/**
 * lc ödeme — DNR ile minimal başlık (kurumsal Chrome webRequestBlocking yasaklıysa tek güvenilir yol).
 * app-name: TrendyolGo + lc JWT → GENERIC_ERROR; iframe UA/referer korunur.
 */
function _tyBuildLcPaymentDnrMinimal(authHeader, _forPost) {
  return [
    { header: "Authorization", operation: "set", value: authHeader },
  ];
}

/** DNR modifyHeaders listesini webRequest.requestHeaders dizisine uygula. */
function _tyApplyDnrStyleToWebRequestHeaders(existing, dnrList) {
  const removes = new Set();
  const sets = [];
  for (const x of dnrList || []) {
    if (x.operation === "remove") removes.add(String(x.header).toLowerCase());
    else if (x.operation === "set")
      sets.push({ name: x.header, value: x.value });
  }
  const out = [];
  for (const h of existing || []) {
    if (!h || !h.name) continue;
    if (removes.has(h.name.toLowerCase())) continue;
    out.push({ name: h.name, value: h.value });
  }
  for (const s of sets) {
    const i = out.findIndex(
      (h) => h.name.toLowerCase() === s.name.toLowerCase(),
    );
    if (i >= 0) out[i] = { name: s.name, value: s.value };
    else out.push({ name: s.name, value: s.value });
  }
  return out;
}

/** Eski: blocking webRequest — birçok kurumsal profilde ExtensionInstallForcelist dışında yasak (console uyarısı + no-op). */
const _tyPayWebHdrCache = { activeProfile: "off", bearer: "" };

function _tyDisablePaymentWebRequestLc() {
  _tyPayWebHdrCache.activeProfile = "off";
  _tyPayWebHdrCache.bearer = "";
}

/** /odeme ödeme: yalnızca web lc JWT — TrendyolGo app-name + lc JWT sunucuda GENERIC_ERROR üretir. */
function _tyJwtIsLcWebPayment(token) {
  try {
    if (!token || typeof token !== "string") return false;
    const p = decodeJwtPayload(token);
    if (!p) return false;
    const an = String(p.appName || p.applicationName || "")
      .trim()
      .toLowerCase();
    if (an === "trendyolgo") return false;
    if (an === "lc") return true;
    return false;
  } catch (_) {
    return false;
  }
}

function _tyJwtIsTrendyolGoPool(token) {
  try {
    const p = decodeJwtPayload(token);
    if (!p) return false;
    const a1 = String(p.appName || "")
      .trim()
      .toLowerCase();
    const a2 = String(p.applicationName || "")
      .trim()
      .toLowerCase();
    return a1 === "trendyolgo" || a2 === "trendyolgo";
  } catch (_) {
    return false;
  }
}

/** tgoyemek access_token / tgo-token — tek kök URL cookie API kaçırıyor (www / domain varyantı). */
async function _tyGetTgoyemekCookieFirst(name) {
  if (!name || typeof name !== "string") return null;
  const bases = [
    "https://tgoyemek.com/odeme",
    "https://tgoyemek.com/",
    "https://tgoyemek.com",
    "https://www.tgoyemek.com/odeme",
    "https://www.tgoyemek.com/",
  ];
  for (const url of bases) {
    try {
      const c = await chrome.cookies.get({ url, name });
      if (c?.value) return c;
    } catch (_) {}
  }
  try {
    const all = await chrome.cookies.getAll({ name });
    const hit = all.find((c) => {
      const d = (c.domain || "").replace(/^\./, "").toLowerCase();
      return d === "tgoyemek.com" || d.endsWith(".tgoyemek.com");
    });
    if (hit?.value) return hit;
  } catch (_) {}
  return null;
}

/** /odeme: tarayıcı cookie JWT (access_token → tgo-token → storage); channelId=4 olsa da kabul (havuz JWT ile aynı olabilir). */
function _tyIsUsablePaymentBearerJwt(token) {
  try {
    if (!token || typeof token !== "string" || !token.startsWith("ey"))
      return false;
    const p = decodeJwtPayload(token);
    if (!p || p.role === "anon") return false;
    if (p.exp && p.exp * 1000 < Date.now()) return false;
    return !!(p.userId || p.sub);
  } catch (_) {
    return false;
  }
}

async function _resolveOdemePaymentBearer() {
  try {
    const accessCkCamel = await _tyGetTgoyemekCookieFirst("accessToken");
    const accessCkSnake = await _tyGetTgoyemekCookieFirst("access_token");
    const accessCk = accessCkCamel || accessCkSnake;
    const tgoCk = await _tyGetTgoyemekCookieFirst("tgo-token");
    const stor = await chrome.storage.local.get([
      "trendyolWebToken",
      "tyMobileToken",
      "tyToken",
    ]);
    /** Canlı cookie önce (storage bazen VPS/mobil ile kirleniyor). */
    const raw = [
      accessCk?.value,
      tgoCk?.value,
      stor.trendyolWebToken,
      stor.tyMobileToken,
      stor.tyToken,
    ].filter(Boolean);
    const seen = new Set();
    const valid = [];
    for (const t of raw) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (_tyIsUsablePaymentBearerJwt(t)) valid.push(t);
    }
    if (valid.length === 0) return null;

    const lc = valid.filter(_tyJwtIsLcWebPayment);
    const pool =
      lc.length > 0 ? lc : valid.filter((t) => !_tyJwtIsTrendyolGoPool(t));
    const use = pool.length > 0 ? pool : valid;

    const pref = stor.trendyolWebToken;
    use.sort((a, b) => {
      const aLc = _tyJwtIsLcWebPayment(a) ? 0 : 1;
      const bLc = _tyJwtIsLcWebPayment(b) ? 0 : 1;
      if (aLc !== bLc) return aLc - bLc;
      if (a.length !== b.length) return a.length - b.length;
      if (a === pref) return -1;
      if (b === pref) return 1;
      return 0;
    });
    const picked = use[0];
    if (_tyJwtIsTrendyolGoPool(picked)) {
      console.warn(
        "[TY Payment] ⚠️ /odeme lc akışı: cookie’lerde appName=lc JWT yok; TrendyolGo token ile payment 400 olabilir — tgoyemek’te normal web girişi kullanın.",
      );
    }
    try {
      const p = decodeJwtPayload(picked);
      console.log(
        "[TY Payment] odeme bearer seçildi:",
        "lc=" + _tyJwtIsLcWebPayment(picked),
        "len=" + picked.length,
        "appName=" +
          (p && (p.appName || p.applicationName)
            ? String(p.appName || p.applicationName)
            : "-"),
      );
    } catch (_) {}
    return picked;
  } catch (_) {}
  return null;
}

/** Mobil havuz JWT profil log'u (Authorization seçimi ayrı). */
function _tyLogPaymentJwtProfile(mobileTok) {
  try {
    const p = decodeJwtPayload(mobileTok);
    if (!p) return;
    console.log(
      "[TY Payment DNR] JWT profil:",
      "appName=" + (p.appName || p.applicationName || ""),
      "ch=" + (p.channelId != null ? p.channelId : "-"),
      "len=" + mobileTok.length,
    );
  } catch (_) {}
}

function _isLikelyWebSessionJwt(token) {
  try {
    if (!token || typeof token !== "string" || !token.startsWith("ey"))
      return false;
    const p = decodeJwtPayload(token);
    if (!p) return false;
    if (p.exp && p.exp * 1000 < Date.now()) return false; // expired
    const an = String(p.appName || p.applicationName || "")
      .trim()
      .toLowerCase();
    // tgoyemek web oturumu çoğunlukla appName=lc; channelId=4 olsa bile web JWT'dir (eski mantık bunu reddediyordu).
    if (an === "lc") return p.role !== "anon" && !!(p.userId || p.sub);
    // Web session göstergesi: appName 'lc' veya channelId !== 4 (mobil değil) ya da gerçek userId
    // Mobil tipik: appName=TrendyolGo, channelId=4. Web tipik: appName='lc'.
    if (p.appName === "TrendyolGo" || p.applicationName === "TrendyolGo")
      return false;
    if (p.channelId === 4) return false;
    if (p.role === "anon") return false;
    return !!(p.userId || p.sub);
  } catch (_) {
    return false;
  }
}

// Storage'da yoksa tgo-token / access_token cookie'sinden okuyup populate et.
async function _resolveTrendyolWebToken() {
  try {
    const stor = await chrome.storage.local.get(["trendyolWebToken"]);
    if (_isLikelyWebSessionJwt(stor.trendyolWebToken))
      return stor.trendyolWebToken;

    const tgoCk = await _tyGetTgoyemekCookieFirst("tgo-token");
    const accessCkCamel = await _tyGetTgoyemekCookieFirst("accessToken");
    const accessCkSnake = await _tyGetTgoyemekCookieFirst("access_token");
    const accessCk = accessCkCamel || accessCkSnake;
    const candidates = [accessCk?.value, tgoCk?.value].filter(Boolean);
    for (const t of candidates) {
      if (_isLikelyWebSessionJwt(t)) {
        await chrome.storage.local.set({ trendyolWebToken: t }).catch(() => {});
        console.log(
          "[TY Payment DNR] ✅ trendyolWebToken cookie'den populate edildi (len=" +
            t.length +
            ")",
        );
        return t;
      }
    }
  } catch (_) {}
  return null;
}

function _tyPayRandHex(n) {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < n; i++) s += hex[(Math.random() * 16) | 0];
  return s;
}

function _tyPayUuid() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID)
      return crypto.randomUUID();
  } catch (_) {}
  return (
    _tyPayRandHex(8) +
    "-" +
    _tyPayRandHex(4) +
    "-4" +
    _tyPayRandHex(3) +
    "-a" +
    _tyPayRandHex(3) +
    "-" +
    _tyPayRandHex(12)
  );
}

/** Ödeme hostu — : mobil JWT + X-Application-Id 5, Referer/Origin kaldır, trace başlıkları. */
function _tyBuildTrendyolGoPaymentHeaders(mobileJwt, forPost) {
  const wantJsonBody = !!forPost;
  const traceId = _tyPayRandHex(32);
  const spanId = _tyPayRandHex(16);
  const ts = Date.now();
  const pid = _tyPayUuid();
  const sid = _tyPayUuid();
  const uniqueId = _tyPayRandHex(16);
  const tpaydid = _tyPayUuid();
  const buildVer = "1.37.0.76";
  const ua = `Dalvik/2.1.0 (Linux; U; Android 9; 2203121C Build/PQ3A.190605.003) TrendyolGo/${buildVer}`;
  const nrPayload = JSON.stringify({
    v: [0, 2],
    d: {
      ty: "Mobile",
      ac: "",
      ap: "",
      tr: traceId,
      id: spanId,
      ti: ts,
      tk: "",
    },
  });

  const removes = [
    { header: "Referer", operation: "remove" },
    { header: "Origin", operation: "remove" },
    { header: "sec-ch-ua", operation: "remove" },
    { header: "sec-ch-ua-mobile", operation: "remove" },
    { header: "sec-ch-ua-platform", operation: "remove" },
    { header: "Sec-Fetch-Dest", operation: "remove" },
    { header: "Sec-Fetch-Mode", operation: "remove" },
    { header: "Sec-Fetch-Site", operation: "remove" },
    { header: "Sec-Fetch-Storage-Access", operation: "remove" },
    { header: "x-application-id", operation: "remove" },
    { header: "x-applicationid", operation: "remove" },
    { header: "X-Application-Id", operation: "remove" },
    { header: "X-ApplicationId", operation: "remove" },
    { header: "x-personalization-id", operation: "remove" },
    { header: "x-session-id", operation: "remove" },
    { header: "X-Personalization-Id", operation: "remove" },
    { header: "X-Session-Id", operation: "remove" },
  ];
  if (!wantJsonBody) {
    removes.push(
      { header: "content-type", operation: "remove" },
      { header: "Content-Type", operation: "remove" },
    );
  }

  const sets = [
    { header: "Authorization", operation: "set", value: `Bearer ${mobileJwt}` },
  ];
  if (wantJsonBody) {
    sets.push({
      header: "Content-Type",
      operation: "set",
      value: "application/json",
    });
  }
  sets.push(
    { header: "X-Application-Id", operation: "set", value: "5" },
    { header: "Accept", operation: "set", value: "*/*" },
    { header: "Accept-Language", operation: "set", value: "tr-TR" },
    { header: "Accept-Encoding", operation: "set", value: "gzip, deflate, br" },
    { header: "User-Agent", operation: "set", value: ua },
    { header: "app-name", operation: "set", value: "TrendyolGo" },
    { header: "x-channelid", operation: "set", value: "4" },
    { header: "platform", operation: "set", value: "Android" },
    { header: "build", operation: "set", value: buildVer },
    { header: "device-language", operation: "set", value: "tr" },
    { header: "osversion", operation: "set", value: "9" },
    { header: "isemulator", operation: "set", value: "false" },
    { header: "cl_eligible", operation: "set", value: "false" },
    { header: "lc-member", operation: "set", value: "true" },
    {
      header: "deviceid",
      operation: "set",
      value: "00000000-0000-0000-0000-000000000000",
    },
    { header: "pid", operation: "set", value: pid },
    { header: "sid", operation: "set", value: sid },
    { header: "uniqueid", operation: "set", value: uniqueId },
    { header: "tpaydid", operation: "set", value: tpaydid },
    {
      header: "x-features",
      operation: "set",
      value:
        "OPTIONAL_REBATE;TRENDYOLPAY_ENABLED;MEAL_CART_ENABLED;MEAL_CARD_TRENDYOL_PROMOTION;DELIVERY_FEE_SUMMARY_HIDDEN",
    },
    { header: "x-storefront-id", operation: "set", value: "1" },
    { header: "x-storefrontid", operation: "set", value: "1" },
    {
      header: "x-supported-payment-options",
      operation: "set",
      value: _TY_LC_PAY_SUPPORTED,
    },
    { header: "searchsegment", operation: "set", value: "20" },
    { header: "gender", operation: "set", value: "F" },
    { header: "x-visitor-type", operation: "set", value: "4" },
    {
      header: "segments",
      operation: "set",
      value: "140750000_0,410750000_1,365750000_generic_6",
    },
    {
      header: "traceparent",
      operation: "set",
      value: `00-${traceId}-${spanId}-01`,
    },
    {
      header: "tracestate",
      operation: "set",
      value: `@nr=0-2---${spanId}----${ts}`,
    },
    { header: "newrelic", operation: "set", value: nrPayload },
    { header: "x-b3-traceid", operation: "set", value: traceId },
    { header: "x-b3-spanid", operation: "set", value: spanId },
    { header: "x-b3-sampled", operation: "set", value: "1" },
    { header: "service.name", operation: "set", value: "mobile-android-go" },
    { header: "service.version", operation: "set", value: buildVer },
    { header: "service.type", operation: "set", value: "client" },
    {
      header: "baggage",
      operation: "set",
      value:
        "ty.source.service.name=mobile-android-go,ty.source.service.type=client,ty.source.service.version=" +
        buildVer,
    },
  );

  return removes.concat(sets);
}

/** payment.tgoapps DNR id aralığı — paralel çağrılarda çift add önlemek için hep aynı remove listesi. */
const TY_PAYMENT_DNR_RULE_IDS = [
  8010, 8011, 8012, 8013, 8014, 8015, 8016, 8017, 8018, 8019, 8020,
];
/** Diğer session/dynamic kurallarla çakışmada payment kazanır. */
const TY_PAYMENT_DNR_PRIORITY = 1000;
let _tyPaymentDnrSetupChain = Promise.resolve();

/**
 * /odeme + lc cookie: session DNR — minimal (sadece app-name/perso/session + GET’te Content-Type kaldır + Bearer).
 * Tam lc (_tyBuildLcWebPaymentHeaders) Safari UA + sec-ch-ua Chrome karışımı canlıda 401 üretebiliyor.
 */
async function _tyInstallPaymentLcMinimalDnr(bearer) {
  const hNo = _tyBuildLcPaymentDnrMinimal(bearer, false);
  const hYes = _tyBuildLcPaymentDnrMinimal(bearer, true);
  await chrome.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: TY_PAYMENT_DNR_RULE_IDS,
      addRules: [
        {
          id: 8010,
          priority: TY_PAYMENT_DNR_PRIORITY,
          action: { type: "modifyHeaders", requestHeaders: hNo },
          condition: {
            urlFilter: "||payment.tgoapps.com/*",
            resourceTypes: [
              "xmlhttprequest",
              "other",
              "sub_frame",
              "main_frame",
            ],
            requestMethods: ["get", "head", "options", "delete"],
          },
        },
        {
          id: 8011,
          priority: TY_PAYMENT_DNR_PRIORITY,
          action: { type: "modifyHeaders", requestHeaders: hYes },
          condition: {
            urlFilter: "||payment.tgoapps.com/*",
            resourceTypes: [
              "xmlhttprequest",
              "other",
              "sub_frame",
              "main_frame",
            ],
            requestMethods: ["post", "put", "patch"],
          },
        },
      ],
    })
    .catch((e) => console.warn("[TY Payment DNR] lc minimal:", e?.message));
}

try {
  if (
    chrome.webRequest &&
    chrome.webRequest.onCompleted &&
    !self.__ksTyPayHttpLog
  ) {
    self.__ksTyPayHttpLog = true;
    chrome.webRequest.onCompleted.addListener(
      (d) => {
        try {
          const u = d.url || "";
          if (u.indexOf("payment.tgoapps.com") === -1) return;
          if (
            u.indexOf("/v3/payment") === -1 &&
            u.indexOf("card-fragment") === -1
          )
            return;
          console.log(
            "[TY Payment] HTTP",
            d.statusCode,
            d.method,
            u.replace(/https:\/\/payment\.tgoapps\.com/i, "").slice(0, 90),
          );
        } catch (_) {}
      },
      { urls: ["https://payment.tgoapps.com/*", "https://*.payment.tgoapps.com/*"] },
    );
  }
} catch (_) {}

let _tyPayDnrInstalledJwt = "";

async function setupTrendyolPaymentHeaderRules(options) {
  const next = _tyPaymentDnrSetupChain.then(() =>
    _setupTrendyolPaymentHeaderRulesCore(options || {}),
  );
  _tyPaymentDnrSetupChain = next.catch(() => {});
  return next;
}

function _tyHasRealDnr() {
  try {
    const dnr = chrome.declarativeNetRequest;
    if (!dnr || typeof dnr.updateSessionRules !== "function") return false;
    if (typeof dnr.MAX_NUMBER_OF_DYNAMIC_RULES === "number") return true;
    if (dnr.RuleActionType) return true;
  } catch (_) {}
  return false;
}

function _tyIsIosExtRuntime() {
  try {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    if (/Orion/i.test(ua) && /Mobile|iOS/i.test(ua)) return true;
  } catch (_) {}
  return false;
}

/** Eski oturumdan kalan payment.tgoapps.com kullanıcı JWT cookie'lerini sil. */
async function _tySetPaymentHostJwtCookies(_tok) {
  const names = ["access_token", "tgo-token", "token", "Authorization"];
  const urls = [
    "https://payment.tgoapps.com/",
    "https://www.payment.tgoapps.com/",
  ];
  await Promise.all(
    names.flatMap((n) =>
      urls.map((u) => chrome.cookies.remove({ url: u, name: n }).catch(() => {})),
    ),
  );
}

async function _setupTrendyolPaymentHeaderRulesCore(_options = {}) {
  // v10.1.9: iframe native x-features header'ı payment/options'da 500 üretiyor.
  // Çözüm: sadece x-features header'ını REMOVE et, geri kalan her şey native kalsın.
  try {
    _tyDisablePaymentWebRequestLc();
    _tyPayDnrInstalledJwt = "";
    await chrome.declarativeNetRequest
      .updateSessionRules({
        removeRuleIds: TY_PAYMENT_DNR_RULE_IDS,
        addRules: [
          {
            id: 8010,
            priority: TY_PAYMENT_DNR_PRIORITY,
            action: {
              type: "modifyHeaders",
              requestHeaders: [
                {
                  header: "x-features",
                  operation: "set",
                  value:
                    "OPTIONAL_REBATE;MEAL_CART_ENABLED;MEAL_CARD_TRENDYOL_PROMOTION;",
                },
                {
                  header: "x-supported-payment-options",
                  operation: "set",
                  value: "MULTINET;SODEXO;EDENRED;ON_DELIVERY;SETCARD",
                },
              ],
            },
            condition: {
              urlFilter: "||payment.tgoapps.com/*",
              resourceTypes: ["xmlhttprequest", "other", "sub_frame"],
            },
          },
        ],
      })
      .catch((e) => console.warn("[TY Payment DNR]", e?.message));
    console.log(
      "[TY Payment] ℹ️ payment.tgoapps.com DNR: x-features MEAL_CART + supported options",
    );
  } catch (e) {
    console.warn("[TY Payment DNR] Hata:", e?.message);
  }
}

/**
 * Trendyol session kurallarını temizle
 * Web API kendi header'larını kullanacak
 */
async function clearTrendyolHeaderRules() {
  try {
    const existingRules = await chrome.declarativeNetRequest.getSessionRules();
    const existingIds = existingRules
      .filter((r) => r.id >= 8000 && r.id < 9000)
      .map((r) => r.id);

    if (existingIds.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: existingIds,
      });
      console.log("[TY Headers] Kurallar temizlendi:", existingIds.length);
    }
    _tyDisablePaymentWebRequestLc();
  } catch (error) {
    console.error("[TY Headers] Kural temizleme hatası:", error);
  }
}

// Başlangıçta kuralları temizle ve mevcut cookie'leri kontrol et
// NOT: Mobil token zaten storage'da varsa ASLA cookie ile ezme.
(async () => {
  await clearTrendyolHeaderRules();

  try {
    const storageData = await chrome.storage.local.get([
      "tyMobileToken",
      "tyToken",
      "tyTokenSource",
    ]);

    // Mobil token zaten varsa payment DNR kuralını restore et ve çık
    if (
      storageData.tyMobileToken ||
      (storageData.tyTokenSource &&
        storageData.tyTokenSource.startsWith("mobile:"))
    ) {
      console.log(
        "[Init] ✅ Mobil token mevcut, cookie kontrolü atlandı:",
        storageData.tyTokenSource,
      );
      await setupTrendyolPaymentHeaderRules({ preferWebPaymentProfile: true });
      return;
    }

    const accessCookie =
      (await _tyGetTgoyemekCookieFirst("accessToken")) ||
      (await _tyGetTgoyemekCookieFirst("access_token"));
    const tgoCookie = await _tyGetTgoyemekCookieFirst("tgo-token");
    const cookieToken =
      (accessCookie && accessCookie.value) || (tgoCookie && tgoCookie.value);

    if (cookieToken && looksLikeMobileJwt(cookieToken)) {
      await setTrendyolMobileToken(
        cookieToken,
        accessCookie ? "init-cookie:access_token" : "init-cookie:tgo-token",
      );
    } else if (cookieToken) {
      console.warn(
        "[Init] ⚠️ Cookie token mobil değil, yazılmadı:",
        summarizeJwt(cookieToken),
      );
    }
  } catch (error) {
    console.log("[Init] Cookie kontrol hatası:", error);
  }
})();

// Cookie değişikliklerini izle — mobil token aktifse ASLA web cookie ile ezme!
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  if (changeInfo.removed) return;

  const cookie = changeInfo.cookie;
  if (!cookie.domain.includes("tgoyemek.com")) return;
  if (
    cookie.name !== "access_token" &&
    cookie.name !== "accessToken" &&
    cookie.name !== "tgo-token"
  )
    return;

  if (
    _tyPayDnrInstalledJwt &&
    cookie.value &&
    cookie.value === _tyPayDnrInstalledJwt
  ) {
    return;
  }

  if (
    (cookie.name === "tgo-token" || cookie.name === "access_token") &&
    (cookie.path === "/" || !cookie.path)
  ) {
    if (cookie.value && cookie.value.startsWith("ey")) {
      await chrome.storage.local
        .set({ trendyolWebToken: cookie.value })
        .catch(() => {});
    }
    await setupTrendyolPaymentHeaderRules({
      preferWebPaymentProfile: true,
    }).catch(() => {});
    return;
  }

  const storageData = await chrome.storage.local.get([
    "tyMobileToken",
    "tyToken",
    "tyTokenSource",
  ]);

  if (
    storageData.tyMobileToken ||
    (storageData.tyTokenSource &&
      storageData.tyTokenSource.startsWith("mobile:"))
  ) {
    try {
      if (
        _tyIsUsablePaymentBearerJwt(cookie.value) &&
        !_tyJwtIsTrendyolGoPool(cookie.value)
      ) {
        await chrome.storage.local
          .set({ trendyolWebToken: cookie.value })
          .catch(() => {});
      }
    } catch (_) {}
    await setupTrendyolPaymentHeaderRules({
      preferWebPaymentProfile: true,
    }).catch(() => {});
    return;
  }

  await chrome.storage.local.set({
    tyToken: cookie.value,
    tyTokenSource: "web-cookie:" + cookie.name,
  });

  try {
    if (
      _isLikelyWebSessionJwt(cookie.value) ||
      _tyIsUsablePaymentBearerJwt(cookie.value)
    ) {
      const prev = await chrome.storage.local.get(["trendyolWebToken"]);
      if (prev.trendyolWebToken !== cookie.value) {
        await chrome.storage.local.set({ trendyolWebToken: cookie.value });
        await setupTrendyolPaymentHeaderRules({
          preferWebPaymentProfile: true,
        }).catch(() => {});
      }
    }
  } catch (_) {}
});

/** tgoyemek SPA: pushState ile /odeme’ye gelince onCommitted çalışmayabilir. */
function _tyTgoyemekPath(urlStr) {
  try {
    return (new URL(urlStr).pathname || "").replace(/\/+$/, "") || "/";
  } catch (_) {
    return "";
  }
}

function _tyUrlIsTgoyemekOdeme(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return false;
  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "tgoyemek.com") return false;
    const pathLower = (u.pathname || "").toLowerCase();
    const hrefL = urlStr.toLowerCase();
    if (/eksik-bilgi|eksik_bilgi/i.test(pathLower)) return false;
    return (
      pathLower.includes("odeme") ||
      pathLower.includes("ödeme") ||
      hrefL.includes("%c3%b6deme")
    );
  } catch (_) {
    return false;
  }
}

function _tyUrlIsSepet(urlStr) {
  const p = _tyTgoyemekPath(urlStr);
  return p === "/sepet" || p.startsWith("/sepet/");
}

function _tyUrlIsCheckoutFlow(urlStr) {
  return _tyUrlIsTgoyemekOdeme(urlStr) || _tyUrlIsSepet(urlStr);
}

function _tyUrlIsRestaurantList(urlStr) {
  return _tyTgoyemekPath(urlStr) === "/restoranlar";
}

function _tyUrlIsRestaurantDetail(urlStr) {
  const p = _tyTgoyemekPath(urlStr);
  return p.startsWith("/restoranlar/");
}

function _tyUrlIsGatedSsr(urlStr) {
  const p = _tyTgoyemekPath(urlStr);
  if (!p || p === "/") return true;
  if (_tyUrlIsRestaurantList(urlStr) || _tyUrlIsRestaurantDetail(urlStr))
    return true;
  if (_tyUrlIsTgoyemekOdeme(urlStr)) return false;
  return /\/(sepet|siparislerim|siparisler|hesabim|favoriler|kampanyalar|arama|uyelik)/i.test(
    p,
  );
}

function _tyUrlIsOdemeBasarili(urlStr) {
  return /odeme-basarili/i.test(_tyTgoyemekPath(urlStr));
}

async function _tyIsCheckoutLocked() {
  try {
    const s = await chrome.storage.local.get([
      "tyCheckoutPending",
      "tyCheckoutLockUntil",
    ]);
    if (s.tyCheckoutLockUntil && Date.now() > s.tyCheckoutLockUntil) {
      if (s.tyCheckoutPending) {
        chrome.storage.local.set({ tyCheckoutPending: false }).catch(() => {});
      }
      return false;
    }
    return !!s.tyCheckoutPending;
  } catch (_) {
    return false;
  }
}

async function _tyArmCheckoutLock() {
  await chrome.storage.local.set({
    tyCheckoutPending: true,
    tyOdemePageActive: true,
    tyCheckoutLockUntil: Date.now() + 120000,
  });
}

async function _tyStripRootAuthForOdemeSsr() {
  // v38: kök JWT silmek /odeme SSR'ı /giris?callbackUrl=/odeme'ye atıyor.
  console.log("[Trendyol] v38: root JWT strip atlandı (web oturum)");
}

async function _tySetCookieIfChanged(details) {
  try {
    const cur = await chrome.cookies.get({
      url: details.url,
      name: details.name,
    });
    if (
      cur &&
      cur.value === details.value &&
      (cur.path || "/") === (details.path || "/")
    ) {
      return false;
    }
  } catch (_) {}
  await chrome.cookies.set(details).catch(() => {});
  return true;
}

/** kök + /odeme path web JWT — oturum /giris'e düşmesin. */
async function _tyRestoreRootWebJwt() {
  let tok = "";
  try {
    tok = (await _ensureTgoWebJwt()) || "";
  } catch (_) {}
  if (!tok || !String(tok).startsWith("ey")) {
    console.warn("[Trendyol] v40: restore JWT yok");
    return false;
  }
  // Root path'e ASLA tgo-token yazma (SSR eksik bilgi redirect döngüsüne girer)
  await chrome.cookies.remove({ url: "https://tgoyemek.com/", name: "tgo-token" }).catch(() => {});
  await chrome.cookies.remove({ url: "https://tgoyemek.com/", name: "access_token" }).catch(() => {});
  await _tySetOdemePathWebJwt();
  return true;
}
async function _tySetOdemePathWebJwt() {
  let web = "";
  let pay = "";
  try {
    web = (await _ensureTgoWebJwt()) || "";
  } catch (_) {}
  try {
    pay = (await _ensureTgoPaymentJwt()) || "";
  } catch (_) {}
  const ssrTok = web || pay;
  const jsTok = web || pay;
  if (!ssrTok || !String(ssrTok).startsWith("ey")) {
    console.warn("[Trendyol] v42: /odeme JWT yok");
    return false;
  }
  const exp = Math.floor(Date.now() / 1000) + 604800;
  // Root'u temiz tut
  await chrome.cookies.remove({ url: "https://tgoyemek.com/", name: "tgo-token" }).catch(() => {});
  await chrome.cookies.remove({ url: "https://tgoyemek.com/", name: "access_token" }).catch(() => {});
  const wrote = [];
  // Yalnızca /odeme ve /odeme-basarili path'lerine yaz (Hem tgoyemek.com hem .tgoyemek.com)
  for (const p of ["/odeme", "/odeme-basarili"]) {
    for (const dom of ["tgoyemek.com", ".tgoyemek.com"]) {
      wrote.push(
        await _tySetCookieIfChanged({
          url: "https://" + dom.replace(/^\./, '') + p,
          name: "tgo-token",
          value: ssrTok,
          domain: dom,
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          path: p,
          expirationDate: exp,
        }),
      );
      wrote.push(
        await _tySetCookieIfChanged({
          url: "https://" + dom.replace(/^\./, '') + p,
          name: "access_token",
          value: jsTok,
          domain: dom,
          secure: true,
          httpOnly: false,
          sameSite: "lax",
          path: p,
          expirationDate: exp,
        }),
      );
    }
  }
  if (wrote.some(Boolean)) {
    console.log(
      "[Trendyol] v43: tgo-token+access_token scoped to /odeme, root kept clean",
    );
  }
  return true;
}

/** Mobil `token` cookie ödeme iframe'inin lc JWT'sini ezer → yöntemler/buton kilitlenir. */
async function _tyStripOdemeMobileAuthCookies() {
  // /odeme ve /odeme-basarili altındaki auth token'lar korunmalıdır; silindiğinde ödeme sayfası kullanıcıyı oturumsuz sanarak /giris'e atar.
  return;
}

async function _tyPrepareOdemePaymentSession() {
  if (typeof ksPayBasketFrozen === "function" && ksPayBasketFrozen()) {
    console.log("[Trendyol] odeme session atlandı (ödeme sepet kilit)");
    return;
  }
  const now = Date.now();
  if (
    _tyPrepareOdemePaymentSession._lastAt &&
    now - _tyPrepareOdemePaymentSession._lastAt < 4000
  )
    return;
  _tyPrepareOdemePaymentSession._lastAt = now;
  await _tySetOdemePathWebJwt();
  await _tyStripOdemeMobileAuthCookies();
  if (typeof setupTrendyolPaymentHeaderRules === "function") {
    setupTrendyolPaymentHeaderRules({ preferWebPaymentProfile: true }).catch(
      () => {},
    );
  }
}

async function _tyRedirectCheckoutToOdeme(tabId, reason) {
  const now = Date.now();
  if (
    _tyRedirectCheckoutToOdeme._lastAt &&
    now - _tyRedirectCheckoutToOdeme._lastAt < 700
  ) {
    return false;
  }
  _tyRedirectCheckoutToOdeme._lastAt = now;
  if (!applyTgoAndroidSsrBypass._odemeRetry)
    applyTgoAndroidSsrBypass._odemeRetry = {};
  const retries = applyTgoAndroidSsrBypass._odemeRetry[tabId] || 0;
  if (retries >= 6) {
    console.warn("[Trendyol] v34: /odeme retry cap —", reason);
    return false;
  }
  applyTgoAndroidSsrBypass._odemeRetry[tabId] = retries + 1;
  await _tyRestoreRootWebJwt();
  await _tyStripCheckoutAndroidCookies();
  await _tySetOdemePathWebJwt();
  console.log(
    "[Trendyol] v39 checkout lock belge → /odeme",
    reason,
    "retry",
    retries + 1,
  );
  chrome.tabs
    .update(tabId, { url: "https://tgoyemek.com/odeme" })
    .catch(() => {});
  return true;
}

function _tyOnTgoyemekNavigation(urlStr, tabId) {
  try {
    if (!urlStr || typeof urlStr !== "string") return;
    let host = "";
    try {
      host = new URL(urlStr).hostname.replace(/^www\./i, "").toLowerCase();
    } catch (_) {
      return;
    }
    if (host !== "tgoyemek.com") return;
    if (_tyUrlIsTgoyemekOdeme(urlStr)) {
      if (_tyUrlIsOdemeBasarili(urlStr)) {
        chrome.storage.local
          .set({ tyOdemePageActive: true, tyCheckoutPending: false })
          .catch(() => {});
      } else {
        chrome.storage.local.set({ tyOdemePageActive: true }).catch(() => {});
      }
      _tyPrepareOdemePaymentSession().catch(() => {});
      chrome.storage.local
        .get(["tyCheckoutPending"])
        .then((s) => {
          if (s.tyCheckoutPending) return;
          setTimeout(() => {
            stripTgoAndroidCookiesForWebPayment().catch(() => {});
          }, 800);
        })
        .catch(() => {});
    } else if (_tyUrlIsRestaurantDetail(urlStr)) {
      chrome.storage.local
        .set({ tyCheckoutPending: false, tyOdemePageActive: false })
        .catch(() => {});
    } else if (
      _tyUrlIsRestaurantList(urlStr) ||
      _tyTgoyemekPath(urlStr) === "/"
    ) {
      chrome.storage.local
        .get(["tyCheckoutPending"])
        .then((s) => {
          if (s.tyCheckoutPending && tabId) {
            _tyRedirectCheckoutToOdeme(tabId, "hist-list");
            return;
          }
          chrome.storage.local
            .set({ tyOdemePageActive: false })
            .catch(() => {});
        })
        .catch(() => {});
    } else {
      chrome.storage.local
        .get(["tyCheckoutPending"])
        .then((s) => {
          if (s.tyCheckoutPending) return;
          chrome.storage.local
            .set({ tyOdemePageActive: false })
            .catch(() => {});
        })
        .catch(() => {});
    }
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sayfaya giderken tgo-token/access_token cookie'yi ROOT path'te
// SET ETMİYOR! Cookie header tamamen boş gidiyor.
// Bu sayede Trendyol SSR middleware JWT bulamıyor → anonim kullanıcı →
// eksik-bilgi redirect'i YOK → sayfa normal yükleniyor.
// API istekleri ise proxy üzerinden authenticated olarak gidiyor.
//
// BİZİM HATA: Her navigasyonda tgo-token + access_token set ediyorduk.
// Bu JWT'yi sunucuya gönderiyordu → StandardUser:"0" → eksik-bilgi redirect!
//
// ÇÖZÜM: Genel sayfalarda tgo-token/access_token cookie SET ETME!
// Sadece /odeme path'inde set et (checkout ANDROID cookie'leri ile birlikte).
// ═══════════════════════════════════════════════════════════════════════════════
/* [Proven Architecture]
 * Deactivated webNavigation redirect hijacking for tgoyemek.com.
 * This architecture does not tamper with webNavigation, eliminating all infinite redirect loops,
 * Next.js router freeze, and broken back/forward navigation.
 */

/**
 * Migros header kuralları — çoklu priority sistemi
 *
 * Her endpoint tipine farklı header seti uygulanır. Mobil API'ye okhttp
 * imzasıyla, web frontend ve ödeme isteğine tarayıcı imzasıyla gidilir:
 * - id 9877: rest.migros.com.tr için temel cookie (priority 2)
 * - id 9890: www.migros.com.tr için web header (priority 5)
 * - id 9878: rest.migros.com.tr için MOBİL API header (priority 10)
 * - id 9885: hexapolygons (CART screen) (priority 100)
 * - id 9886: checkouts (sepet/ödeme) (priority 200)
 * - id 9999: purchase/online/credit-card için WEB header (priority 1000)
 */
async function setupMigrosHeaderRules(
  rememberMeValue,
  deviceIdParam,
  deviceModelParam,
) {
  try {
    console.log("[Migros] DeclarativeNetRequest kuralları ekleniyor...");

    // Önce mevcut Migros kurallarını temizle (9877-9999 arası)
    const existingRules = await chrome.declarativeNetRequest.getSessionRules();
    const migrosRuleIds = existingRules
      .filter((r) => r.id >= 9877 && r.id <= 9999)
      .map((r) => r.id);

    if (migrosRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: migrosRuleIds,
      });
    }

    // Migros device bilgisi — yeni üretilmişse onu kullan
    const stored = await chrome.storage.local.get("migros_device_info");
    const device =
      stored.migros_device_info || generateMigrosDeviceIdentifiers();
    const deviceId = deviceIdParam || device.deviceId;
    const deviceModel = deviceModelParam || device.model;
    const apiLevel = device.apiLevel || "9";
    const appVersion = device.appVersion || "26.11.0"; // güncel Migros app sürümü
    // X-Device-Sign formatı: YYYYMMDDHHmm (dakikaya kadar — canlı imza)
    const _now = new Date();
    const _pad = (n) => String(n).padStart(2, "0");
    const deviceSign =
      "" +
      _now.getFullYear() +
      _pad(_now.getMonth() + 1) +
      _pad(_now.getDate()) +
      _pad(_now.getHours()) +
      _pad(_now.getMinutes());

    // Tarayıcının kendi User-Agent'ını al (web istekleri için)
    const browserUserAgent =
      typeof navigator !== "undefined" && navigator.userAgent
        ? navigator.userAgent
        : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

    // 6 ayrı priority'li kural seti (her endpoint tipine özel header)
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        // ── ID 9877: rest.migros.com.tr için temel remember-me cookie ──
        {
          id: 9877,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              {
                header: "Cookie",
                operation: "set",
                value: `remember-me=${rememberMeValue}`,
              },
            ],
          },
          condition: {
            requestDomains: ["rest.migros.com.tr"],
            resourceTypes: ["xmlhttprequest"],
          },
        },

        // ── ID 9890: www.migros.com.tr için WEB header'ları (PWA görünümü) ──
        {
          id: 9890,
          priority: 5,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              {
                header: "Cookie",
                operation: "set",
                value: `remember-me=${rememberMeValue}`,
              },
              {
                header: "User-Agent",
                operation: "set",
                value: browserUserAgent,
              },
              {
                header: "sec-ch-ua-platform",
                operation: "set",
                value: '"Windows"',
              },
              { header: "accept-language", operation: "set", value: "tr" },
              {
                header: "sec-ch-ua",
                operation: "set",
                value:
                  '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
              },
              { header: "x-forwarded-rest", operation: "set", value: "true" },
              { header: "sec-ch-ua-mobile", operation: "set", value: "?0" },
              { header: "x-device-pwa", operation: "set", value: "true" },
              { header: "x-pwa", operation: "set", value: "true" },
              { header: "accept", operation: "set", value: "application/json" },
              {
                header: "sec-fetch-site",
                operation: "set",
                value: "same-origin",
              },
              { header: "sec-fetch-mode", operation: "set", value: "cors" },
              { header: "sec-fetch-dest", operation: "set", value: "empty" },
              {
                header: "referer",
                operation: "set",
                value: "https://www.migros.com.tr/",
              },
              {
                header: "accept-encoding",
                operation: "set",
                value: "gzip, deflate, br, zstd",
              },
            ],
          },
          condition: {
            requestDomains: ["www.migros.com.tr"],
            resourceTypes: [
              "xmlhttprequest",
              "main_frame",
              "sub_frame",
              "stylesheet",
              "script",
              "image",
              "font",
              "object",
              "other",
            ],
          },
        },

        // ── ID 9878: rest.migros.com.tr için MOBİL API header'ları (esas kural) ──
        {
          id: 9878,
          priority: 10,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              // Web başlıklarını kaldır (kapsamlı liste)
              { header: "sec-ch-ua", operation: "remove" },
              { header: "sec-ch-ua-mobile", operation: "remove" },
              { header: "sec-ch-ua-platform", operation: "remove" },
              { header: "Sec-Fetch-Dest", operation: "remove" },
              { header: "Sec-Fetch-Mode", operation: "remove" },
              { header: "Sec-Fetch-Site", operation: "remove" },
              { header: "Sec-Fetch-User", operation: "remove" },
              { header: "Sec-Fetch-Storage-Access", operation: "remove" },
              { header: "priority", operation: "remove" }, // okhttp UA ile çelişir → bot tetikler
              { header: "referer", operation: "remove" },
              { header: "origin", operation: "remove" }, // okhttp UA ile çelişir → bot tetikler
              { header: "x-ab-tests", operation: "remove" },
              { header: "x-forwarded-rest", operation: "remove" },
              { header: "x-pwa", operation: "remove" },
              { header: "x-device-pwa", operation: "remove" },
              { header: "x-device-channel", operation: "remove" }, // tarayıcı tarafı header — mobil app yok

              // Mobil header'ları ekle (gerçek Migros mobil app'in gönderdikleri)
              {
                header: "X-Device-Platform",
                operation: "set",
                value: "ANDROID",
              },
              {
                header: "X-Device-Platform-Version",
                operation: "set",
                value: apiLevel,
              },
              { header: "X-Device-Type", operation: "set", value: "MOBILE" },
              {
                header: "X-Device-App-Version",
                operation: "set",
                value: appVersion,
              },
              {
                header: "X-Device-Identifier",
                operation: "set",
                value: deviceId,
              },
              {
                header: "X-Device-Model",
                operation: "set",
                value: deviceModel,
              },
              { header: "X-Device-Sign", operation: "set", value: deviceSign },
              {
                header: "X-Device-App-Screen",
                operation: "set",
                value: "CART",
              },
              { header: "Accept-Language", operation: "set", value: "tr-TR" },
              {
                header: "Accept-Encoding",
                operation: "set",
                value: "gzip, deflate, br, zstd",
              },
              { header: "User-Agent", operation: "set", value: "okhttp/5.3.2" },
              {
                header: "content-type",
                operation: "set",
                value: "application/json; charset=UTF-8",
              },
              { header: "accept", operation: "set", value: "application/json" },
            ],
          },
          condition: {
            requestDomains: ["rest.migros.com.tr"],
            resourceTypes: [
              "xmlhttprequest",
              "main_frame",
              "sub_frame",
              "stylesheet",
              "script",
              "image",
              "font",
              "object",
              "other",
            ],
          },
        },

        // ── ID 9881: profil ikonu (avatar değişim takibi) — block ──
        // Tarayıcı seviyesinde direkt block (interceptor'a inmeden önce kesilir)
        {
          id: 9881,
          priority: 50,
          action: { type: "block" },
          condition: {
            urlFilter: "*profilim_icon_s.webp*",
            resourceTypes: ["image", "xmlhttprequest"],
          },
        },

        // ── ID 9885: hexapolygons (konum/teslimat) — EN YÜKSEK priority (300) ──
        // KRİTİK: hexapolygons URL'si `/checkouts/screens/hexapolygons` formatında,
        // yani 9886'nın `*/checkouts/*` matcher'ına da uyuyor. priority 100 iken
        // 9886 (priority 200) bu kuralı override ediyordu → hexapolygons yanlış
        // header set'iyle gidiyor, Migros 99005 dönüyordu.
        // priority 300 ile bu kuralın hexapolygons için kazanmasını garanti ediyoruz.
        {
          id: 9885,
          priority: 300,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "x-ab-tests", operation: "remove" },
              { header: "x-pwa", operation: "remove" },
              { header: "sec-ch-ua", operation: "remove" },
              { header: "sec-ch-ua-mobile", operation: "remove" },
              { header: "sec-ch-ua-platform", operation: "remove" },
              { header: "sec-fetch-site", operation: "remove" },
              { header: "sec-fetch-mode", operation: "remove" },
              { header: "sec-fetch-dest", operation: "remove" },
              { header: "sec-fetch-storage-access", operation: "remove" },
              { header: "priority", operation: "remove" }, // browser-only HTTP/2 hint
              { header: "referer", operation: "remove" },
              { header: "origin", operation: "remove" }, // mobil app göndermez
              { header: "x-device-pwa", operation: "remove" },
              { header: "x-forwarded-rest", operation: "remove" },
              { header: "x-device-channel", operation: "remove" }, // tarayıcı tarafı

              {
                header: "X-Device-Platform",
                operation: "set",
                value: "ANDROID",
              },
              {
                header: "X-Device-Platform-Version",
                operation: "set",
                value: apiLevel,
              },
              { header: "X-Device-Type", operation: "set", value: "MOBILE" },
              {
                header: "X-Device-App-Version",
                operation: "set",
                value: appVersion,
              },
              {
                header: "X-Device-Identifier",
                operation: "set",
                value: deviceId,
              },
              {
                header: "X-Device-Model",
                operation: "set",
                value: deviceModel,
              },
              { header: "X-Device-Sign", operation: "set", value: deviceSign },
              {
                header: "X-Device-App-Screen",
                operation: "set",
                value: "CART",
              },
              { header: "Accept-Language", operation: "set", value: "tr-TR" },
              {
                header: "Accept-Encoding",
                operation: "set",
                value: "gzip, deflate, br, zstd",
              },
              { header: "User-Agent", operation: "set", value: "okhttp/5.3.2" },
              {
                header: "content-type",
                operation: "set",
                value: "application/json; charset=UTF-8",
              },
              { header: "accept", operation: "set", value: "application/json" },
            ],
          },
          condition: {
            urlFilter: "*hexapolygons*",
            requestDomains: ["rest.migros.com.tr"],
            resourceTypes: ["xmlhttprequest"],
          },
        },

        // ── ID 9886: checkouts (sepet/ödeme) — daha yüksek priority ──
        {
          id: 9886,
          priority: 200,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "sec-ch-ua", operation: "remove" },
              { header: "sec-ch-ua-mobile", operation: "remove" },
              { header: "sec-ch-ua-platform", operation: "remove" },
              { header: "sec-fetch-site", operation: "remove" },
              { header: "sec-fetch-mode", operation: "remove" },
              { header: "sec-fetch-dest", operation: "remove" },
              { header: "x-pwa", operation: "remove" },
              { header: "x-device-pwa", operation: "remove" },
              { header: "x-forwarded-rest", operation: "remove" },
              { header: "referer", operation: "remove" },

              {
                header: "X-Device-Platform",
                operation: "set",
                value: "ANDROID",
              },
              {
                header: "X-Device-Platform-Version",
                operation: "set",
                value: apiLevel,
              },
              { header: "X-Device-Type", operation: "set", value: "MOBILE" },
              {
                header: "X-Device-App-Version",
                operation: "set",
                value: appVersion,
              },
              {
                header: "X-Device-Identifier",
                operation: "set",
                value: deviceId,
              },
              {
                header: "X-Device-Model",
                operation: "set",
                value: deviceModel,
              },
              { header: "X-Device-Sign", operation: "set", value: deviceSign },
              {
                header: "X-Device-App-Screen",
                operation: "set",
                value: "CART",
              },
              {
                header: "X-Device-Channel",
                operation: "set",
                value: "BROWSER",
              },
              {
                header: "origin",
                operation: "set",
                value: "https://www.migros.com.tr",
              },
              { header: "priority", operation: "set", value: "u=1, i" },
              { header: "Accept-Language", operation: "set", value: "tr-TR" },
              {
                header: "Accept-Encoding",
                operation: "set",
                value: "gzip, deflate, br, zstd",
              },
              { header: "User-Agent", operation: "set", value: "okhttp/5.3.2" },
              {
                header: "content-type",
                operation: "set",
                value: "application/json; charset=UTF-8",
              },
              { header: "accept", operation: "set", value: "application/json" },
            ],
          },
          // NOT: hexapolygons da `/checkouts/screens/hexapolygons` formatında ama
          // 9885 (priority 300) bu kurala göre kazanır, çakışma yok.
          condition: {
            urlFilter: "*/checkouts/*",
            requestDomains: ["rest.migros.com.tr"],
            resourceTypes: ["xmlhttprequest"],
          },
        },

        // ── ID 9882: purchase için tarayıcı UA + Client Hints ikinci katmanı ──
        // 9999 ana web header'larını set ediyor; bu kural ek olarak Client Hints
        // değerlerini garantiler (ara durum güvenlik ağı)
        {
          id: 9882,
          priority: 10,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              {
                header: "User-Agent",
                operation: "set",
                value: browserUserAgent,
              },
              {
                header: "sec-ch-ua-platform",
                operation: "set",
                value: '"Windows"',
              },
              { header: "accept-language", operation: "set", value: "tr" },
              {
                header: "sec-ch-ua",
                operation: "set",
                value:
                  '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
              },
              { header: "sec-ch-ua-mobile", operation: "set", value: "?0" },
            ],
          },
          condition: {
            urlFilter: "*purchase/online/credit-card*",
            resourceTypes: [
              "xmlhttprequest",
              "main_frame",
              "sub_frame",
              "stylesheet",
              "script",
              "image",
              "font",
              "object",
              "other",
            ],
          },
        },

        // ── ID 9999: purchase/online/credit-card için WEB header (en yüksek priority) ──
        // Ödeme isteği WEB tarayıcısı imzasıyla gitmeli (mobil değil)
        {
          id: 9999,
          priority: 1000,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              // Mobil header'ları kaldır
              { header: "X-Device-Platform", operation: "remove" },
              { header: "X-Device-Platform-Version", operation: "remove" },
              { header: "X-Device-Type", operation: "remove" },
              { header: "X-Device-App-Version", operation: "remove" },
              { header: "X-Device-Identifier", operation: "remove" },
              { header: "X-Device-Model", operation: "remove" },
              { header: "X-Device-App-Screen", operation: "remove" },

              // Web header'ları ekle
              {
                header: "User-Agent",
                operation: "set",
                value: browserUserAgent,
              },
              {
                header: "sec-ch-ua-platform",
                operation: "set",
                value: '"Windows"',
              },
              { header: "accept-language", operation: "set", value: "tr" },
              {
                header: "sec-ch-ua",
                operation: "set",
                value:
                  '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
              },
              { header: "x-forwarded-rest", operation: "set", value: "true" },
              { header: "sec-ch-ua-mobile", operation: "set", value: "?0" },
              { header: "x-device-pwa", operation: "set", value: "true" },
              { header: "x-pwa", operation: "set", value: "true" },
              { header: "accept", operation: "set", value: "application/json" },
              {
                header: "sec-fetch-site",
                operation: "set",
                value: "same-origin",
              },
              { header: "sec-fetch-mode", operation: "set", value: "cors" },
              { header: "sec-fetch-dest", operation: "set", value: "empty" },
              {
                header: "referer",
                operation: "set",
                value: "https://www.migros.com.tr/hemen/siparis/odeme/",
              },
              {
                header: "accept-encoding",
                operation: "set",
                value: "gzip, deflate, br, zstd",
              },
              { header: "priority", operation: "set", value: "u=1, i" },
            ],
          },
          condition: {
            urlFilter: "*purchase/online/credit-card*",
            resourceTypes: [
              "xmlhttprequest",
              "main_frame",
              "sub_frame",
              "stylesheet",
              "script",
              "image",
              "font",
              "object",
              "other",
            ],
          },
        },
      ],
    });

    console.log(
      "[Migros] DeclarativeNetRequest kuralları eklendi — 8 priority kural (hexapolygons öncelikli: 300)",
    );
    console.log("[Migros] Aktif device:", {
      model: deviceModel,
      deviceId: deviceId.substring(0, 8) + "...",
      appVersion,
      apiLevel,
    });
  } catch (error) {
    console.error("[Migros] Header kuralları eklenirken hata:", error);
  }
}

/**
 * Migros location fonksiyonları - eski eklentiden
 */
async function fetchMigrosCities() {
  const requestId =
    Date.now().toString() + Math.floor(Math.random() * 1000000000).toString();
  const response = await fetch(
    `https://www.migros.com.tr/rest/delivery-bff/locations/cities/deliverable?reid=${requestId}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Language": "tr",
      },
      credentials: "include",
    },
  );

  if (!response.ok) {
    throw new Error(`Migros şehir verisi alınamadı: ${response.status}`);
  }

  return await response.json();
}

async function fetchMigrosTowns(cityId) {
  const requestId =
    Date.now().toString() + Math.floor(Math.random() * 1000000000).toString();
  const response = await fetch(
    `https://www.migros.com.tr/rest/delivery-bff/locations/towns/${cityId}/deliverable?reid=${requestId}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Language": "tr",
      },
      credentials: "include",
    },
  );

  if (!response.ok) {
    throw new Error(`Migros ilçe verisi alınamadı: ${response.status}`);
  }

  return await response.json();
}

async function fetchMigrosDistricts(townId) {
  const requestId =
    Date.now().toString() + Math.floor(Math.random() * 1000000000).toString();
  const response = await fetch(
    `https://www.migros.com.tr/rest/delivery-bff/locations/districts/${townId}/deliverable?reid=${requestId}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Language": "tr",
      },
      credentials: "include",
    },
  );

  if (!response.ok) {
    throw new Error(`Migros mahalle verisi alınamadı: ${response.status}`);
  }

  return await response.json();
}

// Migros için eşleştirme — Trendyol'daki gelişmiş findMatchInList'i kullanır.
// `findMatchInList` zaten cleanSuffix (Mh./Mahallesi/Köyü...) + 8 aşamalı fuzzy + Levenshtein
// içeriyor. Migros için de aynısı yeterli.
function findMatchInMigrosData(dataArray, searchName, isNeighborhood = false) {
  if (!dataArray || !searchName) return null;
  return findMatchInList(dataArray, searchName);
}

async function fetchMigrosLocationData(address) {
  try {
    const cities = await fetchMigrosCities();
    const searchCity = address.province || address.city;
    const matchedCity = findMatchInMigrosData(cities, searchCity);

    if (!matchedCity) {
      console.warn("[Migros] Şehir bulunamadı:", searchCity);
      return null;
    }

    const towns = await fetchMigrosTowns(matchedCity.id);

    // "<şehir> Merkez" → "Merkez" normalizasyonu
    let districtSearchName = address.district || "";
    const simpCity = simplifyText(searchCity || "");
    const simpDist = simplifyText(districtSearchName);
    if (
      simpDist === simpCity + "merkez" ||
      simpDist.includes(simpCity + "merkez") ||
      / merkez$/i.test(districtSearchName)
    ) {
      console.log("[Migros] İlçe normalize:", districtSearchName, "→ Merkez");
      districtSearchName = "Merkez";
    }

    const matchedTown = findMatchInMigrosData(towns, districtSearchName);

    if (!matchedTown) {
      console.warn(
        "[Migros] İlçe bulunamadı:",
        address.district,
        "| ilk 10:",
        towns.slice(0, 10).map((t) => t.name),
      );
      return {
        cityId: matchedCity.id,
        townId: null,
        districtId: null,
        cityName: matchedCity.name,
      };
    }

    const districts = await fetchMigrosDistricts(matchedTown.id);
    // findMatchInList zaten "Mh./Mahallesi/Köyü" suffix'lerini cleanSuffix ile temizliyor
    // ve 8 aşamalı fuzzy yapıyor. Ayrı suffix denemeleri gereksiz.
    const matchedDistrict = findMatchInMigrosData(
      districts,
      address.neighborhood,
      true,
    );

    if (!matchedDistrict) {
      console.warn(
        "[Migros] Mahalle bulunamadı:",
        address.neighborhood,
        "| ilk 10:",
        districts.slice(0, 10).map((d) => d.name),
      );
      return {
        cityId: matchedCity.id,
        townId: matchedTown.id,
        districtId: null,
        cityName: matchedCity.name,
        townName: matchedTown.name,
      };
    }

    return {
      cityId: matchedCity.id,
      townId: matchedTown.id,
      districtId: matchedDistrict.id,
      cityName: matchedCity.name,
      townName: matchedTown.name,
      districtName: matchedDistrict.name,
    };
  } catch (error) {
    console.error("[Migros] Location data hatası:", error);
    throw error;
  }
}

/**
 * Migros URL Engelleme - Token prefix'ine göre erişilmemesi gereken URL'leri engelle
 * mg- (sanal market): hemen, yemek ve diğer alt siteleri engelle
 * mgh- (hemen): sanal market, yemek ve diğer alt siteleri engelle
 * mgy- (yemek): sanal market, hemen ve diğer alt siteleri engelle
 */
async function setupMigrosUrlBlocking(service) {
  try {
    // Ortak engellenen alt siteler (tüm token tipleri için)
    const commonBlocked = [
      "elektronik",
      "mion",
      "pet",
      "tazedirekt",
      "macrocenter",
    ];

    // Servise göre ek engellenen yollar
    let blockedPaths = [...commonBlocked];
    let redirectUrl = "https://www.migros.com.tr/";

    // Ana sayfa engelleme flag'i (mgh ve mgy için)
    let blockHomepage = false;

    if (service === "delivery" || service === "sanal") {
      // mg- veya mga-: hemen ve yemek engelle, ana sayfa serbest
      blockedPaths.push("hemen", "yemek");
      redirectUrl = "https://www.migros.com.tr/";
    } else if (service === "hemen") {
      // mgh-: yemek ve ana sayfa engelle
      blockedPaths.push("yemek");
      blockHomepage = true;
      redirectUrl = "https://www.migros.com.tr/hemen";
    } else if (service === "yemek") {
      // mgy-: hemen ve ana sayfa engelle
      blockedPaths.push("hemen");
      blockHomepage = true;
      redirectUrl = "https://www.migros.com.tr/yemek";
    }

    // Content script'in kullanması için storage'a kaydet
    await chrome.storage.local.set({
      migros_blocked_paths: blockedPaths,
      migros_redirect_url: redirectUrl,
      migros_block_homepage: blockHomepage,
    });

    console.log(
      `[Migros] URL engelleme: service=${service}, blocked=${blockedPaths.join(",")}, redirect=${redirectUrl}`,
    );

    // Mevcut Migros URL engelleme kurallarını temizle (ID aralığı: 50000-50099)
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const migrosBlockRuleIds = existingRules
      .filter((r) => r.id >= 50000 && r.id < 50100)
      .map((r) => r.id);

    if (migrosBlockRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: migrosBlockRuleIds,
      });
    }

    // Yeni engelleme kuralları oluştur
    const rules = blockedPaths.map((path, index) => ({
      id: 50000 + index,
      priority: 100,
      action: {
        type: "redirect",
        redirect: { url: redirectUrl },
      },
      condition: {
        urlFilter: `||www.migros.com.tr/${path}*`,
        resourceTypes: ["main_frame"],
      },
    }));

    // Ana sayfa engelleme kuralı (mgh ve mgy için)
    if (blockHomepage) {
      rules.push({
        id: 50099,
        priority: 99,
        action: {
          type: "redirect",
          redirect: { url: redirectUrl },
        },
        condition: {
          // Tam olarak ana sayfaya gidince yönlendir
          regexFilter: "^https://www\\.migros\\.com\\.tr/?(?:\\?.*)?$",
          resourceTypes: ["main_frame"],
        },
      });
    }

    if (rules.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: rules,
      });
      console.log(
        `[Migros] ${rules.length} URL engelleme kuralı eklendi (homepage block: ${blockHomepage})`,
      );
    }
  } catch (error) {
    console.error("[Migros] URL engelleme hatası:", error);
  }
}

/**
 * Content script'e engellenen path listesini döndür
 */
async function getBlockedPathsForContent() {
  try {
    const data = await chrome.storage.local.get([
      "migros_blocked_paths",
      "migros_redirect_url",
      "migros_block_homepage",
    ]);
    return {
      blockedPaths: data.migros_blocked_paths || [],
      redirectUrl: data.migros_redirect_url || "https://www.migros.com.tr/",
      blockHomepage: data.migros_block_homepage || false,
    };
  } catch (error) {
    return {
      blockedPaths: [],
      redirectUrl: "https://www.migros.com.tr/",
      blockHomepage: false,
    };
  }
}

// ====================================
// UBER: DNR header kuralları
// Mod 1 (Android, varsayılan): Android WebView UA + Chromium client hints
// Mod 2 (iOS): macOS Safari 18.6 UA + tüm sec-ch-ua-* REMOVE
// uberMode storage'tan okunur ('android' | 'ios')
// ====================================

// ====================================
// TRENDYOL HEADER OVERRIDE (mobil 429 fix)
// ====================================
// Mobilde service worker'dan fetch ile gönderilen User-Agent ve sec-ch-ua-*
// header'ları tarayıcı tarafından gerçek mobile UA ile override edilir.
// Bu da api.tgoapis.com tarafında HTTP 429 (rate-limit / bot suspect) yer.
// DNR ile bu host'a giden ALL isteklerde UA + Client Hints'i Edge/Windows yaparız.
const TY_RULE_ID_UA = 9200;
const TY_RULE_ID_CH = 9201;
const TY_RULE_ID_ZEUS = 9203; // id 7003 — zeususer için Android Dalvik UA
// v28: DNR ile tgoyemek.com MAIN_FRAME isteklerinde Cookie header'ından
// tgo-token ve access_token'ı kaldır → sunucu JWT görmez → anonim SSR → eksik-bilgi YOK!
// Client-side JS access_token'ı document.cookie'den okur → oturum bilgisi kullanılabilir.
const TY_RULE_ID_STRIP_AUTH_COOKIE = 9206;
const TY_RULE_ID_EKSIK_LEGACY = 9204;
const TY_RULE_ID_EKSIK_LEGACY2 = 9205;
const TY_DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0";
const TY_ANDROID_UA =
  "Dalvik/2.1.0 (Linux; U; Android 9; 2203121C Build/PQ3A.190605.09201023) TrendyolGo/1.45.4.164";

async function setupTrendyolHeaderRules() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      // Eski eksik-bilgi redirect kurallarını da sil (döngü kaynağı)
      removeRuleIds: [
        TY_RULE_ID_UA,
        TY_RULE_ID_CH,
        TY_RULE_ID_ZEUS,
        TY_RULE_ID_EKSIK_LEGACY,
        TY_RULE_ID_EKSIK_LEGACY2,
        TY_RULE_ID_STRIP_AUTH_COOKIE,
      ],
      addRules: [
        // Kural 1: Tüm tgoapis.com isteklerine Desktop UA + web context header'ları ekle
        {
          id: TY_RULE_ID_UA,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "User-Agent", operation: "set", value: TY_DESKTOP_UA },
              {
                header: "sec-ch-ua",
                operation: "set",
                value:
                  '"Not)A;Brand";v="8", "Chromium";v="138", "Microsoft Edge";v="138"',
              },
              { header: "sec-ch-ua-mobile", operation: "set", value: "?0" },
              {
                header: "sec-ch-ua-platform",
                operation: "set",
                value: '"Windows"',
              },
              {
                header: "Origin",
                operation: "set",
                value: "https://tgoyemek.com",
              },
              {
                header: "Referer",
                operation: "set",
                value: "https://tgoyemek.com/",
              },
              {
                header: "Sec-Fetch-Site",
                operation: "set",
                value: "cross-site",
              },
              { header: "Sec-Fetch-Mode", operation: "set", value: "cors" },
              { header: "Sec-Fetch-Dest", operation: "set", value: "empty" },
              {
                header: "Accept-Encoding",
                operation: "set",
                value: "gzip, deflate, br, zstd",
              },
            ],
          },
          condition: {
            requestDomains: ["tgoapis.com", "api.tgoapis.com"],
            resourceTypes: [
              "xmlhttprequest",
              "other",
              "sub_frame",
              "main_frame",
              "script",
              "stylesheet",
              "image",
              "font",
              "media",
              "websocket",
            ],
          },
        },
        // Kural 2: sec-ch-ua extended header'larını kaldır
        {
          id: TY_RULE_ID_CH,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "sec-ch-ua-arch", operation: "remove" },
              { header: "sec-ch-ua-bitness", operation: "remove" },
              { header: "sec-ch-ua-model", operation: "remove" },
              { header: "sec-ch-ua-platform-version", operation: "remove" },
              { header: "sec-ch-ua-full-version", operation: "remove" },
              { header: "sec-ch-ua-full-version-list", operation: "remove" },
              { header: "sec-ch-ua-form-factor", operation: "remove" },
              { header: "sec-ch-ua-form-factors", operation: "remove" },
              { header: "sec-ch-ua-wow64", operation: "remove" },
            ],
          },
          condition: {
            requestDomains: ["tgoapis.com", "api.tgoapis.com"],
            resourceTypes: [
              "xmlhttprequest",
              "other",
              "sub_frame",
              "main_frame",
              "script",
              "stylesheet",
              "image",
              "font",
              "media",
              "websocket",
            ],
          },
        },
        // Kural 3: id 7003 — zeususer/addresses için Android Dalvik UA (öncelik yüksek, kural 1'i geçersiz kılar)
        {
          id: TY_RULE_ID_ZEUS,
          priority: 100,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "User-Agent", operation: "set", value: TY_ANDROID_UA },
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
            ],
          },
          condition: {
            urlFilter:
              "api.tgoapis.com/localcommerce-member-zeususer-service/addresses",
            resourceTypes: ["xmlhttprequest", "other"],
          },
        },
        // NOT: Cookie strip regexFilter (lookahead) Chrome RE2'de GEÇERSİZ —
        // tüm DNR batch'ini düşürüyordu. SSR bypass = root tgo-token silme (SW).
      ],
    });
    // Eski bozuk 9206 kuralını temizle
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [TY_RULE_ID_STRIP_AUTH_COOKIE],
        addRules: [],
      });
    } catch (_) {}
    console.log("[Trendyol DNR] ✅ Header override aktif (v29 )");
  } catch (e) {
    console.warn("[Trendyol DNR] kural ekleme hatası:", e?.message || e);
  }
}

// İlk açılışta da kur — herhangi bir mobilden gelen Trendyol API isteği koruma altında olsun
chrome.runtime.onInstalled.addListener(() => {
  try {
    setupTrendyolHeaderRules();
  } catch (_) {}
});
chrome.runtime.onStartup?.addListener(() => {
  try {
    setupTrendyolHeaderRules();
  } catch (_) {}
});
try {
  setupTrendyolHeaderRules();
} catch (_) {}

// macOS Safari 18.6 / macOS 14 Sonoma
const UBER_IOS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const UBER_IOS_RULE_ID = 9120;
const UBER_IOS_REMOVE_HEADERS = [
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-model",
  "sec-ch-ua-wow64",
  "sec-ch-ua-platform-version",
  "sec-ch-ua-ua",
  "sec-ch-ua-form-factor",
  "sec-ch-ua-form-factors",
  "sec-ch-ua-viewport-width",
  "sec-ch-ua-dpr",
  "sec-ch-ua-resolution",
];

const UBER_UA_FALLBACK =
  "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/148.0.7778.49 Mobile Safari/537.36";
let uberUserAgent = "";
// Not: Önceden Android UA tespitiyle DNR override devre dışı bırakılıyordu;
// bu, masaüstü Chrome kullanıcılarında bile yanlış pozitif veriyor ve
// User-Agent + Client Hints override'ını öldürüyordu. Bu yüzden override'ı
// her zaman aktif tutuyoruz — mobil layout'u alt domain (m.uber.com) zaten
// halledebiliyor.

// Seed'den Android WebView UA üret (core/fingerprint.js'deki ANDROID_WEBVIEW_VERSIONS ve REAL_DEVICES kullanır)
function buildUberUAFromSeed(seed) {
  const profile = buildDeviceProfile(seed);
  return {
    ua: profile.UA,
    major: profile.CHROME_V,
    full: profile.CHROME_FULL,
    androidVer: profile.ANDROID_VER,
    deviceModel: profile.DEVICE_MODEL,
  };
}

// iOS modu: DNR kuralı — macOS Safari UA SET + tüm Client Hints REMOVE
// Safari bu header'ları hiç göndermez, SET etmek tutarsızlık yaratır
async function setupUberHeaderRulesIOS() {
  const ALL_RT = [
    "main_frame",
    "sub_frame",
    "stylesheet",
    "script",
    "image",
    "font",
    "object",
    "xmlhttprequest",
    "ping",
    "csp_report",
    "media",
    "websocket",
    "other",
  ];

  const requestHeaders = [
    // Temel header'lar — SET
    { header: "User-Agent", operation: "set", value: UBER_IOS_UA },
    { header: "Accept-Encoding", operation: "set", value: "gzip, deflate, br" },
    { header: "Accept-Language", operation: "set", value: "tr-TR,tr;q=0.9" },
  ];
  // Tüm Client Hints header'ları REMOVE — Safari bunları hiç göndermez
  for (const h of UBER_IOS_REMOVE_HEADERS) {
    requestHeaders.push({ header: h, operation: "remove" });
  }

  const URL_REGEX =
    "(?i)^https?://([a-z0-9.-]+\\.)*(uber\\.com|cdn-net\\.com|cdn-path\\.com)(:\\d+)?(/|$|\\?|#)";

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [9100, 9101, 9102, UBER_IOS_RULE_ID],
    });
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [
        {
          id: UBER_IOS_RULE_ID,
          priority: 1,
          action: { type: "modifyHeaders", requestHeaders },
          condition: { regexFilter: URL_REGEX, resourceTypes: ALL_RT },
        },
      ],
    });
    console.log(
      "[Uber] iOS DNR kuralı kuruldu — macOS Safari 18.6 (CH REMOVE)",
    );
  } catch (e) {
    console.error("[Uber] iOS DNR kuralı kurulamadı:", e);
  }
}

async function setupUberHeaderRules(userAgent) {
  // Mod kontrolü: varsayılan iOS profili. Sadece açıkça 'android' seçilmişse
  // Android Chrome WebView profili kullanılır.
  let mode = "ios";
  try {
    const r = await chrome.storage.local.get("uberMode");
    if (r && r.uberMode === "android") mode = "android";
  } catch (_) {}

  if (mode === "ios") {
    return setupUberHeaderRulesIOS();
  }

  const ua = userAgent || UBER_UA_FALLBACK;
  const RULE_ID_UA = 9100;

  const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
  const chromeFull = chromeMatch ? chromeMatch[1] : "148.0.7778.49";
  const chromeMajor = chromeFull.split(".")[0];
  const androidMatch = ua.match(/Android\s+(\d+)/);
  const androidVer = androidMatch ? androidMatch[1] : "14";
  const modelMatch = ua.match(/Android\s+\d+;\s+([^)]+)/);
  const deviceModel = modelMatch ? modelMatch[1] : "SM-S911B";

  const secChUa = `"Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}", "Not-A.Brand";v="8"`;
  const secChUaFullVerList = `"Chromium";v="${chromeFull}", "Google Chrome";v="${chromeFull}", "Not-A.Brand";v="8.0.0.0"`;
  const acceptLang = "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7";

  const ALL_RESOURCE_TYPES = [
    "xmlhttprequest",
    "main_frame",
    "sub_frame",
    "stylesheet",
    "script",
    "image",
    "font",
    "object",
    "media",
    "websocket",
    "other",
    "ping",
    "csp_report",
    "webtransport",
    "webbundle",
  ];

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID_UA, 9101, 9102, UBER_IOS_RULE_ID],
    });

    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [
        {
          id: RULE_ID_UA,
          priority: 100,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "User-Agent", operation: "set", value: ua },
              { header: "sec-ch-ua", operation: "set", value: secChUa },
              { header: "sec-ch-ua-mobile", operation: "set", value: "?1" },
              {
                header: "sec-ch-ua-platform",
                operation: "set",
                value: '"Android"',
              },
              {
                header: "sec-ch-ua-platform-version",
                operation: "set",
                value: `"${androidVer}.0.0"`,
              },
              { header: "sec-ch-ua-arch", operation: "set", value: '"arm"' },
              { header: "sec-ch-ua-bitness", operation: "set", value: '"64"' },
              {
                header: "sec-ch-ua-full-version",
                operation: "set",
                value: `"${chromeFull}"`,
              },
              {
                header: "sec-ch-ua-full-version-list",
                operation: "set",
                value: secChUaFullVerList,
              },
              {
                header: "sec-ch-ua-model",
                operation: "set",
                value: `"${deviceModel}"`,
              },
              { header: "sec-ch-ua-wow64", operation: "set", value: "?0" },
              {
                header: "sec-ch-ua-form-factors",
                operation: "set",
                value: '"Mobile"',
              },
              {
                header: "Accept-Language",
                operation: "set",
                value: acceptLang,
              },
            ],
          },
          condition: {
            requestDomains: ["uber.com"],
            resourceTypes: ALL_RESOURCE_TYPES,
          },
        },
      ],
    });

    console.log(
      `[Uber] Header kuralları kuruldu — Chrome/${chromeMajor} | ${deviceModel}`,
    );
  } catch (error) {
    console.error("[Uber] Header kuralları kurulamadı:", error);
  }
}

// Uber FP seed cookie yaz.
// navigatorOverride.js bu cookie'yi document_start'ta senkron okur,
// ":" ile split eder → "{seed}:{chromeFull}".
// Ayraç YANLIŞSA (örn. "|"), navigator override fallback değerle çalışır,
// her hesap aynı fingerprint üretir → Uber risk skoru yükselir → nakit
// ödeme seçeneği kaldırılır.
function writeUberFpSeedCookie(seed, chromeFull) {
  if (!seed) return;
  const val = chromeFull ? `${seed}:${chromeFull}` : seed;
  for (const domain of [".uber.com", ".m.uber.com", ".account.uber.com"]) {
    chrome.cookies
      .set({
        url: "https://www.uber.com",
        name: "_ubfp",
        value: encodeURIComponent(val),
        domain: domain,
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "no_restriction",
        expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      })
      .catch(() => {});
  }
}

// Başlangıçta Uber = iOS Safari (Android seed ile fare/promo bozulmasın)
chrome.storage.local.get(
  ["uberUserAgent", "uberFpSeed", "uberMode"],
  function (result) {
    const existingSeed = result.uberFpSeed || crypto.randomUUID();
    uberUserAgent = UBER_IOS_UA;
    chrome.storage.local.set({
      uberUserAgent: UBER_IOS_UA,
      uberFpSeed: existingSeed,
      uberMode: "ios",
    });
    writeUberFpSeedCookie(existingSeed, "18.6");
    setupUberHeaderRulesIOS();
    console.log("[Uber] Startup DNR: Safari 18.6 / Istanbul fare parity");
  },
);

// uberMode değişirse DNR kuralını yeniden kur (kullanıcı toggle'ı)
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.uberMode) {
      const newMode = changes.uberMode.newValue || "ios";
      console.log("[Uber] Mode değişti →", newMode);
      setupUberHeaderRules(uberUserAgent);
    }
  });
} catch (_) {}

// ============ UBER: Türk isim + update-display-name + VIP geo ============
const TURKISH_MALE_NAMES = [
  "Ahmet",
  "Mehmet",
  "Mustafa",
  "Ali",
  "Hasan",
  "Hüseyin",
  "İbrahim",
  "Osman",
  "Yusuf",
  "Murat",
  "Ömer",
  "Fatih",
  "Emre",
  "Burak",
  "Serkan",
  "Kerem",
  "Cem",
  "Kaan",
  "Eren",
  "Barış",
  "Tolga",
  "Onur",
  "Deniz",
  "Enes",
  "Furkan",
  "Umut",
  "Berkay",
  "Uğur",
  "Volkan",
  "Gökhan",
  "Tuncay",
  "Selim",
  "Oğuz",
  "Caner",
  "Alper",
  "Koray",
  "Erdem",
  "Serhat",
  "Batuhan",
  "Arda",
];
const TURKISH_FEMALE_NAMES = [
  "Fatma",
  "Ayşe",
  "Emine",
  "Hatice",
  "Zeynep",
  "Elif",
  "Merve",
  "Büşra",
  "Esra",
  "Ebru",
  "Seda",
  "Özlem",
  "Gamze",
  "Derya",
  "Pınar",
  "Gül",
  "Sevgi",
  "Tuğba",
  "Sibel",
  "Yasemin",
  "Gizem",
  "İrem",
  "Cansu",
  "Melis",
  "Ece",
  "Dilara",
  "Aslı",
  "Zehra",
  "Şeyma",
  "Beyza",
  "Buse",
  "Nur",
];
const TURKISH_SURNAMES = [
  "Yılmaz",
  "Kaya",
  "Demir",
  "Çelik",
  "Şahin",
  "Yıldız",
  "Yıldırım",
  "Öztürk",
  "Aydın",
  "Özdemir",
  "Arslan",
  "Doğan",
  "Kılıç",
  "Aslan",
  "Çetin",
  "Kara",
  "Koç",
  "Kurt",
  "Özkan",
  "Şimşek",
  "Polat",
  "Korkmaz",
  "Çakır",
  "Erdoğan",
  "Güneş",
  "Aksoy",
  "Acar",
  "Kaplan",
  "Bozkurt",
  "Güler",
  "Işık",
  "Eren",
];

function generateRandomTurkishName(gender = "male") {
  const names = gender === "female" ? TURKISH_FEMALE_NAMES : TURKISH_MALE_NAMES;
  const firstName = names[Math.floor(Math.random() * names.length)];
  const lastName =
    TURKISH_SURNAMES[Math.floor(Math.random() * TURKISH_SURNAMES.length)];
  return { firstName, lastName };
}

/**
 * storeTgoMobilePageContext birebir:
 * 1. TÜM page path'lerden mobil cookie'leri SİL (/ /restoranlar /hesabim...)
 * 2. SADECE checkout path'lerine (/odeme, /odeme-basarili) mobil cookie SET ET
 * 3. Popup engelleme cookie'leri set et
 */
async function _tyStripCheckoutAndroidCookies() {
  // Checkout mimarisi: /odeme ve /odeme-basarili altındaki Android ve auth çerezleri KORUNMALIDIR.
  // Bu çerezler silindiğinde Trendyol SSR /odeme rotasında oturumu tanımayıp /giris sayfasına yönlendirir.
  return;
}

async function applyTgoAndroidSsrBypass(mobileJwt, opts) {
  const force = !!(opts && opts.force);
  const now = Date.now();
  if (
    !force &&
    applyTgoAndroidSsrBypass._lastAt &&
    now - applyTgoAndroidSsrBypass._lastAt < 2000
  ) {
    return;
  }
  applyTgoAndroidSsrBypass._lastAt = now;

  const expLong = Math.floor(Date.now() / 1000) + 604800;

  // v26 model: Root auth cookie'ler ZATEN siliniyor (onBeforeNavigate + cookie.onChanged).
  // Sadece page path'lerdeki gereksiz mobil cookie'leri temizle (checkout hariç)
  const nonCheckoutPaths = [
    "/",
    "/restoranlar",
    "/hesabim",
    "/hesabim/siparislerim",
    "/arama",
    "/giris",
    "/sepet",
    "/siparislerim",
    "/favorilerim",
    "/uyelik",
    "/kampanyalar",
  ];
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

  const removePromises = [];
  for (const pp of nonCheckoutPaths) {
    for (const cn of mobileCookieNames) {
      removePromises.push(
        chrome.cookies
          .remove({ url: "https://tgoyemek.com" + pp, name: cn })
          .catch(() => {}),
      );
    }
  }
  await Promise.all(removePromises);

  // Popup engelleme
  await chrome.cookies
    .set({
      url: "https://tgoyemek.com/",
      domain: "tgoyemek.com",
      path: "/",
      name: "tgo-missing-user-info-popup-date",
      value: "true",
      secure: true,
      httpOnly: false,
      sameSite: "lax",
      expirationDate: expLong,
    })
    .catch(() => {});
  await chrome.cookies
    .set({
      url: "https://tgoyemek.com/",
      domain: "tgoyemek.com",
      path: "/",
      name: "tgo-missing-user-info-popup-basket-date",
      value: "true",
      secure: true,
      httpOnly: false,
      sameSite: "lax",
      expirationDate: expLong,
    })
    .catch(() => {});

  // v39: /odeme path'ine ANDROID/mobil cookie YAZMA. web JWT kullanır;
  // ANDROID set edilince TGO ödeme sayfasını /restoranlar'a atıyor.
  console.log("[Trendyol] v39: checkout ANDROID set atlandı (ödeme JWT)");
}

/** model: checkout path'lerinde ANDROID kalmalı, genel path'lerden temizle */
async function stripTgoAndroidCookiesForWebPayment() {
  const names = ["platform", "token", "mobile-token"];
  // Sadece genel path'lerden temizle — checkout path'lerinde ANDROID KALMALI
  const urls = [
    "https://tgoyemek.com/",
    "https://tgoyemek.com/restoranlar",
    "https://tgoyemek.com/restoranlar/",
    "https://tgoyemek.com/sepet",
    "https://tgoyemek.com/siparislerim",
    "https://tgoyemek.com/hesabim",
    // NOT: /odeme ve /odeme-basarili ÇIKARILdı — orada ANDROID kalmalı
  ];
  await Promise.all(
    names.flatMap((name) =>
      urls.map((url) => chrome.cookies.remove({ url, name }).catch(() => {})),
    ),
  );
}

/** Eski fonksiyon — artık ANDROID cookie yok, no-op */
async function stripTgoRootAndroidKeepDetail() {
  // model: ANDROID cookie set edilmiyor, temizleme gerekmiyor
}

/** Tab bounce — sadece eksik-bilgi sayfasındaki tabları /restoranlar'a yönlendir */
let _ksAndroidBounceAt = 0;
async function bounceTgoyemekToRestoranlar(opts) {
  // Neutralized: Sekme yeniden yükleme veya ping-pong yönlendirme savaşını tamamen engeller
  console.log("[Trendyol] bounceTgoyemekToRestoranlar neutralized to ensure smooth user navigation");
  return;
}

/**
 * Profil tamamlama — *
 * KRİTİK BULGU: StandardUser:"0" JWT ile ÇALIŞIYOR!
 * Token yenileme / re-login YAPMIYOR. JWT immutable, flag asla değişmez.
 *
 * ÇÖZÜM:
 * 1. PATCH ile profili tamamla (backend DB güncellenir)
 * 2. tgo-missing-user-info-popup-* cookie set et (popup engelleme)
 * 3. Checkout path'lerinde platform=ANDROID cookie set et (SSR bypass)
 * 4. Re-login YOK — gereksiz ve döngüye sebep oluyordu
 */
async function completeTrendyolUserInfo(tokenOverride) {
  // 1. Popup engelleme cookie'leri
  const _setMissingCk = (name) =>
    chrome.cookies
      .set({
        url: "https://tgoyemek.com",
        name,
        value: "true",
        domain: "tgoyemek.com",
        secure: true,
        httpOnly: false,
        sameSite: "lax",
        path: "/",
      })
      .catch(() => {});
  await _setMissingCk("tgo-missing-user-info-popup-date");
  await _setMissingCk("tgo-missing-user-info-popup-basket-date");

  // 2. Checkout path'lerinde ANDROID cookie set et (model)
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
    const isMob =
      typeof looksLikeMobileJwt === "function"
        ? looksLikeMobileJwt(primary)
        : primary.length >= 600;
    if (isMob) mobileTok = mobileTok || primary;
    else webTok = webTok || primary;
  }
  const tokenToUse = mobileTok || webTok;
  if (!tokenToUse) {
    console.warn("[Trendyol] completeTrendyolUserInfo: token yok");
    return true;
  }

  // Checkout path'lerinde ANDROID cookie set et
  const tokenForCheckout = mobileTok || webTok;
  const mobileCookieValues = {
    platform: "ANDROID",
    token: tokenForCheckout,
    "mobile-token": tokenForCheckout,
    "channel-id": "4",
    storefrontId: "1",
    countryCode: "TR",
    language: "tr",
    AZ_SELECTED: "false",
  };
  for (const ckPath of checkoutPaths) {
    for (const ckName of mobileCookieNames) {
      await chrome.cookies
        .set({
          url: "https://tgoyemek.com" + ckPath,
          name: ckName,
          value: mobileCookieValues[ckName],
          domain: "tgoyemek.com",
          secure: true,
          httpOnly: false,
          sameSite: "lax",
          path: ckPath,
        })
        .catch(() => {});
    }
  }

  // 3. Proactive Zeus User Service check & update (STANDALONE, NO REMOTE PROXY)
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

  const zeusUrl =
    "https://api.tgoapis.com/localcommerce-member-zeususer-service/user?appName=TrendyolGo&channelId=3";

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

async function checkUberLocationProtection(tabId, url) {
  try {
    if (!url || !url.includes("uber.com") || !url.includes("/go/")) return;
    const decodedUrl = decodeURIComponent(url);
    const latMatches = decodedUrl.match(/"latitude"\s*:\s*([\d.]+)/g);
    const lonMatches = decodedUrl.match(/"longitude"\s*:\s*([\d.]+)/g);
    if (!latMatches || !lonMatches) return;

    let isProtectedArea = false;
    for (const latStr of latMatches) {
      const lat = parseFloat(latStr.match(/([\d.]+)$/)[1]);
      for (const lonStr of lonMatches) {
        const lon = parseFloat(lonStr.match(/([\d.]+)$/)[1]);
        if (lat >= 36.8 && lat <= 37.15 && lon >= 35.1 && lon <= 35.55) {
          isProtectedArea = true;
          break;
        }
        if (lat >= 36.7 && lat <= 37.0 && lon >= 34.4 && lon <= 34.8) {
          isProtectedArea = true;
          break;
        }
      }
      if (isProtectedArea) break;
    }

    if (!isProtectedArea) return;
    const storage = await chrome.storage.local.get("uberVip");
    if (storage.uberVip === "adana") {
      console.log("[Uber] VIP hesap — koruma atlandı");
      return;
    }
    console.log("[Uber] Koruma bölgesi — yönlendiriliyor");
    await chrome.tabs.update(tabId, {
      url: "https://www.uber.com/tr/tr/start-riding/",
    });
  } catch (e) {
    console.warn("[Uber] Lokasyon koruma hatası:", e?.message || e);
  }
}

// tgoyemek ödeme çerezleri content script mesajına bağlı kalmasın.
// Android ve iOS'ta mesaj /odeme isteğinden sonra geldiği için SSR /giris açıyor.
let _tyCheckoutCookieFlight = null;
let _tyCheckoutCookieFlightWrites = false;
let _tyCheckoutCookieAt = 0;
let _tyCheckoutCookieOkAt = 0;
const _tyLoginRecoverAt = {};

function _tyIsTgoyemekHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "tgoyemek.com" || host.endsWith(".tgoyemek.com");
}

function _tyLoginCallbackDest(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!_tyIsTgoyemekHost(u.hostname)) return null;
    if (!/^\/giris\/?$/i.test(u.pathname || "")) return null;
    const cb = u.searchParams.get("callbackUrl") || "";
    if (!cb) return null;
    const path = (cb.startsWith("http") ? new URL(cb).pathname : cb).split("?")[0];
    if (!/^\/(odeme|odeme-basarili|hesabim)(\/|$)/i.test(path)) return null;
    return "https://tgoyemek.com" + path;
  } catch (_) {
    return null;
  }
}

function _tyEnsureCheckoutCookies(writeSession) {
  const now = Date.now();
  if (_tyCheckoutCookieFlight) {
    if (!writeSession || _tyCheckoutCookieFlightWrites) return _tyCheckoutCookieFlight;
    return _tyCheckoutCookieFlight.then(() => _tyEnsureCheckoutCookies(true));
  }
  if (now - _tyCheckoutCookieAt < 1500 && !writeSession) {
    return Promise.resolve({ skipped: true });
  }
  if (typeof handleDhApplyOrderMobileCookies !== "function") {
    return Promise.resolve({ success: false });
  }
  _tyCheckoutCookieAt = now;
  _tyCheckoutCookieFlightWrites = !!writeSession;
  _tyCheckoutCookieFlight = new Promise((resolve) => {
    try {
      handleDhApplyOrderMobileCookies(
        {
          action: "dhApplyOrderMobileCookies",
          checkout: !!writeSession,
          clearWeb: false,
        },
        (res) => {
          if (res && res.success) _tyCheckoutCookieOkAt = Date.now();
          resolve(res || {});
        },
      );
    } catch (_) {
      resolve({ success: false });
    }
  }).finally(() => {
    _tyCheckoutCookieFlight = null;
  });
  return _tyCheckoutCookieFlight;
}

function _tyOnCheckoutNav(urlStr, tabId) {
  try {
    if (!urlStr) return;
    const u = new URL(urlStr);
    if (!_tyIsTgoyemekHost(u.hostname)) return;
    const path = u.pathname || "";
    // Kullanıcı bilgilerim sayfasına giriş yasak
    if (/kullanici-bilgilerim/i.test(path) && tabId) {
      chrome.tabs.update(tabId, { url: "https://tgoyemek.com/hesabim/siparislerim" }).catch(() => {});
      return;
    }
    const recoverTo = _tyLoginCallbackDest(urlStr);
    if (/^\/(giris|uyelik|api)(\/|$)/i.test(path) && !recoverTo) return;
    const writeSession =
      !!recoverTo || /^\/(odeme|odeme-basarili|hesabim)(\/|$)/i.test(path);
    const apply = _tyEnsureCheckoutCookies(writeSession);
    if (!recoverTo || !tabId) return;
    apply.then((res) => {
      const cookiesReady =
        (res && res.success) ||
        (_tyCheckoutCookieOkAt && Date.now() - _tyCheckoutCookieOkAt < 60000);
      if (!cookiesReady) return;
      const now = Date.now();
      if (_tyLoginRecoverAt[tabId] && now - _tyLoginRecoverAt[tabId] < 20000) return;
      _tyLoginRecoverAt[tabId] = now;
      chrome.tabs.update(tabId, { url: recoverTo }).catch(() => {});
    }).catch(() => {});
  } catch (_) {}
}

try {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && changeInfo.url.includes("uber.com")) {
      checkUberLocationProtection(tabId, changeInfo.url);
    }
    const pageUrl = changeInfo.url || (tab && tab.url) || "";
    if (
      pageUrl.includes("tgoyemek.com") &&
      (changeInfo.url || changeInfo.status === "loading" || changeInfo.status === "complete")
    ) {
      _tyOnCheckoutNav(pageUrl, tabId);
    }
  });
  if (chrome.webNavigation?.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.addListener(
      (details) => {
        if (details.frameId === 0)
          checkUberLocationProtection(details.tabId, details.url);
      },
      { url: [{ hostContains: "uber.com" }] },
    );
  }
  const _tyNavFilter = { url: [{ hostSuffix: "tgoyemek.com" }] };
  const _tyNav = (details) => {
    if (!details || details.frameId !== 0) return;
    _tyOnCheckoutNav(details.url, details.tabId);
  };
  if (chrome.webNavigation?.onBeforeNavigate) {
    chrome.webNavigation.onBeforeNavigate.addListener(_tyNav, _tyNavFilter);
  }
  if (chrome.webNavigation?.onCommitted) {
    chrome.webNavigation.onCommitted.addListener(_tyNav, _tyNavFilter);
  }
  if (chrome.webNavigation?.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.addListener(_tyNav, _tyNavFilter);
  }
} catch (_) {}

async function getAddressListFromStorage() {
  try {
    const result = await chrome.storage.local.get([
      "kuponstore_addresses",
      "savedAddresses",
    ]);
    return result.kuponstore_addresses || result.savedAddresses || [];
  } catch (_) {
    return [];
  }
}

// Uber API üzerinden kullanıcı adını güncelle
async function updateUberUserName(firstName, lastName, rawCookies, tabId) {
  if (!firstName) return;
  const requestId = crypto.randomUUID();
  const marketingId =
    (rawCookies || []).find((c) => c && c.name === "marketing_vistor_id")
      ?.value || "";
  const referer = "https://account.uber.com/update-display-name";

  // DNR ile origin/referer/sec-fetch-site override (CSRF için kritik)
  const ruleId = 9001;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 100,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              {
                header: "origin",
                operation: "set",
                value: "https://account.uber.com",
              },
              { header: "referer", operation: "set", value: referer },
              {
                header: "sec-fetch-site",
                operation: "set",
                value: "same-origin",
              },
            ],
          },
          condition: {
            urlFilter: "account.uber.com/api/updateUserInfo",
            resourceTypes: ["xmlhttprequest"],
          },
        },
      ],
    });
  } catch (_) {}

  try {
    const response = await fetch(
      "https://account.uber.com/api/updateUserInfo?localeCode=tr-TR",
      {
        method: "POST",
        credentials: "include",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          accept: "*/*",
          "x-uber-country-iso2": "TR",
          "x-uber-client-name": "uam_desktop",
          "x-uber-request-uuid": requestId,
          "x-uber-device": "",
          "x-uber-device-model": "",
          "x-uber-device-os": "10",
          "x-uber-tenancy": "",
          "x-uber-decision-engine-is-shadow": "true",
          "x-uber-device-location-latitude": "",
          "x-uber-client-version": "",
          "x-uber-device-mobile-iso2": "",
          "x-uber-client-session": "",
          "x-uber-client-id": "",
          "x-uber-auth-sso-id": "",
          "x-uber-device-location-longitude": "",
          "x-uber-marketing-id": marketingId,
          "x-uber-app-device-id": "",
          "x-uber-app-variant": "",
          "x-uber-device-id": "",
          "x-csrf-token": "x",
          "x-uber-device-language": "",
          "x-uber-device-udid": "",
          "x-uber-identity-entrypoint": "uam",
        },
        body: JSON.stringify({
          userInfoUpdate: {
            userInfoUpdateType: "NAME",
            name: { firstname: firstName, lastname: lastName || "-" },
          },
        }),
      },
    );

    if (
      response.ok ||
      response.type === "opaqueredirect" ||
      response.status === 0
    ) {
      console.log("[Uber] İsim güncellendi:", firstName, lastName);
      return;
    }
    const text = await response.text().catch(() => "");
    throw new Error(
      `Uber isim güncelleme başarısız (${response.status}): ${text.substring(0, 200)}`,
    );
  } catch (e) {
    console.warn("[Uber] updateUserInfo hatası:", e?.message || e);
  } finally {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ruleId],
      });
    } catch (_) {}
  }
}

// account.uber.com/update-display-name — content script manuel isim formunu yönetir
async function _uberOnUpdatedHandler(updatedTabId, info, tab) {
  if (info.status !== "complete") return;
  if (
    !tab.url ||
    !tab.url.includes("account.uber.com") ||
    !tab.url.includes("update-display-name")
  )
    return;

  const data = await chrome.storage.local
    .get("_uberPendingNameUpdate")
    .catch(() => ({}));
  const pending = data._uberPendingNameUpdate;
  if (!pending) return;

  if (pending.ts && Date.now() - pending.ts > 90000) {
    await chrome.storage.local.remove("_uberPendingNameUpdate").catch(() => {});
    return;
  }

  console.log(
    "[Uber] update-display-name sayfası yüklendi, content script manuel isim girişini yönetecek",
  );
}

try {
  chrome.tabs.onUpdated.addListener(_uberOnUpdatedHandler);
} catch (_) {}

/**
 * ============================================================
 * MIGROS DEVICE IDENTIFIER ÜRETİMİ
 * ============================================================
 * Her oturumda yeni rastgele cihaz üretir. 17 gerçek Android cihaz havuzundan
 * birini seçer, 16 hex karakterli Android ID üretir, apiLevel ile eşler.
 *
 * Bu sayede Migros backend'i her giriş için farklı bir cihaz görür ve
 * fingerprint anomali tespiti tetiklenmez.
 */
const KS_MIGROS_REAL_ANDROID_DEVICES = [
  { manufacturer: "samsung", model: "SM-S928B", apiLevel: "34" }, // Galaxy S24 Ultra
  { manufacturer: "samsung", model: "SM-S911B", apiLevel: "34" }, // Galaxy S24
  { manufacturer: "samsung", model: "SM-A556B", apiLevel: "34" }, // Galaxy A55 5G
  { manufacturer: "samsung", model: "SM-A356B", apiLevel: "33" }, // Galaxy A35 5G
  { manufacturer: "samsung", model: "SM-S916B", apiLevel: "33" }, // Galaxy S23+
  { manufacturer: "samsung", model: "SM-A546B", apiLevel: "33" }, // Galaxy A54 5G
  { manufacturer: "xiaomi", model: "Redmi Note 12", apiLevel: "33" },
  { manufacturer: "xiaomi", model: "2311DRK48G", apiLevel: "34" }, // Xiaomi 13T
  { manufacturer: "xiaomi", model: "23049PCD8G", apiLevel: "33" }, // Poco X6 Pro
  { manufacturer: "xiaomi", model: "23127PN0CC", apiLevel: "34" }, // Xiaomi 14
  { manufacturer: "xiaomi", model: "23021RAAEG", apiLevel: "33" }, // Xiaomi 13
  { manufacturer: "Google", model: "Pixel 8", apiLevel: "34" },
  { manufacturer: "Google", model: "Pixel 8 Pro", apiLevel: "34" },
  { manufacturer: "Google", model: "Pixel 9", apiLevel: "35" },
  { manufacturer: "OnePlus", model: "CPH2581", apiLevel: "34" }, // OnePlus 12
  { manufacturer: "OnePlus", model: "CPH2465", apiLevel: "33" }, // OnePlus 11
  { manufacturer: "OPPO", model: "CPH2469", apiLevel: "33" }, // OPPO Find X6
];

function generateMigrosDeviceIdentifiers() {
  const template =
    KS_MIGROS_REAL_ANDROID_DEVICES[
      Math.floor(Math.random() * KS_MIGROS_REAL_ANDROID_DEVICES.length)
    ];

  // Android ID style — 16 hex karakter
  const hexChars = "0123456789abcdef";
  let deviceId = "";
  for (let i = 0; i < 16; i++) {
    deviceId += hexChars.charAt(Math.floor(Math.random() * 16));
  }

  return {
    manufacturer: template.manufacturer,
    model: template.model,
    deviceId: deviceId,
    apiLevel: template.apiLevel,
    appVersion: "26.11.0", // Güncel Migros mobil app versiyonu
    buildNumber: "261100154",
  };
}

console.log("KuponStore Background Service Worker loaded");

// ════════════════════════════════════════════════════════════════════════════
// ── YEMEKSEPETİ: Device + DNR + Cookie Yönetimi ─────────────────────────
// ════════════════════════════════════════════════════════════════════════════

// ── Gerçek Android cihaz havuzu ──────────────────────────────────────────────
const YS_REAL_DEVICES = [
  { manufacturer: "samsung", model: "SM-A556B", apiLevel: "34" },
  { manufacturer: "samsung", model: "SM-A356B", apiLevel: "33" },
  { manufacturer: "samsung", model: "SM-S916B", apiLevel: "33" },
  { manufacturer: "samsung", model: "SM-A546B", apiLevel: "33" },
  { manufacturer: "samsung", model: "SM-S928B", apiLevel: "34" },
  { manufacturer: "xiaomi", model: "Redmi Note 12", apiLevel: "33" },
  { manufacturer: "xiaomi", model: "2311DRK48G", apiLevel: "34" },
  { manufacturer: "xiaomi", model: "23049PCD8G", apiLevel: "33" },
  { manufacturer: "xiaomi", model: "23127PN0CC", apiLevel: "34" },
  { manufacturer: "xiaomi", model: "23021RAAEG", apiLevel: "33" },
  { manufacturer: "Google", model: "Pixel 8", apiLevel: "34" },
  { manufacturer: "Google", model: "Pixel 8 Pro", apiLevel: "34" },
  { manufacturer: "Google", model: "Pixel 9", apiLevel: "35" },
  { manufacturer: "OnePlus", model: "CPH2581", apiLevel: "34" },
  { manufacturer: "OnePlus", model: "CPH2465", apiLevel: "33" },
  { manufacturer: "OPPO", model: "CPH2469", apiLevel: "33" },
];

let ysDeviceInfo = null;

function generateDeviceIdentifiers() {
  const t = YS_REAL_DEVICES[Math.floor(Math.random() * YS_REAL_DEVICES.length)];
  const hexs = "0123456789abcdef";
  let deviceId = "";
  for (let i = 0; i < 16; i++) deviceId += hexs[Math.floor(Math.random() * 16)];
  return {
    manufacturer: t.manufacturer,
    model: t.model,
    deviceId,
    apiLevel: t.apiLevel,
    appVersion: "25.27.0",
    buildNumber: "252700274",
  };
}

function getOrCreateDeviceInfo() {
  if (!ysDeviceInfo) {
    ysDeviceInfo = generateDeviceIdentifiers();
    chrome.storage.local.set({ ysDeviceInfo });
  }
  return ysDeviceInfo;
}

// Startup: depolanan cihazı yükle
chrome.storage.local.get("ysDeviceInfo", (r) => {
  ysDeviceInfo = r.ysDeviceInfo || generateDeviceIdentifiers();
  if (!r.ysDeviceInfo) chrome.storage.local.set({ ysDeviceInfo });
});

// ── Yardımcılar ──────────────────────────────────────────────────────────────
function getUserIdFromJwt(token) {
  try {
    const p = token.split(".")[1];
    return (
      JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4))).user_id || ""
    );
  } catch {
    return "";
  }
}

function generateRandomEksValue() {
  const parts = [
    "abc",
    "aaa",
    "cvc",
    "cbc",
    "csc",
    "asd",
    "amg",
    "aq3",
    "mnp",
    "gig",
  ];
  return (
    parts[Math.floor(Math.random() * parts.length)] +
    parts[Math.floor(Math.random() * parts.length)]
  );
}

function randomHex(n) {
  const h = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < n; i++) s += h[Math.floor(Math.random() * 16)];
  return s;
}

function randomUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── generateWebCookies — Perseus + PX cookie sentezi (ys_cookies.js formatı) ──
function generateWebCookies(perseusGuestId, perseusSessionId) {
  const ts = Date.now();
  const tsSec = Math.floor(ts / 1000);

  // Perseus Client ID: {ts}.{17-18 haneli sayi}.{10 alfanumerik}
  function _perseusId(timestampMs) {
    const t = timestampMs || ts;
    const alpha =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const rand10 = Array.from(
      { length: 10 },
      () => alpha[Math.floor(Math.random() * alpha.length)],
    ).join("");
    const bigNum = String(Math.floor(Math.random() * 9e17) + 1e17);
    return `${t}.${bigNum}.${rand10}`;
  }

  const clientId = perseusGuestId || _perseusId(ts);
  const sessionId =
    perseusSessionId || _perseusId(ts + Math.floor(Math.random() * 150) + 50);

  // _pxhd: base64(40 byte) + '==' + base64(60 byte) + '=' (gerçek format)
  function _b64Random(byteCount) {
    const arr = new Uint8Array(byteCount);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode(...arr));
  }
  function _b64NoPad(byteCount) {
    return _b64Random(byteCount).replace(/=+$/g, "");
  }

  const pxhdPart1 = _b64NoPad(40);
  const pxhdPart2 = _b64Random(60).replace(/=+$/g, "");
  const pxvid = randomUUID();
  const pxcts = randomUUID();
  const ssid = randomUUID();

  // _px3: hex(64) : b64(64 byte) : 1000 : b64(272 byte)
  const px3Salt = randomHex(64);
  const px3Hmac = _b64NoPad(64);
  const px3Ct = _b64NoPad(272);

  // __cf_bm: b64-ts-1.0.1.1-b64 (gerçek Cloudflare format)
  const cfBmVal = _b64NoPad(32).replace(/\+/g, ".");
  const cfBmTail = _b64NoPad(40).replace(/\+/g, ".");
  const cfBm = `${cfBmVal}-${tsSec}-1.0.1.1-${cfBmTail}`;

  const ddId = randomUUID();
  const tqId = `${randomHex(16)}.${tsSec}.0.${tsSec}..`;
  const gStateB = _b64NoPad(32);
  const hitId = `${ts + Math.floor(Math.random() * 4900) + 100}.${String(Math.floor(Math.random() * 9e14) + 1e14)}.${Array.from(
    { length: 10 },
    () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[
        Math.floor(Math.random() * 62)
      ],
  ).join("")}`;

  return [
    `dhhPerseusGuestId=${clientId}`,
    `dhhPerseusSessionId=${sessionId}`,
    `ld_key=${clientId}`,
    `hl=tr`,
    `is-generic-address=true`,
    `_pxhd=${pxhdPart1}==${pxhdPart2}=`,
    `__cf_bm=${cfBm}`,
    `dps-session-id=41.076703_29.010804_${clientId}_${tsSec}_${tsSec + 1800}`,
    `_pxvid=${pxvid}`,
    `pxcts=${pxcts}`,
    `g_state={"i_l":0,"i_ll":${ts},"i_b":"${gStateB}","i_e":{"enable_itp_optimization":1}}`,
    `_tq_id.TV-276372-1.c7a5=${tqId}`,
    `user-address-model=%7B%22longitude%22%3A29.01076%2C%22latitude%22%3A41.07683%2C%22countryCode%22%3A%22TR%22%7D`,
    `_px3=${px3Salt}:${px3Hmac}:1000:${px3Ct}`,
    `userCentrics_Braze=true`,
    `userCentrics_TVSquared=undefined`,
    `userCentrics_Perseus=true`,
    `userCentrics_BingConversion=undefined`,
    `userCentrics_TradeTracker=undefined`,
    `userCentrics_LinkedInAds=undefined`,
    `userCentrics_TradeDesk=undefined`,
    `userCentrics_Sklik=undefined`,
    `userCentrics_PerimeterX=undefined`,
    `userCentrics_AdjustforFraudPrevention=true`,
    `userCentrics_DeliveryHeroCore=undefined`,
    `userCentrics_FacebookConnect=true`,
    `userCentrics_GoogleTagManager=true`,
    `userCentrics_Sentry=true`,
    `userCentrics_UsercentricsConsentManagementPlatform=true`,
    `__ssid=${ssid}`,
    `userCentrics_BrazeSDK=true`,
    `userCentrics_FacebookPixel=true`,
    `userCentrics_GoogleAdsRemarketing=true`,
    `userCentrics_Twitter=true`,
    `userCentrics_GoogleAnalytics=true`,
    `userCentrics_PerseusFunctional=true`,
    `userCentrics_PerseusMarketing=true`,
    `userCentrics_Hotjar=true`,
    `userCentrics_GoogleAds=true`,
    `userCentrics_Adjust=true`,
    `userCentrics_FacebookSocialPlugins=true`,
    `userCentrics_GoogleFirebase=true`,
    `userCentrics_remerge=true`,
    `userCentrics_RTBHouse=true`,
    `userCentrics_TikTokAdvertising=true`,
    `userCentrics_TwitterAnalytics=true`,
    `_dd_s=logs=1&id=${ddId}&created=${ts}&expire=${ts + 900000}`,
    `dhhPerseusHitId=${hitId}`,
  ].join("; ");
}

// ── getTrFdApiCookies — real + synthetic cookies birleştir ───────────────────
async function getTrFdApiCookies() {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ domain: "yemeksepeti.com" }, (cookies) => {
      const real = new Map((cookies || []).map((c) => [c.name, c.value]));
      const perseusGuestId = real.get("dhhPerseusGuestId") || null;
      const perseusSessionId = real.get("dhhPerseusSessionId") || null;

      const synthetic = generateWebCookies(perseusGuestId, perseusSessionId);
      const synMap = new Map(
        synthetic.split("; ").map((p) => {
          const i = p.indexOf("=");
          return [p.slice(0, i), p.slice(i + 1)];
        }),
      );

      // Real cookies override synthetic
      synMap.forEach((_, k) => {
        if (real.has(k)) synMap.set(k, real.get(k));
      });
      real.forEach((v, k) => {
        if (!synMap.has(k)) synMap.set(k, v);
      });

      resolve([...synMap.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
    });
  });
}

// ── referans YS Fonksiyonları ───────────────────────────────────────────────

// R-Sig üretimi (referans generateRSig — SHA-256 bazlı)
async function generateYsRSig(
  deviceId,
  url = "",
  body = "",
  custCode = "",
  eksOverride = "",
) {
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const rts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}+0300`;
    const ruid = Math.random().toString();
    const eks = eksOverride || generateEksValue();
    const appVersion = "25.27.0";
    const buildNumber = "252700274";

    // Gerçek HMAC-SHA256 — generateYemeksepetiRSig (generate-rsig.js) kullan
    const sigResult = generateYemeksepetiRSig({
      url: url,
      method: body ? "POST" : "GET",
      eks: eks,
      body: body,
      timestamp: rts,
      random: ruid,
      build: buildNumber,
      version: appVersion,
      custCode: custCode,
    });

    if (sigResult && sigResult.success && (sigResult["R-Sig"] || sigResult.signature)) {
      return {
        success: true,
        signature: sigResult["R-Sig"] || sigResult.signature,
        rts: sigResult.Rts || rts,
        ruid: String(sigResult.Ruid || ruid),
        eks: sigResult.Eks || eks,
      };
    }
    // Fallback
    throw new Error("generateYemeksepetiRSig başarısız");
  } catch (_) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const rts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}+0300`;
    return {
      success: false,
      signature: btoa(randomHex(32)),
      rts,
      ruid: Math.random().toString(),
      eks: eksOverride || generateEksValue(),
    };
  }
}

// JWT'den user_id (cust-code) parse et
function parseCustCodeFromToken(token) {
  if (!token) return "";
  try {
    const parts = token.split(".");
    if (parts.length === 3) return JSON.parse(atob(parts[1])).user_id || "";
  } catch (_) {}
  return "";
}

// Samsung model, 30 dk cache. Inject header varsa onu kullan.
let _ysDeviceCache = null;
let _ysDeviceCacheUntil = 0;
function generateYsRandomDevice(reqHeaders) {
  const h = reqHeaders || {};
  if (h["Device-Id"] && h["Device-Model"]) {
    return {
      deviceId: h["Device-Id"],
      deviceMake: h["Device-Make"] || "samsung",
      deviceModel: h["Device-Model"],
      platformVersion: 33,
    };
  }
  if (_ysDeviceCache && Date.now() < _ysDeviceCacheUntil) return _ysDeviceCache;
  const SAMSUNG_MODELS = [
    "SM-S928B", "SM-S918B", "SM-S921B", "SM-S711B", "SM-S901E",
    "SM-A556E", "SM-G973F", "SM-A546E", "SM-A736B", "SM-N970F",
    "SM-A536E", "SM-A346E", "SM-A336E", "SM-M526BR", "SM-A525F",
    "SM-M336B", "SM-A245F", "SM-A155F", "SM-A515F",
  ];
  let deviceId = "";
  const hexChars = "0123456789abcdef";
  for (let i = 0; i < 16; i++)
    deviceId += hexChars[Math.floor(Math.random() * 16)];
  _ysDeviceCache = {
    deviceId,
    deviceMake: "samsung",
    deviceModel: SAMSUNG_MODELS[Math.floor(Math.random() * SAMSUNG_MODELS.length)],
    platformVersion: 33,
  };
  _ysDeviceCacheUntil = Date.now() + 30 * 60 * 1000;
  return _ysDeviceCache;
}

// PX token
function generateYsPxOriginalToken() {
  // Rakip format: 3:{64hex}:{btoa(hex32) no=padding}:1000:{btoa(hex128) no=padding}
  const b64NoP = (s) => btoa(s).replace(/=/g, "");
  return `3:${randomHex(64)}:${b64NoP(randomHex(32))}:1000:${b64NoP(randomHex(128))}`;
}

// PX device fingerprint
function generateYsPxDeviceFp() {
  return "fp:" + randomHex(32);
}

// Device performance class (ağırlıklı rastgele)
function generateYsDevicePerfClass() {
  const r = Math.random();
  return r < 0.3 ? "low" : r < 0.8 ? "medium" : "high";
}

// Sentry trace V2
function generateYsSentryTrace() {
  const traceId = randomHex(32);
  const spanId = randomHex(16);
  return { traceId, sentryTrace: `${traceId}-${spanId}-0` };
}

// Baggage V2
function generateYsBaggageV2(
  traceId,
  appVersion,
  buildNumber,
  transaction = "sm_AskEmailFragment",
) {
  const sampleRand =
    "0." +
    Array.from({ length: 17 }, () => Math.floor(Math.random() * 10)).join("");
  // Rakip format: sentry-sample_rand + sentry-transaction dahil
  return `sentry-environment=production,sentry-public_key=385c49e6b6c4484d8362abae622b3f0b,sentry-release=com.inovel.app.yemeksepeti%40${appVersion}%2B${buildNumber},sentry-sample_rand=${sampleRand},sentry-sampled=false,sentry-trace_id=${traceId},sentry-transaction=${transaction}`;
}

// ── clearAllRules ────────────────────────────────────────────────────────────
async function clearAllRules() {
  try {
    if (!chrome.declarativeNetRequest) return;
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const ids = rules.map((r) => r.id);
    if (ids.length)
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: ids,
        addRules: [],
      });
  } catch (e) {
    console.warn("[YS Rules] clearAllRules:", e.message);
  }
}

// ── updateCookieRule — referans gibi sadece _pxhd + __cf_bm forward ─────────
// Tüm cookie'leri göndermek yerine sadece PX cookie'lerini forward et
// Bu, chrome-extension:// origin sorununu önler
async function updateCookieRule() {
  if (!chrome.declarativeNetRequest) return;
  try {
    const ysCookies = await chrome.cookies
      .getAll({ domain: "yemeksepeti.com" })
      .catch(() => []);
    const pxCookies = ysCookies.filter(
      (c) => c.name === "_pxhd" || c.name === "__cf_bm",
    );
    const cookieString = pxCookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const orderCookieString = ysCookies
      .filter((c) => c && c.name && c.value != null && c.value !== "")
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    if (!cookieString && !orderCookieString) {
      await chrome.declarativeNetRequest
        .updateDynamicRules({ removeRuleIds: [6755, 6756], addRules: [] })
        .catch(() => {});
      return;
    }
    const cookieRules = [];
    if (cookieString) {
      cookieRules.push({
        id: 6755,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Cookie", operation: "set", value: cookieString },
          ],
        },
        condition: {
          urlFilter: "|https://tr.fd-api.com/*",
          resourceTypes: ["xmlhttprequest"],
        },
      });
    }
    if (orderCookieString) {
      cookieRules.push({
        id: 6756,
        priority: 20,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Cookie", operation: "set", value: orderCookieString },
          ],
        },
        condition: {
          urlFilter: "|https://tr.fd-api.com/api/v5/orders/",
          resourceTypes: ["xmlhttprequest"],
        },
      });
    }
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [6755, 6756],
      addRules: cookieRules,
    });
    console.log(
      "[YS] Cookie forwarding güncellendi (_pxhd + __cf_bm):",
      cookieString.length,
      "karakter",
    );
  } catch (e) {
    console.warn("[YS Rules] updateCookieRule:", e.message);
  }
}

// Cookie değişince updateCookieRule tetikleme → mevcut listener (4683) halleder

// ── setAuthorizationHeader — vouchers + checkout için Bearer ─────────────────
async function setAuthorizationHeader() {
  if (!chrome.declarativeNetRequest) return;
  try {
    const token = await ysGetAndroidToken();
    if (!token) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [3333, 4444, 5555],
        addRules: [],
      });
      return;
    }

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [3333, 4444, 5555],
      addRules: [
        // Sadece incentives-wallet/vouchers için android token — checkout için YOK
        // Checkout kendi volo token'ıyla gider (site bunu cookie'den alır)
        {
          id: 3333,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              {
                header: "Authorization",
                operation: "set",
                value: `Bearer ${token}`,
              },
            ],
          },
          condition: {
            urlFilter:
              "|https://tr.fd-api.com/api/v6/incentives-wallet/vouchers*",
            resourceTypes: ["xmlhttprequest"],
          },
        },
        // id:5555 checkout authorization kaldırıldı — expired android token checkout'u bozuyordu
      ],
    });
  } catch (e) {
    console.warn("[YS Rules] setAuthorizationHeader:", e.message);
  }
}

// ── updateRules — referans setupDynamicHeaders mantığı ile tam DNR ──────────
async function updateRules() {
  if (!chrome.declarativeNetRequest) return;
  try {
    await clearAllRules();

    // referans: rastgele cihaz + R-Sig + tam header seti
    const device = generateYsRandomDevice();
    const appVersion = "25.27.0";
    const buildNumber = "252700274";
    const rSigData = await generateYsRSig(device.deviceId);
    const sentryData = generateYsSentryTrace();
    const baggageV2 = generateYsBaggageV2(
      sentryData.traceId,
      appVersion,
      buildNumber,
    );
    const pxOrigToken = generateYsPxOriginalToken();
    const pxDeviceFp = generateYsPxDeviceFp();
    const perfClass = generateYsDevicePerfClass();
    const adjustAdId = randomUUID();
    const pxVid = randomUUID();
    const pxUuid = randomUUID();
    const emReqId = randomUUID();
    const androidVer = String(device.platformVersion - 19);
    const cookieSt = await getTrFdApiCookies();

    await ysEnsureAndroidFresh();
    const androidTk = await ysGetAndroidToken();
    const checkoutTk =
      [
        await ysCookieValue("access_token"),
        await ysCookieValue("token"),
        await ysCookieValue("uy_token"),
        await ysCookieValue("android_token"),
      ].find((t) => ysPayFresh(t)) || "";
    const ckVolo = await chrome.cookies
      .get({ url: "https://www.yemeksepeti.com", name: "uy_token" })
      .catch(() => null);
    const voloTk = ckVolo?.value || "";
    const token = androidTk || voloTk;
    const custCode = parseCustCodeFromToken(token);

    // DNR boş value hatası için filtrele
    const mkHdr = (header, value) =>
      value ? { header, operation: "set", value: String(value) } : null;

    // Kural 1: calculate için — browser fingerprint header'larını kaldır
    // authorization'ı da kaldır → cookie'deki volo token otomatik gönderilir
    // (android authorization header'ı kupon "hesaba giriş" hatasına neden oluyor)
    const calcCleanHeaders = [
      { header: "sec-ch-ua", operation: "remove" },
      { header: "sec-ch-ua-mobile", operation: "remove" },
      { header: "sec-ch-ua-platform", operation: "remove" },
      { header: "sec-fetch-dest", operation: "remove" },
      { header: "sec-fetch-mode", operation: "remove" },
      { header: "sec-fetch-site", operation: "remove" },
      { header: "sec-fetch-user", operation: "remove" },
      { header: "sec-fetch-storage-access", operation: "remove" },
      { header: "priority", operation: "remove" },
      { header: "referer", operation: "remove" },
      { header: "Referer", operation: "remove" },
      { header: "x-requested-with", operation: "remove" },
      { header: "x-caller-platform", operation: "remove" },
      { header: "perseus-session-id", operation: "remove" },
      { header: "perseus-client-id", operation: "remove" },
      { header: "dps-session-id", operation: "remove" },
      // Android authorization header'ını kaldır — cookie volo token ile çalışacak
      { header: "authorization", operation: "remove" },
      { header: "Authorization", operation: "remove" },
      {
        header: "Origin",
        operation: "set",
        value: "https://www.yemeksepeti.com",
      },
      {
        header: "User-Agent",
        operation: "set",
        value: `Android-app-${appVersion}(${buildNumber})`,
      },
      {
        header: "Accept-Encoding",
        operation: "set",
        value: "gzip, deflate, br",
      },
    ];

    // Kural 2: calculate android meta headers (device, px, r-sig)
    // x-fp-api-key sayfadan geliyor (volo) — override etme
    const calcAndroidHeaders = [
      mkHdr("Host", "tr.fd-api.com"),
      mkHdr("x-pd-language-id", "2"),
      mkHdr("api-client-version", "5.0"),
      // x-fp-api-key intentionally omitted — site sends volo, keep it
      mkHdr("platform", "android"),
      mkHdr("release-lane", "production"),
      mkHdr("platform-version", "30"), // Rakip ys.js: calculate/checkout için sabit '30'
      mkHdr("user-agent", `Android-app-${appVersion}(${buildNumber})`),
      mkHdr("app-name", "com.inovel.app.yemeksepeti"),
      mkHdr("app-flavor", "yemeksepeti"),
      mkHdr("app-version", appVersion),
      mkHdr("app-build", buildNumber),
      mkHdr("build-number", buildNumber),
      mkHdr("build-type", "release"),
      mkHdr("cust-code", custCode),
      mkHdr("content-type", "application/json; charset=UTF-8"),
      mkHdr("android-mobile-service-provider", "gms"),
      mkHdr("device-performance-class", perfClass),
      mkHdr("device-make", device.deviceMake),
      mkHdr("device-model", device.deviceModel),
      mkHdr("device-id", device.deviceId),
      mkHdr("x-px-mobile-sdk-version", "3.3.3"),
      mkHdr("x-px-os", "Android"),
      mkHdr("x-px-os-version", androidVer),
      mkHdr("x-px-device-model", device.deviceModel),
      mkHdr("x-px-vid", pxVid),
      mkHdr("x-px-uuid", pxUuid),
      mkHdr("x-px-device-fp", pxDeviceFp),
      mkHdr("x-px-authorization", "4"),
      mkHdr("x-px-original-token", pxOrigToken),
      mkHdr("adjust-ad-id", adjustAdId),
      mkHdr("sentry-trace", rSigData.rts ? sentryData.sentryTrace : ""),
      mkHdr("baggage", baggageV2),
      mkHdr("em-request-identifier", emReqId),
      mkHdr("r-sig", rSigData.signature),
      mkHdr("rts", rSigData.rts),
      mkHdr("ruid", rSigData.ruid),
      mkHdr("eks", rSigData.eks),
      mkHdr("x-okcronet-trace", "cartCalculate"),
      mkHdr("x-okcronet-priority", "high"),
      // authorization EKLEMİYORUZ — kural 1 android token'ı siliyor
      // cookie'deki volo token (token=...) otomatik gidecek → kupon çalışır
      // Cookie header'ı calcAndroidHeaders'a ekleme — updateCookieRule (rule 6755) halleder
    ].filter(Boolean);

    // checkout/purchase için headers (x-okcronet-trace farklı, android token)
    const checkoutAndroidHeaders = calcAndroidHeaders
      .map((h) =>
        h.header === "x-okcronet-trace"
          ? mkHdr("x-okcronet-trace", "cartCheckout")
          : h,
      )
      .filter(Boolean);

    const purchaseAndroidHeaders = calcAndroidHeaders
      .map((h) =>
        h.header === "x-okcronet-trace"
          ? mkHdr("x-okcronet-trace", "purchaseIntent")
          : h,
      )
      .filter(Boolean);

    // incentives-wallet/vouchers için headers (android)
    const incentivesHeaders = calcAndroidHeaders
      .map((h) =>
        h.header === "x-okcronet-trace"
          ? mkHdr("x-okcronet-trace", "incentives")
          : h,
      )
      .filter(Boolean);
    if (androidTk) {
      incentivesHeaders.push(
        { header: "x-fp-api-key", operation: "set", value: "android" },
        {
          header: "Authorization",
          operation: "set",
          value: `Bearer ${androidTk}`,
        },
        {
          header: "User-Agent",
          operation: "set",
          value: `Android-app-${appVersion}(${buildNumber})`,
        },
      );
    }

    // Calculate için header seti = android headers ama authorization yok
    // Kural 1 android authorization'ı siliyor → cookie'deki volo token otomatik gider
    // YeKupon yöntemi: browser cookie'ye güven, sadece android meta headers ekle
    const calcVoloHeaders = calcAndroidHeaders;

    // Calculate / checkout / purchase/intent DNR:
    // Android access token, x-fp-api-key android, cihaz başlıkları ve gerçek
    // çerez kavanozu. İmza başlıkları istek gövdesine bağlı; DNR'ye yazılmıyor.
    const dropSig = new Set(["r-sig", "rts", "ruid", "eks"]);
    const stripBrowser = [
      "sec-ch-ua",
      "sec-ch-ua-mobile",
      "sec-ch-ua-platform",
      "sec-fetch-dest",
      "sec-fetch-mode",
      "sec-fetch-site",
      "sec-fetch-user",
      "sec-fetch-storage-access",
      "referer",
      "x-requested-with",
      "x-caller-platform",
      "x-px-bypass-reason",
      "x-px-bypass-enhanced",
      "x-px-client-type",
      "priority",
    ];
    const pxCookieHeader = (src) => {
      const parts = [];
      for (const part of String(src || "").split("; ")) {
        const name = part.split("=")[0];
        if (!name.startsWith("_px") || !part.includes("=")) continue;
        const next = parts.concat(part).join("; ");
        if (next.length > 3500) continue;
        parts.push(part);
      }
      return parts.join("; ") || `_pxvid=${pxVid}`;
    };
    const kmHeaders = (base, withAuth) => {
      const headers = base.filter(
        (h) =>
          h &&
          !dropSig.has(String(h.header).toLowerCase()) &&
          String(h.header).toLowerCase() !== "host",
      );
      const put = (header, value) => {
        if (!value) return;
        const row = { header, operation: "set", value: String(value) };
        const i = headers.findIndex(
          (x) => x.header.toLowerCase() === header.toLowerCase(),
        );
        if (i >= 0) headers[i] = row;
        else headers.push(row);
      };
      put("x-fp-api-key", "android");
      const authTok =
        withAuth === false ? "" : typeof withAuth === "string" ? withAuth : androidTk;
      if (authTok && ysPayFresh(authTok)) put("Authorization", `Bearer ${authTok}`);
      put("User-Agent", `Android-app-${appVersion}(${buildNumber})`);
      put("Origin", "https://www.yemeksepeti.com");
      // Geniş fd-api kuralı tüm çerez kavanozunu (volo token dahil) basar.
      // Kavanoz 7000 karakteri aşınca bu kural Cookie yazmıyordu ve düşük
      // öncelikli kural kazanıyordu: android Authorization + volo oturum
      // çerezi. Ödeme o ikiliyi reddediyor. Checkout yalnızca PX çerezini bırakır.
      put("Cookie", pxCookieHeader(cookieSt));
      for (const name of stripBrowser) {
        if (
          !headers.some((x) => x.header.toLowerCase() === name.toLowerCase())
        ) {
          headers.push({ header: name, operation: "remove" });
        }
      }
      return headers;
    };

    const rules = [
      ...(androidTk
        ? [
            {
              id: 9,
              priority: 5,
              action: {
                type: "modifyHeaders",
                requestHeaders: kmHeaders(calcAndroidHeaders),
              },
              condition: {
                regexFilter:
                  "^https://tr\\.fd-api\\.com/api/v5/(?:rs/|qc/)?cart/calculate",
                requestMethods: ["post"],
              },
            },
            {
              id: 4,
              priority: 5,
              action: {
                type: "modifyHeaders",
                requestHeaders: kmHeaders(checkoutAndroidHeaders, checkoutTk || false),
              },
              condition: {
                regexFilter:
                  "^https://tr\\.fd-api\\.com/api/v5/(?:rs/|qc/)?cart/checkout",
                requestMethods: ["post"],
              },
            },
            {
              id: 19,
              priority: 5,
              action: {
                type: "modifyHeaders",
                requestHeaders: kmHeaders(calcAndroidHeaders),
              },
              condition: {
                regexFilter:
                  "^https://www\\.yemeksepeti\\.com/api/v5/(?:rs/|qc/)?cart/calculate",
                requestMethods: ["post"],
              },
            },
            {
              id: 14,
              priority: 5,
              action: {
                type: "modifyHeaders",
                requestHeaders: kmHeaders(checkoutAndroidHeaders, checkoutTk || false),
              },
              condition: {
                regexFilter:
                  "^https://www\\.yemeksepeti\\.com/api/v5/(?:rs/|qc/)?cart/checkout",
                requestMethods: ["post"],
              },
            },
          ]
        : []),

      // 5. incentives-wallet: android headers
      {
        id: 5,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: incentivesHeaders },
        condition: {
          urlFilter: "https://tr.fd-api.com/api/v6/incentives-wallet",
          resourceTypes: ["xmlhttprequest"],
        },
      },
      // 6. vouchers: redirect — platform=android_native_app
      {
        id: 6,
        priority: 1,
        action: {
          type: "redirect",
          redirect: {
            transform: {
              queryTransform: {
                addOrReplaceParams: [
                  { key: "platform", value: "android_native_app" },
                  { key: "statuses", value: "APPLICABLE,NOT_APPLICABLE" },
                  { key: "language_id", value: "2" },
                ],
              },
            },
          },
        },
        condition: {
          urlFilter: "|https://tr.fd-api.com/api/v6/incentives-wallet/vouchers",
          resourceTypes: ["xmlhttprequest"],
        },
      },
      // 7. Cookie rule — fd-api.com XHR
      // 8. CORS response fix
      {
        id: 100,
        priority: 500,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            {
              header: "access-control-allow-origin",
              operation: "set",
              value: "https://www.yemeksepeti.com",
            },
            {
              header: "access-control-allow-credentials",
              operation: "set",
              value: "true",
            },
            {
              header: "access-control-allow-methods",
              operation: "set",
              value: "GET, POST, PUT, DELETE, OPTIONS",
            },
            {
              header: "access-control-allow-headers",
              operation: "set",
              value: "*",
            },
          ],
        },
        condition: {
          urlFilter: "*tr.fd-api.com/*",
          resourceTypes: ["xmlhttprequest"],
        },
      },
    ];

    const wideCookieRules = rules.filter((r) => r.id === 6755);
    const coreRules = rules.filter((r) => r.id !== 6755);
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: coreRules,
    });
    if (wideCookieRules.length) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: wideCookieRules,
        });
      } catch (cookieErr) {
        console.warn(
          "[YS Rules] genis cerez kurali atlandi:",
          cookieErr.message,
        );
      }
    }
    console.log(
      "[YS Rules] updateRules tamamlandı:",
      coreRules.length,
      "kural, r-sig:",
      !!rSigData.signature,
    );
  } catch (e) {
    console.warn("[YS Rules] updateRules hatası:", e.message);
  }
}

// ── checkAndManageAuthRules — 5dk keepalive ──────────────────────────────────
async function checkAndManageAuthRules() {
  try {
    const ck = await chrome.cookies
      .get({ url: "https://www.yemeksepeti.com", name: "access_token" })
      .catch(() => null);
    if (!ck?.value) {
      await chrome.declarativeNetRequest
        .updateDynamicRules({ removeRuleIds: [3333, 4444, 5555], addRules: [] })
        .catch(() => {});
    }
  } catch (_) {}
}

// YS cookie değişince updateCookieRule tetikle (debounce — sonsuz döngüyü önler)
let _ysCoookieDebounce = null;
chrome.cookies.onChanged.addListener((change) => {
  if (
    !change.cookie.domain ||
    !change.cookie.domain.includes("yemeksepeti.com")
  )
    return;
  // Sadece ilgili cookie'leri izle
  const watchedNames = ["_pxhd", "__cf_bm", "access_token", "android_token", "token"];
  if (!watchedNames.includes(change.cookie.name)) return;

  clearTimeout(_ysCoookieDebounce);
  _ysCoookieDebounce = setTimeout(async () => {
    await updateCookieRule().catch(() => {});
    if (["access_token", "token"].includes(change.cookie.name)) {
      await setAuthorizationHeader().catch(() => {});
    }
  }, 2000); // 2 saniye debounce
});

// YS sekmesi yüklenince kuralları kontrol et
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url &&
    tab.url.includes("yemeksepeti.com")
  ) {
    checkAndManageAuthRules();
  }
});

// Her 5 dakikada keepalive
setInterval(checkAndManageAuthRules, 5 * 60 * 1000);

console.log("[YS] Device + DNR + Cookie sistemi aktif");

// ==================== EKS ÜRETME YARDIMCISI ====================
// Geçerli PEK+PES kombinasyonlarından rastgele seç (rakip generateEks ile uyumlu)
function generateEksValue() {
  const validCombinations = [
    "abcaaa",
    "abccvc",
    "abccbc",
    "abccsc",
    "abcasd",
    "aaaabc",
    "aaacvc",
    "aaacbc",
    "aaacsc",
    "aaaasd",
    "amgabc",
    "amgaaa",
    "amgcvc",
    "amgcbc",
    "amgcsc",
    "aq3abc",
    "aq3aaa",
    "aq3cvc",
    "aq3cbc",
    "aq3csc",
    "mnpabc",
    "mnpaaa",
    "mnpcvc",
    "mnpcbc",
    "mnpcsc",
    "gigabc",
    "gigaaa",
    "gigcvc",
    "gigcbc",
    "gigcsc",
  ];
  return validCombinations[
    Math.floor(Math.random() * validCombinations.length)
  ];
}

console.log("[KuponStore] R-Sig + EKS sistemi aktif");

// Trendyol ödeme sayfası için herhangi bir tgo-token kaldır/geri koy yöntemi
// denendi ama oturum bozuluyordu — kaldırıldı.
// payment.tgoapps.com için DNR guest token yöntemi kullanılıyor (setupTrendyolPaymentHeaderRules).

// Native tgoyemek.com/odeme: payment iframe XHR için DNR kuralları
// setupTrendyolPaymentHeaderRules ile Bearer + lc / TrendyolGo başlık profili uygulanır.

