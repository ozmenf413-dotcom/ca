// Bu dosya, ağ isteklerinin belirli endpoint'lere ait olup olmadığını kontrol eden
// yardımcı fonksiyonları içerir.

'use strict';

// Token endpoint'ini engellemek için kontrol fonksiyonu
function isTokenEndpoint(url) {
  return url && (url.includes('users/tokens'));
}

// Logout/exit endpoint'ini engellemek için kontrol fonksiyonu
function isLogoutEndpoint(url) {
  return url && (url.includes('auth/exit') || url.includes('users/closed-accounts') || url.includes('users/registration-blocks'));
}

// Screen-views endpoint'ini engellemek için kontrol fonksiyonu
function isScreenViewsEndpoint(url) {
  return url && url.includes('screen-views');
}

// Service Worker dosyasını engellemek için kontrol fonksiyonu
function isServiceWorkerFile(url) {
  return url && (
    url.includes('ngsw-worker.js') ||
    url.includes('/ngsw-worker.js') ||
    url.endsWith('ngsw-worker.js')
  );
}

// PWA manifest dosyalarını engellemek için kontrol fonksiyonu
function isPWAManifestFile(url) {
  return url && (
    url.includes('manifest.json') ||
    url.includes('/manifest.json') ||
    url.endsWith('manifest.json') ||
    url.includes('ngsw.json') ||
    url.includes('/ngsw.json') ||
    url.endsWith('ngsw.json') ||
    url.includes('ngsw.json?ngsw-cache-bust=') || url.includes("cookie-settings")
  );
}

// Profil ikonu dosyasını engellemek için kontrol fonksiyonu
function isProfileIconFile(url) {
  return url && (
    url.includes('profilim_icon_s.webp') ||
    url.includes('/profilim_icon_s.webp') ||
    url.endsWith('profilim_icon_s.webp')
  );
}

// Tüm checkout endpoints için ortak bir kontrol fonksiyonu
function isCheckoutScreensEndpoint(url) {
  return url && (
    url.includes('/checkouts/screens/single') || 
    url.includes('/checkouts/screens/hexapolygons') || 
    url.includes('/checkouts/screens/schedules')
  );
}

// Custom texts endpoint'ini kontrol fonksiyonu
function isCustomTextsEndpoint(url) {
  return false;
  return (url && url.includes('custom-texts')) || url.includes('homepage/visibility');
}

// Yemeksepeti proxy'lenecek endpoint'leri (rakip endpoints.js)
function isYsProxyEndpoint(url) {
  return url && (
    url.includes('tr.fd-api.com/api/v5/cart/checkout') ||
    url.includes('tr.fd-api.com/api/v5/cart/calculate') ||
    url.includes('tr.fd-api.com/api/v6/incentives-wallet/vouchers') ||
    /tr\.fd-api\.com\/api\/v5\/purchase\/intent(\?|$)/.test(url)
  );
}

// Yemeksepeti calculate endpoint kontrol fonksiyonu
function isYemekSepetiCalculateEndpoint(url) {
  return url && (
    url.includes('tr.fd-api.com/api/v5/cart/calculate') &&
    window.location.hostname.includes('yemeksepeti.com')
  );
}

// Yemeksepeti vouchers endpoint kontrol fonksiyonu
function isYemekSepetiVouchersEndpoint(url) {
  return url && (
    url.includes('tr.fd-api.com/api/v6/incentives-wallet/vouchers') &&
    window.location.hostname.includes('yemeksepeti.com')
  );
}

// Perseus Analytics endpoint'ini engellemek için kontrol fonksiyonu
function isPerseusAnalyticsEndpoint(url) {
  return url && (
    url.includes('perseus-productanalytics.deliveryhero.net') ||
    url.includes('/v1/insert/pandora/hit')
  );
}

// Migros proxy'lenecek endpoint'leri kontrol eden fonksiyon
function isMgProxyEndpoint(url) {
  return url && url.includes('rest.migros.com.tr') && (
    url.includes('/checkouts/screens/single') ||
    url.includes('/checkouts/screens/hexapolygons') ||
    url.includes('/checkouts/screens/schedules') ||
    url.includes('/purchase/online/credit-card')
  );
}

// Trendyol proxy'lenecek endpoint'leri kontrol eden fonksiyon
function isTyProxyEndpoint(url) {
  return url && url.includes('api.tgoapis.com') && (
    url.includes('/meal-mmcheckout-sfxcarts-santral/carts/code-promotions') ||
    url.includes('/web-checkout-apicheckout-santral/carts/code-promotions') ||
    url.includes('/web-checkout-apicheckout-santral/carts/coupons') ||
    url.includes('/web-checkout-apicheckout-santral/carts')
  );
}

// Analytics ve tracking URL'lerini engellemek için kontrol fonksiyonu
function isAnalyticsOrTrackingEndpoint(url) {
  if (!url) return false;
  
  const blockedPatterns = [
    "px-cloud.net",
    "sentry.io",
    "usercentrics.eu",
    "tvsquared.com",
    "icg-in.com",
    "braze.com",
    "api/v2/collector",
    "trackjs.com",
    "xhr/b/s",
    "cdn-cgi/rum",
    "px-cdn.net",
    "perseus-productanalytics",
    "/v5/action-log",
    "pxchk.net",
    "hotjar.io",
    "hotjar.com",
    "datadoghq.eu",
    "hexagon-analytics",
    "qualtrics.com",
    "datadog",
    "browser-intake-datadoghq.eu",
    "deliveryhero.com/api/logs",
    "bruce-ys-tr.production.eu.fintech.deliveryhero.com/api/logs",
    "at-display-eu.deliveryhero.io",
    "disco.deliveryhero.io/up-and-cross-sell",
    "action-log.yemeksepeti.com",
    "/v1/insert/pandora/hit",
    "perseus-productanalytics.deliveryhero.net",
    "conn-check.icg-in.info",
    "pagespeed.deliveryhero.net",
    "browser-http-intake.logs.datadoghq.eu/v1",
    "browser-http-intake",
    "browser-http-intake.logs.datadoghq.eu",
    "yemeksepeti.com/cdn-cgi/rum"
];
  
  return blockedPatterns.some(pattern => url.includes(pattern));
}
