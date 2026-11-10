// ====================================
// YEMEKSEPETI: Mevcut UA override
// ====================================
(function() {
    if (!window.location.hostname.includes('yemeksepeti.com')) return;
    try {
        const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
        const script = document.createElement('script');
        script.textContent = `
            (function() {
                var ua = '${desktopUA}';
                Object.defineProperty(navigator, 'userAgent', { get: function() { return ua; } });
                Object.defineProperty(navigator, 'appVersion', { get: function() { return '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'; } });
                Object.defineProperty(navigator, 'platform', { get: function() { return 'Win32'; } });
                Object.defineProperty(navigator, 'vendor', { get: function() { return 'Google Inc.'; } });
                Object.defineProperty(navigator, 'maxTouchPoints', { get: function() { return 0; } });
                Object.defineProperty(navigator, 'userAgentData', { get: function() {
                    return {
                        brands: [
                            { brand: 'Google Chrome', version: '145' },
                            { brand: 'Chromium', version: '145' },
                            { brand: 'Not_A Brand', version: '24' }
                        ],
                        mobile: false,
                        platform: 'Windows',
                        getHighEntropyValues: function() {
                            return Promise.resolve({
                                architecture: 'x86',
                                bitness: '64',
                                model: '',
                                platform: 'Windows',
                                platformVersion: '10.0.0',
                                fullVersionList: [
                                    { brand: 'Google Chrome', version: '145.0.0.0' },
                                    { brand: 'Chromium', version: '145.0.0.0' }
                                ],
                                mobile: false
                            });
                        }
                    };
                }});
                Object.defineProperty(screen, 'width', { get: function() { return 1920; } });
                Object.defineProperty(screen, 'height', { get: function() { return 1080; } });
                Object.defineProperty(screen, 'availWidth', { get: function() { return 1920; } });
                Object.defineProperty(screen, 'availHeight', { get: function() { return 1040; } });
                if (window.matchMedia) {
                    var origMatchMedia = window.matchMedia;
                    window.matchMedia = function(query) {
                        if (query.includes('max-width') || query.includes('max-device-width')) {
                            var match = query.match(/max-(?:device-)?width\\s*:\\s*(\\d+)/);
                            if (match && parseInt(match[1]) < 1024) {
                                return { matches: false, media: query, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return true; } };
                            }
                        }
                        if (query.includes('pointer: coarse') || query.includes('hover: none')) {
                            return { matches: false, media: query, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return true; } };
                        }
                        return origMatchMedia.call(window, query);
                    };
                }
            })();
        `;
        (document.head || document.documentElement).prepend(script);
        script.remove();
    } catch(e) {
        console.warn('Desktop UA override hatasi:', e);
    }
})();

(function() {
    if (!window.location.hostname.includes('yemeksepeti.com')) return;
    try {
        chrome.storage.local.get('_needReload', function(data) {
            if (data._needReload) {
                chrome.storage.local.remove('_needReload');
                const doReload = function() {
                    setTimeout(function() { window.location.reload(); }, 1500);
                };
                if (document.readyState === 'complete') {
                    doReload();
                } else {
                    window.addEventListener('load', doReload);
                }
            }
        });
    } catch(e) {}
})();

function extractCoordinateFromAddress(address) {
    if (!address) return null;

    if (address.latitude && address.longitude) {
        return { lat: parseFloat(address.latitude), lng: parseFloat(address.longitude) };
    }

    if (address.lat && address.lng) {
        return { lat: parseFloat(address.lat), lng: parseFloat(address.lng) };
    }

    if (address.coordinates && typeof address.coordinates.lat === 'number' && typeof address.coordinates.lng === 'number') {
        return { lat: address.coordinates.lat, lng: address.coordinates.lng };
    }

    return null;
}

function saveLastUsedLocation(coordinates) {
    if (!coordinates || typeof coordinates.lat !== 'number' || typeof coordinates.lng !== 'number') {
        chrome.storage.local.remove('ys_last_successful_location');
        return;
    }

    const payload = {
        lat: coordinates.lat,
        lng: coordinates.lng,
        savedAt: Date.now()
    };

    chrome.storage.local.set({ 'ys_last_successful_location': payload });
}

function ensureLocationModelState(callback) {
    if (typeof callback !== 'function') {
        return;
    }

    try {
        const localCart = localStorage.getItem('cart');
        const hasLocationModel = !!localStorage.getItem('location-model-1');

        if (localCart && hasLocationModel) {
            callback();
            return;
        }

        chrome.storage.sync.get(['yemekhub_session'], function(result) {
            const sessionData = result?.yemekhub_session;
            const serializedCart = sessionData?.defaultCartData || sessionData?.activeCartData || null;

            if (serializedCart) {
                localStorage.setItem('cart', serializedCart);
            }

            if (!hasLocationModel) {
                const coordinates = extractCoordinateFromAddress(sessionData?.selectedAddress);
                if (coordinates) {

                    const locationPayload = buildLocationModelPayload(coordinates, sessionData?.selectedAddress, true);
                    if (locationPayload) {
                        localStorage.setItem('location-model-1', JSON.stringify(locationPayload));
                        console.log('📍 ensureLocationModelState - Boşluklu adres kaydedildi:', locationPayload.formatted_customer_address);
                    }
                }
            }

            callback();
        });
    } catch (error) {
        console.warn('ensureLocationModelState error:', error);
        callback();
    }
}
let HBY_SessionData = {
   isLogged: false,
   cookies: [],
   expiry: 0,
   token: '',
   isCookieInserted: false
};

let HBY_Scripts = [];

let processedSessionId = null;

let addressAddingInProgress = false;
let addressAlreadyAdded = false;

function createBlockingOverlay(message = 'İşlem devam ediyor...') {

   let overlay = document.getElementById('hby-blocking-overlay');
   if (overlay) {
       const messageEl = overlay.querySelector('.hby-overlay-message');
       if (messageEl) {
           messageEl.textContent = message;
       }
       return overlay;
   }

overlay = document.createElement('div');
   overlay.id = 'hby-blocking-overlay';
   overlay.style.cssText = `
       position: fixed;
       top: 0;
       left: 0;
       width: 100%;
       height: 100%;
       background: rgba(0, 0, 0, 0.9);
       z-index: 999999999;
       display: flex;
       flex-direction: column;
       justify-content: center;
       align-items: center;
       color: white;
       font-family: Arial, sans-serif;
       cursor: not-allowed;
       user-select: none;
       -webkit-user-select: none;
       -moz-user-select: none;
       -ms-user-select: none;
   `;

const content = document.createElement('div');
   content.style.cssText = `
       text-align: center;
       max-width: 400px;
       padding: 20px;
   `;

const messageEl = document.createElement('h2');
   messageEl.className = 'hby-overlay-message';
   messageEl.style.cssText = `
       margin-bottom: 20px;
       font-size: 24px;
       font-weight: normal;
   `;
   messageEl.textContent = message;

const spinner = document.createElement('div');
   spinner.style.cssText = `
       width: 50px;
       height: 50px;
       border: 4px solid rgba(255, 255, 255, 0.3);
       border-top: 4px solid white;
       border-radius: 50%;
       animation: hby-spin 1s linear infinite;
       margin: 0 auto 20px;
   `;

const subMessage = document.createElement('p');
   subMessage.style.cssText = `
       font-size: 14px;
       opacity: 0.8;
       margin: 0;
   `;
   subMessage.textContent = 'Lütfen bekleyin, sayfa ile etkileşime geçmeyin...';

content.appendChild(messageEl);
   content.appendChild(spinner);
   content.appendChild(subMessage);
   overlay.appendChild(content);

if (!document.getElementById('hby-overlay-styles')) {
       const style = document.createElement('style');
       style.id = 'hby-overlay-styles';
       style.textContent = `
           @keyframes hby-spin {
               0% { transform: rotate(0deg); }
               100% { transform: rotate(360deg); }
           }

           /* Overlay varken scroll'u engelle */
           body.hby-no-scroll {
               overflow: hidden !important;
               position: fixed !important;
               width: 100% !important;
           }
       `;
       document.head.appendChild(style);
   }

document.body.classList.add('hby-no-scroll');

document.body.appendChild(overlay);

overlay.addEventListener('click', (e) => {
       e.preventDefault();
       e.stopPropagation();
       return false;
   });

overlay.addEventListener('contextmenu', (e) => {
       e.preventDefault();
       return false;
   });

   return overlay;
}

function removeBlockingOverlay() {
   const overlay = document.getElementById('hby-blocking-overlay');
   if (overlay) {
       overlay.remove();
       document.body.classList.remove('hby-no-scroll');
   }
}

function updateOverlayMessage(message) {
   const overlay = document.getElementById('hby-blocking-overlay');
   if (overlay) {
       const messageEl = overlay.querySelector('.hby-overlay-message');
       if (messageEl) {
           messageEl.textContent = message;
       }
   }
}

function addRandomBlankSpaces(text, enableRandomSpaces = true) {
   if (!text || !enableRandomSpaces) return text;

   const unicodeBlank = "⠀ ";
   let spacesAdded = 0;
   const maxSpaces = 2;

let words = text.split(' ');

if (words.length === 1) {
       const position = Math.floor(Math.random() * 3);

       if ((position === 0 || position === 2) && spacesAdded < maxSpaces) {
           words[0] = unicodeBlank + words[0];
           spacesAdded++;
       }

       if ((position === 1 || position === 2) && spacesAdded < maxSpaces) {
           words[0] = words[0] + " ⠀";
           spacesAdded++;
       }

       return words[0];
   }

let result = "";
   for (let i = 0; i < words.length; i++) {
       result += words[i];

       if (i < words.length - 1 && spacesAdded < maxSpaces) {

           result += unicodeBlank;
           spacesAdded++;
       }
   }

if (Math.random() < 0.3 && spacesAdded < maxSpaces) {
       result = unicodeBlank + result;
       spacesAdded++;
   }

if (Math.random() < 0.3 && spacesAdded < maxSpaces) {
       result = result + " ⠀";
       spacesAdded++;
   }

   return result;
}

function randomizeCoordinates(latitude, longitude, radiusInMeters = 5) {

   const lat = parseFloat(latitude);
   const lng = parseFloat(longitude);

const radiusInKm = radiusInMeters / 1000;

const angle = Math.random() * 2 * Math.PI;

const distance = Math.random() * radiusInKm;

const earthRadius = 6371;

const deltaLat = (distance / earthRadius) * Math.cos(angle);
   const deltaLng = (distance / earthRadius) * Math.sin(angle) / Math.cos(lat * Math.PI / 180);

   const newLat = lat + (deltaLat * 180 / Math.PI);
   const newLng = lng + (deltaLng * 180 / Math.PI);

   return {
       latitude: newLat,
       longitude: newLng
   };
}

function processAddressData(addressBody) {

   const useRandomSpaces = false;

const processedNeighborhood = addRandomBlankSpaces(addressBody.areas || addressBody.neighborhood || "", useRandomSpaces);
   const processedStreet = addRandomBlankSpaces(addressBody.street || addressBody.address_line1 || "", useRandomSpaces);

let processedBuilding = addressBody.building || addressBody.address_line2 || "";
   if (useRandomSpaces && processedBuilding) {
       const unicodeBlank = " ";
       const buildingSpaces = Math.floor(Math.random() * 2) + 1;
       let spacesToAdd = "";
       for (let i = 0; i < buildingSpaces; i++) {
           spacesToAdd += unicodeBlank;
       }

       processedBuilding = processedBuilding + spacesToAdd + "⠀";
   }

let processedFloor = addressBody.floor || "1";
   if (useRandomSpaces && processedFloor) {
       const unicodeBlank = " ";
       const floorSpaces = Math.floor(Math.random() * 2) + 1;
       let spacesToAdd = "";
       for (let i = 0; i < floorSpaces; i++) {
           spacesToAdd += unicodeBlank;
       }

       processedFloor = processedFloor + spacesToAdd + "⠀";
   }

let processedApartment = addressBody.entrance || addressBody.apartment || "1";
   if (useRandomSpaces && processedApartment) {
       const unicodeBlank = " ";
       const apartmentSpaces = Math.floor(Math.random() * 2) + 1;
       let spacesToAdd = "";
       for (let i = 0; i < apartmentSpaces; i++) {
           spacesToAdd += unicodeBlank;
       }

       processedApartment = processedApartment + spacesToAdd + "⠀";
   }

return {
       ...addressBody,
       areas: processedNeighborhood,
       address_line1: processedStreet,
       address_line2: processedBuilding,
       address_line3: processedNeighborhood,
       building: processedBuilding,
       entrance: processedApartment,
       floor: processedFloor,
       street: processedStreet,
       formatted_customer_address: `${processedNeighborhood}, ${processedStreet}, ${processedBuilding}, ${addressBody.address_line4 || addressBody.city || ''}`
   };
}

const LAST_LOCATION_STORAGE_KEY = 'ys_last_successful_location';
const LAST_CART_STORAGE_KEY = 'ys_last_cart_snapshot';

function isValidCoordinate(candidate) {
    return candidate && !Number.isNaN(candidate.lat) && !Number.isNaN(candidate.lng) && isFinite(candidate.lat) && isFinite(candidate.lng);
}

function normalizeCoordinate(value) {
    if (!value) return null;

    if (typeof value.lat === 'number' && typeof value.lng === 'number') {
        return { lat: value.lat, lng: value.lng };
    }

    if (typeof value.latitude === 'number' && typeof value.longitude === 'number') {
        return { lat: value.latitude, lng: value.longitude };
    }

    if (value.lat && value.lng) {
        const lat = parseFloat(value.lat);
        const lng = parseFloat(value.lng);
        return isFinite(lat) && isFinite(lng) ? { lat, lng } : null;
    }

    if (value.latitude && value.longitude) {
        const lat = parseFloat(value.latitude);
        const lng = parseFloat(value.longitude);
        return isFinite(lat) && isFinite(lng) ? { lat, lng } : null;
    }

    return null;
}

function extractCoordinateFromAddress(address) {
    if (!address) return null;

    const coordinateFields = [
        { lat: address.latitude, lng: address.longitude },
        { lat: address.lat, lng: address.lng },
        address.coordinate,
        address.coordinates,
        address.location,
        address.address_details?.coordinate,
        address.delivery_address?.coordinate
    ];

    for (const candidate of coordinateFields) {
        const normalized = normalizeCoordinate(candidate);
        if (isValidCoordinate(normalized)) {
            return normalized;
        }
    }

    return null;
}

function saveLastUsedLocation(coordinates) {
    if (!isValidCoordinate(coordinates)) {
        chrome.storage.local.remove(LAST_LOCATION_STORAGE_KEY);
        return;
    }

    const payload = {
        lat: coordinates.lat,
        lng: coordinates.lng,
        savedAt: Date.now()
    };

    try {
        chrome.storage.local.set({ [LAST_LOCATION_STORAGE_KEY]: payload });
    } catch (error) {
        console.warn('saveLastUsedLocation error:', error);
    }
}

function buildLocationModelPayload(coordinates, selectedAddress, useProcessedAddress = false) {
    if (!isValidCoordinate(coordinates)) {
        return null;
    }

    let formatted = selectedAddress?.formatted_customer_address ||
        selectedAddress?.address ||
        selectedAddress?.fullAddress ||
        '';

if (useProcessedAddress && selectedAddress) {

        const processedData = processAddressData({
            areas: selectedAddress.areas || selectedAddress.neighborhood || '',
            address_line1: selectedAddress.address_line1 || selectedAddress.street || '',
            address_line2: selectedAddress.address_line2 || selectedAddress.building || '',
            address_line4: selectedAddress.address_line4 || selectedAddress.city || '',
            building: selectedAddress.building || '',
            entrance: selectedAddress.entrance || selectedAddress.apartment || '',
            floor: selectedAddress.floor || '',
            street: selectedAddress.street || '',
            latitude: coordinates.lat,
            longitude: coordinates.lng
        });

formatted = processedData.formatted_customer_address || formatted;
    }

    return {
        id: `ext_${Date.now()}`,
        formatted_customer_address: formatted,
        address: formatted,
        city: selectedAddress?.city || selectedAddress?.province || '',
        district: selectedAddress?.district || '',
        latitude: coordinates.lat,
        longitude: coordinates.lng,
        coordinate: {
            lat: coordinates.lat,
            lng: coordinates.lng
        },
        updatedAt: new Date().toISOString(),
        source: 'extension'
    };
}

function ensureCartState(sessionData, storedCartData) {
    try {
        const cartCandidates = [];

        if (typeof sessionData?.defaultCartData === 'string') cartCandidates.push(sessionData.defaultCartData);
        if (typeof sessionData?.activeCartData === 'string') cartCandidates.push(sessionData.activeCartData);
        if (typeof sessionData?.defaultCart === 'string') cartCandidates.push(sessionData.defaultCart);
        if (typeof sessionData?.defaultCart?.data === 'string') cartCandidates.push(sessionData.defaultCart.data);
        if (typeof sessionData?.selectedCart?.data === 'string') cartCandidates.push(sessionData.selectedCart.data);
        if (typeof storedCartData === 'string') cartCandidates.push(storedCartData);

        const cartString = cartCandidates.find(str => typeof str === 'string' && str.trim().length > 0);

        if (cartString) {
            localStorage.setItem('cart', cartString);
            chrome.storage.local.set({ [LAST_CART_STORAGE_KEY]: cartString });
        }
    } catch (error) {
        console.warn('ensureCartState error:', error);
    }
}

function setLocationModel(coordinates, selectedAddress, useProcessedAddress = true) {
    const payload = buildLocationModelPayload(coordinates, selectedAddress, useProcessedAddress);
    if (!payload) return;

    try {
        localStorage.setItem('location-model-1', JSON.stringify(payload));
        console.log('📍 Location model güncellendi:', payload.formatted_customer_address);
    } catch (error) {
        console.warn('setLocationModel error:', error);
    }
}

function triggerPostAddressRedirect(sessionData, providedCoordinates) {
    const provided = normalizeCoordinate(providedCoordinates);
    const addressCoordinate = extractCoordinateFromAddress(sessionData?.selectedAddress);
    const lastUsed = normalizeCoordinate(sessionData?.lastUsedCoordinates);

    chrome.storage.local.get([LAST_LOCATION_STORAGE_KEY, LAST_CART_STORAGE_KEY], (storageResult = {}) => {
        const storedCoordinate = normalizeCoordinate(storageResult[LAST_LOCATION_STORAGE_KEY]);

        const coordinateCandidates = [provided, addressCoordinate, lastUsed, storedCoordinate].filter(isValidCoordinate);
        const finalCoordinate = coordinateCandidates.find(Boolean);

        if (!finalCoordinate) {
            console.log('🌐 Content Script - Koordinat bulunamadı, ana sayfaya yönlendiriliyor');
            window.location.href = 'https://www.yemeksepeti.com/';
            return;
        }

        ensureCartState(sessionData, storageResult[LAST_CART_STORAGE_KEY]);
        setLocationModel(finalCoordinate, sessionData?.selectedAddress, true);
        saveLastUsedLocation(finalCoordinate);

const token = sessionData?.token || '';
        const isMrbToken = token && token.startsWith('MRB-');
        const isDyToken = token && token.startsWith('DY-');
        const isOnCampaignsPage = window.location.href.includes('/campaigns');

        if (isMrbToken && isOnCampaignsPage) {

            console.log('🎯 MRB Token - Campaigns sayfasında kalınıyor, yönlendirme yapılmadı');

            return;
        }

        if (isDyToken && isOnCampaignsPage) {

            console.log('🎯 DY Token - Campaigns sayfasında kalınıyor, yönlendirme yapılmadı');

            return;
        }

const targetUrl = `https://www.yemeksepeti.com/restaurants/new/?lat=${finalCoordinate.lat}&lng=${finalCoordinate.lng}&vertical=restaurants`;
        console.log('📍 Content Script - Otomatik yönlendirme:', targetUrl);
        chrome.storage.local.set({ '_needReload': true }, function() {
            window.location.href = targetUrl;
        });
    });
}

function isYsProxyEndpoint(url) {
 // Rakip endpoints.js: calculate + checkout + vouchers (android)
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

function injectScript(file) {
 var script = document.createElement('script');
 script.setAttribute('type', 'text/javascript');
 script.setAttribute('src', chrome.runtime.getURL(file));
 document.documentElement.appendChild(script);
}

function performSmartRedirectFromContentScript() {
    chrome.storage.sync.get(['yemekhub_session'], function(result) {
        const sessionData = result?.yemekhub_session;

        if (!sessionData) {
            console.log('🌐 Content Script - Session yok, varsayılan yönlendirme');
            window.location.href = 'https://www.yemeksepeti.com/';
            return;
        }

        const coordinates = extractCoordinateFromAddress(sessionData.selectedAddress);
        triggerPostAddressRedirect(sessionData, coordinates);
    });
}

// ============================================================
// YEMEKTIME: EKLENTİ PASİFE ALINDIĞINDA OTURUM GÜVENLİK KİLİDİ
// ------------------------------------------------------------
// Amaç: Kullanıcı eklentiyi devre dışı bıraktığında (chrome://extensions
// üzerinden kapatma / kaldırma / güncelleme) yemeksepeti oturumunu kapatmak,
// çerezleri temizlemek ve hesabın eklentisiz kullanılmasını/kurcalanmasını
// engellemek.
//
// ÖNEMLİ (MV3 kısıtı): Eklenti pasife alındığında background service worker
// ANINDA ölür ve kendi "devre dışı bırakıldım" olayını yakalayamaz. O anda
// çalışmaya devam eden TEK kod, sayfaya önceden enjekte edilmiş bu content
// script'tir. Ancak content script de "orphan" (öksüz) hale gelir:
//   - chrome.* API'leri KAYBOLUR (chrome.runtime.id okumak hata fırlatır)
//   - document.cookie / localStorage / sessionStorage / location ÇALIŞMAYA
//     DEVAM EDER.
// Bu yüzden temizlik burada, chrome.* HİÇ KULLANILMADAN yapılır.
//
// NOT: Bu eklentide yemeksepeti oturum çerezleri (access_token, refresh_token,
// device_token, token, _pxvid, _pxhd ...) "httpOnly: false" ile set edildiği
// için JS'ten (document.cookie) DOĞRUDAN silinebilirler. Bu yüzden SUNUCU
// TARAFI /logout ÇAĞRILMAZ — böylece sunucudaki oturum/token GEÇERSİZ KILINMAZ
// (token yeniden kullanılabilir kalır). Sadece bu tarayıcıdaki çerezler silinir
// ve sayfa yeniden yüklenerek bellekteki oturum düşürülür (çıkış yapılmadan).
// ============================================================
(function ysExtensionKillSwitch() {
  var host = (window.location.hostname || '').toLowerCase();
  // Sadece yemeksepeti alan adında çalışsın (fd-api/deliveryhero API domainleri hariç)
  if (host.indexOf('yemeksepeti.com') === -1) return;

  // Çerezler silindikten sonra gidilecek nötr sayfa. /logout DEĞİL (çıkış yapmaz).
  var HOME_URL = 'https://www.yemeksepeti.com/';
  var deadStreak = 0;
  var triggered = false;
  var timer = null;

  // Eklenti hâlâ canlı (aktif) mı? Pasife alınınca chrome.runtime geçersiz olur.
  // Not: Service worker sadece "idle" (boşta) iken chrome.runtime.id GEÇERLİ
  // kalır; yalnızca eklenti gerçekten devre dışı/kaldırıldı/güncellendiğinde
  // geçersiz olur. Bu yüzden bu kontrol "idle" ile "pasif" ayrımını doğru yapar.
  function extAlive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false; // "Extension context invalidated"
    }
  }

  // JS ile erişilebilen (HttpOnly OLMAYAN) tüm çerezleri + local/session storage temizle
  function clearClientStorage() {
    try { window.localStorage.clear(); } catch (e) {}
    try { window.sessionStorage.clear(); } catch (e) {}
    try {
      var hostname = window.location.hostname;      // ör: www.yemeksepeti.com
      var domains = [hostname, '.' + hostname];
      var parts = hostname.split('.');
      if (parts.length > 2) {                        // üst alan: .yemeksepeti.com
        var parent = parts.slice(parts.length - 2).join('.');
        domains.push(parent, '.' + parent);
      }
      var past = 'Thu, 01 Jan 1970 00:00:00 GMT';
      var cookies = document.cookie ? document.cookie.split(';') : [];
      for (var i = 0; i < cookies.length; i++) {
        var eq = cookies[i].indexOf('=');
        var name = (eq > -1 ? cookies[i].substr(0, eq) : cookies[i]).trim();
        if (!name) continue;
        document.cookie = name + '=; expires=' + past + '; path=/;';
        for (var d = 0; d < domains.length; d++) {
          document.cookie = name + '=; expires=' + past + '; path=/; domain=' + domains[d] + ';';
          document.cookie = name + '=; expires=' + past + '; path=/; domain=' + domains[d] + '; Secure; SameSite=None';
        }
      }
    } catch (e) {}
  }

  // Sayfayı tamamen kaplayan, etkileşimi engelleyen bilgilendirme katmanı
  function showLockOverlay() {
    try {
      if (document.getElementById('ys-ext-kill-overlay')) return;
      var ov = document.createElement('div');
      ov.id = 'ys-ext-kill-overlay';
      ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;' +
        'background:rgba(8,8,8,0.97);z-index:2147483647;display:flex;flex-direction:column;' +
        'align-items:center;justify-content:center;color:#fff;text-align:center;padding:24px;' +
        'font-family:Arial,Helvetica,sans-serif;cursor:not-allowed;';
      ov.innerHTML =
        '<div style="max-width:460px;">' +
        '<div style="font-size:46px;margin-bottom:16px;">🔒</div>' +
        '<h2 style="font-size:24px;margin:0 0 12px;font-weight:700;">Eklenti pasife alındı</h2>' +
        '<p style="font-size:16px;line-height:1.6;opacity:.9;margin:0;">Güvenliğiniz için oturum ' +
        'kapatılıyor ve çerezler temizleniyor...</p></div>';
      (document.body || document.documentElement).appendChild(ov);
      ov.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
      ov.addEventListener('contextmenu', function (e) { e.preventDefault(); }, true);
    } catch (e) {}
  }

  // Oturumu kapat: overlay + çerezleri DOĞRUDAN sil + ana sayfaya yeniden yükle.
  // Çıkış (logout) YAPILMAZ; sunucudaki oturum/token bozulmaz.
  function killSession() {
    if (triggered) return;
    triggered = true;
    if (timer) { try { clearInterval(timer); } catch (e) {} }
    showLockOverlay();
    clearClientStorage();               // access_token vb. çerezleri sil (httpOnly:false → silinebilir)
    // Çerezleri sildikten sonra sayfayı nötr ana sayfaya yükle ki bellekteki
    // oturum da düşsün ve site "çıkış yapılmış" gibi görünsün. /logout'a GİTMEYİZ.
    try { window.location.replace(HOME_URL); }
    catch (e) { try { window.location.href = HOME_URL; } catch (e2) {} }
  }

  // Kullanıcı sekmeye döndüğünde / etkileşime geçtiğinde ANINDA kontrol et.
  // (Arka plan sekmelerinde setInterval kısıtlanabildiği için bu şart.)
  function checkNow() {
    if (triggered) return;
    if (!extAlive()) killSession();
  }

  // Periyodik kontrol: üst üste 2 kez "ölü" okunursa kesin pasif kabul et.
  timer = setInterval(function () {
    if (triggered) return;
    if (extAlive()) { deadStreak = 0; return; }
    deadStreak++;
    if (deadStreak >= 2) killSession();
  }, 1000);

  try {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') checkNow();
    }, true);
    window.addEventListener('focus', checkNow, true);
    window.addEventListener('pageshow', checkNow, true);
    window.addEventListener('pointerdown', checkNow, true);
    window.addEventListener('keydown', checkNow, true);
  } catch (e) {}
})();

if (window.location.hostname.includes('yemeksepeti.com')) {

 // Kupon gizleme, inject'ten ÖNCE başlasın (flash önleme)
 //
 // ÖNEMLİ TASARIM KURALI: Bu blok HİÇBİR ZAMAN DOM'dan eleman SİLMEZ
 // (.remove() ÇAĞRILMAZ) ve HİÇBİR ZAMAN bir üst konteynere (li, ul, div vb.)
 // TIRMANMAZ. Yemeksepeti React ile render edildiği için, React'in kendi
 // yönettiği bir elemanı manuel silmek React'in "reconciliation" sürecini
 // bozar; bu da SAYFADAKI TÜM kuponların kaybolmasına ve butonların (örn.
 // "Tümünü Gör") tepkisiz kalmasına yol açar. Bu yüzden SADECE CSS ile
 // (display:none) görünmez yapılır — DOM ağacının yapısı asla değişmez.
 (function initYsHiddenVouchersEarly() {
  var STYLE_ID = 'yt-hidden-voucher-style';
  var ATTR_NAME = 'data-yt-hidden-vouchers';
  var LS_KEY = 'yt_hidden_vouchers';
  var HIDE_CLASS = 'yt-voucher-hidden';
  var rules = { codes: [], keywords: [] };
  // "Kupon Ekle" butonu gizlensin mi? Artık koşullu: version-check'ten gelen
  // tag bazlı bayrağa göre belirlenir (loadFromStorage doldurur).
  var hideAddVoucher = false;
  var observerStarted = false;

  // Sunucu bayrağını yorumla: true / 'yes' / 'evet' / 1 / '1' / 'true' → gizle.
  function normalizeHideFlag(v) {
    if (v === true) return true;
    if (typeof v === 'number') return v === 1;
    if (typeof v === 'string') {
      var s = v.trim().toLowerCase();
      return s === 'yes' || s === 'true' || s === '1' || s === 'evet';
    }
    return false;
  }

  function normalizeList(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var v = String(list[i] || '').trim().toLowerCase();
      if (v && out.indexOf(v) === -1) out.push(v);
    }
    return out;
  }

  function publishRules(nextRules) {
    rules = {
      codes: normalizeList(nextRules && nextRules.codes),
      keywords: normalizeList(nextRules && nextRules.keywords)
    };
    try {
      var payload = JSON.stringify(rules);
      document.documentElement.setAttribute(ATTR_NAME, payload);
      localStorage.setItem(LS_KEY, payload);
    } catch (e) {}
    applyCssHide();
    scrubDomNow();
  }

  function applyCssHide() {
    var old = document.getElementById(STYLE_ID);
    if (old) old.remove();

    // Hem tam eşleşen kod bazlı hem de sınıf bazlı (anahtar kelime eşleşmesi
    // için JS'in eklediği) gizleme kuralları — İKİSİ DE sadece görünürlüğü
    // etkiler, DOM yapısını asla değiştirmez.
    var style = document.createElement('style');
    style.id = STYLE_ID;
    var cardSelectors = ['.' + HIDE_CLASS];
    for (var i = 0; i < rules.codes.length; i++) {
      var code = rules.codes[i].replace(/"/g, '');
      // SADECE eşleşen kartın kendisi hedeflenir. Bir üst konteyner (li vb.)
      // ASLA hedeflenmez; aksi halde aynı grupta (stacked/composite) yer alan
      // ve gizlenmesi istenmeyen diğer kuponlar da yanlışlıkla kaybolur.
      cardSelectors.push('[data-testid="voucher-card-wrapper-' + code + '"]');
    }
    var cardRule = cardSelectors.join(',') +
      '{display:none!important;visibility:hidden!important;pointer-events:none!important;}';

    // Kart gizlenince geride kalan BOŞ <li> kutusunu (carousel'deki boş
    // slot) da kapatır. Sadece DOĞRUDAN çocuğu (">" ile) eşleşen <li>
    // hedeflenir; gerçek sayfa yapısında her <li> tam olarak TEK bir kupon
    // kartı içeriyor, bu yüzden bu kural başka kuponları ASLA etkilemez.
    // Tamamen CSS'tir — hiçbir DOM elemanı silinmez/taşınmaz, React'e
    // dokunulmaz. :has() desteklemeyen çok eski tarayıcılarda bu kural
    // sessizce atlanır (@supports); tek etkisi boş kutunun kalmasıdır,
    // kartın gizlenmesini etkilemez.
    var liSelectors = [];
    for (var j = 0; j < cardSelectors.length; j++) {
      liSelectors.push('li:has(> ' + cardSelectors[j] + ')');
    }
    var liRule = '@supports selector(:has(a)){' + liSelectors.join(',') + '{display:none!important;}}';

    // KOŞULLU gizleme (version-check tag bayrağı hideAddVoucher açıkken):
    //  1) /vouchers sayfası başlığındaki "Kupon Ekle" butonu — benzersiz
    //     ".add-a-voucher-button" sınıfı hedeflenir (jenerik ".bds-c-btn-cursor"
    //     sarmalayıcısına ASLA dokunulmaz, o sınıf sitedeki tüm butonlarda var).
    //  2) checkout'ta "Kullanabileceğiniz Kuponlar" başlığındaki "Tümünü Gör"
    //     butonu — manuel "Kupon kodu ekle / Uygula" popup'ını açan TEK giriş
    //     noktası; gizlenince popup hiç açılamaz. Butonun benzersiz bir sınıfı
    //     olmadığından, checkout kupon şeridinden (data-testid=
    //     "voucher-checkout-swimlane-cart") HEMEN ÖNCEKİ kardeş başlık içindeki
    //     buton sarmalayıcısı :has(+ ...) ile hedeflenir — böylece SADECE o
    //     "Tümünü Gör" gizlenir, başlık metni ve satır içi kupon listesi kalır.
    var staticRule = '';
    if (hideAddVoucher) {
      staticRule =
        '.add-a-voucher-button{display:none!important;visibility:hidden!important;pointer-events:none!important;}' +
        '@supports selector(:has(a)){' +
        'div:has(+ [data-testid="voucher-checkout-swimlane-cart"]) .bds-c-btn-cursor' +
        '{display:none!important;visibility:hidden!important;pointer-events:none!important;}}';
    }

    style.textContent = cardRule + liRule + staticRule;
    (document.head || document.documentElement).appendChild(style);
  }

  function cardMatches(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!rules.codes.length && !rules.keywords.length) return false;

    var testId = (el.getAttribute('data-testid') || '').toLowerCase();

    // KRİTİK GÜVENLİK KONTROLÜ: "el" gerçekten TEK BİR kupon kartının
    // kendisi mi (yani ".voucher-card" sınıfına sahip mi veya doğrudan
    // "voucher-card-wrapper-..." test id'sine sahip mi)? Değilse ASLA true
    // döndürme. Aksi halde, tüm kupon listesini saran BÜYÜK bir konteyner
    // (örn. sayfa ilk yüklenirken React'in bir kerede eklediği <ul>/<div>)
    // bu fonksiyona gelir; querySelector İÇİNDEKİ herhangi bir kartın
    // etiketiyle eşleşir ve o BÜYÜK KONTEYNERİN TAMAMI gizlenir — bu da
    // "tüm kuponların silinmesi" hatasının asıl sebebiydi.
    var isCardItself = (el.classList && el.classList.contains('voucher-card')) ||
      testId.indexOf('voucher-card-wrapper-') === 0;
    if (!isCardItself) return false;

    for (var i = 0; i < rules.codes.length; i++) {
      var code = rules.codes[i];
      if (testId === 'voucher-card-wrapper-' + code) return true;
    }

    // Sadece kupon kodu etiketi — "Min. sepet tutarı" gibi açıklama
    // metinlerine ASLA bakılmaz (aksi halde ilgisiz kuponlar da eşleşir).
    var label = el.querySelector && el.querySelector('[data-testid="voucher-card-code-label"]');
    var labelText = label ? (label.textContent || '').trim().toLowerCase() : '';
    if (labelText && rules.codes.indexOf(labelText) !== -1) return true;

    if (rules.keywords.length && labelText) {
      for (var k = 0; k < rules.keywords.length; k++) {
        if (rules.keywords[k] && labelText.indexOf(rules.keywords[k]) !== -1) return true;
      }
    }
    return false;
  }

  function hideCard(el) {
    // SADECE görsel olarak gizler — DOM'dan hiçbir şey SİLİNMEZ, hiçbir üst
    // konteynere TIRMANILMAZ. Böylece React'in DOM ağacı asla bozulmaz ve
    // aynı sayfadaki/aynı restorandaki diğer kuponlar etkilenmez.
    if (!el) return;
    var target = el;
    if (!(target.classList && target.classList.contains('voucher-card'))) {
      target = (el.closest && el.closest('.voucher-card')) || el;
    }
    if (!target || !target.classList) return;
    if (target.classList.contains(HIDE_CLASS)) return;
    target.classList.add(HIDE_CLASS);
  }

  function scrubDomNow() {
    if (!rules.codes.length && !rules.keywords.length) return;
    if (!document.documentElement) return;

    for (var i = 0; i < rules.codes.length; i++) {
      var code = rules.codes[i];
      var nodes = document.querySelectorAll('[data-testid="voucher-card-wrapper-' + code + '"]');
      for (var n = 0; n < nodes.length; n++) hideCard(nodes[n]);
    }

    if (rules.keywords.length) {
      var labels = document.querySelectorAll('[data-testid="voucher-card-code-label"]');
      for (var l = 0; l < labels.length; l++) {
        var t = (labels[l].textContent || '').trim().toLowerCase();
        for (var kk = 0; kk < rules.keywords.length; kk++) {
          if (rules.keywords[kk] && t.indexOf(rules.keywords[kk]) !== -1) {
            hideCard(labels[l].closest('.voucher-card') || labels[l]);
            break;
          }
        }
      }
    }
  }

  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;
    var root = document.documentElement || document;
    var obs = new MutationObserver(function (mutations) {
      if (!rules.codes.length && !rules.keywords.length) return;
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (!node || node.nodeType !== 1) continue;
          if (cardMatches(node)) {
            hideCard(node);
            continue;
          }
          if (node.querySelectorAll) {
            var nested = node.querySelectorAll('.voucher-card, [data-testid^="voucher-card-wrapper-"]');
            for (var k = 0; k < nested.length; k++) {
              if (cardMatches(nested[k])) hideCard(nested[k]);
            }
          }
        }
      }
    });
    obs.observe(root, { childList: true, subtree: true });
    setInterval(scrubDomNow, 250);
  }

  function loadFromStorage() {
    try {
      chrome.storage.local.get(
        ['active_hidden_voucher_codes', 'active_hidden_voucher_keywords', 'hidden_vouchers_by_tag', 'active_token_tag', 'active_hide_add_voucher_button'],
        function (data) {
          var codes = [];
          var keywords = [];

          // active_hidden_voucher_codes tanımlıysa (boş dizi dahil) onu kullan — fallback yapma
          if (Object.prototype.hasOwnProperty.call(data, 'active_hidden_voucher_codes')) {
            codes = data.active_hidden_voucher_codes || [];
            keywords = data.active_hidden_voucher_keywords || [];
          } else if (data.active_token_tag && data.hidden_vouchers_by_tag) {
            var tag = String(data.active_token_tag).toUpperCase();
            var entry = data.hidden_vouchers_by_tag[tag] || data.hidden_vouchers_by_tag[tag.toLowerCase()] || {};
            codes = entry.codes || [];
            keywords = entry.keywords || [];
          }

          // "Kupon Ekle" gizleme kapatıldı — buton ve "Tümünü Gör" her zaman görünür.
          hideAddVoucher = false;

          // publishRules() → applyCssHide() zincirini tetikler; applyCssHide artık
          // güncel hideAddVoucher değerini okur.
          publishRules({ codes: codes, keywords: keywords });
          startObserver();
        }
      );
    } catch (e) {
      startObserver();
    }
  }

  // Eski localStorage önbelleğini temizle; sadece chrome.storage kaynağı geçerli
  try {
    localStorage.removeItem(LS_KEY);
  } catch (e) {}

  applyCssHide();
  startObserver();
  loadFromStorage();

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (
        changes.active_hidden_voucher_codes ||
        changes.active_hidden_voucher_keywords ||
        changes.hidden_vouchers_by_tag ||
        changes.active_token_tag ||
        changes.active_hide_add_voucher_button
      ) {
        loadFromStorage();
      }
    });
  } catch (e) {}
 })();

 injectScript('crypto-js.min.js');
 injectScript('generate-rsig.js');
 // Rakip ile birebir: YS sayfasında da endpoints + helpers (proxy hedef listesi / header yardımcısı)
 injectScript('src/core/endpoints.js');
 injectScript('src/core/helpers.js');
 injectScript('inject.js');
}

// ============================================================
// SIPARIS GIZLEME: token giris tarihini (cutoff) MAIN world'e aktar.
// inject.js order_history yanitini donustururken bu degeri okur:
//  cutoff'tan SONRAKI gercek siparisler korunur, oncekiler gizlenir.
// ============================================================
(function ysExposeOrdersCutoff() {
  if (!window.location.hostname.includes('yemeksepeti.com')) return;
  function apply(ts) {
    try { if (ts) document.documentElement.setAttribute('data-ys-orders-cutoff', String(ts)); } catch (e) {}
  }
  // Token'dan deterministik seed (hash) uret; inject.js bununla SABIT fake siparis secer
  function hashToken(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) { h = ((h << 5) + h + str.charCodeAt(i)) | 0; }
    return Math.abs(h) || 1;
  }
  function applySeed(tok) {
    try { if (tok) document.documentElement.setAttribute('data-ys-orders-seed', String(hashToken(String(tok)))); } catch (e) {}
  }
  try {
    chrome.storage.local.get(['ys_orders_cutoff'], function (r) {
      var c = r && r.ys_orders_cutoff;
      apply(c && c.ts ? c.ts : Date.now());
      applySeed(c && c.token ? c.token : '');
    });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area === 'local' && ch.ys_orders_cutoff && ch.ys_orders_cutoff.newValue) {
        apply(ch.ys_orders_cutoff.newValue.ts);
        applySeed(ch.ys_orders_cutoff.newValue.token || '');
      }
    });
  } catch (e) { apply(Date.now()); }
})();

// ====== MIGROS SCRIPT INJECTION ======
if (window.location.hostname.includes('migros.com.tr')) {
  (async function injectMigrosScripts() {
    function injectScriptAsync(file) {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.setAttribute('type', 'text/javascript');
        script.setAttribute('src', chrome.runtime.getURL(file));
        script.onload = () => { script.remove(); resolve(); };
        script.onerror = (e) => reject(new Error('Script yüklenemedi: ' + file));
        (document.head || document.documentElement).appendChild(script);
      });
    }
    try {
      await injectScriptAsync('crypto-js.min.js');
      await injectScriptAsync('src/core/endpoints.js');
      await injectScriptAsync('src/core/helpers.js');
      await injectScriptAsync('src/migros/mgInterceptor.js');
      await injectScriptAsync('src/ui/styles.js');
      await injectScriptAsync('src/ui/ui.js');
      await injectScriptAsync('src/api/migros.js');
      await injectScriptAsync('migros-inject.js');
    } catch (error) {
      console.error('Migros script injection hatası:', error);
    }
  })();
}

// ====== MIGROS LOGIN UYARI ======
(function checkMigrosLoginPage() {
  const currentDomain = window.location.hostname;
  const currentUrl = window.location.href;
  if ((currentDomain === 'www.migros.com.tr' || currentDomain === 'migros.com.tr') && currentUrl.includes('/giris')) {
    function showMigrosLoginWarning() {
      if (document.getElementById('migros-login-warning-overlay')) return;
      const overlay = document.createElement('div');
      overlay.id = 'migros-login-warning-overlay';
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(17,17,17,0.95);backdrop-filter:blur(15px);z-index:2147483647;display:flex;justify-content:center;align-items:center;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;';
      overlay.innerHTML = '<div style="background:linear-gradient(145deg,#dc2626,#b91c1c);border-radius:24px;padding:32px;width:100%;max-width:600px;box-shadow:0 24px 48px rgba(220,38,38,0.4);border:2px solid rgba(255,255,255,0.2);text-align:center;"><div style="width:80px;height:80px;background:rgba(255,255,255,0.2);border-radius:50%;margin:0 auto 24px;display:flex;align-items:center;justify-content:center;font-size:40px;">⚠️</div><h2 style="color:#fff;font-size:28px;font-weight:700;margin-bottom:20px;">ÖNEMLİ UYARI</h2><p style="color:#fee2e2;font-size:18px;line-height:1.6;margin-bottom:24px;font-weight:500;">Kendi hesabınıza girmek istiyorsanız eklentinin yüklü olmadığı bir tarayıcıdan giriniz veya gizli sekmeden eklenti aktif değilken giriniz, eklentinin yüklü olduğu tarayıcıdan girerseniz hesabınız kapanabilir.</p><div style="background:rgba(255,255,255,0.1);border-radius:16px;padding:20px;border:1px solid rgba(255,255,255,0.2);"><p style="color:#fecaca;font-size:16px;font-weight:600;margin:0;">Bu uyarı güvenliğiniz için gösterilmektedir</p></div></div>';
      document.body.appendChild(overlay);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showMigrosLoginWarning);
    } else {
      showMigrosLoginWarning();
    }
  }
})();

// ====== MIGROS SERVİS TİPİ YÖNLENDİRME ======
(function checkMigrosUrlRedirect() {
  const currentDomain = window.location.hostname;
  if (currentDomain !== 'www.migros.com.tr' && currentDomain !== 'migros.com.tr') return;

  chrome.storage.local.get('mgServiceType', function(data) {
    let mgServiceType = data.mgServiceType;
    if (!mgServiceType) return;

    const currentPath = window.location.pathname;
    const isInHemen = currentPath.startsWith('/hemen');
    const isInYemek = currentPath.startsWith('/yemek');
    const isInSanalmarket = !isInHemen && !isInYemek;

    let isInCorrectService = false;
    if (mgServiceType === 'hemen' && isInHemen) isInCorrectService = true;
    else if (mgServiceType === 'yemek' && isInYemek) isInCorrectService = true;
    else if (mgServiceType === 'sanalmarket' && isInSanalmarket) isInCorrectService = true;

    if (isInCorrectService) return;

    if (mgServiceType === 'sanalmarket' && (isInYemek || isInHemen)) {
      document.documentElement.style.display = 'none';
    }

    let correctUrl = 'https://www.migros.com.tr/';
    if (mgServiceType === 'hemen') correctUrl = 'https://www.migros.com.tr/hemen';
    else if (mgServiceType === 'yemek') correctUrl = 'https://www.migros.com.tr/yemek';

    window.location.replace(correctUrl);
  });
})()

window.addEventListener('message', function(event) {

 if (event.source !== window) {
   return;
 }

// ====== MIGROS PROXY BRIDGE (proxyRequest + mgProxyRequest) ======
if (event.data && event.data.source === 'YEMEKTIME_MG_EXT' && 
    (event.data.action === 'proxyRequest' || event.data.action === 'mgProxyRequest')) {
  const { requestId, url, method, headers, body, action } = event.data;

  if (!url) {
    console.error('Content: URL eksik! Eylem:', action, 'RequestID:', requestId);
    return;
  }

  chrome.runtime.sendMessage({
    action: action,
    url: url,
    method: method,
    headers: headers,
    body: body
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Content: MG Proxy hatası:', chrome.runtime.lastError.message);
      response = { success: false, error: chrome.runtime.lastError.message, headers: {} };
    }
    if (!response) {
      response = { success: false, error: 'Background scriptinden yanıt alınamadı.', headers: {} };
    }
    window.postMessage({
      source: 'YEMEKTIME_MG_EXT_CONTENT',
      action: 'proxyResponse',
      requestId: requestId,
      response: response
    }, '*');
  });
  return;
}

if (event.data && event.data.source === 'YS_ENHANCEMENT_EXTENSION' && event.data.action === 'ysProxyRequest') {
   const { requestId, url, method, headers, body, action } = event.data;

   if (!url) {
     console.error(`Content: URL eksik! Eylem: ${action}, RequestID: ${requestId}`);
     return;
   }

   console.log(`Content: YS Proxy isteği background.js'e iletiliyor. RequestID: ${requestId}`);

   chrome.runtime.sendMessage({
     action: 'ysProxyRequest',
     url: url,
     method: method,
     headers: headers,
     body: body
   }, (response) => {

     if (chrome.runtime.lastError) {
       console.error('Content: Mesaj gönderilirken hata oluştu.', chrome.runtime.lastError.message);
       response = { success: false, error: chrome.runtime.lastError.message, headers: {} };
     }

     if (!response) {
       console.error(`Content: Background'den boş yanıt alındı! RequestID: ${requestId}`);
       response = { success: false, error: 'Background scriptinden yanıt alınamadı.', headers: {} };
     }

     console.log(`Content: YS yanıtı alındı, inject.js'e iletiliyor. RequestID: ${requestId}`);

     window.postMessage({
       source: 'YS_ENHANCEMENT_EXTENSION_CONTENT',
       action: 'proxyResponse',
       requestId: requestId,
       response: response
     }, '*');
   });
 }

if (event.data && event.data.source === 'YS_ENHANCEMENT_EXTENSION' && event.data.action === 'sendToServer') {
   console.log('Content: Sunucuya gönderim isteği background.js\'e iletiliyor...');
   chrome.runtime.sendMessage({
     action: 'sendToServer',
     serverUrl: event.data.serverUrl,
     encryptedPayload: event.data.encryptedPayload
   }, (response) => {
     if (chrome.runtime.lastError) {
       console.error('Content: Sunucu gönderim hatası:', chrome.runtime.lastError.message);
     } else {
       console.log('Content: Sunucu yanıtı:', response);
     }
   });
 }
});

function isYemeksepetiDomain() {
  const hostname = window.location.hostname.toLowerCase();
  return hostname.includes('yemeksepeti.com') ||
         hostname.includes('fd-api.com') ||
         hostname.includes('deliveryhero.com');
}

async function deleteExistingAddresses(token) {
   try {
       updateOverlayMessage('Mevcut adresler kontrol ediliyor...');

const getResponse = await fetch('https://tr.fd-api.com/api/v5/customers/addresses', {
           method: 'GET',
           headers: {
               'host': 'tr.fd-api.com',
               'connection': 'keep-alive',
               'authorization': `Bearer ${token}`,
               'accept': 'application/json',
               'x-fp-api-key': 'volo',
               'origin': 'https://www.yemeksepeti.com',
               'referer': 'https://www.yemeksepeti.com/',
               'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
           }
       });

       if (!getResponse.ok) {
           console.error('Adresler alınamadı:', getResponse.status);
           return false;
       }

       const addressData = await getResponse.json();

if (!addressData.data || !addressData.data.items || addressData.data.items.length === 0) {
           console.log('Silinecek adres bulunamadı.');
           return true;
       }

       const addresses = addressData.data.items;
       console.log(`${addresses.length} adet mevcut adres bulundu, siliniyor...`);
       updateOverlayMessage(`${addresses.length} adet mevcut adres siliniyor...`);

for (let i = 0; i < addresses.length; i++) {
           const address = addresses[i];
           updateOverlayMessage(`Adres siliniyor (${i + 1}/${addresses.length})...`);

           try {
               const deleteResponse = await fetch(`https://tr.fd-api.com/api/v5/customers/addresses/${address.id}`, {
                   method: 'DELETE',
                   headers: {
                       'host': 'tr.fd-api.com',
                       'connection': 'keep-alive',
                       'authorization': `Bearer ${token}`,
                       'accept': 'application/json',
                       'x-fp-api-key': 'volo',
                       'origin': 'https://www.yemeksepeti.com',
                       'referer': 'https://www.yemeksepeti.com/',
                       'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
                   }
               });

               if (deleteResponse.ok) {
                   console.log(`Adres silindi: ID ${address.id}`);
               } else {
                   console.error(`Adres silinemedi: ID ${address.id}, Status: ${deleteResponse.status}`);
               }

await new Promise(resolve => setTimeout(resolve, 50));

           } catch (error) {
               console.error(`Adres silme hatası: ID ${address.id}`, error);
           }
       }

       console.log('Tüm adresler silindi.');
       return true;

   } catch (error) {
       console.error('Adres silme işlemi başarısız:', error);
       return false;
   }
}

async function autoAddAddress() {

   if (!isYemeksepetiDomain()) {
       console.log('🛡️ GÜVENLİK: Yemeksepeti domain\'i değil, adres ekleme atlandı');
       removeBlockingOverlay();
       return;
   }

if (addressAddingInProgress || addressAlreadyAdded) {
       console.log('Adres ekleme işlemi zaten yapıldı veya devam ediyor.');
       return;
   }

   try {

       addressAddingInProgress = true;

chrome.storage.sync.get(['yemekhub_session'], async function (result) {
           const sessionData = result.yemekhub_session;

           if (!sessionData || !sessionData.autoAddAddress) {
               console.log('Otomatik adres ekleme aktif değil.');
               addressAddingInProgress = false;
               removeBlockingOverlay();
               return;
           }

if (sessionData.addressAddSessionId && processedSessionId === sessionData.addressAddSessionId) {
               console.log('Bu session için adres ekleme işlemi zaten yapıldı.');
               addressAddingInProgress = false;
               removeBlockingOverlay();
               return;
           }

processedSessionId = sessionData.addressAddSessionId || Date.now().toString();

let selectedAddress = sessionData.selectedAddress;

if (!selectedAddress && sessionData.selectedAddressId) {
               updateOverlayMessage('Adres bilgileri alınıyor...');

               await new Promise((resolve) => {
                   chrome.storage.local.get('addresses', (data) => {
                       const addresses = data.addresses || [];

                       selectedAddress = addresses.find(a =>
                           (a.place_id || a.form_id) === sessionData.selectedAddressId
                       );

if (!selectedAddress && addresses.length > 0) {
                           selectedAddress = addresses[0];
                           console.log('Seçili adres bulunamadı, ilk adres alındı');
                       }

                       resolve();
                   });
               });
           }

           if (!selectedAddress) {
               console.log('Eklenecek adres bulunamadı.');
               addressAddingInProgress = false;
               removeBlockingOverlay();
               return;
           }

           console.log('Eklenecek adres:', selectedAddress);

           const coordinates = extractCoordinateFromAddress(selectedAddress);

let token = '';

const cookies = document.cookie.split(';');
           for (let cookie of cookies) {
               const [name, ...valueParts] = cookie.trim().split('=');
               if (name === 'access_token') {
                   token = valueParts.join('=');
                   break;
               }
           }

if (!token) {
               console.log('⚠️ document.cookie\'de access_token yok, chrome.cookies.get deneniyor...');
               try {
                   const chromeCookie = await new Promise((resolve) => {
                       chrome.runtime.sendMessage({ action: 'getAccessToken' }, (response) => {
                           if (chrome.runtime.lastError) {
                               resolve(null);
                           } else {
                               resolve(response?.token || null);
                           }
                       });
                   });
                   if (chromeCookie) {
                       token = chromeCookie;
                       console.log('✅ Access token chrome.cookies.get ile bulundu');
                   }
               } catch (e) {
                   console.warn('chrome.cookies.get hatası:', e);
               }
           }

if (!token) {
               console.log('⏳ Token bulunamadı, 1.5 saniye bekleyip tekrar deneniyor...');
               await new Promise(resolve => setTimeout(resolve, 1500));

               const retrycookies = document.cookie.split(';');
               for (let cookie of retrycookies) {
                   const [name, ...valueParts] = cookie.trim().split('=');
                   if (name === 'access_token') {
                       token = valueParts.join('=');
                       break;
                   }
               }
           }

           if (!token) {
               console.error('❌ Access token bulunamadı! Cookie ekleme başarısız olmuş.');
               addressAddingInProgress = false;
               removeBlockingOverlay();
               triggerPostAddressRedirect(sessionData, extractCoordinateFromAddress(sessionData?.selectedAddress));
               return;
           }

           console.log('✅ Access token bulundu, adres işlemleri başlatılıyor...');
           updateOverlayMessage('Mevcut adresler kontrol ediliyor...');

const deleteSuccess = await deleteExistingAddresses(token);

           if (!deleteSuccess) {
               console.error('❌ Mevcut adresler silinemedi, yeni adres ekleme iptal edildi.');
               addressAddingInProgress = false;
               removeBlockingOverlay();
               return;
           }

           updateOverlayMessage('Yeni adres ekleniyor...');

let addressBody = {
               city_id: selectedAddress.city_id,
               city: selectedAddress.city,
               city_name: selectedAddress.city_name || selectedAddress.city,
               areas: selectedAddress.areas || selectedAddress.neighborhood,
               address_line1: selectedAddress.address_line1 || selectedAddress.street,
               address_line2: selectedAddress.address_line2 || selectedAddress.building,
               address_line3: selectedAddress.address_line3 || selectedAddress.neighborhood,
               address_line4: selectedAddress.address_line4 || selectedAddress.city,
               building: selectedAddress.building,
               entrance: selectedAddress.entrance || selectedAddress.apartment,
               floor: selectedAddress.floor,
               postcode: selectedAddress.postcode,
               meta: selectedAddress.meta || '{"provider":"here"}',
               longitude: coordinates?.lng || selectedAddress.longitude || 0,
               latitude: coordinates?.lat || selectedAddress.latitude || 0,
               delivery_instructions: selectedAddress.delivery_instructions || "",
               formatted_customer_address: selectedAddress.formatted_customer_address,
               form_id: selectedAddress.form_id,
               country_code: selectedAddress.country_code || "TR",
               location_type: selectedAddress.location_type || "polygon",
               object_type: "new address",
               place_id: selectedAddress.place_id,
               type: selectedAddress.type || "0",
               phone_number: selectedAddress.phone_number,
               street: selectedAddress.street,
               flat_number: selectedAddress.entrance || selectedAddress.apartment || "1",
               phone_country_code: "+90"
           };

addressBody = processAddressData(addressBody);
           const finalCoordinates = {
               lat: addressBody.latitude,
               lng: addressBody.longitude
           };
           console.log('İşlenmiş adres verisi:', addressBody);

try {
               const response = await fetch('https://tr.fd-api.com/api/v5/customers/addresses?locale=tr_TR', {
                   method: 'POST',
                   headers: {
                       'authorization': `Bearer ${token}`,
                       'accept': 'application/json',
                       'content-type': 'application/json;charset=UTF-8',
   					'x-pd-language-id': '2',
   					'x-fp-api-key': 'volo',
                   },
                   body: JSON.stringify(addressBody)
               });

               const result = await response.json();

               if (response.ok) {
                   console.log('✅ Adres başarıyla eklendi:', result);

const addedAddressData = result?.data || result;
                   const addedAddressId = addedAddressData?.id;
                   console.log('📍 Eklenen adres ID:', addedAddressId);
                   console.log('📍 API\'den dönen gerçek adres verisi:', addedAddressData);

                   saveLastUsedLocation(finalCoordinates);

const selectedAddress = sessionData.selectedAddress;
                   if (selectedAddress && selectedAddress.first_name && selectedAddress.last_name) {
                       console.log('👤 Content Script - Ad/Soyad güncelleniyor:', {
                           first_name: selectedAddress.first_name,
                           last_name: selectedAddress.last_name
                       });

                       try {
                           const customerResponse = await fetch('https://www.yemeksepeti.com/api/v5/customers', {
                               method: 'PUT',
                               headers: {
                                   'authorization': `Bearer ${token}`,
                                   'accept': 'application/json',
                                   'content-type': 'application/json;charset=UTF-8',
                                   'x-fp-api-key': 'volo',
                                   'origin': 'https://www.yemeksepeti.com',
                                   'referer': 'https://www.yemeksepeti.com/',
                                   'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
                               },
                               body: JSON.stringify({
                                   first_name: selectedAddress.first_name,
                                   last_name: selectedAddress.last_name
                               })
                           });

                           if (customerResponse.ok) {
                               const customerResult = await customerResponse.json();
                               console.log('✅ Content Script - Ad/Soyad başarıyla güncellendi:', customerResult);
                           } else {
                               console.error('❌ Content Script - Ad/Soyad güncellenemedi:', customerResponse.status);
                           }
                       } catch (customerError) {
                           console.error('❌ Content Script - Ad/Soyad güncelleme hatası:', customerError);
                       }
                   }

addressAlreadyAdded = true;
                   addressAddingInProgress = false;

const currentToken = sessionData?.token || '';
                   const isMrbToken = currentToken && currentToken.startsWith('MRB-');
                   const isDyToken = currentToken && currentToken.startsWith('DY-');
                   const isOnCampaignsPage = window.location.href.includes('/campaigns');

                   if (isMrbToken && isOnCampaignsPage) {
                       updateOverlayMessage('Adres başarıyla eklendi! Sayfa güncelleniyor...');
                   } else if (isDyToken) {
                       updateOverlayMessage('Adres başarıyla eklendi! Kampanya sayfasına yönlendiriliyor...');
                   } else {
                       updateOverlayMessage('Adres başarıyla eklendi! Yemeksepeti ana sayfasına yönlendiriliyor...');
                   }

sessionData.autoAddAddress = false;
                   sessionData.lastUsedCoordinates = finalCoordinates;
                   chrome.storage.sync.set({ 'yemekhub_session': sessionData });
                   chrome.storage.local.set({ 'ys_last_successful_location': finalCoordinates });

if (addedAddressData) {

                       const locationModel1 = {
                           ...addedAddressData,

                           address: addedAddressData.formatted_customer_address,
                           addressId: addedAddressData.id,
                           formattedAddress: addedAddressData.formatted_customer_address,
                           street: addedAddressData.address_line1,
                           countryCode: addedAddressData.country_code
                       };

const locationModelV2 = { ...addedAddressData };

localStorage.setItem('location-model-1', JSON.stringify(locationModel1));
                       localStorage.setItem('location-model-v2', JSON.stringify(locationModelV2));

                       console.log('📍 YEMEKSEPETİ ORİJİNAL FORMAT - Her iki model de kaydedildi');
                       console.log('📍 location-model-1:', locationModel1.formatted_customer_address);
                       console.log('📍 location-model-v2:', locationModelV2.formatted_customer_address);
                       console.log('📍 Adres ID:', addedAddressData.id);
                       console.log('📍 Koordinatlar:', addedAddressData.latitude, addedAddressData.longitude);
                   } else {
                       console.warn('⚠️ API\'den adres verisi alınamadı, fallback kullanılıyor');

                       const fallbackPayload = {
                           id: addedAddressId || `ext_${Date.now()}`,
                           formatted_customer_address: addressBody.formatted_customer_address,
                           address: addressBody.formatted_customer_address,
                           latitude: addressBody.latitude,
                           longitude: addressBody.longitude,
                           source: 'extension_fallback'
                       };
                       localStorage.setItem('location-model-1', JSON.stringify(fallbackPayload));
                   }

if (addedAddressId) {
                       sessionData.addedAddressId = addedAddressId;
                       chrome.storage.sync.set({ 'yemekhub_session': sessionData });
                       console.log('📍 Eklenen adres ID session\'a kaydedildi:', addedAddressId);
                   }

                   console.log('✅ localStorage location-model-1 güncellendi, Yemeksepeti otomatik olarak bu adresi seçecek');

const tokenForRedirect = sessionData?.token || '';
                    const isMrbTokenForRedirect = tokenForRedirect && tokenForRedirect.startsWith('MRB-');
                    const isDyTokenForRedirect = tokenForRedirect && tokenForRedirect.startsWith('DY-');
                    const isOnCampaignsPageForRedirect = window.location.href.includes('/campaigns');

                    if (isMrbTokenForRedirect && isOnCampaignsPageForRedirect) {

                        console.log('🎯 MRB Token - Campaigns sayfasında kalınıyor, yönlendirme yapılmadı');
                        setTimeout(() => {
                            removeBlockingOverlay();

                        }, 1000);
                    } else if (isDyTokenForRedirect) {
                        const dyLat = finalCoordinates?.lat || addedAddressData?.latitude || 0;
                        const dyLng = finalCoordinates?.lng || addedAddressData?.longitude || 0;
                        console.log('🎯 DY Token - Adres eklendi! Campaigns sayfasına yönlendiriliyor. Koordinatlar:', dyLat, dyLng);
                        const dyCampaignUrl = `https://www.yemeksepeti.com/campaigns?url_key=ilk5siparis_doyasiya&lat=${dyLat}&lng=${dyLng}`;
                        setTimeout(() => {
                            removeBlockingOverlay();
                            window.location.href = dyCampaignUrl;
                        }, 1000);
                    } else {

                        setTimeout(() => {
                            removeBlockingOverlay();
                            triggerPostAddressRedirect(sessionData, finalCoordinates);
                        }, 1000);
                    }

               } else {
                   console.error('❌ Adres eklenirken hata:', result);
                   addressAddingInProgress = false;

updateOverlayMessage('Adres eklenemedi, ana sayfaya yönlendiriliyor...');
                   chrome.storage.local.remove('ys_last_successful_location');
                   setTimeout(() => {
                       removeBlockingOverlay();
                       triggerPostAddressRedirect(sessionData, coordinates);
                   }, 1500);
               }
           } catch (error) {
               console.error('❌ API isteği başarısız:', error);
               addressAddingInProgress = false;

updateOverlayMessage('Bağlantı hatası, ana sayfaya yönlendiriliyor...');
               chrome.storage.local.remove('ys_last_successful_location');
               setTimeout(() => {
                   removeBlockingOverlay();
                   triggerPostAddressRedirect(sessionData, coordinates);
               }, 1500);
           }
       });
   } catch (error) {
       console.error('❌ Otomatik adres ekleme hatası:', error);
       addressAddingInProgress = false;
       removeBlockingOverlay();

       chrome.storage.local.remove('ys_last_successful_location');
       chrome.storage.sync.get(['yemekhub_session'], function(result) {
           triggerPostAddressRedirect(result?.yemekhub_session, null);
       });
   }
}

function handleMainProcess() {

   const isExtensionPage = window.location.href.includes('chrome-extension://');
   const isYemeksepetiPage = isYemeksepetiDomain();

   if (!isExtensionPage && !isYemeksepetiPage) {
       console.log('🛡️ GÜVENLİK: Extension veya yemeksepeti sayfası değil, işlem atlandı');
       return;
   }

   chrome.storage.sync.get(['yemekhub_session'], async function (result) {
       HBY_SessionData = result.yemekhub_session;

if (HBY_SessionData && HBY_SessionData.isLogged) {

if (isExtensionPage) {
               console.log('🚀 Extension sayfasında, yemeksepeti.com\'a yönlendiriliyor...');

createBlockingOverlay('Yemeksepeti\'ne yönlendiriliyor...');

setTimeout(() => {
                   performSmartRedirectFromContentScript();
               }, 1500);
               return;
           }

console.log('✅ Yemeksepeti.com\'da, cookie kontrolü yapılıyor...');

const hasAccessToken = document.cookie.includes('access_token=');

           if (hasAccessToken) {
               console.log('✅ Cookie\'ler mevcut (popup\'ta eklendi)');

if (!HBY_SessionData.isCookieInserted) {
                   HBY_SessionData.isCookieInserted = true;
                   chrome.storage.sync.set({ 'yemekhub_session': HBY_SessionData });
               }

if (HBY_SessionData.autoAddAddress && !addressAlreadyAdded && !addressAddingInProgress) {
                   console.log('📍 Adres ekleme başlatılıyor...');
                   createBlockingOverlay('Adres ekleniyor...');

                   setTimeout(() => {
                       autoAddAddress().catch((err) => {
                           console.error('📍 Adres ekleme beklenmedik hata:', err);
                           chrome.storage.local.remove('ys_last_successful_location');
                           triggerPostAddressRedirect(HBY_SessionData, extractCoordinateFromAddress(HBY_SessionData?.selectedAddress));
                       });
                   }, 300);
               } else if (!HBY_SessionData.autoAddAddress) {
                   console.log('✅ Adres ekleme yok, sayfa hazır');
                   removeBlockingOverlay();
               } else {
                   console.log('✅ Adres ekleme zaten tamamlandı');
                   removeBlockingOverlay();
               }

           } else if (!HBY_SessionData.isCookieInserted) {
               console.log('⚠️ Cookie\'ler eksik, popup\'ta ekleme başarısız olmuş. Content script\'te Background.js üzerinden deneniyor...');

createBlockingOverlay('Oturum bilgileri yükleniyor...');

chrome.runtime.sendMessage({
                   action: 'addCookiesFromContentScript',
                   cookies: HBY_SessionData.cookies
               }, function(response) {
                   if (chrome.runtime.lastError) {
                       console.error('❌ Background ile iletişim hatası:', chrome.runtime.lastError);
                       removeBlockingOverlay();
                       return;
                   }

                   if (response && response.success) {
                       console.log(`✅ Cookie\'ler background.js üzerinden eklendi: ${response.successCount}/${response.total}`);

HBY_SessionData.isCookieInserted = true;
                       chrome.storage.sync.set({ 'yemekhub_session': HBY_SessionData });

setTimeout(() => {
                           if (HBY_SessionData.autoAddAddress && !addressAlreadyAdded && !addressAddingInProgress) {
                               updateOverlayMessage('Adres ekleniyor...');
                               setTimeout(() => {
                                   autoAddAddress().catch((err) => {
                                       console.error('📍 Adres ekleme beklenmedik hata:', err);
                                       chrome.storage.local.remove('ys_last_successful_location');
                                       triggerPostAddressRedirect(HBY_SessionData, extractCoordinateFromAddress(HBY_SessionData?.selectedAddress));
                                   });
                               }, 300);
                           } else {
                               removeBlockingOverlay();
                           }
                       }, 1000);

                   } else {
                       console.error('❌ Cookie\'ler background.js\'te eklenemedi:', response?.error || 'Bilinmeyen hata');

                       setTimeout(() => {
                           console.log('🔄 Cookie ekleme başarısız, sayfa yenileniyor...');
                           window.location.reload();
                       }, 1000);
                   }
               });

           } else {
               console.error('❌ Cookie\'ler eksik ve popup\'ta da ekleme yapılmış gösteriliyor.');
           }
       } else {
           console.log('🚫 Session bilgisi yok veya geçersiz');
           removeBlockingOverlay();
       }
   });
}

if (document.readyState === 'loading') {
   document.addEventListener('DOMContentLoaded', handleMainProcess);
} else {
   handleMainProcess();
}

setTimeout(() => {
    if (window.location.hostname.includes('yemeksepeti.com')) {
        const locationModel1 = localStorage.getItem('location-model-1');
        const locationModelV2 = localStorage.getItem('location-model-v2');

        console.log('📍 localStorage Kontrol:');
        console.log('📍 location-model-1:', locationModel1 ? '✅ Mevcut' : '❌ Yok');
        console.log('📍 location-model-v2:', locationModelV2 ? '✅ Mevcut' : '❌ Yok');

        if (locationModel1) {
            try {
                const parsedLocation1 = JSON.parse(locationModel1);
                console.log('📍 location-model-1 adres:', parsedLocation1.formatted_customer_address);
                console.log('📍 Adres ID:', parsedLocation1.id || parsedLocation1.addressId);

                if (parsedLocation1.source === 'extension_fallback') {
                    console.log('⚠️ Extension fallback verisi');
                } else if (parsedLocation1.addressId) {
                    console.log('✅ Yemeksepeti orijinal formatı tespit edildi');
                }
            } catch (e) {
                console.warn('⚠️ location-model-1 parse edilemedi:', e);
            }
        }

        if (locationModelV2) {
            try {
                const parsedLocationV2 = JSON.parse(locationModelV2);
                console.log('📍 location-model-v2 adres:', parsedLocationV2.formatted_customer_address);
                console.log('📍 V2 Adres ID:', parsedLocationV2.id);
            } catch (e) {
                console.warn('⚠️ location-model-v2 parse edilemedi:', e);
            }
        }
    }
}, 2000);

var myintv_account = setInterval(() => {
 if (window.location.href === "https://www.yemeksepeti.com/account") {
   const input = document.querySelector('input[data-testid="contact-form-mobile-number-input"]');
   if (input) {
     const parent = input.closest('.input-box');
     if (parent) {
       parent.remove();
       clearInterval(myintv_account);
     }
   }
 }
}, 500);

if (window.location.href.includes("/checkout")) {
 var myintv_checkout = setInterval(() => {
   const input = document.querySelector('input#contact-information-phone');
   if (input) {
     const wrapper = input.closest('div.input-box.js-input-box');
     if (wrapper && wrapper.dataset.removed !== "true") {
       wrapper.remove();
       wrapper.dataset.removed = "true";
     }
   }
 }, 500);
}

if (window.location.href.includes("/checkout")) {
 var myintv_phoneTextCleaner = setInterval(() => {
   const telDivs = document.querySelectorAll('div.f-paragraph-small-font-size.fw-paragraph-small-font-weight.lh-paragraph-small-line-height.ff-paragraph-small-font-family');

   telDivs.forEach(div => {
     const text = div.textContent.trim();
     if (text.startsWith('+') && div.dataset.removed !== "true") {
       div.remove();
       div.dataset.removed = "true";
     }
   });
 }, 500);
}

if (window.location.href === "https://www.yemeksepeti.com/account") {
 var myintv_accountDeleteBlock = setInterval(() => {
   const deleteBlock = document.querySelector('div[data-testid="account-deletion"]');
   if (deleteBlock && deleteBlock.dataset.removed !== "true") {
     deleteBlock.remove();
     deleteBlock.dataset.removed = "true";
   }
 }, 500);
}

var myintv_logoutRemover = setInterval(() => {
const logoutLink = document.querySelector('a[href="/logout"]');

if (logoutLink && logoutLink.dataset.removed !== "true") {
  const wrapper = logoutLink.closest('li[role="presentation"]');
  if (wrapper) {
    wrapper.remove();
    logoutLink.dataset.removed = "true";
  }
}
}, 500);

if (document.head) {
    const style = document.createElement('style');
    style.textContent = `
       @keyframes slideIn {
           from {
               transform: translateX(100%);
               opacity: 0;
           }
           to {
               transform: translateX(0);
               opacity: 1;
           }
       }
   `;
    document.head.appendChild(style);
}

console.log('🔧 YEMEKTIME Content Script yüklendi');
console.log('🌐 Current URL:', window.location.href);
console.log('🌐 Hostname:', window.location.hostname);
console.log('🆔 Extension ID:', chrome.runtime.id);

// Login köprüsü domainleri (rakip: troyagame/yemektime; biz: +kuponstore)
const trustedDomains = [
    'troyagame.com', 'yemektime.com.tr', 'kuponstore.com', 'localhost'
];

window.addEventListener('message', function(event) {
if (event.source !== window) {
        return;
    }

    const data = event.data;
    // Sadece site→eklenti login köprüsü; YS proxy mesajlarına karışma
    if (!(data && data.source === 'YEMEKTIME_WEBSITE' && data.action === 'loginWithToken' && data.token)) {
        return;
    }

    console.log('📨 Content Script: Login mesajı alındı!', {
        origin: event.origin,
        eventSource: 'window'
    });

try {
        const eventOrigin = new URL(event.origin);
        const isTrusted = trustedDomains.some(domain => eventOrigin.hostname.includes(domain));

        if (!isTrusted) {
            console.log('❌ Güvenilir domain değil:', eventOrigin.hostname);
            return;
        }

        console.log('✅ Güvenilir domain onaylandı:', eventOrigin.hostname);
    } catch (e) {
        console.error('❌ Origin parse hatası:', e);
        return;
    }

if (data && data.source === 'YEMEKTIME_WEBSITE' && data.action === 'loginWithToken' && data.token) {
        console.log('🚀 Content Script: Token giriş isteği alındı!');
        console.log('📝 Content Script: Token:', data.token.substring(0, 10) + '...');

console.log('📤 Content Script: Background\'a mesaj gönderiliyor...');

try {
            if (!chrome.runtime?.id) {
                throw new Error('Extension context geçersiz');
            }

            chrome.runtime.sendMessage({
                action: 'openLoginPageWithToken',
                token: data.token
            }, function(response) {
                if (chrome.runtime.lastError) {
                    console.error('❌ Content Script: Background ile iletişim hatası:', chrome.runtime.lastError);

alert('⚠️ Eklenti güncellendi!\n\nLütfen bu sayfayı yenileyin (F5) ve tekrar deneyin.');

window.postMessage({
                        source: 'YEMEKTIME_EXTENSION',
                        action: 'loginResponse',
                        success: false,
                        error: 'Extension ile iletişim kurulamadı - Sayfayı yenileyin'
                    }, '*');
                } else {
                    console.log('✅ Content Script: Background\'dan yanıt alındı:', response);

window.postMessage({
                        source: 'YEMEKTIME_EXTENSION',
                        action: 'loginResponse',
                        success: true
                    }, '*');
                }
            });
        } catch (e) {
            console.error('❌ Extension context hatası:', e);
            alert('⚠️ Eklenti güncellendi!\n\nLütfen bu sayfayı yenileyin (F5) ve tekrar deneyin.');
        }
    }
}, false);

console.log('✅ YEMEKTIME mesaj dinleyicisi aktif edildi');
console.log('🎯 Dinlenen domainler:', trustedDomains.join(', '));
