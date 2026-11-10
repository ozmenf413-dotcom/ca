// Bu dosya, uygulama genelinde kullanılan çeşitli yardımcı fonksiyonları içerir.

'use strict';

// Global yemekTime objesi henüz yoksa oluştur.
// inject.js yalnızca Migros sayfalarına enjekte edildiğinden Trendyol gibi diğer
// platformlarda bu obje ve proxyResponse dinleyicisi buradan kurulur.
window.yemekTime = window.yemekTime || {};

// proxyResponse dinleyicisini yalnızca bir kez kur (inject.js de aynı dinleyiciyi
// ekler; _ytProxyListenerActive bayrağı çift kayıt oluşmasını önler).
if (!window._ytProxyListenerActive) {
  window._ytProxyListenerActive = true;
  window.addEventListener('message', function(event) {
    if (event.source !== window || !event.data || event.data.source !== 'YEMEKTIME_MG_EXT_CONTENT') return;
    if (event.data.action !== 'proxyResponse') return;
    const { requestId, response } = event.data;
    if (response && !response.headers) response.headers = {};
    if (window.yemekTime && window.yemekTime.xhrCallbacks && window.yemekTime.xhrCallbacks[requestId]) {
      window.yemekTime.xhrCallbacks[requestId](response);
    }
    if (window.yemekTime && window.yemekTime.fetchCallbacks && window.yemekTime.fetchCallbacks[requestId]) {
      window.yemekTime.fetchCallbacks[requestId](response);
    }
  });
}

// UUID v4 oluşturmak için yardımcı fonksiyon
function generateUUIDv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// GM_addStyle fonksiyonunu tarayıcı eklentisi için tanımla
function GM_addStyle(css) {
  try {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
      return style;
  } catch (error) {
      console.error('CSS ekleme hatası:', error);
      return false
  }
}

// Hangi serviste olduğumuzu tespit eden fonksiyon
function detectService() {
    const mainElement = document.querySelector('main');
    if (!mainElement) return null;

    const classList = mainElement.classList;
    if (classList.contains('yemek')) return 'yemek';
    if (classList.contains('hemen')) return 'hemen';
    return 'sanalmarket';
}

// Servis tipine göre API URL'sini oluşturan fonksiyon
function getApiBaseUrl(service) {
    switch(service) {
        case 'yemek': return '/rest/yemek';
        case 'hemen': return '/rest/hemen';
        default: return '/rest'; // Sanalmarket için
    }
}

function generateDeviceIdentifier() {
  const hexChars = '0123456789abcdef';
  let identifier = '';
  for (let i = 0; i < 16; i++) {
    identifier += hexChars[Math.floor(Math.random() * hexChars.length)];
  }
  return identifier;
}

// Generate device identifier for YS
function generateYSDeviceInfo() {
  // Try to get from localStorage first
  let deviceInfo = null;
  try {
    const stored = localStorage.getItem('ys_device_info');
    if (stored) {
      deviceInfo = JSON.parse(stored);
    }
  } catch (e) {
    console.warn('Could not load device info from localStorage');
  }

  if (!deviceInfo) {
    // Generate new device info
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
    
    // Generate device ID
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

    // Save to localStorage
    try {
      localStorage.setItem('ys_device_info', JSON.stringify(deviceInfo));
    } catch (e) {
      console.warn('Could not save device info to localStorage');
    }
  }

  return deviceInfo;
}

// Generate YS headers with R-Sig
function generateYSHeaders(url = '', method = 'POST', body = '') {
  const device = generateYSDeviceInfo();
  
  function makeid(length) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  }

  // Rastgele Eks değeri üret
  function generateRandomEks() {
    const parts = ["abc", "aaa", "cvc", "cbc", "csc", "asd", "amg", "aq3", "mnp", "gig"];
    return parts[Math.floor(Math.random() * parts.length)] + parts[Math.floor(Math.random() * parts.length)];
  }

  // Rastgele hex değer üret
  function generateRandomHex(length) {
    const hexChars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += hexChars.charAt(Math.floor(Math.random() * 16));
    }
    return result;
  }

  // JWT token'dan user_id çıkar
  function getUserIdFromToken(token) {
    try {
      if (!token || token === "null") return "";
      const parts = token.split('.');
      if (parts.length !== 3) return "";
      const payload = atob(parts[1]);
      const decoded = JSON.parse(payload);
      return decoded?.user_id || "";
    } catch (error) {
      return "";
    }
  }

  // Access token: android JWT tercih (cookie: access_token / android_token / uy_token / token)
  let accessToken = "";
  try {
    function jwtClientId(tok) {
      try {
        const p = String(tok || '').split('.')[1];
        if (!p) return '';
        const pad = p + '='.repeat((4 - (p.length % 4)) % 4);
        return String(JSON.parse(atob(pad.replace(/-/g, '+').replace(/_/g, '/'))).client_id || '');
      } catch (_) { return ''; }
    }
    function cookieVal(name) {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    }
    for (const name of ['access_token', 'android_token', 'uy_token', 'token']) {
      const v = cookieVal(name);
      if (v && jwtClientId(v) === 'android') { accessToken = v; break; }
    }
    if (!accessToken) accessToken = cookieVal('access_token') || '';
  } catch (e) {
    console.warn('Access token alınamadı:', e);
  }

  const custCode = getUserIdFromToken(accessToken);
  const eksValue = generateRandomEks();
  const adjustAdId = generateRandomHex(32);
  const widevineId = device.deviceId || generateRandomHex(16);

  console.log('🎲 YS Headers Üretiliyor:', {
    url: url || '(URL yok)',
    method: method,
    device: {
      manufacturer: device.manufacturer,
      model: device.model,
      deviceId: device.deviceId.substring(0, 8) + '...'
    },
    custCode: custCode || '(boş)',
    eksValue: eksValue,
    adjustAdId: adjustAdId.substring(0, 16) + '...',
    widevineId: widevineId.substring(0, 8) + '...'
  });

  // Temel header'lar
  const headers = {
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
    "Cust-Code": custCode,
    "Eks": eksValue,
    "Sentry-Trace": "00000000000000000000000000000000-0000000000000000-0",
    "Em-Request-Identifier": generateUUIDv4(),
    "X-Px-Bypass-Reason": "Invalid SDK initialization",
    "X-Px-Authorization": "4",
    "Adjust-Ad-Id": adjustAdId,
    "X-Fp-Api-Key": "android",
    "X-Pd-Language-Id": "2",
    "X-Reorder-Origin": "",
    "Content-Type": "application/json; charset=UTF-8",
  };

  // R-Sig üretimi (eğer URL verilmişse)
  if (url && typeof window.generateYemeksepetiRSig === 'function') {
    try {
      console.log('🔐 R-Sig Üretimi İçin Request Data:', {
        url: url.substring(0, 50) + '...',
        method: method,
        eks: eksValue,
        bodyLength: body ? body.length : 0,
        build: device.buildNumber,
        version: device.appVersion,
        custCode: custCode || ''
      });

      // timestamp ve random değerlerini göndermiyoruz, generateSecurityHeaders kendi oluşturacak
      const requestData = {
        url: url,
        method: method,
        eks: eksValue,
        body: body,
        build: device.buildNumber,
        version: device.appVersion,
        custCode: custCode
      };

      const sigResult = window.generateYemeksepetiRSig(requestData);
      
      if (sigResult && sigResult.success) {
        const rSig = sigResult['R-Sig'] || sigResult.signature;
        headers['R-Sig'] = rSig;
        headers['Rts'] = sigResult.Rts;
        headers['Ruid'] = sigResult.Ruid;
        console.log('✅ R-Sig Helpers\'dan Başarıyla Eklendi:', {
          'R-Sig': rSig?.substring(0, 20) + '...',
          'Rts': sigResult.Rts,
          'Ruid': sigResult.Ruid?.substring(0, 10) + '...',
          'Eks': eksValue
        });
      } else {
        console.error('❌ R-Sig üretilemedi:', sigResult ? sigResult.error : 'Bilinmeyen hata');
      }
    } catch (error) {
      console.error('❌ R-Sig üretimi sırasında hata:', error);
    }
  } else {
    console.warn('⚠️ R-Sig üretilemiyor:', {
      hasUrl: !!url,
      hasGenerateFunction: typeof window.generateYemeksepetiRSig === 'function'
    });
  }

  return headers;
}

// Generate device identifier for Trendyol
function generateTyDeviceInfo() {
  let deviceInfo = null;
  try {
    const stored = localStorage.getItem('ty_device_info');
    if (stored) {
      deviceInfo = JSON.parse(stored);
    }
  } catch (e) {
    console.warn('Could not load TY device info from localStorage');
  }

  if (!deviceInfo) {
    deviceInfo = {
      deviceId: generateUUIDv4(),
      uniqueId: generateDeviceIdentifier(),
      sessionId: generateUUIDv4(),
      processId: generateUUIDv4(),
      tpaydid: generateUUIDv4(),
      buildVersion: '1.45.4.164'
    };

    try {
      localStorage.setItem('ty_device_info', JSON.stringify(deviceInfo));
    } catch (e) {
      console.warn('Could not save TY device info to localStorage');
    }
  }

  return deviceInfo;
}

// Generate Trendyol segments
function generateTySegments() {
  const segments = [
    '410750033_generic_6',
    '410750050_1_6',
    '278500001_1753975821420',
    '278500001_1764162914545',
    '278500001_1764163821920',
    '410750032_coupon_6',
    '278500001_1709048753408',
    '410750284_a101lansmanhl_6',
    '410750721_meal_nursery__01-2026__01-2026',
    '410750284_150tlmarkethl_6',
    '278500001_a101all',
    '410750245_grpceryyilbasi_6'
  ];
  return segments.join(',');
}

// Generate Trendyol headers with device signals
function generateTyHeaders(accessToken) {
  const device = generateTyDeviceInfo();
  
  // Generate device signals using the provided code
  const { payload, signature } = window.generateTyDeviceSignals ? 
    window.generateTyDeviceSignals({ version: device.buildVersion }) : 
    { payload: '', signature: '' };
  
  const headers = {
    'Host': 'api.tgoapis.com',
    'Deviceid': device.deviceId,
    'Bff-Token-Validation': 'true',
    'X-Features': 'OPTIONAL_REBATE;TRENDYOLPAY_ENABLED;MEAL_CART_ENABLED;MEAL_CARD_TRENDYOL_PROMOTION;DELIVERY_FEE_SUMMARY_HIDDEN',
    'X-Application-Id': '5',
    'Cl_eligible': 'false',
    'Sid': device.sessionId,
    'Pid': device.processId,
    'Build': device.buildVersion,
    'Platform': 'Android',
    'Device-Language': 'tr',
    'Osversion': '9',
    'Isemulator': 'false',
    'X-Channelid': '4',
    'X-Device-Signals-Payload': payload,
    'X-Device-Signals-Signature': signature,
    'Uniqueid': device.uniqueId,
    'Tpaydid': device.tpaydid,
    'Accept-Language': 'tr-TR',
    'X-Storefront-Id': '1',
    'Searchsegment': '20',
    'Gender': Math.random() > 0.5 ? 'F' : 'M',
    'X-Visitor-Type': '4',
    'Segments': generateTySegments(),
    'App-Name': 'TrendyolGo',
    'Lc-Member': 'true',
    'User-Agent': `Dalvik/2.1.0 (Linux; U; Android 9; 2203121C Build/PQ3A.190605.09201023) TrendyolGo/${device.buildVersion}`,
    'Authorization': `bearer ${accessToken}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'Accept-Encoding': 'gzip, deflate, br'
  };

  console.log('🎲 TY Headers Üretildi:', {
    deviceId: device.deviceId.substring(0, 8) + '...',
    hasSignature: !!signature,
    hasPayload: !!payload
  });

  return headers;
}

// Proxy isteğini gönderen ve yanıtı işleyen merkezi fonksiyon
function sendProxyRequest(requestDetails, timeoutMs) {
  const _timeout = timeoutMs != null ? timeoutMs : 15000;
  return new Promise((resolve, reject) => {
    const requestId = Date.now() + Math.random().toString().substring(2, 8);
    let _settled = false;

    window.yemekTime.fetchCallbacks = window.yemekTime.fetchCallbacks || {};

    const _timer = setTimeout(() => {
      if (_settled) return;
      _settled = true;
      delete window.yemekTime.fetchCallbacks[requestId];
      reject(new Error(`Proxy timeout (${requestDetails.action})`));
    }, _timeout);

    window.yemekTime.fetchCallbacks[requestId] = (response) => {
      if (_settled) return;
      _settled = true;
      clearTimeout(_timer);
      delete window.yemekTime.fetchCallbacks[requestId];
      if (response && response.success) {
        resolve(response);
      } else {
        console.error(`Proxy hatası (${requestDetails.action}):`, response ? response.error : 'Bilinmeyen hata');
        reject(new Error(response ? response.error : 'Proxy request failed'));
      }
    };

    window.postMessage({
      source: 'YEMEKTIME_MG_EXT',
      ...requestDetails,
      requestId: requestId,
    }, '*');
  });
}
