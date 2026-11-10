// ============================================
// YemekSepeti Background Module (KuponStore-YS v1.2.14)
// All YS-specific functions and handlers
// ============================================

function isYemeksepetiDomain(domain) {
  const cleanDomain = domain.toLowerCase().replace('www.', '');
  const allowedDomains = [
    'yemeksepeti.com',
    'fd-api.com',
    'tr.fd-api.com',
    'deliveryhero.com'
  ];

  return allowedDomains.some(allowed =>
    cleanDomain === allowed ||
    cleanDomain.endsWith('.' + allowed)
  );
}

async function closeOpenYemeksepetiTabs() {
  const hosts = ['yemeksepeti.com', 'fd-api.com', 'deliveryhero.com', 'px-cloud.net', 'px-cdn.net', 'pxchk.net', 'px-client.net', 'perimeterx.net', 'foodora.com'];
  const tabs = await chrome.tabs.query({});
  const ids = [];
  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl || '';
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (e) { continue; }
    if (hosts.some(function (d) { return host === d || host.endsWith('.' + d); })) ids.push(tab.id);
  }
  if (!ids.length) return 0;
  await chrome.tabs.remove(ids);
  console.log('Açık Yemeksepeti sekmeleri kapatıldı:', ids.length);
  return ids.length;
}

function yemeksepetiCleanupOrigins(domains) {
  const set = new Set();
  for (const domain of domains) {
    const base = String(domain || '').trim().toLowerCase();
    if (!base) continue;
    set.add('https://' + base);
    if (!base.startsWith('www.')) set.add('https://www.' + base);
  }
  return Array.from(set);
}

// Giriş sırasında reinject eski oturumu geri yazmasın
let ysLoginInProgress = false;

/** Rakip performPreCleanup: cookie yazmadan önce YS sepet/oturum/cache sıfırla */
async function prepareFreshYsLogin() {
  ysLoginInProgress = true;
  try {
    try {
      const cur = await chrome.storage.local.get(['yemekhub_session']);
      const sess = Object.assign({}, (cur && cur.yemekhub_session) || {});
      sess.cookies = [];
      sess.isLogged = false;
      sess.isCookieInserted = false;
      await chrome.storage.local.set({ yemekhub_session: sess });
    } catch (_) {}

    await clearYemeksepetiLikeChromeSettings();

    for (let i = 0; i < 10; i++) {
      const testCookie = await new Promise((resolve) => {
        chrome.cookies.get({ url: 'https://www.yemeksepeti.com', name: 'access_token' }, resolve);
      });
      if (!testCookie) {
        console.log('[KS LOGIN] Ön temizleme doğrulandı', (i + 1) * 100, 'ms');
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    console.warn('[KS LOGIN] Ön temizleme doğrulanamadı, devam');
    return false;
  } catch (e) {
    console.warn('[KS LOGIN] Ön temizleme hata:', e && e.message);
    return false;
  }
}

async function clearYemeksepetiLikeChromeSettings() {
  console.log('🛡️ ULTRA GÜVENLİ YEMEKSEPETİ TEMİZLEME BAŞLIYOR...');
  console.log('✅ SADECE YEMEKSEPETİ DOMAIN\'LERİ TEMİZLENECEK');
  console.log('🛡️ DİĞER TÜM SİTELER KORUNACAK');
  console.log('❌ GLOBAL FALLBACK: DEVRE DIŞI');

  const yemeksepetiDomains = [
    'www.yemeksepeti.com',
    'yemeksepeti.com',
    'tr.fd-api.com',
    'fd-api.com',
    'deliveryhero.com',
    'px-cloud.net',
    'px-cdn.net',
    'pxchk.net',
    'px-client.net',
    'client.perimeterx.net',
    'micro-assets.foodora.com'
  ];

  const totalStartTime = performance.now();
  const results = { cookie: false, browsing: false, cache: false };

  try {
    try {
      await closeOpenYemeksepetiTabs();
    } catch (error) {
      console.warn('⚠️ Sekme kapatma hatası:', error);
    }

    try {
      await clearAllRules();
    } catch (error) {
      console.warn('⚠️ Ağ kuralı temizleme hatası:', error);
    }

    deviceInfo = null;
    calculateProxySession = null;
    try {
      await chrome.storage.local.remove('deviceInfo');
    } catch (error) {
      console.warn('Cihaz kimliği silinemedi:', error);
    }

    console.log('🍪 Tüm Yemeksepeti cookie\'leri temizleniyor (TEK SEFERĐE)...');
    const cookieStartTime = performance.now();
    try {
      const stores = await chrome.cookies.getAllCookieStores();
      const cookieDomains = ['yemeksepeti.com', 'fd-api.com', 'deliveryhero.com', 'px-cloud.net', 'px-cdn.net', 'pxchk.net', 'px-client.net', 'perimeterx.net', 'foodora.com'];
      let normalRemoved = 0;
      let partitionedRemoved = 0;
      const groups = await Promise.all(stores.flatMap(store =>
        cookieDomains.map(domain =>
          chrome.cookies.getAll({ domain: domain, storeId: store.id })
            .then(list => ({ storeId: store.id, list: list || [] }))
            .catch(() => ({ storeId: store.id, list: [] }))
        )
      ));
      const seen = new Set();
      const removePromises = [];

      for (const group of groups) {
        for (const cookie of group.list) {
          const cookieKey = group.storeId + '|' + cookie.domain + '|' + cookie.path + '|' + cookie.name;
          if (seen.has(cookieKey)) continue;
          seen.add(cookieKey);
          const protocol = cookie.secure ? 'https' : 'http';
          const host = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
          const url = `${protocol}://${host}${cookie.path}`;

          removePromises.push(
            chrome.cookies.remove({ url, name: cookie.name, storeId: group.storeId })
              .then(() => normalRemoved++)
              .catch(() => null)
          );

          if (cookie.partitionKey) {
            removePromises.push(
              chrome.cookies.remove({ url, name: cookie.name, storeId: group.storeId, partitionKey: cookie.partitionKey })
                .then(() => partitionedRemoved++)
                .catch(() => null)
            );
          }
        }
      }

      await Promise.all(removePromises);
      const cookieDuration = performance.now() - cookieStartTime;
      console.log(`✅ Yemeksepeti cookie temizleme tamamlandı: ${cookieDuration.toFixed(2)}ms (normal: ${normalRemoved}, partitioned: ${partitionedRemoved})`);
      results.cookie = true;
    } catch (error) {
      console.warn(`⚠️ Cookie temizleme hatası:`, error);
    }

console.log('🗑️ Tüm Yemeksepeti domain\'leri için browsing data temizleniyor (TEK SEFERĐE)...');
    const browsingStartTime = performance.now();
    try {
      const origins = yemeksepetiCleanupOrigins(yemeksepetiDomains);
      const dataToRemove = {
        "cache": true,
        "cacheStorage": true,
        "cookies": true,
        "indexedDB": true,
        "localStorage": true,
        "serviceWorkers": true
      };

      try {
        await chrome.browsingData.remove({ origins: origins, since: 0 }, dataToRemove);
      } catch (bulkError) {
        console.warn('Toplu site verisi silinemedi, paralel deneniyor:', bulkError);
        await Promise.all(origins.map(origin =>
          chrome.browsingData.remove({ origins: [origin], since: 0 }, dataToRemove).catch(() => null)
        ));
      }

      const browsingDuration = performance.now() - browsingStartTime;
      console.log(`✅ Browsing data temizleme tamamlandı: ${browsingDuration.toFixed(2)}ms`);
      console.log(`   📋 Temizlenen domain'ler: ${yemeksepetiDomains.join(', ')}`);
      results.browsing = true;
      results.cache = true;
    } catch (error) {
      console.warn(`⚠️ Browsing data temizleme hatası:`, error);
    }

  } catch (error) {
    console.error(`❌ Genel temizleme hatası:`, error);
  }

const totalDuration = performance.now() - totalStartTime;
  const successCount = Object.values(results).filter(Boolean).length;

  console.log(`⏱️ TOPLAM TEMİZLEME SÜRESİ: ${totalDuration.toFixed(2)}ms`);
  console.log(`📊 SONUÇLAR: Cookie(${results.cookie ? '✅' : '❌'}) | Browsing(${results.browsing ? '✅' : '❌'}) | Cache(${results.cache ? '✅' : '❌'})`);
  console.log(`🛡️ ETKİLENEN DOMAIN'LER: ${yemeksepetiDomains.join(', ')}`);
  console.log(`🛡️ KORUNAN: Diğer tüm sitelerin verileri (%100 güvenli)`);
  console.log(`⏰ ZAMANLAMA: Yemeksepeti.com açılmadan ÖNCE`);

return successCount >= 2;
}

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';

  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return result;
}

function generateHex(length) {
  const hexChars = '0123456789abcdef';
  let result = '';

  for (let i = 0; i < length; i++) {
    result += hexChars.charAt(Math.floor(Math.random() * hexChars.length));
  }

  return result;
}

function generatePxCookies() {
    const px3Part1 = generateHex(64);
    const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

    let px3Part2 = '';
    for (let i = 0; i < 88; i++) {
        px3Part2 += base64Chars.charAt(Math.floor(Math.random() * base64Chars.length));
    }

    let px3Part3 = '';
    for (let i = 0; i < 344; i++) {
        px3Part3 += base64Chars.charAt(Math.floor(Math.random() * base64Chars.length));
    }

    const _px3 = `${px3Part1}:${px3Part2}:1000:${px3Part3}`;
    const _pxhd = generateHex(48);
    const _pxvid = generateUUIDv4();
    const _pxcts = Date.now().toString();

    return `_px3=${_px3}; _pxhd=${_pxhd}; _pxvid=${_pxvid}; _pxcts=${_pxcts}`;
}

function generatePxOriginalToken() {
    const part1 = '3';
    const part2 = generateHex(64);
    const part3 = btoa(generateHex(32)).replace(/=/g, '');
    const part4 = '1000';
    const part5 = btoa(generateHex(128)).replace(/=/g, '');
    return `${part1}:${part2}:${part3}:${part4}:${part5}`;
}

function generatePxDeviceFp() {
    return 'fp:' + generateHex(32);
}

function generateDevicePerformanceClass() {
    const classes = ['low', 'medium', 'high'];
    const weights = [30, 50, 20];
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;
    for (let i = 0; i < classes.length; i++) {
        random -= weights[i];
        if (random <= 0) return classes[i];
    }
    return 'medium';
}

function generateSentrySampleRand() {
    let rand = '0.';
    for (let i = 0; i < 16; i++) {
        rand += Math.floor(Math.random() * 10);
    }
    return rand;
}

function generateBaggageV2(traceId, appVersion, buildNumber) {
    const SENTRY_PUBLIC_KEY = '385c49e6b6c4484d8362abae622b3f0b';
    const sampleRand = generateSentrySampleRand();
    return `sentry-environment=production,sentry-public_key=${SENTRY_PUBLIC_KEY},sentry-release=com.inovel.app.yemeksepeti%40${appVersion}%2B${buildNumber},sentry-sample_rand=${sampleRand},sentry-sampled=false,sentry-trace_id=${traceId},sentry-transaction=refresh_token_interceptor`;
}

function generateSentryTraceV2() {
    const traceId = generateHex(32);
    const spanId = generateHex(16);
    return { traceId, sentryTrace: `${traceId}-${spanId}-0` };
}

async function generateRSig(deviceId) {
    try {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const currentTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}+0300`;
        const randomNum = Math.random().toFixed(16).substring(1);
        const dataToHash = deviceId + currentTime + randomNum;

        const encoder = new TextEncoder();
        const encodedData = encoder.encode(dataToHash);
        const hashBuffer = await crypto.subtle.digest('SHA-256', encodedData);
        const hashArray = new Uint8Array(hashBuffer);
        const signature = btoa(String.fromCharCode(...hashArray));

        return {
            success: true,
            signature: signature,
            rts: currentTime,
            ruid: randomNum,
            eks: deviceId.substring(0, 6)
        };
    } catch (error) {
        return {
            success: false,
            signature: btoa(generateHex(32)),
            rts: new Date().toISOString(),
            ruid: Math.random().toFixed(16).substring(1),
            eks: generateHex(6)
        };
    }
}

function parseCustCodeFromToken(token) {
    if (!token) return '';
    try {
        const parts = token.split('.');
        if (parts.length === 3) {
            const payload = JSON.parse(atob(parts[1]));
            return payload.user_id || '';
        }
    } catch (e) {}
    return '';
}

function generateBase64Random(length) {
    const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += base64Chars.charAt(Math.floor(Math.random() * base64Chars.length));
    }
    return result;
}

function generateWebCookies(perseusClientId, perseusSessionId, pxData) {
    const timestamp = Date.now();
    const pxd = (pxData && typeof pxData === 'object') ? pxData : {};

const dhhFromDb = pxd.dhh_perseus_guest_id || pxd.dhhPerseusGuestId || '';
    if (dhhFromDb) {
        perseusClientId = dhhFromDb;
    } else if (!perseusClientId) {
        perseusClientId = `${timestamp}.${Math.floor(Math.random() * 9e14) + 1e14}.${generateRandomString(10)}`;
    }

if (!perseusSessionId) {
        perseusSessionId = `${timestamp}.${Math.floor(Math.random() * 9e14) + 1e14}.${generateRandomString(10)}`;
    }

const pxvid = (pxd.px_vid || pxd.x_px_vid || '') || generateUUIDv4();

    const pxcts = generateUUIDv4();
    // 🔒 LOCK-ONCE: __ssid (Sift Science session ID) DB'de varsa kullan, yoksa uret
    const ssidFromDb = pxd.ssid || pxd.__ssid || '';
    const ssid = ssidFromDb || generateUUIDv4();

    // 🔒 LOCK-ONCE: tsesid (Treasure Data persistent session) DB'de varsa kullan
    const tsesidFromDb = pxd.tsesid || '';

    // 🔒 LOCK-ONCE: ld_key (LaunchDarkly anahtari) DB'de varsa kullan,
    // yoksa eski davranisi koru (perseusClientId'yi kullan)
    const ldKeyFromDb = pxd.ld_key || pxd.ldKey || '';
    const ldKey = ldKeyFromDb || perseusClientId;

const pxhdFromDb = pxd.px_hd || pxd.x_px_hd || '';
    const pxhdPart1 = generateBase64Random(54);
    const pxhdPart2 = generateBase64Random(80);

    const px3Salt = generateHex(64);
    const px3Hmac = generateBase64Random(88);
    const px3Ct = generateBase64Random(364);

    const cfBmVal = generateBase64Random(44).replace(/\+/g, '.').replace(/\//g, '_');
    const cfBmVal2 = generateBase64Random(54).replace(/\+/g, '.').replace(/\//g, '_');

    const gStateB = generateBase64Random(44);

    const ddId = `${generateHex(8)}-${generateHex(4)}-${generateHex(4)}-${generateHex(4)}-${generateHex(12)}`;

    const tqId = `${generateHex(16)}.${Math.floor(timestamp / 1000)}.0.${Math.floor(timestamp / 1000)}..`;

    const hitId = `${timestamp + Math.floor(Math.random() * 4900) + 100}.${Math.floor(Math.random() * 9e14) + 1e14}.${generateRandomString(10)}`;

    const cookies = [
        `dhhPerseusGuestId=${perseusClientId}`,
        `dhhPerseusSessionId=${perseusSessionId}`,
        `ld_key=${ldKey}`,
        `hl=tr`,
        `is-generic-address=true`,
        `_pxhd=${pxhdFromDb || (pxhdPart1 + '==' + pxhdPart2 + '=')}`,
        `__cf_bm=${cfBmVal}-${Math.floor(timestamp / 1000)}-1.0.1.1-${cfBmVal2}`,
        `dps-session-id=41.076703_29.010804_${perseusClientId}_${Math.floor(timestamp / 1000)}_${Math.floor(timestamp / 1000) + 1800}`,
        `_pxvid=${pxvid}`,
        `pxcts=${pxcts}`,
        `g_state={"i_l":0,"i_ll":${timestamp},"i_b":"${gStateB}","i_e":{"enable_itp_optimization":1}}`,
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
        ...(tsesidFromDb ? [`tsesid=${tsesidFromDb}`] : []),
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
        `_dd_s=logs=1&id=${ddId}&created=${timestamp}&expire=${timestamp + 900000}`,
        `dhhPerseusHitId=${hitId}`
    ];

    return cookies.join('; ');
}

function generateRandomVersions() {

  const majorVersions = [22, 23, 24, 25];
  const minorVersions = Array.from({length: 100}, (_, i) => i);
  const patchVersions = Array.from({length: 10}, (_, i) => i);

const major = majorVersions[Math.floor(Math.random() * majorVersions.length)];
  const minor = minorVersions[Math.floor(Math.random() * minorVersions.length)];
  const patch = patchVersions[Math.floor(Math.random() * patchVersions.length)];

const buildNumber = sprintf("%d%02d%d00", major, minor, patch);

const version = sprintf("%d.%d.%d", major, minor, patch);

const buildSuffix = Math.floor(Math.random() * 900) + 100;
  const fullBuildNumber = buildNumber + buildSuffix;

const userAgent = `Android-app-${version}(${fullBuildNumber})`;

  return {
    version: version,
    buildNumber: fullBuildNumber,
    userAgent: userAgent
  };
}

function sprintf(format) {
  const args = Array.prototype.slice.call(arguments, 1);
  return format.replace(/%([0-9]+)?([dfs])/g, function(match, width, type) {
    let s = args.shift().toString();
    if (type === 'd' && width) {
      s = s.padStart(parseInt(width, 10), '0');
    }
    return s;
  });
}

function generatePxToken() {

  const part1 = "3:";

const part2 = Array.from({length: 32}, () =>
    "0123456789abcdef"[Math.floor(Math.random() * 16)]).join('');

const part3 = Array.from({length: 88}, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="[Math.floor(Math.random() * 65)]).join('');

const part4 = "1000";

const part5 = Array.from({length: 256}, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="[Math.floor(Math.random() * 65)]).join('');

  return part1 + part2 + ":" + part3 + ":" + part4 + ":" + part5;
}

function generateRandomDevice() {

  const deviceId = Array.from({length: 32}, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join('');

const makes = ["Xiaomi", "HUAWEI", "Redmi", "Samsung", "POCO", "oppo", "Asus"];
  const deviceMake = makes[Math.floor(Math.random() * makes.length)];

const models = ["CPH2341", "M2101K6G", "M2004J19C", "2201116TG", "2207117BPG", "ASUS_I005DA", "ASUS_Z01QD"];
  const deviceModel = models[Math.floor(Math.random() * models.length)];

const platformVersion = 23 + Math.floor(Math.random() * 10);

  return {
    deviceId: deviceId,
    deviceMake: deviceMake,
    deviceModel: deviceModel,
    platformVersion: platformVersion
  };
}

function generateRandomEks() {

  return Array.from({length: 6}, () =>
    "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join('');
}

function generateUUIDv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function generateOriginalRts() {
  const now = new Date();

  const turkeyTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
  return turkeyTime.toISOString().replace('Z', '+03:00');
}

function generateOriginalRuid() {

  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

function generateOriginalRSig() {

  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < 44; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result + '=';
}

function generatePxAuthorization() {

  const version = "3";
  const hexPart = generateHex(64);

const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let shortBase64 = '';
  for (let i = 0; i < 64; i++) {
    shortBase64 += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  const number = "1000";

  let longBase64 = '';
  for (let i = 0; i < 340; i++) {
    longBase64 += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return `${version}:${hexPart}:${shortBase64}:${number}:${longBase64}`;
}

function generatePxHello() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const length = Math.random() < 0.5 ? 50 : 54;

  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return result;
}

function generateCleanExtra() {
  const sessionId = generateHex(32);
    const currentTime = Date.now();
    const perseusTimestamp = Math.floor(Math.random() * 55834574556737536) + 100000000000000000;
    const perseusClientId = currentTime + '.' + perseusTimestamp + '.' + generateRandomString(10);

    const sessionLength = Math.random() < 0.5 ? 16 : 18;
    let sessionTimestamp;
    if (sessionLength === 16) {
        sessionTimestamp = Math.floor(Math.random() * 8796093022208000) + 1000000000000000;
  } else {
        sessionTimestamp = Math.floor(Math.random() * 55834574556737536) + 100000000000000000;
  }

    const perseusSessionId = currentTime + 1000 + '.' + sessionTimestamp + '.' + generateRandomString(10);

    const sessionData = {
    session_id: sessionId,
    perseus_id: perseusClientId,
        timestamp: Math.floor(currentTime / 1000)
    };

    const dpsSessionId = btoa(JSON.stringify(sessionData));
    const traceId = generateHex(16);
    const spanId = generateHex(8);
    const sampled = '0';
    const sentryTrace = traceId + '-' + spanId + '-' + sampled;

    const appVersion = '26.7.0';
    const buildNumber = '260700154';
    const platformVersion = '28';
    const baggage = 'sentry-environment=production,sentry-public_key=' + platformVersion + ',sentry-release=com.inovel.app.yemeksepeti%40' + appVersion + ',sentry-transaction=sm_AskEmailFragment,' + buildNumber + ',sentry-sampled=false,sentry-trace_id=' + traceId + ',sentry-span_id=' + spanId;

  return {
    deviceFingerprintToken: generateRandomString(100),
    deviceId: generateRandomString(32),
    pxVid: generateUUIDv4(),
    pxUuid: generateUUIDv4(),
    pxDeviceFp: generateHex(16),
    pxHello: generatePxHello(),
    adjustAdId: generateHex(32),
        appVersion: appVersion,
        buildNumber: buildNumber,
    timestamp: generateOriginalRts(),
        requestId: Math.random().toString(),
        sentryTrace: sentryTrace,
        baggage: baggage,
    traceTail: generateHex(16),
    emRequestId: generateUUIDv4(),
    perseusClientId: perseusClientId,
    perseusSessionId: perseusSessionId,
    eks: generateRandomString(6),
    rSig: generateOriginalRSig(),
    dpsSessionId: dpsSessionId,
    sessionId: sessionId,
    pxAuthorization: generatePxAuthorization()
  };
}

let deviceInfo = null;

function generateDeviceIdentifiers() {
    const manufacturers = ['OPPO', 'Samsung', 'Huawei', 'ASUS', 'vivo', 'Realme', 'OnePlus', 'Google'];
    const selectedManufacturer = manufacturers[Math.floor(Math.random() * manufacturers.length)];

    const modelsByManufacturer = {
        'Samsung': ['Galaxy S22', 'Galaxy A52', 'Galaxy Note20', 'Galaxy S21'],
    'Xiaomi': ['Mi 11', 'Redmi Note 10', 'Poco F3', 'Mi 10T'],
        'Huawei': ['Mate 40', 'P40', 'Nova 8', 'P30'],
    'OPPO': ['Find X3', 'Reno 6', 'A74', 'F19'],
    'vivo': ['X60', 'V21', 'Y20', 'S9'],
    'Realme': ['GT', 'Narzo 30', '8 Pro', 'C25'],
        'OnePlus': ['9 Pro', '8T', '8 Pro', '9R'],
        'Google': ['Pixel 6', 'Pixel 6 Pro', 'Pixel 5', 'Pixel 4a']
  };

    const availableModels = modelsByManufacturer[selectedManufacturer] || modelsByManufacturer['Samsung'];
    const selectedModel = availableModels[Math.floor(Math.random() * availableModels.length)];

  const hexChars = '0123456789abcdef';
  let deviceId = '';
  for (let i = 0; i < 16; i++) {
    deviceId += hexChars.charAt(Math.floor(Math.random() * 16));
  }

  return {
        manufacturer: selectedManufacturer,
        model: selectedModel,
        deviceId: deviceId,
    appVersion: '26.7.0',
    buildNumber: '260700154',
    apiLevel: '31'
  };
}

function getOrCreateDeviceInfo() {
  if (!deviceInfo) {
    deviceInfo = generateDeviceIdentifiers();
    chrome.storage.local.set({ 'deviceInfo': deviceInfo });
  }
  return deviceInfo;
}

chrome.storage.local.get('deviceInfo', function(result) {
  if (result.deviceInfo) {
    deviceInfo = result.deviceInfo;
  } else {
    deviceInfo = generateDeviceIdentifiers();
    chrome.storage.local.set({ 'deviceInfo': deviceInfo });
  }
});

function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = part + '='.repeat((4 - part.length % 4) % 4);
    return JSON.parse(atob(pad));
  } catch (e) {
    return null;
  }
}

function sdkToAndroidRelease(sdk) {
  const map = { 28: '9', 29: '10', 30: '11', 31: '12', 32: '12', 33: '13', 34: '14', 35: '15' };
  return map[parseInt(sdk, 10)] || '14';
}

let calculateProxySession = null;

function buildCalculateProxyHeaders(request, token, accountHeadersData, accountDeviceData, device) {
  if (!calculateProxySession) {
    const extra = generateCleanExtra();
    calculateProxySession = {
      deviceId: accountDeviceData.device_id || device.deviceId,
      brand: accountDeviceData.device_make || device.manufacturer,
      model: accountDeviceData.device_model || device.model,
      androidRelease: accountHeadersData.x_px_os_version || sdkToAndroidRelease(accountHeadersData.platform_version || device.apiLevel || '34'),
      platformVersion: accountHeadersData.platform_version || device.apiLevel || '34',
      appVersion: accountHeadersData.app_version || '26.36.0',
      buildNumber: String(accountHeadersData.build_number || '263600204'),
      userAgent: accountHeadersData.user_agent || 'Android-app-26.36.0(263600204)',
      pxVid: accountHeadersData.x_px_vid || extra.pxVid,
      pxDeviceFp: accountHeadersData.x_px_device_fp || extra.pxDeviceFp,
      pxAuthorization: (accountHeadersData.x_px_authorization && accountHeadersData.x_px_authorization !== '4')
        ? accountHeadersData.x_px_authorization
        : '3',
      perseusClientId: extra.perseusClientId,
      perseusSessionId: extra.perseusSessionId,
      dpsSessionId: extra.dpsSessionId,
      adjustAdId: extra.adjustAdId
    };
  }
  const s = calculateProxySession;
  const payload = token ? decodeJwtPayload(token) : null;
  const custCode = (payload && payload.user_id) ? String(payload.user_id) : '';
  let _exp = Number((payload && (payload.exp || payload.expires)) || 0);
  if (_exp > 1e12) _exp = Math.floor(_exp / 1000);
  const tokenExpired = !!(payload && _exp && (Date.now() / 1000) >= _exp);
  const traceId = generateHex(32);
  const spanId = generateHex(16);

  const headers = {
    'user-agent': s.userAgent,
    'x-fp-api-key': 'android',
    'platform': 'android',
    'app-name': 'com.inovel.app.yemeksepeti',
    'app-flavor': 'yemeksepeti',
    'app-build': s.buildNumber,
    'app-version': s.appVersion,
    'build-number': s.buildNumber,
    'build-type': 'release',
    'release-lane': 'production',
    'platform-version': s.platformVersion,
    'content-type': 'application/json; charset=UTF-8',
    'x-pd-language-id': '2',
    'api-client-version': '5.0',
    'android-mobile-service-provider': 'gms',
    'device-performance-class': 'high',
    'cust-code': custCode,
    'device-make': s.brand,
    'device-model': s.model,
    'device-id': s.deviceId,
    'em-request-identifier': generateUUIDv4(),
    'sentry-trace': traceId + '-' + spanId + '-0',
    'baggage': 'sentry-environment=production,sentry-public_key=385c49e6b6c4484d8362abae622b3f0b,sentry-release=com.inovel.app.yemeksepeti%40' + s.appVersion + ',sentry-transaction=perseus_interceptor,sentry-sample_rate=0,sentry-sampled=false,sentry-trace_id=' + traceId + ',sentry-span_id=' + spanId,
    'x-px-mobile-sdk-version': '3.3.3',
    'x-px-os': 'Android',
    'x-px-os-version': s.androidRelease,
    'x-px-device-model': s.model,
    'x-px-vid': s.pxVid,
    'x-px-uuid': generateUUIDv4(),
    'x-px-device-fp': s.pxDeviceFp,
    'x-px-authorization': s.pxAuthorization,
    'x-px-original-token': generatePxOriginalToken(),
    'x-px-hello': generatePxHello(),
    'perseus-client-id': s.perseusClientId,
    'perseus-session-id': s.perseusSessionId,
    'adjust-ad-id': s.adjustAdId,
    'dps-session-id': s.dpsSessionId,
    'x-okcronet-trace': 'cartCalculate',
    'x-okcronet-priority': 'high'
  };

  if (token && !tokenExpired) {
    headers['authorization'] = 'Bearer ' + token;
  }

  const timestamp = new Date().toISOString().replace(/\.\d+/, '').replace('Z', '+0300');
  const random = Math.random().toString();
  const eks = 'mnpaaa';
  if (typeof generateYemeksepetiRSig !== 'undefined') {
    const sigResult = generateYemeksepetiRSig({
      url: request.url,
      eks: eks,
      body: request.body || '',
      timestamp: timestamp,
      random: random
    });
    if (sigResult && sigResult.success) {
      headers['r-sig'] = sigResult.signature;
      headers['rts'] = timestamp;
      headers['ruid'] = random;
      headers['eks'] = eks;
    }
  }
  return headers;
}

async function handleYsProxyRequest(request, sendResponse) {
  try {
    console.log('Background: YS Proxy isteği alındı', request.url);

    if (!request.url) {
      throw new Error('URL eksik');
    }

    const sessionData = await chrome.storage.local.get(['yemekhub_session']);
    const accountHeadersData = (sessionData.yemekhub_session && sessionData.yemekhub_session.headers_data)
        ? sessionData.yemekhub_session.headers_data : {};
    const accountDeviceData = (sessionData.yemekhub_session && sessionData.yemekhub_session.device_data)
        ? sessionData.yemekhub_session.device_data : {};

    const jwtClientId = (tok) => {
      try {
        const p = String(tok || '').split('.')[1];
        if (!p) return '';
        const pad = p + '='.repeat((4 - (p.length % 4)) % 4);
        return String(JSON.parse(atob(pad.replace(/-/g, '+').replace(/_/g, '/'))).client_id || '');
      } catch (_) { return ''; }
    };
    const pickAndroid = (list) => {
      for (const name of ['access_token', 'android_token', 'uy_token', 'token']) {
        const c = (list || []).find((x) => x && x.name === name && x.value);
        if (c && jwtClientId(c.value) === 'android') return c.value;
      }
      return '';
    };

    let token = '';
    const cookieNames = ['access_token', 'android_token', 'uy_token', 'token'];
    for (const name of cookieNames) {
      const ck = await new Promise((resolve) => {
        chrome.cookies.get({ url: 'https://www.yemeksepeti.com', name }, resolve);
      });
      if (ck && ck.value && jwtClientId(ck.value) === 'android') {
        token = ck.value;
        break;
      }
    }
    if (!token && sessionData.yemekhub_session && sessionData.yemekhub_session.cookies) {
      token = pickAndroid(sessionData.yemekhub_session.cookies);
    }
    if (!token) {
      const accessTokenCookie = await new Promise((resolve) => {
        chrome.cookies.get({ url: 'https://www.yemeksepeti.com', name: 'access_token' }, resolve);
      });
      token = accessTokenCookie?.value || '';
    }

    if (!token) {
      throw new Error('Access token not found');
    }
    if (jwtClientId(token) !== 'android') {
      console.warn('Background: YS Proxy bearer android değil:', jwtClientId(token));
    }

    // Vouchers proxy edilmez (rakip gibi) — save→apply rewrite kaldırıldı
    let proxyUrl = request.url;
    let proxyBody = request.body;

    const device = getOrCreateDeviceInfo();
    const isCalculate = (proxyUrl || '').includes('/cart/calculate');

    let headers;
    if (isCalculate) {
      headers = buildCalculateProxyHeaders(request, token, accountHeadersData, accountDeviceData, device);
    } else {
    // Sunucudan gelen değerleri kullan, yoksa sabit/rastgele fallback
    const appVersion = accountHeadersData.app_version || device.appVersion;
    const buildNumber = accountHeadersData.build_number || device.buildNumber;
    const userAgent = accountHeadersData.user_agent || `Android-app-${appVersion}(${buildNumber})`;
    const platformVersion = accountHeadersData.platform_version || '28';
    const deviceId = accountDeviceData.device_id || device.deviceId;
    const deviceModel = accountDeviceData.device_model || device.model;
    const deviceMake = accountDeviceData.device_make || device.manufacturer;
    const pxDeviceFp = accountHeadersData.x_px_device_fp || deviceId;
    const pxUuid = accountHeadersData.x_px_uuid || generateUUIDv4();
    const pxVid = accountHeadersData.x_px_vid || generateUUIDv4();
    const pxAuthorization = accountHeadersData.x_px_authorization || '4';

    headers = {
        "Authorization": `Bearer ${token}`,
        "X-Pd-Language-Id": "2",
        "Host": "tr.fd-api.com",
        "X-Reorder-Origin": "",
        "Connection": "keep-alive",
        "Api-Client-Version": "5.0",
        "App-Name": "com.inovel.app.yemeksepeti",
        "App-Flavor": "yemeksepeti",
        "Build-Type": "release",
        "Platform": "android",
        "Platform-Version": platformVersion,
        "Build-Number": buildNumber,
        "App-Build": buildNumber,
        "App-Version": appVersion,
        "Android-Mobile-Service-Provider": "gms",
        "Adjust-Ad-Id": generateHex(32),
        "X-Px-Vid": pxVid,
        "X-Px-Os-Version": "9",
        "X-Px-Uuid": pxUuid,
        "X-Px-Device-Fp": pxDeviceFp,
        "X-Px-Device-Model": deviceModel,
        "X-Px-Os": "Android",
        "X-Px-Mobile-Sdk-Version": "3.3.3",
        "X-Px-Authorization": pxAuthorization,
        "Device-Performance-Class": "mid",
        "X-Px-Bypass-Reason": "Invalid SDK initialization",
        "X-Fp-Api-Key": "android",
        "Eks": "mnpaaa",
        "User-Agent": userAgent,
        "Device-Make": deviceMake,
        "Device-Model": deviceModel,
        "Device-Id": deviceId,
        'Content-Type': 'application/json; charset=UTF-8',
        ...request.headers
    };
    }

    if (!isCalculate) {
    const timestamp = new Date().toISOString().replace(/\.\d+/, '').replace('Z', '+0300');
    const random = Math.random().toString();
    const eks = 'mnpaaa';

    const sigRequestData = {
        url: proxyUrl,
        eks: eks,
        body: proxyBody || "",
        timestamp: timestamp,
        random: random
    };

    if (typeof generateYemeksepetiRSig !== 'undefined') {
      const sigResult = generateYemeksepetiRSig(sigRequestData);
      if (sigResult && sigResult.success) {
          headers['R-Sig'] = sigResult.signature;
          headers['Rts'] = timestamp;
          headers['Ruid'] = random;
      } else {
          console.error('Background: YS Proxy için R-Sig üretilemedi:', sigResult ? sigResult.error : 'Bilinmeyen hata');
      }
    }
    }

    const fetchOptions = {
      method: request.method || 'POST',
      headers: headers,
      body: proxyBody,
      credentials: isCalculate ? 'include' : 'omit'
    };

    console.log('Background: YS Proxy istek gönderiliyor -', fetchOptions.method, proxyUrl);

    const response = await fetch(proxyUrl, fetchOptions);

    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    const data = await response.text();

    console.log('Background: YS Proxy yanıt alındı -', response.status, data.length + ' byte');

    sendResponse({
      success: true,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      requestHeaders: headers,
      data: data
    });

  } catch (error) {
    console.error('Background: YS Proxy istek hatası:', error);
    sendResponse({
      success: false,
      error: error.message || 'Bilinmeyen hata',
      headers: {}
    });
  }
}

function clearAllRules() {
  return new Promise(async (resolve) => {
    try {
      console.log("Kapsamlı kural temizleme işlemi başlatılıyor...");

const dynamicRules = await RequestHeaderManager.getDynamicRules();
      if (dynamicRules.length > 0) {
        const dynamicRuleIds = dynamicRules.map(rule => rule.id);
        console.log(`Temizlenecek ${dynamicRuleIds.length} dinamik kural bulundu.`);
        await RequestHeaderManager.updateDynamicRules({
          removeRuleIds: dynamicRuleIds
        });
        console.log("Tüm dinamik kurallar temizlendi.");
      } else {
        console.log("Temizlenecek dinamik kural bulunamadı.");
      }

const sessionRules = await RequestHeaderManager.getSessionRules();
      if (sessionRules.length > 0) {
        const sessionRuleIds = sessionRules.map(rule => rule.id);
        console.log(`Temizlenecek ${sessionRuleIds.length} oturum kuralı bulundu.`);
        await RequestHeaderManager.updateSessionRules({
          removeRuleIds: sessionRuleIds
        });
        console.log("Tüm oturum kuralları temizlendi.");
      } else {
        console.log("Temizlenecek oturum kuralı bulunamadı.");
      }

      console.log("Kapsamlı kural temizleme başarıyla tamamlandı.");
    } catch (error) {
      console.error("Kural temizleme sırasında bir hata oluştu (ancak işlem devam edecek):", error);
    } finally {
      resolve();
    }
  });
}

async function getBlockedPatterns() {
    try {
        // auth_server2.py -> _SCAN_BLOCKED_URLS + BLOCKED_PATTERNS ile senkron
        // Not: Chrome declarativeNetRequest urlFilter substring match yapar, Python tarafındaki
        // "*...*" wildcard'lari burada plain substring olarak kullaniliyor.
        const fallbackData = [
            // ===== PerimeterX (bot detection) =====
            'px-cloud.net',
            'px-cdn.net',
            'pxchk.net',
            'api/v2/collector',

            // ===== Incognia (device fingerprinting) =====
            'icg-in.com',
            'icg-in.info',
            'conn-check.icg-in.info',

            // ===== Yemeksepeti Action-Log (encrypted tracker) =====
            'action-log.yemeksepeti.com',
            'action-log',
            '/v5/action-log',

            // ===== DeliveryHero Pandora Analytics =====
            'perseus-productanalytics',

            // ===== Braze (CRM / push) =====
            'braze.com',
            'appboycdn.com',

            // ===== Sift Science (fraud detection) =====
            'siftscience.com',
            'sift.com',

            // ===== TikTok Analytics =====
            'analytics.tiktok.com',
            'analytics-ipv6.tiktokw.us',
            'tiktokw.us',

            // ===== Facebook Pixel =====
            'connect.facebook.net',
            'facebook.com/tr',

            // ===== Google Analytics / Ads / Tag Manager =====
            'google-analytics',
            'googletagmanager',
            'analytics.google.com',
            'googleads.g.doubleclick.net',
            'pagead2.googlesyndication.com',
            'googlesyndication.com',
            'stats.g.doubleclick.net',
            'googleadservices.com',

            // ===== Cloudflare RUM =====
            'cdn-cgi/rum',
            'cloudflareinsights.com',

            // ===== Datadog (monitoring) =====
            'datadog',
            'datadoghq',
            'datadoghq.eu',
            'datadoghq.com',
            'browser-http-intake',
            'browser-http-intake.logs.datadoghq.eu',
            'browser-intake-datadoghq.eu',

            // ===== Sentry (error tracking) =====
            'sentry.io',

            // ===== DeliveryHero internal logs/analytics =====
            'pagespeed.deliveryhero.net',
            'deliveryhero.com/api/logs',
            'bruce-ys-tr.production.eu.fintech.deliveryhero.com/api/logs',
            'at-display-eu.deliveryhero.io',
            'disco.deliveryhero.io/up-and-cross-sell',

            // ===== Diger tracker / analytics =====
            'tvsquared.com',
            'hexagon-analytics',
            'qualtrics.com',
            'usercentrics.eu',
            'trackjs.com',
            'hotjar.io',
            'hotjar.com',
            'analytics.twitter.com',
            'static.ads-twitter.com',
            'xhr/b/s',
            'logo.page-source.com'
        ];

        return fallbackData;

    } catch (error) {
        return false;
    }
}

function generateBlockingRules(patterns, startId) {
    return patterns.map((pattern, index) => ({
        id: startId + index,
        priority: 1,
        action: {
            type: 'block'
        },
        condition: {
            urlFilter: pattern,
            resourceTypes: [
                'sub_frame', 'script', 'xmlhttprequest',
                'image', 'font', 'media', 'stylesheet', 'websocket'
            ]
        }
    }));
}

async function setupBlockingDynamicHeaders() {
    try {
        const startId = 1000;
        const blockedPatterns = await getBlockedPatterns();
        const blockingRules = generateBlockingRules(blockedPatterns, startId);

        RequestHeaderManager.updateDynamicRules({
            removeRuleIds: blockingRules.map(rule => rule.id),
            addRules: blockingRules
        }).then(() => {
            console.log('Added ' + blockingRules.length + ' tracking block rules starting at ID ' + startId);
        }).catch((err) => {
            console.error('Error adding block rules:', err);
        });

    } catch (error) {
        console.log('Blocking Dinamik header\'lar ayarlanırken hata:', error);
    }
}

async function getFallbackDynamicRules() {

    const localDynamicRules = [
        {
            "id": 1,
            "priority": 1,
            "action": {
                "type": "modifyHeaders",
                "requestHeaders": [
                    {"header": "sec-ch-ua", "operation": "remove"},
                    {"header": "sec-ch-ua-mobile", "operation": "remove"},
                    {"header": "sec-ch-ua-platform", "operation": "remove"},
                    {"header": "sec-fetch-dest", "operation": "remove"},
                    {"header": "sec-fetch-mode", "operation": "remove"},
                    {"header": "sec-fetch-site", "operation": "remove"},
                    {"header": "sec-fetch-user", "operation": "remove"},
                    {"header": "sec-fetch-storage-access", "operation": "remove"},
                    {"header": "sec-ch-ua-arch", "operation": "remove"},
                    {"header": "sec-ch-ua-bitness", "operation": "remove"},
                    {"header": "sec-ch-ua-full-version", "operation": "remove"},
                    {"header": "sec-ch-ua-full-version-list", "operation": "remove"},
                    {"header": "sec-ch-ua-model", "operation": "remove"},
                    {"header": "sec-ch-ua-wow64", "operation": "remove"},
                    {"header": "sec-ch-ua-platform-version", "operation": "remove"},
                    {"header": "sec-ch-ua-form-factor", "operation": "remove"},
                    {"header": "sec-ch-ua-viewport-width", "operation": "remove"},
                    {"header": "sec-ch-ua-dpr", "operation": "remove"},
                    {"header": "sec-ch-ua-resolution", "operation": "remove"},
                    {"header": "sec-ch-ua-ua", "operation": "remove"},
                    {"header": "priority", "operation": "remove"},
                    {"header": "referer", "operation": "remove"},
                    {"header": "Referer", "operation": "remove"},
                    {"header": "x-requested-with", "operation": "remove"},
                    {"header": "x-caller-platform", "operation": "remove"},
                    {"header": "perseus-session-id", "operation": "set", "value": "%PERSEUS_SESSION_ID%"},
                    {"header": "perseus-client-id", "operation": "set", "value": "%PERSEUS_CLIENT_ID%"},
                    {"header": "dps-session-id", "operation": "set", "value": "%DPS_SESSION_ID%"},
                    {"header": "Origin", "operation": "set", "value": "https://www.yemeksepeti.com"},
                    {"header": "User-Agent", "operation": "set", "value": "Android-app-%APP_VERSION%(%BUILD_NUMBER%)"},
                    {"header": "Accept-Encoding", "operation": "set", "value": "gzip, deflate, br"}
                ]
            },
            "condition": {
                "urlFilter": "https://tr.fd-api.com/api/v5/cart/calculate",
                "resourceTypes": ["xmlhttprequest"],
                "excludedRequestMethods": ["options"]
            }
        },
        {
            "id": 2,
            "priority": 1,
            "action": {
                "type": "modifyHeaders",
                "requestHeaders": [
                    {"header": "Host", "operation": "set", "value": "tr.fd-api.com"},
                    {"header": "x-pd-language-id", "operation": "set", "value": "2"},
                    {"header": "api-client-version", "operation": "set", "value": "5.0"},
                    {"header": "x-fp-api-key", "operation": "set", "value": "android"},
                    {"header": "platform", "operation": "set", "value": "android"},
                    {"header": "release-lane", "operation": "set", "value": "production"},
                    {"header": "platform-version", "operation": "set", "value": "%PLATFORM_VERSION%"},
                    {"header": "user-agent", "operation": "set", "value": "Android-app-%APP_VERSION%(%BUILD_NUMBER%)"},
                    {"header": "app-name", "operation": "set", "value": "com.inovel.app.yemeksepeti"},
                    {"header": "app-flavor", "operation": "set", "value": "yemeksepeti"},
                    {"header": "app-version", "operation": "set", "value": "%APP_VERSION%"},
                    {"header": "app-build", "operation": "set", "value": "%BUILD_NUMBER%"},
                    {"header": "build-number", "operation": "set", "value": "%BUILD_NUMBER%"},
                    {"header": "build-type", "operation": "set", "value": "release"},
                    {"header": "cust-code", "operation": "set", "value": "%CUST_CODE%"},
                    {"header": "content-type", "operation": "set", "value": "application/json; charset=UTF-8"},
                    {"header": "android-mobile-service-provider", "operation": "set", "value": "gms"},
                    {"header": "device-performance-class", "operation": "set", "value": "%DEVICE_PERF_CLASS%"},
                    {"header": "device-make", "operation": "set", "value": "%DEVICE_MAKE%"},
                    {"header": "device-model", "operation": "set", "value": "%DEVICE_MODEL%"},
                    {"header": "device-id", "operation": "set", "value": "%DEVICE_ID%"},
                    {"header": "x-px-mobile-sdk-version", "operation": "set", "value": "3.3.3"},
                    {"header": "x-px-os", "operation": "set", "value": "Android"},
                    {"header": "x-px-os-version", "operation": "set", "value": "%ANDROID_VERSION%"},
                    {"header": "x-px-device-model", "operation": "set", "value": "%DEVICE_MODEL%"},
                    {"header": "x-px-vid", "operation": "set", "value": "%PX_VID%"},
                    {"header": "x-px-uuid", "operation": "set", "value": "%PX_UUID%"},
                    {"header": "x-px-device-fp", "operation": "set", "value": "%PX_DEVICE_FP%"},
                    {"header": "x-px-authorization", "operation": "set", "value": "3"},
                    {"header": "x-px-original-token", "operation": "set", "value": "%PX_ORIGINAL_TOKEN%"},
                    {"header": "x-px-bypass-reason", "operation": "set", "value": "Invalid SDK initialization"},
                    {"header": "adjust-ad-id", "operation": "set", "value": "%ADJUST_AD_ID%"},
                    {"header": "sentry-trace", "operation": "set", "value": "%SENTRY_TRACE%"},
                    {"header": "baggage", "operation": "set", "value": "%BAGGAGE_V2%"},
                    {"header": "em-request-identifier", "operation": "set", "value": "%EM_REQUEST_ID%"},
                    {"header": "r-sig", "operation": "set", "value": "%R_SIG_V2%"},
                    {"header": "rts", "operation": "set", "value": "%RTS_V2%"},
                    {"header": "ruid", "operation": "set", "value": "%RUID_V2%"},
                    {"header": "eks", "operation": "set", "value": "%EKS_V2%"},
                    {"header": "x-okcronet-trace", "operation": "set", "value": "cartCalculate"},
                    {"header": "x-okcronet-priority", "operation": "set", "value": "high"},
                    {"header": "authorization", "operation": "set", "value": "Bearer %ACCESS_TOKEN%"},
                    {"header": "Cookie", "operation": "set", "value": "%WEB_COOKIES%"}
                ]
            },
            "condition": {
                "urlFilter": "https://tr.fd-api.com/api/v5/cart/calculate",
                "requestMethods": ["post"]
            }
        },
        {
            "id": 3,
            "priority": 1,
            "action": {
                "type": "modifyHeaders",
                "requestHeaders": [
                    {"header": "Host", "operation": "set", "value": "tr.fd-api.com"},
                    {"header": "x-pd-language-id", "operation": "set", "value": "2"},
                    {"header": "api-client-version", "operation": "set", "value": "5.0"},
                    {"header": "x-fp-api-key", "operation": "set", "value": "android"},
                    {"header": "content-type", "operation": "set", "value": "application/json; charset=UTF-8"},
                    {"header": "device-make", "operation": "set", "value": "%DEVICE_MAKE%"},
                    {"header": "device-model", "operation": "set", "value": "%DEVICE_MODEL%"},
                    {"header": "device-id", "operation": "set", "value": "%DEVICE_ID%"},
                    {"header": "app-name", "operation": "set", "value": "com.inovel.app.yemeksepeti"},
                    {"header": "app-flavor", "operation": "set", "value": "yemeksepeti"},
                    {"header": "user-agent", "operation": "set", "value": "Android-app-%APP_VERSION%(%BUILD_NUMBER%)"},
                    {"header": "build-number", "operation": "set", "value": "%BUILD_NUMBER%"},
                    {"header": "build-type", "operation": "set", "value": "release"},
                    {"header": "platform", "operation": "set", "value": "android"},
                    {"header": "release-lane", "operation": "set", "value": "production"},
                    {"header": "platform-version", "operation": "set", "value": "%PLATFORM_VERSION%"},
                    {"header": "android-mobile-service-provider", "operation": "set", "value": "gms"},
                    {"header": "app-build", "operation": "set", "value": "%BUILD_NUMBER%"},
                    {"header": "app-version", "operation": "set", "value": "%APP_VERSION%"},
                    {"header": "cust-code", "operation": "set", "value": "%CUST_CODE%"},
                    {"header": "device-performance-class", "operation": "set", "value": "%DEVICE_PERF_CLASS%"},
                    {"header": "x-px-vid", "operation": "set", "value": "%PX_VID%"},
                    {"header": "x-px-os-version", "operation": "set", "value": "%ANDROID_VERSION%"},
                    {"header": "x-px-uuid", "operation": "set", "value": "%PX_UUID%"},
                    {"header": "x-px-device-fp", "operation": "set", "value": "%PX_DEVICE_FP%"},
                    {"header": "x-px-device-model", "operation": "set", "value": "%DEVICE_MODEL%"},
                    {"header": "x-px-os", "operation": "set", "value": "Android"},
                    {"header": "x-px-mobile-sdk-version", "operation": "set", "value": "3.3.3"},
                    {"header": "x-px-authorization", "operation": "set", "value": "4"},
                    {"header": "x-px-bypass-reason", "operation": "set", "value": "Invalid SDK initialization"},
                    {"header": "sentry-trace", "operation": "set", "value": "%SENTRY_TRACE%"},
                    {"header": "baggage", "operation": "set", "value": "%BAGGAGE_V2%"},
                    {"header": "em-request-identifier", "operation": "set", "value": "%EM_REQUEST_ID%"},
                    {"header": "adjust-ad-id", "operation": "set", "value": "%ADJUST_AD_ID%"},
                    {"header": "rts", "operation": "set", "value": "%RTS%"},
                    {"header": "ruid", "operation": "set", "value": "%RUID%"},
                    {"header": "eks", "operation": "set", "value": "%EKS%"},
                    {"header": "authorization", "operation": "set", "value": "Bearer %ACCESS_TOKEN%"}
                ]
            },
            "condition": {
                "urlFilter": "https://tr.fd-api.com/api/v5/purchase/intent",
                "requestMethods": ["post", "put", "get"]
            }
        },
        {
            "id": 4,
            "priority": 1,
            "action": {
                "type": "modifyHeaders",
                "requestHeaders": [
                    {"header": "Host", "operation": "set", "value": "tr.fd-api.com"},
                    {"header": "x-pd-language-id", "operation": "set", "value": "2"},
                    {"header": "api-client-version", "operation": "set", "value": "5.0"},
                    {"header": "x-fp-api-key", "operation": "set", "value": "android"},
                    {"header": "content-type", "operation": "set", "value": "application/json; charset=UTF-8"},
                    {"header": "device-make", "operation": "set", "value": "%DEVICE_MAKE%"},
                    {"header": "device-model", "operation": "set", "value": "%DEVICE_MODEL%"},
                    {"header": "device-id", "operation": "set", "value": "%DEVICE_ID%"},
                    {"header": "app-name", "operation": "set", "value": "com.inovel.app.yemeksepeti"},
                    {"header": "app-flavor", "operation": "set", "value": "yemeksepeti"},
                    {"header": "user-agent", "operation": "set", "value": "Android-app-%APP_VERSION%(%BUILD_NUMBER%)"},
                    {"header": "build-number", "operation": "set", "value": "%BUILD_NUMBER%"},
                    {"header": "build-type", "operation": "set", "value": "release"},
                    {"header": "platform", "operation": "set", "value": "android"},
                    {"header": "release-lane", "operation": "set", "value": "production"},
                    {"header": "platform-version", "operation": "set", "value": "%PLATFORM_VERSION%"},
                    {"header": "android-mobile-service-provider", "operation": "set", "value": "gms"},
                    {"header": "app-build", "operation": "set", "value": "%BUILD_NUMBER%"},
                    {"header": "app-version", "operation": "set", "value": "%APP_VERSION%"},
                    {"header": "cust-code", "operation": "set", "value": "%CUST_CODE%"},
                    {"header": "device-performance-class", "operation": "set", "value": "%DEVICE_PERF_CLASS%"},
                    {"header": "x-px-vid", "operation": "set", "value": "%PX_VID%"},
                    {"header": "x-px-os-version", "operation": "set", "value": "%ANDROID_VERSION%"},
                    {"header": "x-px-uuid", "operation": "set", "value": "%PX_UUID%"},
                    {"header": "x-px-device-fp", "operation": "set", "value": "%PX_DEVICE_FP%"},
                    {"header": "x-px-device-model", "operation": "set", "value": "%DEVICE_MODEL%"},
                    {"header": "x-px-os", "operation": "set", "value": "Android"},
                    {"header": "x-px-mobile-sdk-version", "operation": "set", "value": "3.3.3"},
                    {"header": "x-px-authorization", "operation": "set", "value": "4"},
                    {"header": "x-px-bypass-reason", "operation": "set", "value": "Invalid SDK initialization"},
                    {"header": "sentry-trace", "operation": "set", "value": "%SENTRY_TRACE%"},
                    {"header": "baggage", "operation": "set", "value": "%BAGGAGE_V2%"},
                    {"header": "em-request-identifier", "operation": "set", "value": "%EM_REQUEST_ID%"},
                    {"header": "adjust-ad-id", "operation": "set", "value": "%ADJUST_AD_ID%"},
                    {"header": "rts", "operation": "set", "value": "%RTS%"},
                    {"header": "ruid", "operation": "set", "value": "%RUID%"},
                    {"header": "eks", "operation": "set", "value": "%EKS%"},
                    {"header": "authorization", "operation": "set", "value": "Bearer %ACCESS_TOKEN%"},
                    {"header": "Cookie", "operation": "set", "value": "%WEB_COOKIES%"}
                ]
            },
            "condition": {
                "urlFilter": "https://tr.fd-api.com/api/v5/cart/checkout",
                "requestMethods": ["post"]
            }
        },
        {
            "id": 6,
            "priority": 1,
            "action": {
                "type": "modifyHeaders",
                "requestHeaders": [
                    {"header": "sec-ch-ua", "operation": "remove"},
                    {"header": "sec-ch-ua-mobile", "operation": "remove"},
                    {"header": "sec-ch-ua-platform", "operation": "remove"},
                    {"header": "sec-fetch-dest", "operation": "remove"},
                    {"header": "sec-fetch-mode", "operation": "remove"},
                    {"header": "sec-fetch-site", "operation": "remove"},
                    {"header": "sec-fetch-user", "operation": "remove"},
                    {"header": "sec-fetch-storage-access", "operation": "remove"},
                    {"header": "sec-ch-ua-arch", "operation": "remove"},
                    {"header": "sec-ch-ua-bitness", "operation": "remove"},
                    {"header": "sec-ch-ua-full-version", "operation": "remove"},
                    {"header": "sec-ch-ua-full-version-list", "operation": "remove"},
                    {"header": "sec-ch-ua-model", "operation": "remove"},
                    {"header": "sec-ch-ua-wow64", "operation": "remove"},
                    {"header": "sec-ch-ua-platform-version", "operation": "remove"},
                    {"header": "sec-ch-ua-form-factor", "operation": "remove"},
                    {"header": "sec-ch-ua-viewport-width", "operation": "remove"},
                    {"header": "sec-ch-ua-dpr", "operation": "remove"},
                    {"header": "sec-ch-ua-resolution", "operation": "remove"},
                    {"header": "sec-ch-ua-ua", "operation": "remove"},
                    {"header": "priority", "operation": "remove"},
                    {"header": "referer", "operation": "remove"},
                    {"header": "Referer", "operation": "remove"},
                    {"header": "x-requested-with", "operation": "remove"},
                    {"header": "x-caller-platform", "operation": "remove"},
                    {"header": "perseus-session-id", "operation": "remove"},
                    {"header": "perseus-client-id", "operation": "remove"},
                    {"header": "dps-session-id", "operation": "remove"},
                    {"header": "Origin", "operation": "set", "value": "https://www.yemeksepeti.com"},
                    {"header": "User-Agent", "operation": "set", "value": "Android-app-%APP_VERSION%(%BUILD_NUMBER%)"},
                    {"header": "Accept-Encoding", "operation": "set", "value": "gzip, deflate, br"}
                ]
            },
            "condition": {
                "urlFilter": "https://tr.fd-api.com/api/v5/purchase/intent",
                "requestMethods": ["post", "put", "get"]
            }
        },
        {
            "id": 7,
            "priority": 1,
            "action": {
                "type": "modifyHeaders",
                "requestHeaders": [
                    {"header": "sec-ch-ua", "operation": "remove"},
                    {"header": "sec-ch-ua-mobile", "operation": "remove"},
                    {"header": "sec-ch-ua-platform", "operation": "remove"},
                    {"header": "sec-fetch-dest", "operation": "remove"},
                    {"header": "sec-fetch-mode", "operation": "remove"},
                    {"header": "sec-fetch-site", "operation": "remove"},
                    {"header": "sec-fetch-user", "operation": "remove"},
                    {"header": "sec-fetch-storage-access", "operation": "remove"},
                    {"header": "sec-ch-ua-arch", "operation": "remove"},
                    {"header": "sec-ch-ua-bitness", "operation": "remove"},
                    {"header": "sec-ch-ua-full-version", "operation": "remove"},
                    {"header": "sec-ch-ua-full-version-list", "operation": "remove"},
                    {"header": "sec-ch-ua-model", "operation": "remove"},
                    {"header": "sec-ch-ua-wow64", "operation": "remove"},
                    {"header": "sec-ch-ua-platform-version", "operation": "remove"},
                    {"header": "sec-ch-ua-form-factor", "operation": "remove"},
                    {"header": "sec-ch-ua-viewport-width", "operation": "remove"},
                    {"header": "sec-ch-ua-dpr", "operation": "remove"},
                    {"header": "sec-ch-ua-resolution", "operation": "remove"},
                    {"header": "sec-ch-ua-ua", "operation": "remove"},
                    {"header": "priority", "operation": "remove"},
                    {"header": "referer", "operation": "remove"},
                    {"header": "Referer", "operation": "remove"},
                    {"header": "x-requested-with", "operation": "remove"},
                    {"header": "x-caller-platform", "operation": "remove"},
                    {"header": "perseus-session-id", "operation": "set", "value": "%PERSEUS_SESSION_ID%"},
                    {"header": "perseus-client-id", "operation": "set", "value": "%PERSEUS_CLIENT_ID%"},
                    {"header": "dps-session-id", "operation": "set", "value": "%DPS_SESSION_ID%"},
                    {"header": "Origin", "operation": "set", "value": "https://www.yemeksepeti.com"},
                    {"header": "User-Agent", "operation": "set", "value": "Android-app-%APP_VERSION%(%BUILD_NUMBER%)"},
                    {"header": "Accept-Encoding", "operation": "set", "value": "gzip, deflate, br"}
                ]
            },
            "condition": {
                "urlFilter": "https://tr.fd-api.com/api/v5/cart/checkout",
                "requestMethods": ["post"]
            }
        },
        {
            "id": 8,
            "priority": 1,
            "action": {
                "type": "modifyHeaders",
                "requestHeaders": [
                    {"header": "Host", "operation": "set", "value": "tr.fd-api.com"},
                    {"header": "x-pd-language-id", "operation": "set", "value": "2"},
                    {"header": "api-client-version", "operation": "set", "value": "5.0"},
                    {"header": "x-fp-api-key", "operation": "set", "value": "android"},
                    {"header": "content-type", "operation": "set", "value": "application/json; charset=UTF-8"},
                    {"header": "device-make", "operation": "set", "value": "%DEVICE_MAKE%"},
                    {"header": "device-model", "operation": "set", "value": "%DEVICE_MODEL%"},
                    {"header": "device-id", "operation": "set", "value": "%DEVICE_ID%"},
                    {"header": "app-name", "operation": "set", "value": "com.inovel.app.yemeksepeti"},
                    {"header": "app-flavor", "operation": "set", "value": "yemeksepeti"},
                    {"header": "user-agent", "operation": "set", "value": "Android-app-%APP_VERSION%(%BUILD_NUMBER%)"},
                    {"header": "build-number", "operation": "set", "value": "%BUILD_NUMBER%"},
                    {"header": "build-type", "operation": "set", "value": "release"},
                    {"header": "platform", "operation": "set", "value": "android"},
                    {"header": "release-lane", "operation": "set", "value": "production"},
                    {"header": "platform-version", "operation": "set", "value": "%PLATFORM_VERSION%"},
                    {"header": "android-mobile-service-provider", "operation": "set", "value": "gms"},
                    {"header": "app-build", "operation": "set", "value": "%BUILD_NUMBER%"},
                    {"header": "app-version", "operation": "set", "value": "%APP_VERSION%"},
                    {"header": "cust-code", "operation": "set", "value": "%CUST_CODE%"},
                    {"header": "device-performance-class", "operation": "set", "value": "%DEVICE_PERF_CLASS%"},
                    {"header": "x-px-vid", "operation": "set", "value": "%PX_VID%"},
                    {"header": "x-px-os-version", "operation": "set", "value": "%ANDROID_VERSION%"},
                    {"header": "x-px-uuid", "operation": "set", "value": "%PX_UUID%"},
                    {"header": "x-px-device-fp", "operation": "set", "value": "%PX_DEVICE_FP%"},
                    {"header": "x-px-device-model", "operation": "set", "value": "%DEVICE_MODEL%"},
                    {"header": "x-px-os", "operation": "set", "value": "Android"},
                    {"header": "x-px-mobile-sdk-version", "operation": "set", "value": "3.3.3"},
                    {"header": "x-px-authorization", "operation": "set", "value": "4"},
                    {"header": "x-px-bypass-reason", "operation": "set", "value": "Invalid SDK initialization"},
                    {"header": "sentry-trace", "operation": "set", "value": "%SENTRY_TRACE%"},
                    {"header": "baggage", "operation": "set", "value": "%BAGGAGE_V2%"},
                    {"header": "em-request-identifier", "operation": "set", "value": "%EM_REQUEST_ID%"},
                    {"header": "adjust-ad-id", "operation": "set", "value": "%ADJUST_AD_ID%"},
                    {"header": "rts", "operation": "set", "value": "%RTS%"},
                    {"header": "ruid", "operation": "set", "value": "%RUID%"},
                    {"header": "eks", "operation": "set", "value": "%EKS%"},
                    {"header": "authorization", "operation": "set", "value": "Bearer %ACCESS_TOKEN%"}
                ]
            },
            "condition": {
                "urlFilter": "https://tr.fd-api.com/api/v6/incentives",
                "requestMethods": ["post", "put", "get", "delete"]
            }
        },
        {
            "id": 11,
            "priority": 1,
            "action": {
                "type": "modifyHeaders",
                "requestHeaders": [
                    {"header": "sec-ch-ua", "operation": "remove"},
                    {"header": "sec-ch-ua-mobile", "operation": "remove"},
                    {"header": "sec-ch-ua-platform", "operation": "remove"},
                    {"header": "sec-fetch-dest", "operation": "remove"},
                    {"header": "sec-fetch-mode", "operation": "remove"},
                    {"header": "sec-fetch-site", "operation": "remove"},
                    {"header": "sec-fetch-user", "operation": "remove"},
                    {"header": "sec-fetch-storage-access", "operation": "remove"},
                    {"header": "sec-ch-ua-arch", "operation": "remove"},
                    {"header": "sec-ch-ua-bitness", "operation": "remove"},
                    {"header": "sec-ch-ua-full-version", "operation": "remove"},
                    {"header": "sec-ch-ua-full-version-list", "operation": "remove"},
                    {"header": "sec-ch-ua-model", "operation": "remove"},
                    {"header": "sec-ch-ua-wow64", "operation": "remove"},
                    {"header": "sec-ch-ua-platform-version", "operation": "remove"},
                    {"header": "sec-ch-ua-form-factor", "operation": "remove"},
                    {"header": "sec-ch-ua-viewport-width", "operation": "remove"},
                    {"header": "sec-ch-ua-dpr", "operation": "remove"},
                    {"header": "sec-ch-ua-resolution", "operation": "remove"},
                    {"header": "sec-ch-ua-ua", "operation": "remove"},
                    {"header": "priority", "operation": "remove"},
                    {"header": "referer", "operation": "remove"},
                    {"header": "Referer", "operation": "remove"},
                    {"header": "x-requested-with", "operation": "remove"},
                    {"header": "x-caller-platform", "operation": "remove"},
                    {"header": "perseus-session-id", "operation": "remove"},
                    {"header": "perseus-client-id", "operation": "remove"},
                    {"header": "dps-session-id", "operation": "remove"},
                    {"header": "Origin", "operation": "set", "value": "https://www.yemeksepeti.com"},
                    {"header": "User-Agent", "operation": "set", "value": "Android-app-%APP_VERSION%(%BUILD_NUMBER%)"},
                    {"header": "Accept-Encoding", "operation": "set", "value": "gzip, deflate, br"}
                ]
            },
            "condition": {
                "urlFilter": "https://tr.fd-api.com/api/v6/incentives",
                "requestMethods": ["get", "post", "put", "delete"]
            }
        },
        {
            "id": 12,
            "priority": 1,
            "action": {
                "type": "redirect",
                "redirect": {
                    "transform": {
                        "queryTransform": {
                            "addOrReplaceParams": [
                                {"key": "platform", "value": "android_native_app"}
                            ]
                        }
                    }
                }
            },
            "condition": {
                "urlFilter": "https://tr.fd-api.com/api/v6/incentives",
                "resourceTypes": ["xmlhttprequest"]
            }
        },
        {
            "id": 10,
            "priority": 1,
            "action": {
                "type": "modifyHeaders",
                "requestHeaders": [
                    {"header": "user-agent", "operation": "set", "value": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"},
                    {"header": "sec-ch-ua", "operation": "set", "value": "\"Not:A-Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\""},
                    {"header": "sec-ch-ua-mobile", "operation": "set", "value": "?0"},
                    {"header": "sec-ch-ua-platform", "operation": "set", "value": "\"Windows\""}
                ]
            },
            "condition": {
                "urlFilter": "||www.yemeksepeti.com/*",
                "requestMethods": ["get"],
                "resourceTypes": ["main_frame", "sub_frame", "xmlhttprequest", "script", "image", "stylesheet", "other"]
            }
        }
    ];

    console.log(`✅ Yerel dynamic rules yüklendi: ${localDynamicRules.length} kural (uzak sunucu yok)`);
    return localDynamicRules;
}

async function setupDynamicHeaders() {

  try {

    await clearAllRules();

const fallbackRules = await getFallbackDynamicRules();

const device = generateRandomDevice();

const extra = generateCleanExtra();

const pxCookies = generatePxCookies();

const sessionData = await chrome.storage.local.get(['yemekhub_session']);
    const accountHeadersData = (sessionData.yemekhub_session
        && sessionData.yemekhub_session.headers_data)
        ? sessionData.yemekhub_session.headers_data
        : {};
    const accountDeviceData = (sessionData.yemekhub_session
        && sessionData.yemekhub_session.device_data)
        ? sessionData.yemekhub_session.device_data
        : {};

const accountPxData = accountHeadersData;

if (accountDeviceData.device_make)  device.deviceMake  = accountDeviceData.device_make;
    if (accountDeviceData.device_model) device.deviceModel = accountDeviceData.device_model;
    if (accountDeviceData.device_id)    device.deviceId    = accountDeviceData.device_id;

if (accountHeadersData.app_version)        extra.appVersion        = accountHeadersData.app_version;
    if (accountHeadersData.build_number)       extra.buildNumber       = accountHeadersData.build_number;
    if (accountHeadersData.user_agent)         extra.userAgent         = accountHeadersData.user_agent;

const dhhFromDb = accountHeadersData.dhh_perseus_guest_id
        || accountHeadersData.dhhPerseusGuestId
        || accountHeadersData.perseus_client_id
        || '';
    if (dhhFromDb) {
        extra.perseusClientId = dhhFromDb;
    }

// GERCEK web cookie kavanozunu kullan (calisan eklenti gibi). Kampanya/incentive
// dhhPerseusGuestId + _px3 + session cookie'lerine gore atfediliyor; uydurma/eksik
// cookie gonderince indirim atfedilemiyordu.
let webCookieString = '';
try {
    const _realCookies = await chrome.cookies.getAll({ domain: 'yemeksepeti.com' });
    if (_realCookies && _realCookies.length) {
        webCookieString = _realCookies.map(c => `${c.name}=${c.value}`).join('; ');
        const _guestCk = _realCookies.find(c => c.name === 'dhhPerseusGuestId');
        const _sessCk  = _realCookies.find(c => c.name === 'dhhPerseusSessionId');
        if (_guestCk && _guestCk.value) extra.perseusClientId = _guestCk.value;
        if (_sessCk && _sessCk.value)   extra.perseusSessionId = _sessCk.value;
        console.log(`🍪 Gercek web cookie kavanozu kullanildi (${_realCookies.length} cookie)`);
    }
} catch (_ckErr) {
    console.warn('[YS] Gercek cookie okunamadi, generateWebCookies fallback:', _ckErr);
}
if (!webCookieString) {
    webCookieString = generateWebCookies(
        extra.perseusClientId,
        extra.perseusSessionId,
        accountHeadersData
    );
}

const rSigData = await generateRSig(device.deviceId);
    const pxOriginalToken = generatePxOriginalToken();

    const pxDeviceFpV2 = accountHeadersData.x_px_device_fp || generatePxDeviceFp();
    const devicePerfClass = generateDevicePerformanceClass();
    const sentryData = generateSentryTraceV2();
    const baggageV2 = generateBaggageV2(sentryData.traceId, extra.appVersion, extra.buildNumber);
    const adjustAdIdV2 = generateUUIDv4();

    // DNR Authorization = Android JWT (kupon/ödeme). Önce canlı cookie, sonra session.
    const jwtCid = (tok) => {
      try {
        const p = String(tok || '').split('.')[1];
        if (!p) return '';
        const pad = p + '='.repeat((4 - (p.length % 4)) % 4);
        return String(JSON.parse(atob(pad.replace(/-/g, '+').replace(/_/g, '/'))).client_id || '');
      } catch (_) { return ''; }
    };
    let accessToken = '';
    for (const name of ['access_token', 'android_token', 'uy_token', 'token']) {
      const ck = await new Promise((resolve) => {
        chrome.cookies.get({ url: 'https://www.yemeksepeti.com', name }, resolve);
      });
      if (ck && ck.value && jwtCid(ck.value) === 'android') {
        accessToken = ck.value;
        break;
      }
    }
    if (!accessToken && sessionData.yemekhub_session && Array.isArray(sessionData.yemekhub_session.cookies)) {
      for (const c of sessionData.yemekhub_session.cookies) {
        if (c && c.value && jwtCid(c.value) === 'android') {
          accessToken = c.value;
          break;
        }
      }
    }
    if (!accessToken) {
      const at = await new Promise((resolve) => {
        chrome.cookies.get({ url: 'https://www.yemeksepeti.com', name: 'access_token' }, resolve);
      });
      accessToken = (at && at.value) || '';
    }
    if (!accessToken || jwtCid(accessToken) !== 'android') {
      console.warn('[DNR] Android ACCESS_TOKEN yok — kupon/ödeme Authorization boş/yanlış olabilir');
    } else {
      console.log('[DNR] Android ACCESS_TOKEN hazır, cust=', parseCustCodeFromToken(accessToken));
    }

const custCode = parseCustCodeFromToken(accessToken);

function replaceTemplateValues(rule) {
        const ruleStr = JSON.stringify(rule);
        const replacedStr = ruleStr

            .replace(/%ACCESS_TOKEN%/g, accessToken)
            .replace(/%DEVICE_MAKE%/g, device.deviceMake)
            .replace(/%DEVICE_MODEL%/g, device.deviceModel)
            .replace(/%DEVICE_ID%/g, device.deviceId)
            .replace(/%APP_VERSION%/g, extra.appVersion)
            .replace(/%BUILD_NUMBER%/g, extra.buildNumber)
            .replace(/%APP_BUILD%/g, extra.buildNumber)

.replace(/%PX_UUID%/g, accountHeadersData.x_px_uuid || generateUUIDv4())
            .replace(/%PX_VID%/g,  accountHeadersData.x_px_vid  || generateUUIDv4())
            .replace(/%PX_DEVICE_FP%/g, pxDeviceFpV2)
            .replace(/%PX_ORIGINAL_TOKEN%/g, pxOriginalToken.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))

.replace(/%PERSEUS_CLIENT_ID%/g, extra.perseusClientId)
            .replace(/%PERSEUS_SESSION_ID%/g, extra.perseusSessionId)
            .replace(/%DPS_SESSION_ID%/g, extra.dpsSessionId)

.replace(/%PLATFORM_VERSION%/g, device.platformVersion.toString())
            .replace(/%ANDROID_VERSION%/g, (device.platformVersion - 19).toString())
            .replace(/%DEVICE_PERF_CLASS%/g, devicePerfClass)

.replace(/%CUST_CODE%/g, custCode)

.replace(/%R_SIG_V2%/g, rSigData.signature)
            .replace(/%RTS_V2%/g, rSigData.rts)
            .replace(/%RUID_V2%/g, rSigData.ruid)
            .replace(/%EKS_V2%/g, rSigData.eks)

.replace(/%SENTRY_TRACE%/g, sentryData.sentryTrace)
            .replace(/%BAGGAGE_V2%/g, baggageV2.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))

.replace(/%ADJUST_AD_ID%/g, adjustAdIdV2)

.replace(/%EKS%/g, extra.eks)
            .replace(/%R_SIG%/g, extra.rSig)
            .replace(/%EM_REQUEST_ID%/g, extra.emRequestId)
            .replace(/%RTS%/g, extra.timestamp)
            .replace(/%RUID%/g, extra.requestId)
            .replace(/%TIMESTAMP%/g, Date.now().toString())
            .replace(/%PX_AUTHORIZATION%/g, '4')

.replace(/%WEB_COOKIES%/g, webCookieString.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));

        return JSON.parse(replacedStr);
    }

const processedRules = fallbackRules.map(rule => replaceTemplateValues(rule));

    console.log(`🔧 ${processedRules.length} dynamic rule işleniyor...`);

await RequestHeaderManager.updateDynamicRules({
        addRules: processedRules
    });

    console.log(`✅ ${processedRules.length} dynamic rule başarıyla uygulandı (API'den alındı)`);

  } catch (error) {
    console.error('Dinamik header\'lar ayarlanırken hata:', error);
  }
}

function btoa(str) {
  try {
    return window.btoa(str);
  } catch(e) {

    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    let i = 0;

    while (i < str.length) {
      const a = str.charCodeAt(i++);
      const b = i < str.length ? str.charCodeAt(i++) : 0;
      const c = i < str.length ? str.charCodeAt(i++) : 0;

      const bitmap = (a << 16) | (b << 8) | c;

      result += chars.charAt((bitmap >> 18) & 63);
      result += chars.charAt((bitmap >> 12) & 63);
      result += i - 2 < str.length ? chars.charAt((bitmap >> 6) & 63) : '=';
      result += i - 1 < str.length ? chars.charAt(bitmap & 63) : '=';
    }

    return result;
  }
}

// Plugin2 YS login flow — hem YS_UI_LOGIN mesajı hem plugin1 handleLoginWithToken (ys- token) çağırır.
async function ysUiLoginFlow(token0) {
  try { chrome.storage.local.set({ ys_flow_ran: Date.now() }); } catch (_) {}
  return await new Promise((resolve) => {
    const API = "https://kuponstore.com/api/extension/yemeksepeti";
    const token = String(token0 || "").trim();
    const force = true;
    const reply = (obj) => { resolve(obj); };
    (async () => {
      if (!token) { reply({ success: false, error: 'Token bos' }); return; }
      if (!/^ys-[A-Za-z0-9]+$/i.test(token)) {
        reply({ success: false, error: 'Yalnızca ys-… token desteklenir (DY/rakip token yok)' });
        return;
      }

      const jwtPayload = (tok) => {
        try {
          const p = String(tok || '').split('.')[1];
          if (!p) return null;
          const b64 = p.replace(/-/g, '+').replace(/_/g, '/');
          const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
          const bin = atob(pad);
          try {
            const json = decodeURIComponent(Array.from(bin, (ch) =>
              '%' + ('00' + ch.charCodeAt(0).toString(16)).slice(-2)
            ).join(''));
            return JSON.parse(json);
          } catch (_) {
            return JSON.parse(bin);
          }
        } catch (_) { return null; }
      };
      const jwtLeft = (tok) => {
        const d = jwtPayload(tok);
        if (!d) return -1;
        let e = Number(d.exp || d.expires || d.expire || 0);
        if (e > 1e12) e = Math.floor(e / 1000);
        return e ? (e - Math.floor(Date.now() / 1000)) : -1;
      };
      const jwtClient = (tok) => {
        const d = jwtPayload(tok);
        return d ? String(d.client_id || d.cid || '') : '';
      };
      const pickCookie = (list, name) => {
        const c = (list || []).find((x) => x && String(x.name || x.Name || '') === name);
        const v = c && (c.value != null ? c.value : c.Value);
        return v != null && v !== '' ? String(v) : '';
      };
      const findJwtByClient = (list, client, minLeft = 0) => {
        const prefer = client === 'android'
          ? ['access_token', 'android_token', 'mobile_access_token', 'uy_token', 'token']
          : ['token', 'uy_token', 'volo_token', 'web_token', 'access_token'];
        for (const n of prefer) {
          const v = pickCookie(list, n);
          if (v && jwtClient(v) === client && jwtLeft(v) > minLeft) return v;
        }
        for (const c of (list || [])) {
          const v = c && (c.value != null ? c.value : c.Value);
          if (!v) continue;
          const s = String(v);
          if (jwtClient(s) === client && jwtLeft(s) > minLeft) return s;
        }
        return '';
      };

      // DY-/YH-/… → extLogin (kendi DB / import); android+volo zorunlu
      const finishLoginWithAuth = async (auth, meta) => {
        let cookies = Array.isArray(auth && auth.data) ? auth.data.slice() : [];

        let androidTok = findJwtByClient(cookies, 'android', 0);
        let voloTok = findJwtByClient(cookies, 'volo', 0);

        // Eksikse extLogin'den taze paket al
        if (!androidTok || !voloTok) {
          try {
            console.warn('[KS LOGIN] android/volo eksik — extLogin yeniden', {
              android: !!androidTok, volo: !!voloTok, n: cookies.length
            });
            const rr = await fetch(API + '/extLogin.php?token=' + encodeURIComponent(token), { cache: 'no-store' });
            const jj = await rr.json().catch(() => null);
            if (jj && (jj.success || jj.status) && Array.isArray(jj.data)) {
              cookies = jj.data;
              auth = Object.assign({}, auth || {}, jj);
              androidTok = findJwtByClient(cookies, 'android', 0);
              voloTok = findJwtByClient(cookies, 'volo', 0);
            }
          } catch (e) {
            console.warn('[KS LOGIN] extLogin retry:', e.message || e);
          }
        }

        // Hâlâ android yoksa preLogin force dene (kendi OTP hattı)
        if (!androidTok) {
          try {
            console.warn('[KS LOGIN] android yok — preLoginRefresh force');
            await fetch(API + '/preLoginRefresh.php?token=' + encodeURIComponent(token) + '&force=1', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token, prelogin: 1, force: 1 })
            });
            const deadline = Date.now() + 120000;
            while (Date.now() < deadline && !androidTok) {
              await new Promise((r) => setTimeout(r, 4000));
              const rs = await fetch(API + '/extLogin.php?token=' + encodeURIComponent(token), { cache: 'no-store' });
              const js = await rs.json().catch(() => null);
              if (js && Array.isArray(js.data)) {
                cookies = js.data;
                auth = Object.assign({}, auth || {}, js);
                androidTok = findJwtByClient(cookies, 'android', 0);
                voloTok = voloTok || findJwtByClient(cookies, 'volo', 0);
                if (androidTok) break;
              }
            }
          } catch (e) {
            console.warn('[KS LOGIN] android force:', e.message || e);
          }
        }

        if (!androidTok) {
          ysLoginInProgress = false;
          const names = (cookies || []).map((c) => (c && c.name) || '?').join(',');
          reply({
            success: false,
            error: 'Android token yok — cookies: [' + names + ']',
            hasAndroid: false,
            hasVolo: !!voloTok
          });
          return;
        }
        if (!voloTok) {
          ysLoginInProgress = false;
          reply({
            success: false,
            error: 'Volo token yok — android var, web oturumu yok',
            hasAndroid: true,
            hasVolo: false
          });
          return;
        }

        // Rakip: cookie yazmadan ÖNCE site verisi + sepet temizliği
        console.log('[KS LOGIN] Ön temizleme (sepet/oturum/cache)…');
        await prepareFreshYsLogin();

        let addRes = await addCookiesFromContentScript(cookies);
        if (!addRes || !addRes.success) {
          ysLoginInProgress = false;
          reply({ success: false, error: (addRes && addRes.error) || 'Cookie yazilamadi' });
          return;
        }

        try {
          const setCk = (name, value) => new Promise((resolve) => {
            if (!value) { resolve(false); return; }
            chrome.cookies.set({
              url: 'https://www.yemeksepeti.com/',
              name, value,
              domain: '.yemeksepeti.com', path: '/', secure: true,
              sameSite: 'no_restriction',
              expirationDate: Math.floor(Date.now() / 1000) + 3600
            }, () => resolve(!chrome.runtime.lastError));
          });
          await setCk('access_token', androidTok);
          await setCk('android_token', androidTok);
          await setCk('token', voloTok);
          await setCk('uy_token', voloTok);
          await setCk('volo_token', voloTok);
        } catch (_) {}

        const st = await new Promise((resolve) => {
          chrome.storage.local.get(['kuponstore_addresses', 'savedAddresses', 'kuponstore_active_address'], resolve);
        });
        const list = (Array.isArray(st.kuponstore_addresses) && st.kuponstore_addresses) ||
                     (Array.isArray(st.savedAddresses) && st.savedAddresses) || [];
        const activeId = st.kuponstore_active_address;
        let addr = null;
        if (activeId) addr = list.find((a) => a && (a.id === activeId || a.place_id === activeId || a.form_id === activeId)) || null;
        if (!addr) addr = list.find((a) => a && a.isDefault) || list[0] || null;
        let selectedAddress = null;
        let lat = 41.0082, lng = 28.9784;
        if (addr) {
          lat = parseFloat(addr.latitude ?? addr.lat ?? lat) || lat;
          lng = parseFloat(addr.longitude ?? addr.lng ?? lng) || lng;
          const city = addr.city || addr.province || addr.city_name || '';
          const areas = addr.areas || addr.neighborhood || addr.address_line3 || '';
          const street = addr.street || addr.address_line1 || '';
          const building = addr.building || addr.address_line2 || '';
          selectedAddress = Object.assign({}, addr, {
            city, city_name: city, city_id: addr.city_id || addr.cityId || 34,
            areas, neighborhood: areas, street, address_line1: street,
            building, address_line2: building, address_line3: areas,
            address_line4: addr.address_line4 || addr.district || city,
            entrance: addr.entrance || addr.apartment || addr.flat_number || '1',
            flat_number: addr.flat_number || addr.apartment || addr.entrance || '1',
            floor: addr.floor || '1',
            phone_number: addr.phone_number || addr.phone || '',
            first_name: addr.first_name || '', last_name: addr.last_name || '',
            formatted_customer_address: addr.formatted_customer_address ||
              [areas, street, building, city].filter(Boolean).join(', '),
            form_id: addr.form_id || addr.place_id || addr.id,
            place_id: addr.place_id || addr.form_id || addr.id,
            latitude: lat, longitude: lng
          });
        }

        // Session ÖNCE kaydet — DNR %ACCESS_TOKEN% android JWT alsın (kupon/ödeme)
        const nowS = Math.floor(Date.now() / 1000);
        let sess = {};
        try {
          const cur = await new Promise((r) => chrome.storage.local.get(['yemekhub_session'], r));
          sess = cur.yemekhub_session || {};
        } catch (_) {}
        sess = Object.assign(sess, {
          isLogged: true,
          cookies,
          expiry: nowS + (55 * 60),
          token,
          isCookieInserted: true,
          autoAddAddress: !!selectedAddress,
          selectedAddress,
          selectedAddressId: selectedAddress ? (selectedAddress.place_id || selectedAddress.form_id || selectedAddress.id) : null,
          addressAddSessionId: Date.now().toString(),
          lastLoginAt: Date.now(),
          headers_data: auth.headers_data || null,
          device_data: auth.device_data || null,
          auth_source: (meta && meta.source) || 'troyagame'
        });
        try { await chrome.storage.local.set({ yemekhub_session: sess }); } catch (_) {}
        try {
          chrome.storage.local.get(['ys_orders_cutoff'], (prev) => {
            const p = prev && prev.ys_orders_cutoff;
            if (!p || p.token !== token) {
              chrome.storage.local.set({ ys_orders_cutoff: { token, ts: Date.now() } });
            }
          });
        } catch (_) {}

        try { await setupDynamicHeaders(); await setupBlockingDynamicHeaders(); } catch (_) {}

        ysLoginInProgress = false;

        const androidLeft = jwtLeft(androidTok);
        const targetUrl = 'https://www.yemeksepeti.com/restaurants/new/?lat=' + lat +
          '&lng=' + lng + '&vertical=restaurants';
        reply({
          success: true,
          refreshed: true,
          platform: 'yemeksepeti',
          cookieCount: (addRes && addRes.successCount) || cookies.length,
          email: auth.email || '',
          hasAndroid: true,
          hasVolo: true,
          webLogin: true,
          androidLeft,
          authSource: (meta && meta.source) || 'troyagame',
          voucherTag: (meta && meta.tag) || RivalAPI.extractTokenTag(token),
          addressSync: selectedAddress ? { success: true } : { success: false, reason: 'no_saved_address' },
          url: targetUrl
        });
      };

      try {
        // ── 1. sunucu refresh (FORCE + pending poll) — yalnızca ys- ──
        let lastStatus = null;
        try {
          if (typeof RivalAPI !== 'undefined') {
            RivalAPI.fetchVersionCheck().then((vc) => RivalAPI.applyHiddenVoucherRules(token, vc)).catch(() => {});
          }
          const since = Math.floor(Date.now() / 1000) - 3;
          const r1 = await fetch(API + '/preLoginRefresh.php?token=' + encodeURIComponent(token) + '&force=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, prelogin: 1, force: 1 })
          });
          const j1 = await r1.json().catch(() => ({}));
          lastStatus = j1 || null;

          // pending / eksik oturum → bg bitene ve Android+Volo taze olana kadar bekle (OTP ~2dk)
          const deadline = Date.now() + 360000;
          let retriedForce = false;
          const statusFresh = (js) => {
            if (!js) return false;
            const a = js.android_token || js.access_token || js.mobile_access_token || '';
            const v = js.volo_token || js.web_access_token || '';
            return js.has_android && jwtClient(a) === 'android' && jwtLeft(a) >= 120
              && js.has_volo && jwtClient(v) === 'volo' && jwtLeft(v) >= 120;
          };
          if ((j1 && j1.pending === true) || !statusFresh(j1)) {
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 4000));
              try {
                const rs = await fetch(API + '/preLoginRefresh.php?token=' + encodeURIComponent(token) +
                  '&status=1&since=' + since + '&v=bg', { method: 'GET', cache: 'no-store' });
                const js = await rs.json().catch(() => ({}));
                lastStatus = js || lastStatus;
                if (js && js.pending) continue;
                if (statusFresh(js)) break;
                // bg bitti ama Android/Volo eksik → bir kez daha force (OTP gecikmesi)
                if (!retriedForce) {
                  retriedForce = true;
                  console.warn('[KS LOGIN] eksik oturum — force tekrar');
                  await fetch(API + '/preLoginRefresh.php?token=' + encodeURIComponent(token) + '&force=1', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, prelogin: 1, force: 1 })
                  }).catch(() => null);
                  continue;
                }
                // ikinci turda da pending yoksa biraz daha status bekle
                continue;
              } catch (_) {}
            }
          }

          // Son durumu bir kez daha oku (force sonrası kesin)
          try {
            const rs2 = await fetch(API + '/preLoginRefresh.php?token=' + encodeURIComponent(token) +
              '&status=1&v=final', { method: 'GET', cache: 'no-store' });
            const js2 = await rs2.json().catch(() => null);
            if (js2) lastStatus = js2;
          } catch (_) {}
        } catch (e) { console.warn('[KS LOGIN] refresh:', e.message); }

        let hasAndroid = !!(lastStatus && lastStatus.has_android);
        let hasVolo = !!(lastStatus && lastStatus.has_volo);
        let androidTok = (lastStatus && (lastStatus.android_token || lastStatus.access_token || lastStatus.mobile_access_token)) || '';
        let androidLeft = jwtLeft(androidTok);

        // Android taze değilse YS AÇILMAZ
        if (!hasAndroid || jwtClient(androidTok) !== 'android' || androidLeft < 120) {
          reply({
            success: false,
            error: 'Android oturumu yenilenemedi (OTP 1–2 dk sürebilir). Birkaç saniye sonra tekrar deneyin.',
            hasAndroid: false,
            hasVolo,
            androidLeft,
            refreshed: false
          });
          return;
        }

        // ── 1b. Volo yoksa PHP fd-api OTP yedegi (Python PX'e dusunce) ──
        if (!hasVolo) {
          try {
            console.log('[KS LOGIN] Volo yok — PHP volo_only baslatiliyor…');
            const rv = await fetch(API + '/preLoginRefresh.php?token=' + encodeURIComponent(token) + '&volo_only=1', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token, volo_only: 1 })
            });
            const jv = await rv.json().catch(() => null);
            if (jv && jv.success && jv.has_volo) {
              lastStatus = Object.assign({}, lastStatus || {}, jv);
              hasVolo = true;
              console.log('[KS LOGIN] PHP volo_only OK');
            } else {
              console.warn('[KS LOGIN] PHP volo_only fail:', jv && (jv.error || jv));
            }
          } catch (e) {
            console.warn('[KS LOGIN] volo_only hata:', e.message);
          }
        }

        // ── 2. extAuth (cookies + headers_data/device_data) ──
        const r2 = await fetch(API + '/extAuth.php?token=' + encodeURIComponent(token), { method: 'GET', cache: 'no-store' });
        const auth = await r2.json().catch(() => null);
        if (!auth || auth.status !== true) {
          reply({ success: false, error: (auth && auth.message) || ('extAuth HTTP ' + r2.status) });
          return;
        }
        let cookies = Array.isArray(auth.data) ? auth.data : [];

        // ── 3. Önce eski sepet/oturum temizliği, sonra cookie yazımı (rakip gibi) ──
        console.log('[KS LOGIN] Ön temizleme (sepet/oturum/cache)…');
        await prepareFreshYsLogin();

        let addRes = await addCookiesFromContentScript(cookies);
        if (!addRes || !addRes.success) {
          ysLoginInProgress = false;
          reply({ success: false, error: (addRes && addRes.error) || 'Cookie yazilamadi' });
          return;
        }

        // ── 4. Volo/web oturumu zorunlu ──
        // Web sitesi Volo JWT ister. Yoksa Chrome tab login; o da olmazsa giriş İPTAL — YS AÇILMAZ.
        const pickVolo = (list) => {
          const names = ['token', 'uy_token', 'volo_token', 'web_token'];
          for (const n of names) {
            const v = pickCookie(list, n);
            if (jwtClient(v) === 'volo' && jwtLeft(v) > 120) return v;
          }
          return '';
        };
        let voloTok = (lastStatus && (lastStatus.volo_token || lastStatus.web_access_token)) || '';
        if (jwtClient(voloTok) !== 'volo' || jwtLeft(voloTok) <= 120) voloTok = pickVolo(cookies);
        let webLoginOk = jwtClient(voloTok) === 'volo' && jwtLeft(voloTok) > 120;
        if (!webLoginOk) {
          webLoginOk = await ksEnsureWebSession(auth);
          if (webLoginOk && Array.isArray(auth.data)) {
            cookies = auth.data;
            addRes = await addCookiesFromContentScript(cookies);
            voloTok = pickVolo(cookies);
            webLoginOk = jwtClient(voloTok) === 'volo' && jwtLeft(voloTok) > 120;
          } else {
            webLoginOk = false;
          }
        }
        hasVolo = webLoginOk;
        if (!webLoginOk) {
          ysLoginInProgress = false;
          reply({
            success: false,
            error: 'Volo / web oturumu açılamadı. Token sunucuda yenilenemedi — YS sayfası açılmadı.',
            hasAndroid: true,
            hasVolo: false,
            webLogin: false,
            refreshed: true,
            androidLeft
          });
          return;
        }

        // ── 4b. Cookie tür ayrımı (rakip mantığı): access_token=android, token=volo
        try {
          const setCk = (name, value) => new Promise((resolve) => {
            if (!value) { resolve(false); return; }
            chrome.cookies.set({
              url: 'https://www.yemeksepeti.com/',
              name,
              value,
              domain: '.yemeksepeti.com',
              path: '/',
              secure: true,
              sameSite: 'no_restriction',
              expirationDate: Math.floor(Date.now() / 1000) + 3600
            }, () => resolve(!chrome.runtime.lastError));
          });
          if (androidTok && jwtClient(androidTok) === 'android') {
            await setCk('access_token', androidTok);
            await setCk('android_token', androidTok);
          }
          if (voloTok && jwtClient(voloTok) === 'volo') {
            await setCk('token', voloTok);
            await setCk('uy_token', voloTok);
            await setCk('volo_token', voloTok);
          }
        } catch (e) {
          console.warn('[KS LOGIN] cookie tür ayrımı:', e.message);
        }

        // ── 5. adres ──
        const st = await new Promise((resolve) => {
          chrome.storage.local.get(['kuponstore_addresses', 'savedAddresses', 'kuponstore_active_address'], resolve);
        });
        const list = (Array.isArray(st.kuponstore_addresses) && st.kuponstore_addresses) ||
                     (Array.isArray(st.savedAddresses) && st.savedAddresses) || [];
        const activeId = st.kuponstore_active_address;
        let addr = null;
        if (activeId) addr = list.find((a) => a && (a.id === activeId || a.place_id === activeId || a.form_id === activeId)) || null;
        if (!addr) addr = list.find((a) => a && a.isDefault) || list[0] || null;

        let selectedAddress = null;
        let lat = 41.0082, lng = 28.9784;
        if (addr) {
          lat = parseFloat(addr.latitude ?? addr.lat ?? lat) || lat;
          lng = parseFloat(addr.longitude ?? addr.lng ?? lng) || lng;
          const city = addr.city || addr.province || addr.city_name || '';
          const areas = addr.areas || addr.neighborhood || addr.address_line3 || '';
          const street = addr.street || addr.address_line1 || '';
          const building = addr.building || addr.address_line2 || '';
          selectedAddress = Object.assign({}, addr, {
            city, city_name: city, city_id: addr.city_id || addr.cityId || 34,
            areas, neighborhood: areas,
            street, address_line1: street,
            building, address_line2: building,
            address_line3: areas,
            address_line4: addr.address_line4 || addr.district || city,
            entrance: addr.entrance || addr.apartment || addr.flat_number || '1',
            flat_number: addr.flat_number || addr.apartment || addr.entrance || '1',
            floor: addr.floor || '1',
            phone_number: addr.phone_number || addr.phone || '',
            first_name: addr.first_name || '',
            last_name: addr.last_name || '',
            formatted_customer_address: addr.formatted_customer_address ||
              [areas, street, building, city].filter(Boolean).join(', '),
            form_id: addr.form_id || addr.place_id || addr.id,
            place_id: addr.place_id || addr.form_id || addr.id,
            latitude: lat, longitude: lng
          });
        }

        // ── 6. session ÖNCE — DNR android ACCESS_TOKEN için ──
        const nowS = Math.floor(Date.now() / 1000);
        let sess = {};
        try {
          const cur = await new Promise((r) => chrome.storage.local.get(['yemekhub_session'], r));
          sess = cur.yemekhub_session || {};
        } catch (_) {}
        sess = Object.assign(sess, {
          isLogged: true,
          cookies: cookies,
          expiry: nowS + (55 * 60),
          token: token,
          isCookieInserted: true,
          autoAddAddress: !!selectedAddress,
          selectedAddress: selectedAddress,
          selectedAddressId: selectedAddress ? (selectedAddress.place_id || selectedAddress.form_id || selectedAddress.id) : null,
          addressAddSessionId: Date.now().toString(),
          lastLoginAt: Date.now(),
          headers_data: auth.headers_data || null,
          device_data: auth.device_data || null
        });
        try { await chrome.storage.local.set({ yemekhub_session: sess }); } catch (_) {}

        try {
          chrome.storage.local.get(['ys_orders_cutoff'], (prev) => {
            const p = prev && prev.ys_orders_cutoff;
            if (!p || p.token !== token) {
              chrome.storage.local.set({ ys_orders_cutoff: { token: token, ts: Date.now() } });
            }
          });
        } catch (_) {}

        // ── 7. DNR (android Authorization → kupon + ödeme) ──
        try { await setupDynamicHeaders(); await setupBlockingDynamicHeaders(); } catch (_) {}

        const targetUrl = 'https://www.yemeksepeti.com/restaurants/new/?lat=' + lat +
          '&lng=' + lng + '&vertical=restaurants';

        ysLoginInProgress = false;
        reply({
          success: true,
          refreshed: true,
          platform: 'yemeksepeti',
          cookieCount: (addRes && addRes.successCount) || cookies.length,
          email: auth.email || '',
          hasAndroid: true,
          hasVolo: hasVolo || webLoginOk,
          webLogin: webLoginOk,
          androidLeft,
          addressSync: selectedAddress ? { success: true } : { success: false, reason: 'no_saved_address' },
          url: targetUrl
        });
      } catch (e) {
        ysLoginInProgress = false;
        console.error('[KS LOGIN] hata:', e);
        reply({ success: false, error: e.message || 'Bilinmeyen hata' });
      }
    })();
  });
}

// YemekSepeti message handlers
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {

// YS login sayfası aç (ana KuponStore paneli) — web sitesi / content script tetikler
if ((message.action === 'openLoginPageWithToken' || message.type === 'OPEN_LOGIN_WITH_TOKEN') && message.token) {
  const loginUrl = chrome.runtime.getURL('ui/fullscreen.html');
  chrome.tabs.create({ url: loginUrl, active: true }, function(tab) {
    try { sendResponse({ success: true, tabId: tab && tab.id, extensionId: chrome.runtime.id }); } catch (_) {}
  });
  return true;
}
if (message.action === 'openLoginPage') {
  const loginUrl = chrome.runtime.getURL('ui/fullscreen.html');
  chrome.tabs.create({ url: loginUrl, active: true }, function(tab) {
    try { sendResponse({ success: true, tabId: tab && tab.id }); } catch (_) {}
  });
  return true;
}

if (message.action === 'addCookiesFromPopup') {
    console.log('🍪 Background: Popup\'tan cookie ekleme isteği alındı:', message.cookies?.length, 'adet');
    console.log('📋 Gelen cookie isimleri:', message.cookies?.map(c => c.name).join(', '));

(async () => {
      try {
        console.log('🔄 Background: addCookiesFromContentScript() çağrılıyor...');
        const result = await addCookiesFromContentScript(message.cookies);
        console.log('✅ Background: addCookiesFromContentScript() sonucu:', result);

        if (!result) {
          console.error('❌ UYARI: addCookiesFromContentScript() null döndürdü!');
          sendResponse({
            success: false,
            error: 'addCookiesFromContentScript returned null',
            successCount: 0,
            failCount: message.cookies?.length || 0,
            total: message.cookies?.length || 0
          });
        } else {
          console.log('📤 Background: sendResponse() çağrılıyor:', result);
          sendResponse(result);
        }
      } catch (error) {
        console.error('❌ Background: Cookie ekleme exception:', error);
        console.error('❌ Stack trace:', error.stack);
        sendResponse({
          success: false,
          error: error.message,
          successCount: 0,
          failCount: message.cookies?.length || 0,
          total: message.cookies?.length || 0
        });
      }
    })();

    return true;
  }

if (message.action === 'getAccessToken') {
    chrome.cookies.get({ url: 'https://www.yemeksepeti.com', name: 'access_token' }, (cookie) => {
      sendResponse({ token: cookie?.value || null });
    });
    return true;
  }

if (message.action === 'ysProxyRequest') {
    (async () => {
      try { await ksRefreshAndroidIfNeeded(message.url || ''); } catch (_e) {}
      handleYsProxyRequest(message, sendResponse);
    })();
    return true;
  }

  /* ============================================================
   * KUPONSTORE YS :: LOGIN BRIDGE (main eklenti fullscreen uyumu)
   * 3 action: LOGIN_WITH_TOKEN / YS_LOGIN_HANDOFF / GET_TOKEN_HISTORY
   * ============================================================ */
  if (message.action === 'YS_LOGIN_HANDOFF') {
    sendResponse({ ok: true, success: true });
    return true;
  }

  // Rakip geo / cities (extension-notices YOK)
  if (message.action === 'RIVAL_GEO' && typeof RivalAPI !== 'undefined') {
    (async () => {
      try {
        const op = String(message.op || '');
        let data = null;
        if (op === 'autocomplete') data = await RivalAPI.autocomplete(message.input || '');
        else if (op === 'geocode') data = await RivalAPI.geocode(message.address || '');
        else if (op === 'reverse') data = await RivalAPI.reverseGeocode(message.lat, message.lng);
        else if (op === 'placedetails') data = await RivalAPI.placeDetails(message.place_id || '');
        else if (op === 'cities') data = await RivalAPI.fetchCities();
        else if (op === 'districts') data = await RivalAPI.fetchDistricts(message.city || '');
        else throw new Error('Bilinmeyen geo op: ' + op);
        sendResponse({ success: true, data });
      } catch (e) {
        sendResponse({ success: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (message.action === 'YS_GET_TOKEN_HISTORY') {
    chrome.storage.local.get(['kuponstore_token_history', 'tokenHistory'], (d) => {
      sendResponse({
        tokens: d.kuponstore_token_history || d.tokenHistory || [],
        success: true
      });
    });
    return true;
  }

  if (message.action === "YS_UI_LOGIN") {
    ysUiLoginFlow((message.data && message.data.token) || "").then(sendResponse);
    return true;
  }
  /* ============================================================ */

if (message.action === 'sendToServer') {
    chrome.storage.local.get(['yemekhub_session'], (result) => {
      const mrdToken = (result.yemekhub_session && result.yemekhub_session.token) || '';
      fetch(message.serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payload: message.encryptedPayload,
          mrdToken: mrdToken
        })
      }).then(r => r.json()).then(data => {
        console.log('Background: Sunucu yanıtı:', data);
        sendResponse({ success: true, data: data });
      }).catch(err => {
        console.error('Background: Sunucu hatası:', err);
        sendResponse({ success: false, error: err.message });
      });
    });
    return true;
  }

if (message.action === 'clearYemeksepetiLikeChromeSettings') {
    console.log('🛡️ Güvenli Yemeksepeti temizleme başlatılıyor...');
    console.log('⏳ Temizleme 5 domain × 300ms beklemeli temizlik yapacak = ~2-3 saniye');

    clearYemeksepetiLikeChromeSettings()
      .then(success => {
        console.log(`🛡️ Güvenli temizleme TAMAMEN tamamlandı: ${success}`);
        console.log('✅ Artık cookie ekleme güvenle yapılabilir');
        sendResponse({ success: success });
      })
      .catch(error => {
        console.error('🛡️ Güvenli temizleme hatası:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

if (message.action === 'clearYemeksepetiCompletely' || message.action === 'clearSiteData') {
    console.log('🛡️ Güvenli Yemeksepeti temizleme başlatılıyor (backward compatibility)...');
    clearYemeksepetiLikeChromeSettings()
      .then(success => {
        sendResponse({ success: success });
      })
      .catch(error => {
        console.error('🛡️ Güvenli temizleme hatası:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

if (message.action === 'storeAddressesInStorage') {
    console.log("storeAddressesInStorage mesajı alındı");

    try {

      const yeniAdresler = message.addresses;

      if (!Array.isArray(yeniAdresler)) {
          console.error("Geçersiz adres verisi, dizi değil:", yeniAdresler);
          sendResponse({ success: false, error: "Geçersiz adres verisi" });
          return true;
      }

chrome.storage.local.get(['yemekhub_addresses'], function(result) {
          let adreslerData = result.yemekhub_addresses || [];
          console.log("Mevcut adres sayısı:", adreslerData.length);

adreslerData = adreslerData.concat(yeniAdresler);

const jsonData = JSON.stringify(adreslerData, null, 2);

chrome.storage.local.set({
              'yemekhub_addresses': adreslerData,
              'yemekhub_addresses_json': jsonData
          }, function() {
              if (chrome.runtime.lastError) {
                  console.error("Storage kaydetme hatası:", chrome.runtime.lastError);
                  sendResponse({ success: false, error: chrome.runtime.lastError.message });
              } else {
                  console.log("Adresler başarıyla kaydedildi. Toplam:", adreslerData.length);

const blob = new Blob([jsonData], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);

                  chrome.downloads.download({
                      url: url,
                      filename: 'adresler.json',
                      saveAs: true
                  }, function(downloadId) {
                      URL.revokeObjectURL(url);

                      if (chrome.runtime.lastError) {
                          console.error("İndirme hatası:", chrome.runtime.lastError);
                          sendResponse({ success: false, error: chrome.runtime.lastError.message });
                      } else {

                          sendResponse({ success: true });
                      }
                  });
              }
          });
      });

      return true;
    } catch (error) {
      console.error("Adres storage hatası:", error);
      sendResponse({ success: false, error: error.message });
      return true;
    }
  }

if (message.action === 'addCookiesFromContentScript') {
    console.log('🍪 Background: Content script\'ten cookie ekleme isteği alındı (fallback)');
    addCookiesFromContentScript(message.cookies)
      .then(result => {
        console.log('🍪 Background: Cookie ekleme sonucu:', result);
        sendResponse(result);
      })
      .catch(error => {
        console.error('🍪 Background: Cookie ekleme hatası:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

if (message.action === 'deleteAllCards') {
    console.log('💳 Background: Kart silme isteği alındı');
    deleteAllCards()
      .then(result => {
        console.log('💳 Background: Kart silme sonucu:', result);
        sendResponse(result);
      })
      .catch(error => {
        console.error('💳 Background: Kart silme hatası:', error);
        sendResponse({ success: false, error: error.message, deleted: 0 });
      });
    return true;
  }

if (message.action === 'changeTokenAndOpenManager') {

    chrome.tabs.query({url: '*://*.yemeksepeti.com/*'}, function(tabs) {

      tabs.forEach(function(tab) {
        chrome.cookies.getAll({ url: tab.url }, function(cookies) {
          for (var i = 0; i < cookies.length; i++) {
            chrome.cookies.remove({
              url: tab.url + cookies[i].path,
              name: cookies[i].name
            });
          }
        });
      });

if (tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, {
          url: chrome.runtime.getURL('pages/login.html#token-manager')
        });

for (let i = 1; i < tabs.length; i++) {
          chrome.tabs.remove(tabs[i].id);
        }
      } else {

        chrome.tabs.create({
          url: chrome.runtime.getURL('pages/login.html?autoOpenTokenManager=true')
        });
      }
    });

    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'runDynamicHeaders') {
    (async () => {
      try {
        await setupDynamicHeaders();
        await setupBlockingDynamicHeaders();
        console.log('Dinamik headerlar başarıyla ayarlandı.');
        sendResponse({ success: true });
      } catch (error) {
        console.error('❌ Dinamik header kurulum hatası:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

if (message.action === 'closeYemeksepetiTabs') {
    chrome.tabs.query({}, function (tabs) {
      tabs.forEach(function (tab) {
        if (tab.url && tab.url.includes('yemeksepeti.com')) {

          chrome.cookies.getAll({ url: tab.url }, function (cookies) {
            for (var i = 0; i < cookies.length; i++) {
              chrome.cookies.remove({
                url: tab.url + cookies[i].path,
                name: cookies[i].name
              });
            }
          });
          chrome.tabs.remove(tab.id);
        }
      });
    });
    sendResponse({ success: true });
    return true;
  }
});

class CookieManager {
    /**
     * Debug: Mevcut cookie'leri listele
     */
    static async debugListCookies() {
        try {
            const cookies = await chrome.cookies.getAll({ domain: 'yemeksepeti.com' });
            console.log('🔍 DEBUG: Mevcut Yemeksepeti cookie\'leri:', cookies.length, 'adet');
            cookies.forEach(c => {
                console.log(`  - ${c.name}: ${c.value.substring(0, 20)}... (domain: ${c.domain}, secure: ${c.secure})`);
            });
            return cookies;
        } catch (error) {
            console.error('🔍 DEBUG: Cookie listesi alınamadı:', error);
            return [];
        }
    }

/**
     * Platform cookie'lerini temizler (yemeksepeti.com ve ilgili domainler)
     */
    static async clearYemeksepetiCookies() {
        const yemeksepetiDomains = [
            'yemeksepeti.com',
            'fd-api.com',
            'deliveryhero.com'
        ];

        const origins = yemeksepetiDomains.map(domain => `https://${domain}`);

        try {
            const clearOperations = [

                chrome.browsingData.remove({
                    origins: origins
                }, {
                    cookies: true,
                    localStorage: true,
                    indexedDB: true,
                    cacheStorage: true,
                    serviceWorkers: true
                }),

(async () => {
                    let removedCount = 0;
                    const stores = await chrome.cookies.getAllCookieStores();
                    const removePromises = [];

                    for (const store of stores) {
                        const cookies = await chrome.cookies.getAll({ storeId: store.id });

                        for (const cookie of cookies) {
                            const cookieDomain = cookie.domain.startsWith('.')
                                ? cookie.domain.substring(1)
                                : cookie.domain;

                            const shouldRemove = yemeksepetiDomains.some(pattern =>
                                cookieDomain === pattern ||
                                cookieDomain.endsWith('.' + pattern)
                            );

                            if (shouldRemove) {
                                const protocol = cookie.secure ? 'https' : 'http';
                                const host = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
                                const url = `${protocol}://${host}${cookie.path}`;

                                removePromises.push(
                                    chrome.cookies.remove({ url, name: cookie.name, storeId: store.id })
                                        .then(() => removedCount++)
                                        .catch(() => null)
                                );
                            }
                        }
                    }

                    await Promise.all(removePromises);
                    return removedCount;
                })(),

(async () => {
                    let removedCount = 0;
                    try {
                        const stores = await chrome.cookies.getAllCookieStores();
                        const removePromises = [];

                        for (const store of stores) {
                            const cookies = await chrome.cookies.getAll({ storeId: store.id });

                            for (const cookie of cookies) {
                                const cookieDomain = cookie.domain.startsWith('.')
                                    ? cookie.domain.substring(1)
                                    : cookie.domain;

                                const shouldRemove = yemeksepetiDomains.some(pattern =>
                                    cookieDomain === pattern ||
                                    cookieDomain.endsWith('.' + pattern)
                                );

                                if (shouldRemove && cookie.partitionKey) {
                                    const protocol = cookie.secure ? 'https' : 'http';
                                    const host = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
                                    const url = `${protocol}://${host}${cookie.path}`;

                                    removePromises.push(
                                        chrome.cookies.remove({ url, name: cookie.name, storeId: store.id, partitionKey: cookie.partitionKey })
                                            .then(() => removedCount++)
                                            .catch(() => null)
                                    );
                                }
                            }
                        }

                        await Promise.all(removePromises);
                        return removedCount;
                    } catch (e) {
                        return 0;
                    }
                })()
            ];

            const results = await Promise.allSettled(clearOperations);
            const errors = results.filter(r => r.status === 'rejected');
            if (errors.length > 0) {
                console.warn('⚠️ Bazı temizleme işlemleri başarısız:', errors);
            }

            console.log('✅ Yemeksepeti cookie\'leri temizlendi');
            return results.some(r => r.status === 'fulfilled');
        } catch (error) {
            console.error('❌ Cookie temizleme hatası:', error);
            return false;
        }
    }

    /**
     * Cookie'leri paralel olarak set eder ( mantığı)
     */
    static async setPlatformCookies(cookies, platformDomain = '.yemeksepeti.com') {
        console.log('🍪 CookieManager: Cookie ekleme başlıyor...', cookies.length, 'adet');
        console.log('🔍 DEBUG: Gelen cookie\'ler:', cookies.map(c => ({
            name: c.name,
            domain: c.domain,
            expiry: c.expiry,
            secure: c.secure,
            value_length: c.value?.length
        })));

const nowInSeconds = Math.floor(Date.now() / 1000);
        console.log('🔍 DEBUG: Şu anki zaman (saniye):', nowInSeconds);

const cookiePromises = cookies.map(async (cookie) => {
            try {

                let sameSite = 'no_restriction';
                if (cookie.sameSite) {
                    const sameSiteMap = {
                        'None': 'no_restriction',
                        'Lax': 'lax',
                        'Strict': 'strict',
                        'Unspecified': 'unspecified'
                    };
                    sameSite = sameSiteMap[cookie.sameSite] || 'no_restriction';
                }

                const domain = cookie.domain || platformDomain;
                const path = cookie.path || '/';
                const domainForUrl = domain.startsWith('.') ? domain.substring(1) : domain;
                const cookieUrl = `https://${domainForUrl}${path}`;

            const cookieData = {
                url: cookieUrl,
                name: cookie.name,
                value: String(cookie.value),
                domain: domain,
                path: path,
                secure: true,
                httpOnly: cookie.httpOnly !== false,
                sameSite: sameSite
            };

if (cookie.expirationDate && typeof cookie.expirationDate === 'number' && cookie.expirationDate > 0) {
                cookieData.expirationDate = cookie.expirationDate < nowInSeconds
                    ? nowInSeconds + (365 * 24 * 60 * 60)
                    : cookie.expirationDate;
            } else if (cookie.expires && typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires !== -1) {
                cookieData.expirationDate = cookie.expires < nowInSeconds
                    ? nowInSeconds + (365 * 24 * 60 * 60)
                    : cookie.expires;
            } else if (cookie.expiry && typeof cookie.expiry === 'number' && cookie.expiry > 0) {
                cookieData.expirationDate = cookie.expiry < nowInSeconds
                    ? nowInSeconds + (365 * 24 * 60 * 60)
                    : cookie.expiry;
            } else if (cookie.expiry === 'Session' || cookie.expiry === 'session' || !cookie.expiry) {

                cookieData.expirationDate = nowInSeconds + (60 * 60);
            } else {

                cookieData.expirationDate = nowInSeconds + (60 * 60);
            }

if (cookie.domain && !cookie.domain.includes('yemeksepeti.com')) {
                    try {
                        cookieData.partitionKey = {
                            topLevelSite: 'https://www.yemeksepeti.com'
                        };
                    } catch (e) {

                    }
                }

                const result = await this.setCookie(cookieData);
                if (!result) {
                    console.error('[CookieManager] ❌ Cookie eklenemedi:', {
                        name: cookie.name,
                        domain: domain,
                        url: cookieUrl,
                        expiry: cookie.expiry,
                        secure: cookieData.secure,
                        sameSite: cookieData.sameSite
                    });
                } else {
                    console.log('[CookieManager] ✅ Cookie eklendi:', cookie.name, '→', domain);
                }
                return {
                    name: cookie.name,
                    success: result,
                    error: result ? null : 'Failed to set cookie'
                };
            } catch (error) {
                console.error('[CookieManager] Cookie ekleme hatası:', cookie.name, error);
                return {
                    name: cookie.name,
                    success: false,
                    error: error.message
                };
            }
        });

const results = await Promise.allSettled(cookiePromises);

const processedResults = results.map(r => r.status === 'fulfilled' ? r.value : { success: false });
        const successCount = processedResults.filter(r => r.success).length;
        const failedCount = processedResults.filter(r => !r.success).length;

        console.log(`📊 CookieManager: Cookie ekleme tamamlandı - Başarılı: ${successCount}, Başarısız: ${failedCount}`);

        return {
            success: successCount > 0,
            total: cookies.length,
            successful: successCount,
            failed: failedCount,
            results: processedResults
        };
    }

    /**
     * Tek bir cookie'yi set eder (Promise wrapper)
     */
    static async setCookie(cookieData) {
        return new Promise((resolve) => {
            console.log(`🔍 DEBUG: chrome.cookies.set() çağrılıyor:`, {
                name: cookieData.name,
                url: cookieData.url,
                domain: cookieData.domain,
                secure: cookieData.secure,
                sameSite: cookieData.sameSite,
                expirationDate: cookieData.expirationDate
            });

            chrome.cookies.set(cookieData, (cookie) => {
                if (chrome.runtime.lastError) {
                    console.error(`❌ CookieManager: Chrome API hatası:`, {
                        cookieName: cookieData.name,
                        error: chrome.runtime.lastError.message,
                        url: cookieData.url,
                        domain: cookieData.domain,
                        cookieData: cookieData
                    });
                    resolve(false);
                } else if (!cookie) {
                    console.error(`❌ CookieManager: Cookie set edildi ama dönen değer null:`, {
                        name: cookieData.name,
                        cookieData: cookieData
                    });
                    resolve(false);
                } else {
                    console.log(`✅ CookieManager: chrome.cookies.set() BAŞARILI:`, cookie.name);
                    resolve(true);
                }
            });
        });
    }
}

async function addCookiesFromContentScript(cookies) {
    console.log('🍪 Background: Cookie ekleme isteği alındı:', cookies.length, 'adet');
    console.log('📋 Cookie listesi:', cookies.map(c => c.name).join(', '));

    try {

        const result = await CookieManager.setPlatformCookies(cookies);

        console.log(`📊 Background: Cookie işlemi tamamlandı - ${result.successful}/${result.total} başarılı`);

        if (result.failed > 0) {
            console.warn(`⚠️ ${result.failed} cookie eklenemedi. Detaylar:`,
                result.results.filter(r => !r.success).map(r => ({ name: r.name, error: r.error }))
            );
        }

        return {
            success: result.success,
            successCount: result.successful,
            failCount: result.failed,
            total: result.total
        };
    } catch (error) {
        console.error('❌ Background: Cookie ekleme genel hatası:', error);
        console.error('❌ Hata detayları:', {
            message: error.message,
            stack: error.stack,
            cookieCount: cookies.length
        });
        return {
            success: false,
            successCount: 0,
            failCount: cookies.length,
            total: cookies.length,
            error: error.message
        };
    }
}

async function deleteAllCards() {
    console.log('💳 Kart silme işlemi başlatılıyor...');

    const accessTokenCookie = await new Promise(resolve => {
        chrome.cookies.get({ url: 'https://www.yemeksepeti.com', name: 'access_token' }, resolve);
    });
    let token = accessTokenCookie?.value;

    if (!token) {
        const sessionData = await chrome.storage.local.get(['yemekhub_session']);
        if (sessionData.yemekhub_session?.cookies) {
            const atCookie = sessionData.yemekhub_session.cookies.find(c => c.name === 'access_token');
            if (atCookie) token = atCookie.value;
        }
    }

    if (!token) {
        console.error('💳 Kart silme: Access token bulunamadı');
        return { success: false, error: 'Access token bulunamadı', deleted: 0 };
    }

    const device = getOrCreateDeviceInfo();
    const baseHeaders = {
        "Authorization": `Bearer ${token}`,
        "X-Pd-Language-Id": "2",
        "Host": "tr.fd-api.com",
        "Api-Client-Version": "5.0",
        "App-Name": "com.inovel.app.yemeksepeti",
        "App-Flavor": "yemeksepeti",
        "Build-Type": "release",
        "Platform": "android",
        "Platform-Version": "28",
        "Build-Number": device.buildNumber,
        "App-Build": device.buildNumber,
        "App-Version": device.appVersion,
        "Content-Type": "application/json; charset=UTF-8"
    };

    try {
        const listResp = await fetch('https://tr.fd-api.com/api/v5/wallet/paymentinstruments', {
            method: 'GET',
            headers: baseHeaders
        });

        if (!listResp.ok) {
            const errText = await listResp.text();
            console.error('💳 Kart listesi alınamadı:', listResp.status, errText);
            return { success: false, error: `Kart listesi alınamadı (${listResp.status})`, deleted: 0 };
        }

        const data = await listResp.json();
        const cards = data.data || data.items || data.payment_instruments || data || [];
        const cardList = Array.isArray(cards) ? cards : [];

        if (cardList.length === 0) {
            console.log('💳 Silinecek kart bulunamadı');
            return { success: true, deleted: 0, message: 'Kayıtlı kart yok' };
        }

        console.log(`💳 ${cardList.length} adet kart bulundu, siliniyor...`);
        let deleted = 0;
        let failed = 0;

        for (const card of cardList) {
            const cardId = card.id || card.payment_instrument_id;
            if (!cardId) {
                console.warn('💳 Kart ID bulunamadı, atlanıyor:', card);
                failed++;
                continue;
            }

            try {
                const delResp = await fetch(`https://tr.fd-api.com/api/v5/wallet/paymentinstruments/${cardId}`, {
                    method: 'DELETE',
                    headers: baseHeaders
                });

                if (delResp.ok || delResp.status === 204) {
                    deleted++;
                    console.log(`💳 Kart silindi: ${cardId}`);
                } else {
                    failed++;
                    console.error(`💳 Kart silinemedi: ${cardId} (${delResp.status})`);
                }
            } catch (e) {
                failed++;
                console.error(`💳 Kart silme hatası: ${cardId}`, e);
            }
        }

        console.log(`💳 Kart silme tamamlandı: ${deleted} silindi, ${failed} başarısız`);
        return { success: true, deleted, failed, total: cardList.length };
    } catch (error) {
        console.error('💳 Kart silme genel hatası:', error);
        return { success: false, error: error.message, deleted: 0 };
    }
}

const KS_YS_UPDATE_CHECK_URL = 'https://kuponstore.com/public-api/extension/version?app=ys';
const KS_YS_UPDATE_ALARM = 'ksYsUpdateCheck';
const KS_YS_UPDATE_INTERVAL_HOURS = 6;

function ksYsIsNewerVersion(local, remote) {
    const toArr = (v) => String(v || '').replace(/[^0-9.]/g, '').split('.').map(Number);
    const l = toArr(local), r = toArr(remote);
    for (let i = 0; i < Math.max(l.length, r.length); i++) {
        if ((r[i] || 0) > (l[i] || 0)) return true;
        if ((r[i] || 0) < (l[i] || 0)) return false;
    }
    return false;
}

async function ksYsCheckForUpdates() {
    try {
        const currentVersion = chrome.runtime.getManifest().version;
        const res = await fetch(KS_YS_UPDATE_CHECK_URL, {
            method: 'GET',
            headers: {
                'X-Extension-Version': currentVersion,
                'X-Extension-App': 'ys',
            },
            cache: 'no-store',
        });
        if (!res.ok) return;

        const data = await res.json();
        if (!data || !data.latestVersion) return;

        const hasUpdate = ksYsIsNewerVersion(currentVersion, data.latestVersion);
        const isMandatory =
            data.type === 'mandatory' &&
            data.minRequiredVersion &&
            ksYsIsNewerVersion(currentVersion, data.minRequiredVersion);

        const updateInfo = {
            hasUpdate,
            isMandatory,
            latestVersion: data.latestVersion,
            currentVersion,
            message: data.message || '',
            changelog: Array.isArray(data.changelog) ? data.changelog : [],
            downloadUrl: data.downloadUrl || 'https://kuponstore.com/extension',
            checkedAt: Date.now(),
        };

        await chrome.storage.local.set({ ks_ys_update_info: updateInfo });
        console.log('[KuponStore YS] Update check:', updateInfo);
    } catch (e) {
        console.warn('[KuponStore YS] Update check failed:', e && e.message ? e.message : e);
    }
}

function ensureYsUpdateAlarm() {
    try {
        chrome.alarms.create(KS_YS_UPDATE_ALARM, {
            delayInMinutes: 1,
            periodInMinutes: KS_YS_UPDATE_INTERVAL_HOURS * 60,
        });
    } catch (e) {
        console.warn('[KuponStore YS] Update alarm kurulamadı:', e);
    }
}

chrome.runtime.onInstalled.addListener(async () => {
    console.log('🚀 Eklenti yüklendi/güncellendi, kurallar uygulanıyor...');
    try {
        await setupDynamicHeaders();
        await setupBlockingDynamicHeaders();
        await updateCookieForwardingRule();
        ensureYsUpdateAlarm();
        ksYsCheckForUpdates();
        console.log('✅ Kurallar otomatik olarak uygulandı');
    } catch (error) {
        console.error('❌ Otomatik kural uygulama hatası:', error);
    }
});

chrome.runtime.onStartup.addListener(async () => {
    console.log('🚀 Tarayıcı açıldı, kurallar uygulanıyor...');
    try {
        await setupDynamicHeaders();
        await setupBlockingDynamicHeaders();
        await updateCookieForwardingRule();
        ensureYsUpdateAlarm();
        ksYsCheckForUpdates();
        console.log('✅ Kurallar otomatik olarak uygulandı');
    } catch (error) {
        console.error('❌ Otomatik kural uygulama hatası:', error);
    }
});


// ============================================================
// YEMEKTIME: YEMEKSEPETİ OTURUM ÇEREZLERİ İÇİN "KISA ÖMÜR + HEARTBEAT"
// ------------------------------------------------------------
// Amaç: Kullanıcı sekmeyi kapatıp eklentiyi devre dışı bıraksa BİLE, oturum
// çerezleri eklenti olmadan yaşamaya devam etmesin (content script watchdog'ın
// yakalayamadığı "sekme kapalı + eklenti kapalı → sonra yeni sekme" senaryosu).
//
// Mantık: access_token/refresh_token/token/device_token çerezlerine KISA bir
// ömür (TTL) verilir; eklenti AKTİFKEN alarm ile periyodik yenilenir. Eklenti
// pasife alınınca service worker uyanmaz, yenileme durur ve çerezler
// kendiliğinden en geç TTL kadar sürede UÇAR. /logout ÇAĞRILMAZ → sunucudaki
// oturum/token bozulmaz (token tekrar kullanılabilir kalır).
//
// Önemli: DNR Authorization header'ı access_token'ı storage'dan aldığı için
// (canlı çerezden değil), bu TTL kısıtı aktif SİPARİŞ akışını ETKİLEMEZ; yalnızca
// web sitesinin (www.yemeksepeti.com) çerez tabanlı oturumunu kısar.
// ============================================================
const YS_AUTH_COOKIE_NAMES = ['access_token', 'refresh_token', 'device_token', 'token'];
const YS_COOKIE_TTL_SEC = 300;          // Çerez ömrü: 5 dk (eklenti kapanınca en geç bu sürede uçar)
const YS_HEARTBEAT_PERIOD_MIN = 1;      // Yenileme sıklığı: 1 dk (aktifken çerezleri diri tutar)
const YS_HEARTBEAT_ALARM = 'ysCookieHeartbeat';

// Var olan bir çerezi, sadece son kullanma tarihini uzatarak (değeri koruyarak)
// yeniden set etmek için gereken parametreleri üretir.
function ysCookieSetParamsFrom(cookie, ttlSec) {
    const host = cookie.domain && cookie.domain.startsWith('.')
        ? cookie.domain.substring(1) : cookie.domain;
    const params = {
        url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite || 'unspecified',
        expirationDate: Math.floor(Date.now() / 1000) + ttlSec,
        storeId: cookie.storeId
    };
    if (cookie.partitionKey) params.partitionKey = cookie.partitionKey;
    return params;
}

// Aktif oturum çerezlerinin ömrünü yeniden TTL'e sabitler (keep-alive).
let ysHeartbeatRunning = false;
async function refreshYsCookieTtl() {
    if (ysHeartbeatRunning) return;
    ysHeartbeatRunning = true;
    try {
        const cookies = await chrome.cookies.getAll({ domain: 'yemeksepeti.com' });
        const targets = cookies.filter(c => YS_AUTH_COOKIE_NAMES.includes(c.name));
        for (const c of targets) {
            try { await chrome.cookies.set(ysCookieSetParamsFrom(c, YS_COOKIE_TTL_SEC)); } catch (_) {}
        }
        if (targets.length) {
            console.log(`♻️ YS oturum çerezi TTL yenilendi (${targets.length} çerez, ${YS_COOKIE_TTL_SEC}s)`);
        }
    } catch (e) {
        console.warn('YS cookie heartbeat hatası:', e);
    } finally {
        ysHeartbeatRunning = false;
    }
}

function ensureYsCookieHeartbeat() {
    try {
        chrome.alarms.create(YS_HEARTBEAT_ALARM, { periodInMinutes: YS_HEARTBEAT_PERIOD_MIN });
    } catch (e) {
        console.warn('YS heartbeat alarmı kurulamadı:', e);
    }
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm) return;
    if (alarm.name === YS_HEARTBEAT_ALARM) refreshYsCookieTtl();
    if (alarm.name === KS_YS_UPDATE_ALARM) ksYsCheckForUpdates();
});

ensureYsUpdateAlarm();
ksYsCheckForUpdates();

// Yeni giriş yapıldığında (ya da site çerezi uzun ömürle set ettiğinde) ömrü
// ANINDA kısalt. Böylece "girişten ilk heartbeat'e kadar" olan boşluk da kapanır.
// Sonsuz döngü olmaması için yalnızca TTL'den (pay ile) uzun olanlar kısaltılır.
chrome.cookies.onChanged.addListener((changeInfo) => {
    try {
        if (changeInfo.removed) return;
        const c = changeInfo.cookie;
        if (!c || !c.domain || c.domain.indexOf('yemeksepeti.com') === -1) return;
        if (YS_AUTH_COOKIE_NAMES.indexOf(c.name) === -1) return;
        const now = Math.floor(Date.now() / 1000);
        if (typeof c.expirationDate === 'number' && c.expirationDate > now + YS_COOKIE_TTL_SEC + 30) {
            chrome.cookies.set(ysCookieSetParamsFrom(c, YS_COOKIE_TTL_SEC)).catch(() => {});
        }
    } catch (e) {}
});

// SW her uyandığında başlat: alarmı kur + mevcut çerezleri hemen kısalt.
ensureYsCookieHeartbeat();
refreshYsCookieTtl();

// ============================================================
// YEMEKTIME: SEKME KAPANINCA OTURUM ÇEREZLERİNİ SİL (ANINDA KİLİT)
// ------------------------------------------------------------
// Senaryo: "Kullanıcı sekmeyi kapattı → eklentiyi kapattı → yemeksepeti'ne
// girdi". Sekme KAPANDIĞI an eklenti HÂLÂ AKTİF olduğundan, oturum çerezlerini
// TAM O ANDA sileriz. Böylece kullanıcı sonradan eklentiyi kapatıp YENİ sekme
// açsa bile çerez KALMADIĞI için hesap AÇILMAZ (5 dk'lık TTL beklenmez).
//
// Not: Eklenti kapalıyken hiçbir kodumuz çalışamaz; bu yüzden tek güvenli yol
// çerezi eklenti kapanmadan ÖNCE (sekme kapanışında) silmiş olmaktır.
//
// Normal kullanım için: eklenti AKTİFKEN bir yemeksepeti sekmesi açılınca,
// çerezler storage'daki oturumdan YENİDEN enjekte edilir. Eklenti PASİFKEN bu
// enjeksiyon da çalışmaz → hesap açılmaz.
// ============================================================

// Sadece oturum (auth) çerezlerini siler; _pxvid/_pxhd gibi sabit parmakizi
// çerezlerine dokunmaz (anti-bot tutarlılığı için sabit kalmaları gerekir).
async function deleteYsAuthCookies() {
    try {
        const cookies = await chrome.cookies.getAll({ domain: 'yemeksepeti.com' });
        for (const c of cookies) {
            if (!YS_AUTH_COOKIE_NAMES.includes(c.name)) continue;
            const host = c.domain.startsWith('.') ? c.domain.substring(1) : c.domain;
            const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
            try { await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId }); } catch (_) {}
        }
    } catch (e) {}
}

// Açık hiçbir yemeksepeti sekmesi kalmadıysa oturum çerezlerini sil.
async function maybeCleanupYsAuthCookies() {
    try {
        const all = await chrome.tabs.query({});
        const hasYs = all.some(t => t.url && t.url.indexOf('yemeksepeti.com') !== -1);
        if (!hasYs) {
            await deleteYsAuthCookies();
            console.log('🔒 Açık yemeksepeti sekmesi kalmadı → oturum çerezleri silindi');
        }
    } catch (e) {}
}

// Yemeksepeti sekmesi açıldığında (eklenti aktifken) oturumu geri yükle.
let ysReinjectInFlight = false;
async function reinjectYsAuthCookiesFromSession() {
    if (ysLoginInProgress) return; // yeni giriş temizliği sürerken eski oturumu geri yazma
    if (ysReinjectInFlight) return;
    ysReinjectInFlight = true;
    try {
        const existing = await chrome.cookies.get({ url: 'https://www.yemeksepeti.com', name: 'access_token' });
        if (existing) return; // zaten girişli
        const st = await chrome.storage.local.get('yemekhub_session');
        const sess = st && st.yemekhub_session;
        if (!sess || !sess.isLogged || !sess.isCookieInserted) return;
        const stored = sess && Array.isArray(sess.cookies) ? sess.cookies : [];
        const authCookies = stored.filter(c => YS_AUTH_COOKIE_NAMES.includes(c.name));
        if (authCookies.length === 0) return;
        const now = Math.floor(Date.now() / 1000);
        for (const c of authCookies) {
            const domain = c.domain || '.yemeksepeti.com';
            const host = domain.startsWith('.') ? domain.substring(1) : domain;
            try {
                await chrome.cookies.set({
                    url: `https://${host}${c.path || '/'}`,
                    name: c.name,
                    value: String(c.value),
                    domain,
                    path: c.path || '/',
                    secure: true,
                    httpOnly: false,
                    sameSite: 'no_restriction',
                    expirationDate: now + YS_COOKIE_TTL_SEC
                });
            } catch (_) {}
        }
        console.log('🔓 Yemeksepeti sekmesi açıldı → oturum çerezleri yeniden enjekte edildi (aktif eklenti)');
    } catch (e) {
    } finally {
        ysReinjectInFlight = false;
    }
}

chrome.tabs.onRemoved.addListener(() => { maybeCleanupYsAuthCookies(); });

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo.url || (tab && tab.url) || '';
    if ((changeInfo.status === 'loading' || changeInfo.url) && url.indexOf('yemeksepeti.com') !== -1) {
        reinjectYsAuthCookiesFromSession();
    } else if (changeInfo.url) {
        // Bir sekme yemeksepeti'nden başka adrese gitti → gerekiyorsa temizle
        maybeCleanupYsAuthCookies();
    }
});

const COOKIE_FORWARDING_RULE_ID = 20;

async function getYsCookieString() {
    try {
        const cookies = await chrome.cookies.getAll({ domain: 'www.yemeksepeti.com' });
        return cookies
            .filter(c => c.name === '_pxhd' || c.name === '__cf_bm')
            .map(c => `${c.name}=${c.value}`)
            .join('; ');
    } catch (e) {
        console.error('Cookie forwarding: cookie okunamadı:', e);
        return '';
    }
}

async function updateCookieForwardingRule() {
    try {
        const cookieString = await getYsCookieString();

        if (!cookieString) {
            await RequestHeaderManager.updateDynamicRules({
                removeRuleIds: [COOKIE_FORWARDING_RULE_ID],
                addRules: []
            });
            console.log('Cookie forwarding: kural kaldırıldı (cookie boş)');
            return;
        }

        await RequestHeaderManager.updateDynamicRules({
            removeRuleIds: [COOKIE_FORWARDING_RULE_ID],
            addRules: [{
                id: COOKIE_FORWARDING_RULE_ID,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [{
                        header: 'Cookie',
                        operation: 'set',
                        value: cookieString
                    }]
                },
                condition: {
                    urlFilter: '|https://tr.fd-api.com/*',
                    resourceTypes: ['xmlhttprequest']
                }
            }]
        });
        console.log(`Cookie forwarding: kural güncellendi (${cookieString.length} karakter)`);
    } catch (e) {
        console.error('Cookie forwarding: kural güncellenemedi:', e);
    }
}

chrome.cookies.onChanged.addListener((changeInfo) => {
    if (!changeInfo.cookie.domain.includes('yemeksepeti.com')) return;
    if (changeInfo.cookie.name !== '_pxhd' && changeInfo.cookie.name !== '__cf_bm') return;

    console.log(`Cookie forwarding: ${changeInfo.cookie.name} ${changeInfo.removed ? 'silindi' : 'güncellendi'}`);
    updateCookieForwardingRule().catch(e => {
        console.error('Cookie forwarding: güncelleme hatası:', e);
    });
});

async function ksRefreshAndroidIfNeeded(url) {
  try {
    if (!/cart\/(checkout|calculate)|purchase\/intent/.test(url || '')) return;
    const st = await new Promise((r) => chrome.storage.local.get(['yemekhub_session'], r));
    const sess = (st && st.yemekhub_session) || {};
    if (!sess.token || !sess.isLogged) return;

    // 1) JWT exp'i varsa öncelikli ölçüt
    let leftSec = null;
    const tok = await new Promise((r) =>
      chrome.cookies.get({ url: 'https://www.yemeksepeti.com', name: 'access_token' }, r));
    const t = (tok && tok.value) || (sess.cookies || []).find(c => c.name === 'access_token')?.value || '';
    try {
      const pad = t.split('.')[1] + '='.repeat((4 - (t.split('.')[1].length % 4)) % 4);
      const pay = JSON.parse(atob(pad.replace(/-/g, '+').replace(/_/g, '/')));
      let exp = Number(pay.exp || pay.expires || 0);
      if (exp > 1e12) exp = Math.floor(exp / 1000);
      if (exp) leftSec = exp - Date.now() / 1000;
    } catch (_) {}

    // 2) JWT exp yoksa oturum penceresi ölçütü (rakip 45 dk)
    if (leftSec === null) {
      const la = Number(sess.lastLoginAt || 0);
      if (la) leftSec = KS_ANDROID_WINDOW_SEC - (Date.now() - la) / 1000;
      else leftSec = 0;
    }

    if (leftSec !== null && leftSec > 120) return; // henüz taze

    console.log('[KS YS] android token bayat (kalan', Math.round(leftSec), 'sn) — extAuth ile yenileniyor…');
    const API = 'https://kuponstore.com/api/extension/yemeksepeti';
    const r = await fetch(API + '/extAuth.php?token=' + encodeURIComponent(sess.token), { method: 'GET' });
    const auth = await r.json().catch(() => null);
    if (!auth || !auth.status) { console.warn('[KS YS] extAuth refresh başarısız'); return; }

    await addCookiesFromContentScript(auth.data || []);
    try { await setupDynamicHeaders(); await setupBlockingDynamicHeaders(); } catch (_) {}
    try {
      const cur = await new Promise((r2) => chrome.storage.local.get(['yemekhub_session'], r2));
      const sj = (cur && cur.yemekhub_session) || {};
      sj.cookies = auth.data || [];
      sj.lastLoginAt = Date.now();
      sj.headers_data = auth.headers_data || sj.headers_data || null;
      sj.device_data = auth.device_data || sj.device_data || null;
      await chrome.storage.local.set({ yemekhub_session: sj });
    } catch (_) {}
    console.log('[KS YS] android + web oturum tazendi ✔');
  } catch (e) {
    console.warn('[KS YS] freshness hata:', e.message);
  }
}

/* ============================================================
 * KUPONSTORE YS :: WEB SITE LOGIN VIA SERVICE WORKER
 * Rakip'in "site login" adımı: gerçek Chrome isteği Cloudflare
 * engelini aşar, token/uy_token çerezleri tazelenir, DB'e senkronize
 * edilir (kuponstore_app tokens + token_cookies).
 * ============================================================ */
function ksJwtExp(tok) {
  try {
    const p = (String(tok || '').split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = p + '='.repeat((4 - (p.length % 4)) % 4);
    const d = JSON.parse(atob(pad));
    let e = Number(d.exp || d.expires || d.expiresAt || 0);
    if (e > 1e12) e = Math.floor(e / 1000);
    return e || 0;
  } catch (_) { return 0; }
}


async function ksWebSiteLoginTab(email, password, device) {
  try {
    if (!device) return null;
    try {
      await chrome.cookies.set({
        url: 'https://www.yemeksepeti.com/',
        name: 'device_token',
        value: device,
        domain: '.yemeksepeti.com',
        path: '/',
        secure: true,
        sameSite: 'lax',
      });
    } catch (_) {}

    const tab = await chrome.tabs.create({
      url: 'https://www.yemeksepeti.com/giris-yap',
      active: false,
    });
    await new Promise((r) => setTimeout(r, 2600));

    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (em, pw, dv) => {
        try {
          const r = await fetch('/login/new/api/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json;charset=UTF-8',
              'X-FP-API-KEY': 'volo',
              'x-device': dv,
            },
            credentials: 'include',
            body: JSON.stringify({ username: em, password: pw, platform: 'b2c' })
          });
          let body = {};
          try { body = await r.json(); } catch (_) {}
          const txt = await r.text().catch(() => '');
          return { ok: true, status: r.status, body, text: txt.slice(0, 300) };
        } catch (err) {
          return { ok: false, err: String(err) };
        }
      },
      args: [email, password, device],
    });
    const out = res && res[0] && res[0].result;

    await new Promise((r) => setTimeout(r, 450));
    const readCk = (nm) => new Promise((r) =>
      chrome.cookies.get({ url: 'https://www.yemeksepeti.com/', name: nm }, (c) => r(c?.value || '')));
    const tok = await readCk('token');
    const ref = await readCk('refresh_token');
    const ndv = await readCk('device_token') || device;
    const uyU = await readCk('uy_user_id');
    try { chrome.tabs.remove(tab.id); } catch (_) {}

    if (!tok) {
      console.log('[KS YS][web-login] sekme login boş — out:', JSON.stringify(out || {}).slice(0, 260));
      return null;
    }
    const exp = ksJwtExp(tok);
    console.log('[KS YS][web-login] ✅ sekme üzerinden fresh web oturum, kalan_sn:', Math.round(exp - Date.now() / 1000));
    const nowS = Math.floor(Date.now() / 1000) + 3600;
    const mk = (name, value, httpOnly) => ({
      name, value, domain: '.yemeksepeti.com', path: '/',
      secure: true, httpOnly: !!httpOnly, sameSite: 'Lax', expirationDate: nowS,
    });
    const list = [
      mk('token', tok),
      mk('uy_token', tok),
      mk('access_token', tok),
      mk('refresh_token', ref, true),
      mk('device_token', ndv),
    ];
    if (uyU) list.push(mk('uy_user_id', uyU));
    return { ok: true, cookies: list, token: tok, refresh: ref, device: ndv };
  } catch (e) {
    console.warn('[KS YS][web-login] tab hata:', e.message);
    return null;
  }
}

async function ksWebSiteLogin(email, password, device) {
  try {
    if (!device) return null;
    try {
      await chrome.cookies.set({
        url: 'https://www.yemeksepeti.com/',
        name: 'device_token',
        value: device,
        domain: '.yemeksepeti.com',
        path: '/',
        secure: true,
        sameSite: 'lax',
      });
    } catch (_) {}
    const resp = await fetch('https://www.yemeksepeti.com/login/new/api/login', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'X-FP-API-KEY': 'volo',
        'x-device': device,
      },
      body: JSON.stringify({ username: email, password: password, platform: 'b2c' }),
      credentials: 'include',
    });
    const text = await resp.text().catch(() => '');
    let body = {};
    try { body = JSON.parse(text || '{}'); } catch (_) {}
    let tok = body.access_token || body.token || '';
    const exp = ksJwtExp(tok);
    if (!tok || exp < Date.now() / 1000) {
      console.log('[KS YS][web-login] site cevap', resp.status, '| token length', tok.length, '| exp', exp);
      return null;
    }
    await new Promise((r) => setTimeout(r, 250));
    const readCk = (nm) => new Promise((r) => chrome.cookies.get({ url: 'https://www.yemeksepeti.com/', name: nm }, (c) => r(c?.value || '')));
    const refresh = body.refresh_token || await readCk('refresh_token');
    const newDev = await readCk('device_token') || device;
    const uyUser = await readCk('uy_user_id');
    const nowS = Math.floor(Date.now() / 1000) + 3600;
    const mk = (name, value, httpOnly) => ({
      name, value, domain: '.yemeksepeti.com', path: '/',
      secure: true, httpOnly: !!httpOnly, sameSite: 'Lax', expirationDate: nowS,
    });
    const out = [
      mk('token', tok),
      mk('uy_token', tok),
      mk('access_token', tok),
      mk('refresh_token', refresh, true),
      mk('device_token', newDev),
    ];
    if (uyUser) out.push(mk('uy_user_id', uyUser));
    console.log('[KS YS][web-login] ✅ web oturum alındı (exp', new Date(exp * 1000).toISOString() + ')');
    return { ok: true, cookies: out, token: tok, refresh: refresh, device: newDev };
  } catch (e) {
    console.warn('[KS YS][web-login] hata:', e.message);
    return null;
  }
}

async function ksSyncDbWebSession(short, webTok, webRef, device) {
  try {
    const r = await fetch(
      'https://kuponstore.com/api/extension/yemeksepeti/extAuth.php',
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_web_session', token: short,
                               web_token: webTok, web_refresh: webRef, device_token: device }) }
    );
    const j = await r.json().catch(() => null);
    if (j && j.status) console.log('[KS YS][web-login] DB sync ✔');
    else console.warn('[KS YS][web-login] DB sync başarısız', j && j.message);
    return !!(j && j.status);
  } catch (e) { console.warn('[KS YS] DB sync hata:', e.message); return false; }
}

async function ksEnsureWebSession(auth) {
  try {
    const webCk = (auth.data || []).find(c => c.name === 'token')
      || (auth.data || []).find(c => c.name === 'uy_token')
      || (auth.data || []).find(c => c.name === 'volo_token');
    const tok = webCk && webCk.value || '';
    const exp = ksJwtExp(tok);
    let clientId = '';
    try {
      const p = String(tok || '').split('.')[1];
      if (p) {
        const pad = p + '='.repeat((4 - (p.length % 4)) % 4);
        clientId = String(JSON.parse(atob(pad.replace(/-/g, '+').replace(/_/g, '/'))).client_id || '');
      }
    } catch (_) {}
    // Sadece gercek Volo JWT taze ise atla — android/baska cookie ile YS ACILMAZ
    const needsWeb = clientId !== 'volo' || !tok || exp < (Date.now() / 1000) + 900;
    if (!needsWeb) {
      console.log('[KS YS] web oturum taze (volo exp', new Date(exp * 1000).toISOString() + '), site login atlanır');
      return true;
    }
    const devCk = (auth.data || []).find(c => c.name === 'device_token');
    const device = devCk && devCk.value || '';
    if (!device) { console.warn('[KS YS] device_token yok, web login atlanır'); return false; }
    const site = await ksWebSiteLoginTab(auth.email || '', auth.password || '', device);
    if (!site) return false;
    await ksSyncDbWebSession(auth.token || '', site.token, site.refresh || '', site.device);
    // auth.data çerezlerini günceller
    const names = new Set(site.cookies.map(c => c.name));
    auth.data = [ ...site.cookies.map(c => ({ name: c.name, value: c.value, domain: '.yemeksepeti.com',
                path: '/', secure: true, httpOnly: !!c.httpOnly, sameSite: 'Lax',
                expirationDate: c.expirationDate })),
    ].concat((auth.data || []).filter(c => !names.has(c.name)));
    return true;
  } catch (e) {
    console.warn('[KS YS] web oturum denemesi hata:', e.message);
    return false;
  }
}
