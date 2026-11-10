/**
 * KuponStore Extension - Fullscreen UI Controller
 * Version: 10.1.20
 */

// Wait for DOM to be ready
try {
  chrome.runtime.connect({ name: 'ks-ext-page' });
} catch (_) {}

async function leaveExtensionPage(url) {
  try { stopYsRefreshClock(); } catch (_) {}
  try {
    await chrome.runtime.sendMessage({ action: 'YS_LOGIN_HANDOFF' });
  } catch (_) {}
  try { stopYsRefreshClock(); } catch (_) {}
  window.location.href = url;
}

document.addEventListener('DOMContentLoaded', async () => {
  // Güvenli fallback: ne olursa olsun preload class 800ms içinde kalksın,
  // yoksa init hatası tıklamaları engelleyebilir.
  const removePreload = () => document.body.classList.remove('preload');
  setTimeout(removePreload, 800);

  try {
    await initializeApp();
  } catch (e) {
    console.error('[KuponStore] init hatası:', e);
  } finally {
    setTimeout(removePreload, 100);
  }
});

/**
 * Initialize Application
 */
async function initializeApp() {
  // Initialize UI elements
  initializeElements();
  
  // Load user data
  await loadUserData();
  
  // Load token history
  await loadTokenHistory();
  
  // Load activity logs
  await loadActivityLogs();
  
  // Setup event listeners
  setupEventListeners();
  
  // Load theme
  loadTheme();
  
  // Update greeting
  updateGreeting();

  // Durum özeti kartları
  updateStatusSummary();

  // KuponStore üyelik bağlama banner butonu
  bindKsLinkBanner();

  // Check for updates
  checkUpdateStatus();
}

/**
 * Initialize UI Elements
 */
function initializeElements() {
  window.ui = {
    // Input elements
    tokenInput: document.getElementById('tokenInput'),
    loginBtn: document.getElementById('loginBtn'),
    clearBtn: document.getElementById('clearBtn'),
    
    // Platform indicator
    platformIndicator: document.getElementById('platformIndicator'),
    platformIcon: document.getElementById('platformIcon'),
    platformName: document.getElementById('platformName'),
    
    // Action buttons
    historyBtn: document.getElementById('historyBtn'),
    addressBtn: document.getElementById('addressBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    
    // Log elements
    logContainer: document.getElementById('logContainer'),
    clearLogBtn: document.getElementById('clearLogBtn'),
    
    // Status
    connectionStatus: document.getElementById('connectionStatus'),

    // Durum özeti kartları
    statusSummary: document.getElementById('statusSummary'),
    scAccount: document.getElementById('scAccount'),
    scAddress: document.getElementById('scAddress'),
    scLast: document.getElementById('scLast'),

    // Greeting
    greetingText: document.getElementById('greetingText'),
    
    // KuponStore üyelik bağlama banner'ı
    ksLinkBanner: document.getElementById('ksLinkBanner'),
    ksLinkBannerBtn: document.getElementById('ksLinkBannerBtn'),
    
    // Toast container
    toastContainer: document.getElementById('toastContainer'),
    
    // Loading overlay
    loadingOverlay: document.getElementById('loadingOverlay'),
    loadingText: document.getElementById('loadingText')
  };
}

/**
 * Setup Event Listeners
 */
function setupEventListeners() {
  // Token input
  ui.tokenInput.addEventListener('input', handleTokenInput);
  ui.tokenInput.addEventListener('paste', handleTokenPaste);
  
  // Login button
  ui.loginBtn.addEventListener('click', handleLogin);
  
  // Clear button
  ui.clearBtn.addEventListener('click', () => {
    ui.tokenInput.value = '';
    ui.clearBtn.style.display = 'none';
    ui.loginBtn.disabled = true;
    hidePlatformIndicator();
    try { ui.tokenInput.focus(); } catch (_) {}
  });
  
  // Action buttons
  ui.historyBtn.addEventListener('click', () => showTokenHistory());
  ui.addressBtn.addEventListener('click', () => {
    // Open address modal
    if (window.addressModalInstance) {
      window.addressModalInstance.open();
    } else {
      showToast('error', 'Adres yönetimi yüklenemedi');
    }
  });
  ui.settingsBtn.addEventListener('click', () => showSettings());
  
  // Clear logs
  ui.clearLogBtn.addEventListener('click', handleClearLogs);
  
  // Enter key on token input
  ui.tokenInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !ui.loginBtn.disabled) {
      handleLogin();
    }
  });
}

/**
 * Handle token input
 */
function handleTokenInput(e) {
  const token = e.target.value.trim();
  
  if (token.length > 0) {
    ui.clearBtn.style.display = 'flex';
    
    // Detect platform
    const platformInfo = detectTokenPlatform(token);
    if (platformInfo) {
      ui.loginBtn.disabled = false;
      showPlatformIndicator(platformInfo);
    } else {
      ui.loginBtn.disabled = true;
      hidePlatformIndicator();
    }
  } else {
    ui.clearBtn.style.display = 'none';
    ui.loginBtn.disabled = true;
    hidePlatformIndicator();
  }
}

/**
 * Handle token paste
 */
function handleTokenPaste(e) {
  setTimeout(() => {
    handleTokenInput({ target: e.target });
  }, 10);
}

/**
 * Detect token platform
 */
function detectTokenPlatform(token) {
  const prefixes = {
    // Migros - Eski eklenti prefix'leri
    'mg-': { name: 'Migros Delivery', icon: '🛒', color: '#ff6b00' },
    'mgy-': { name: 'Migros Yemek', icon: '🛒', color: '#ff6b00' },
    'mgh-': { name: 'Migros Hemen', icon: '⚡', color: '#ff6b00' },
    'mga-': { name: 'Migros Sanal Market', icon: '🏪', color: '#ff6b00' },
    
    // Trendyol
    'tgo-': { name: 'Trendyol Yemek', icon: '🍕', color: '#f27a1a' },
    'tgm-': { name: 'Trendyol Market', icon: '🛍️', color: '#f27a1a' },
    
    // Getir - Eski eklenti prefix'i
    'gt-': { name: 'Getir', icon: '🟣', color: '#5d3ebc' },
    'gtb-': { name: 'GetirBüyük', icon: '🟣', color: '#5d3ebc' },
    'gty-': { name: 'GetirYemek', icon: '🟣', color: '#5d3ebc' },
    
    // Yemeksepeti
    'ys-': { name: 'Yemeksepeti', icon: '🍔', color: '#ff0000' },
    
    // Uber - Eski eklenti prefix'i
    'ub-': { name: 'Uber Eats', icon: '🚗', color: '#000000' },
    
    // Hepsiburada
    'hb-': { name: 'Hepsiburada', icon: '🎁', color: '#ff6000' },

    // Coffy (uzun prefix önce eşleşsin diye sort)
    'coffy-': { name: 'Coffy', icon: '☕', color: '#75BFB4' },
    'cof-': { name: 'Coffy', icon: '☕', color: '#75BFB4' }
  };
  
  const keys = Object.keys(prefixes).sort((a, b) => b.length - a.length);
  for (const prefix of keys) {
    if (token.startsWith(prefix)) {
      return { prefix, ...prefixes[prefix] };
    }
  }
  
  return null;
}

/**
 * Show platform indicator
 */
function showPlatformIndicator(platformInfo) {
  ui.platformIcon.textContent = platformInfo.icon;
  ui.platformName.textContent = platformInfo.name;
  ui.platformIndicator.style.display = 'flex';
  ui.platformIndicator.classList.add('fade-in');
}

/**
 * Hide platform indicator
 */
function hidePlatformIndicator() {
  ui.platformIndicator.style.display = 'none';
}

/**
 * Handle login
 */
async function handleLogin() {
  const token = ui.tokenInput.value.trim();

  if (!token) {
    showToast('error', 'Lütfen bir token girin');
    return;
  }

  // Yemeksepeti: özel YS paneline yönlendir (otomatik adres + tema akışı)
  if (/^ys-/i.test(token)) {
    try {
      const url = chrome.runtime.getURL('ui/ys-fullscreen.html') + '?token=' + encodeURIComponent(token);
      window.location.href = url;
    } catch (_) {
      window.location.href = 'ys-fullscreen.html?token=' + encodeURIComponent(token);
    }
    return;
  }

  const platformInfo = detectTokenPlatform(token);
  const isCoffy = !!(platformInfo && (platformInfo.prefix === 'cof-' || platformInfo.prefix === 'coffy-'));

  if (isCoffy && !window._loginWarningAccepted) {
    window._showLoginWarning(function() {
      window._loginWarningAccepted = true;
      handleLogin();
    });
    return;
  }
  window._loginWarningAccepted = false;

  // Adres kontrolü — Coffy gel-al; adres gerekmez
  if (!isCoffy) {
    try {
      const addrData = await chrome.storage.local.get(['kuponstore_addresses', 'savedAddresses']);
      const savedAddresses =
        (Array.isArray(addrData.kuponstore_addresses) && addrData.kuponstore_addresses) ||
        (Array.isArray(addrData.savedAddresses) && addrData.savedAddresses) ||
        [];

      if (savedAddresses.length === 0) {
        showToast('error', 'Tokenle giriş yapabilmeniz için önce adres eklemelisiniz');
        if (window.addressModalInstance && typeof window.addressModalInstance.open === 'function') {
          setTimeout(() => {
            try { window.addressModalInstance.open(); } catch (_) {}
          }, 400);
        }
        return;
      }
    } catch (e) {
      console.warn('[KuponStore] Adres kontrolü başarısız:', e);
      showToast('error', 'Adres kontrolü yapılamadı, lütfen tekrar deneyin');
      return;
    }
  }

  const platformName = platformInfo ? platformInfo.name : 'Platform';
  const platformIcon = platformInfo ? platformInfo.icon : '🔑';
  const isMigros = token.startsWith('mg-') || token.startsWith('mgy-') || token.startsWith('mgh-') || token.startsWith('mga-');
  const isUber = token.startsWith('ub-');
  const isYs = token.startsWith('ys-');

  // Migros: kayıtlı adreste harita pini yoksa girişe izin verme — kullanıcıyı net yönlendir
  if (isMigros) {
    try {
      const addrData = await chrome.storage.local.get(['kuponstore_addresses', 'savedAddresses', 'kuponstore_active_address']);
      const list =
        (Array.isArray(addrData.kuponstore_addresses) && addrData.kuponstore_addresses) ||
        (Array.isArray(addrData.savedAddresses) && addrData.savedAddresses) ||
        [];
      const activeId = addrData.kuponstore_active_address;
      const active =
        (activeId && list.find((a) => a.id === activeId)) ||
        list.find((a) => a.autoAddAddress === true) ||
        list[0];
      const lat = parseFloat(active?.lat || active?.latitude) || 0;
      const lng = parseFloat(active?.lng || active?.longitude) || 0;
      if (!active || !lat || !lng) {
        showMigrosAddressHelpPopup({
          reason: 'missing_coords',
          openAddressModal: true,
          blockLogin: true,
        });
        return;
      }
    } catch (e) {
      console.warn('[KuponStore] Migros adres pin kontrolü:', e);
    }
  }
  
  ui.loginBtn.disabled = true;

  try {
    if (isUber) {
      showUberLoginGate(platformName, platformIcon);
      await waitForUberAcknowledgement();
    }

    const loginKind = isYs ? 'ys' : (isMigros ? 'migros' : (isCoffy ? 'coffy' : (isUber ? 'uber' : 'default')));
    showLoginProgress(platformName, platformIcon, isMigros, false, isYs, {
      kind: loginKind,
      color: platformInfo?.color || '#6366f1',
    });

    // Backend tüm işlemi yapar (cookie + adres sync) tab açmadan
    const response = await chrome.runtime.sendMessage({
      action: 'LOGIN_WITH_TOKEN',
      data: { token }
    });
    
    if (response.success) {
      // Adres sync başarısızsa kullanıcıya gerçek hatayı göster
      const addrSync = response.addressSync;
      if (addrSync && addrSync.success === false) {
        const reason = addrSync.reason || 'api_error';
        hideLoginProgress();
        ui.loginBtn.disabled = false;

        let openAddrModal = false;
        if (isMigros && (reason === 'missing_coords' || reason === 'map_or_location' || reason === 'no_saved_address')) {
          await showMigrosAddressHelpPopup({
            reason,
            openAddressModal: true,
            blockLogin: false,
          });
          openAddrModal = true;
        } else {
          const errText =
            addrSync.message ||
            addrSync.error ||
            'Adres eklenemedi. Adres Yönetimi’nden kontrol edip tekrar deneyin.';
          openAddrModal = await showAddressErrorPopup({
            platformName: platformInfo?.name || (isMigros ? 'Migros' : 'Platform'),
            message: errText,
            reason,
          });
        }

        // Adresi düzeltecekse siteye gitme; "devam et" derse yönlendir
        if (!openAddrModal && response.url) {
          await leaveExtensionPage(response.url);
        }
        return;
      }

      await completeYsLoginProgress();
      await leaveExtensionPage(response.url);
      return;
    } else {
      hideLoginProgress();
      ui.loginBtn.disabled = false;
      showToast('error', response.error || 'Giriş başarısız');
    }
  } catch (error) {
    console.error('Login error:', error);
    hideLoginProgress();
    ui.loginBtn.disabled = false;
    showToast('error', 'Bir hata oluştu: ' + error.message);
  }
}

function discardLoginProgress() {
  stopYsRefreshClock();
  const overlay = document.getElementById('loginProgressOverlay');
  if (overlay) overlay.remove();
}

function buildLoginProfile(kind, platformName, color) {
  if (kind === 'ys') {
    return {
      accent: '#fa0050',
      accent2: '#ff8000',
      chip: 'Tahmini bekleme · 1–2 dakika',
      eta: 90,
      tau: 48,
      title: 'Oturum hazırlanıyor',
      hold: 'Bu pencereyi kapatmayın. Çıkarsanız token yenilemesi yarıda kalır ve tekrar beklemeniz gerekir.',
      doneTitle: 'Giriş hazır',
      doneHold: 'Token yenilendi. Yemeksepeti açılıyor.',
      leaveGuard: true,
      steps: ['Hesap', 'Token', 'Adres', 'Açılış'],
      stages: [
        { until: 6, step: 1, title: 'Hesap doğrulanıyor', detail: 'Satın aldığınız hesap kontrol ediliyor.' },
        { until: 35, step: 2, title: 'Token yenileniyor', detail: 'Oturum sunucuda tazeleniyor. Bu adım genelde 1–2 dakika sürer.' },
        { until: 90, step: 2, title: 'Güvenlik doğrulaması', detail: 'Yemeksepeti ek doğrulama isteyebilir. Pencere açık kalsın, işlem sürüyor.' },
        { until: Infinity, step: 2, title: 'Hâlâ yenileniyor', detail: 'Tahmini süre doldu. Sunucu yanıtı bekleniyor, bu pencereyi kapatmayın.' },
      ],
      beats: [
        { step: 3, title: 'Token yenilendi', detail: 'Adres bağlanıyor.', wait: 550 },
        { step: 4, title: 'Yemeksepeti açılıyor', detail: 'Oturum hazır, yönlendiriliyorsunuz.', wait: 450 },
      ],
    };
  }
  if (kind === 'migros') {
    return {
      accent: '#ff6b00',
      accent2: '#ffb020',
      chip: 'Tahmini bekleme · 20–40 saniye',
      eta: 35,
      tau: 18,
      title: 'Oturum hazırlanıyor',
      hold: 'Bu pencereyi kapatmayın. Adres eklenirken çıkarsanız girişi baştan yapmanız gerekir.',
      doneTitle: 'Giriş hazır',
      doneHold: 'Hesap hazır. Migros açılıyor.',
      steps: ['Hesap', 'Oturum', 'Adres', 'Açılış'],
      warning: true,
      stages: [
        { until: 4, step: 1, title: 'Hesap doğrulanıyor', detail: 'Satın aldığınız Migros hesabı kontrol ediliyor.' },
        { until: 12, step: 2, title: 'Oturum açılıyor', detail: 'Çerezler hazırlanıyor ve hesaba giriş yapılıyor.' },
        { until: 35, step: 3, title: 'Adres ekleniyor', detail: 'Kayıtlı adresiniz hesaba bağlanıyor.' },
        { until: Infinity, step: 3, title: 'Hâlâ hazırlanıyor', detail: 'Tahmini süre doldu. Adres kaydı sürüyor, bu pencereyi kapatmayın.' },
      ],
      beats: [
        { step: 3, title: 'Adres eklendi', detail: 'Kayıtlı adres hesaba bağlandı.', wait: 450 },
        { step: 4, title: 'Migros açılıyor', detail: 'Oturum hazır, yönlendiriliyorsunuz.', wait: 400 },
      ],
    };
  }
  if (kind === 'coffy') {
    return {
      accent: color || '#75BFB4',
      accent2: '#d7f3ee',
      chip: 'Tahmini bekleme · 10–20 saniye',
      eta: 18,
      tau: 10,
      title: 'Oturum hazırlanıyor',
      hold: 'Bu pencereyi kapatmayın. Giriş bitmeden çıkarsanız işlemi tekrar başlatmanız gerekir.',
      doneTitle: 'Giriş hazır',
      doneHold: 'Hesap hazır. Coffy açılıyor.',
      steps: ['Hesap', 'Oturum', 'Menü', 'Açılış'],
      stages: [
        { until: 3, step: 1, title: 'Hesap doğrulanıyor', detail: 'Satın aldığınız Coffy hesabı kontrol ediliyor.' },
        { until: 10, step: 2, title: 'Oturum açılıyor', detail: 'Çerezler hazırlanıyor. Coffy gel-al, adres eklenmez.' },
        { until: 18, step: 3, title: 'Menü hazırlanıyor', detail: 'Hesap açılışa hazırlanıyor.' },
        { until: Infinity, step: 3, title: 'Hâlâ hazırlanıyor', detail: 'Tahmini süre doldu. Sunucu yanıtı bekleniyor, bu pencereyi kapatmayın.' },
      ],
      beats: [
        { step: 4, title: 'Coffy açılıyor', detail: 'Oturum hazır, yönlendiriliyorsunuz.', wait: 450 },
      ],
    };
  }
  const accent = kind === 'uber' ? '#06C167' : (color || '#6366f1');
  const accent2 = kind === 'uber' ? '#111111' : accent;
  return {
    accent,
    accent2,
    chip: 'Tahmini bekleme · 15–30 saniye',
    eta: 22,
    tau: 12,
    title: 'Oturum hazırlanıyor',
    hold: 'Bu pencereyi kapatmayın. Giriş bitmeden çıkarsanız işlemi tekrar başlatmanız gerekir.',
    doneTitle: 'Giriş hazır',
    doneHold: 'Hesap hazır. ' + platformName + ' açılıyor.',
    steps: ['Hesap', 'Çerez', 'Oturum', 'Açılış'],
    stages: [
      { until: 3, step: 1, title: 'Hesap doğrulanıyor', detail: 'Satın aldığınız ' + platformName + ' hesabı kontrol ediliyor.' },
      { until: 9, step: 2, title: 'Çerezler hazırlanıyor', detail: 'Oturum bilgileri tarayıcıya yazılıyor.' },
      { until: 22, step: 3, title: 'Oturum açılıyor', detail: 'Hesaba giriş yapılıyor.' },
      { until: Infinity, step: 3, title: 'Hâlâ hazırlanıyor', detail: 'Tahmini süre doldu. Sunucu yanıtı bekleniyor, bu pencereyi kapatmayın.' },
    ],
    beats: [
      { step: 4, title: platformName + ' açılıyor', detail: 'Oturum hazır, yönlendiriliyorsunuz.', wait: 450 },
    ],
  };
}

function renderLoginCard(platformName, platformIcon, profile) {
  const steps = profile.steps.map((label, i) =>
    '<li data-ys-step="' + (i + 1) + '"><span>' + (i + 1) + '</span>' + label + '</li>'
  ).join('');
  const warning = profile.warning ? `
    <div class="lp-mg-warning">
      <div class="lp-mg-warning-icon">⚠️</div>
      <div class="lp-mg-warning-text">
        <div class="lp-mg-warning-title">ÖNEMLİ UYARI</div>
        <div class="lp-mg-warning-msg">Kendi Migros hesabınıza girmek istiyorsanız <b>eklenti yüklü olmayan</b> bir tarayıcıdan veya <b>gizli sekmeden</b> giriş yapın. Eklenti aktifken kendi hesabınıza girerseniz <b>hesabınız kapanabilir</b>.</div>
      </div>
    </div>` : '';
  const overlay = document.createElement('div');
  overlay.id = 'loginProgressOverlay';
  overlay.innerHTML = `
    <div class="lp-card lp-ys-card${profile.warning ? ' lp-ys-card-wide' : ''}" style="--lp-accent:${profile.accent};--lp-accent-2:${profile.accent2}">
      <div class="lp-ys-top">
        <span class="lp-platform-icon">${platformIcon}</span>
        <div>
          <div class="lp-ys-kicker">${platformName}</div>
          <div class="lp-ys-title" id="lpYsTitle">${profile.title}</div>
        </div>
      </div>
      <div class="lp-ys-chip">${profile.chip}</div>
      ${warning}
      <div class="lp-ys-ring-wrap">
        <svg class="lp-ys-ring" viewBox="0 0 120 120" aria-hidden="true">
          <defs>
            <linearGradient id="lpYsGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="${profile.accent}"/>
              <stop offset="100%" stop-color="${profile.accent2}"/>
            </linearGradient>
          </defs>
          <circle class="lp-ys-ring-bg" cx="60" cy="60" r="52"></circle>
          <circle class="lp-ys-ring-fg" id="lpYsRing" cx="60" cy="60" r="52"></circle>
        </svg>
        <div class="lp-ys-ring-label">
          <div class="lp-ys-elapsed" id="lpYsElapsed">0:00</div>
          <div class="lp-ys-remain" id="lpYsRemain">kalan ~${formatYsClock(profile.eta)}</div>
        </div>
      </div>
      <div class="lp-ys-status" id="lpYsStatus">${profile.stages[0].title}</div>
      <div class="lp-ys-detail" id="lpYsDetail">${profile.stages[0].detail}</div>
      <ol class="lp-ys-steps">${steps}</ol>
      <div class="lp-ys-hold" id="lpYsHold">
        <span class="material-symbols-rounded">schedule</span>
        <span id="lpYsHoldText">${profile.hold}</span>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  startYsRefreshClock();
}

function showUberLoginGate(platformName, platformIcon) {
  discardLoginProgress();
  const overlay = document.createElement('div');
  overlay.id = 'loginProgressOverlay';
  overlay.innerHTML = `
    <div class="lp-card lp-ys-card lp-ys-card-wide">
      <div class="lp-ys-top">
        <span class="lp-platform-icon">${platformIcon}</span>
        <div>
          <div class="lp-ys-kicker" style="color:#06C167">${platformName}</div>
          <div class="lp-ys-title">Girişten önce</div>
        </div>
      </div>
      <div class="lp-uber-stepper" id="lpUberStepper">
        <div class="lp-uber-stepper-nav">
          <div class="lp-uber-step-dot active" data-dot="1"></div>
          <div class="lp-uber-step-dot" data-dot="2"></div>
        </div>
        <div class="lp-uber-step active" data-uber-step="1">
          <div class="lp-uber-step-icon warn">
            <span class="material-symbols-rounded">extension_off</span>
          </div>
          <div class="lp-uber-step-title">Eklenti Kontrolü</div>
          <div class="lp-uber-step-desc">
            Uber hesabına giriş yapmadan önce tarayıcınızda KuponStore dışında kurulu olan <b>diğer tüm eklentileri</b> devre dışı bırakın veya kaldırın.
          </div>
          <div class="lp-uber-step-alert">
            <span class="material-symbols-rounded">info</span>
            Başka eklentiler aktifken hesaptan oturum kapanabilir ve token kalıcı olarak kullanılamaz hale gelebilir.
          </div>
          <button type="button" class="lp-uber-next-btn" id="lpUberNextBtn">
            <span>Devam Et</span>
            <span class="material-symbols-rounded">arrow_forward</span>
          </button>
        </div>
        <div class="lp-uber-step" data-uber-step="2">
          <div class="lp-uber-step-icon info">
            <span class="material-symbols-rounded">local_taxi</span>
          </div>
          <div class="lp-uber-step-title">Yolculuk Bilgisi</div>
          <div class="lp-uber-step-desc">
            Yolculuk başlatırken sistem uygun sürücüyü bulmak için <b>1-2 dakika</b> arayabilir. Bu süreçte ekranda arama durumu gösterilir.
          </div>
          <div class="lp-uber-step-desc">
            Arama sırasında sayfayı <b>kapatmayın</b> veya <b>yenilemeyin</b>. Sürücü bulunduğunda otomatik olarak yönlendirileceksiniz.
          </div>
          <button type="button" class="lp-uber-ack-btn" id="lpUberAckBtn" disabled>
            Oturum Aç
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

/**
 * Show login progress overlay with step-by-step card
 */
function showLoginProgress(platformName, platformIcon, isMigros, isUber = false, isYs = false, options = {}) {
  const kind = options.kind || (isYs ? 'ys' : (isMigros ? 'migros' : (isUber ? 'uber' : 'default')));
  const profile = buildLoginProfile(kind, platformName, options.color);
  window.__loginProfile = profile;
  discardLoginProgress();
  renderLoginCard(platformName, platformIcon, profile);
}

function waitForUberAcknowledgement() {
  return new Promise((resolve) => {
    const stepper = document.getElementById('lpUberStepper');
    const nextBtn = document.getElementById('lpUberNextBtn');
    const ackBtn = document.getElementById('lpUberAckBtn');
    if (!stepper || !ackBtn) { resolve(); return; }

    if (nextBtn) {
      nextBtn.onclick = () => {
        const step1 = stepper.querySelector('[data-uber-step="1"]');
        const step2 = stepper.querySelector('[data-uber-step="2"]');
        const dot1 = stepper.querySelector('[data-dot="1"]');
        const dot2 = stepper.querySelector('[data-dot="2"]');
        if (step1) step1.classList.remove('active');
        if (step2) step2.classList.add('active');
        if (dot1) dot1.classList.remove('active');
        if (dot2) dot2.classList.add('active');

        ackBtn.disabled = true;
        let countdown = 3;
        ackBtn.innerHTML = `<span class="material-symbols-rounded lp-uber-btn-spin">progress_activity</span> Lütfen okuyun (${countdown})`;
        const timer = setInterval(() => {
          countdown--;
          if (countdown > 0) {
            ackBtn.innerHTML = `<span class="material-symbols-rounded lp-uber-btn-spin">progress_activity</span> Lütfen okuyun (${countdown})`;
          } else {
            clearInterval(timer);
            ackBtn.disabled = false;
            ackBtn.innerHTML = '<span>Oturum Aç</span><span class="material-symbols-rounded">login</span>';
          }
        }, 1000);
      };
    }

    ackBtn.onclick = () => {
      ackBtn.disabled = true;
      ackBtn.innerHTML = '<span class="material-symbols-rounded lp-uber-btn-spin">progress_activity</span> Oturum açılıyor...';
      resolve();
    };
  });
}

/**
 * Update login progress step
 */
function updateLoginStep(step, text) {
  const overlay = document.getElementById('loginProgressOverlay');
  if (!overlay) return;
  
  const steps = overlay.querySelectorAll('.lp-step');
  const bar = overlay.querySelector('.lp-bar-fill');
  const total = parseInt(bar?.dataset.total || '4');
  
  steps.forEach(s => {
    const sStep = parseInt(s.dataset.step);
    if (sStep < step) {
      s.classList.remove('active');
      s.classList.add('done');
      const icon = s.querySelector('.lp-step-icon .material-symbols-rounded');
      if (icon) { icon.textContent = 'check_circle'; icon.classList.remove('lp-spinner'); }
    } else if (sStep === step) {
      s.classList.add('active');
      s.classList.remove('done');
      const icon = s.querySelector('.lp-step-icon .material-symbols-rounded');
      if (icon && sStep < total) { icon.textContent = 'sync'; icon.classList.add('lp-spinner'); }
      else if (icon) { icon.textContent = 'check_circle'; icon.classList.remove('lp-spinner'); s.classList.add('done'); }
      if (text) s.querySelector('.lp-step-text').textContent = text;
    } else {
      s.classList.remove('active', 'done');
    }
  });
  
  if (bar) bar.style.width = Math.min(step / total * 100, 100) + '%';
}

/**
 * Hide login progress overlay
 */
const YS_RING = 2 * Math.PI * 52;
const YS_ETA_SEC = 90;

function formatYsClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

function ysStageFor(elapsed) {
  if (elapsed < 6) {
    return {
      step: 1,
      title: 'Hesap doğrulanıyor',
      detail: 'Satın aldığınız hesap kontrol ediliyor.',
    };
  }
  if (elapsed < 35) {
    return {
      step: 2,
      title: 'Token yenileniyor',
      detail: 'Oturum sunucuda tazeleniyor. Bu adım genelde 1–2 dakika sürer.',
    };
  }
  if (elapsed < YS_ETA_SEC) {
    return {
      step: 2,
      title: 'Güvenlik doğrulaması',
      detail: 'Yemeksepeti ek doğrulama isteyebilir. Pencere açık kalsın, işlem sürüyor.',
    };
  }
  return {
    step: 2,
    title: 'Hâlâ yenileniyor',
    detail: 'Tahmini süre doldu. Sunucu yanıtı bekleniyor, bu pencereyi kapatmayın.',
  };
}

function paintYsProgress(overlay, { step, title, detail, pct, elapsed, remainText }) {
  if (!overlay) return;
  const statusEl = overlay.querySelector('#lpYsStatus');
  const detailEl = overlay.querySelector('#lpYsDetail');
  const elapsedEl = overlay.querySelector('#lpYsElapsed');
  const remainEl = overlay.querySelector('#lpYsRemain');
  const ring = overlay.querySelector('#lpYsRing');
  if (statusEl && title) statusEl.textContent = title;
  if (detailEl && detail) detailEl.textContent = detail;
  if (elapsedEl && elapsed != null) elapsedEl.textContent = formatYsClock(elapsed);
  if (remainEl && remainText) remainEl.textContent = remainText;
  if (ring && pct != null) {
    ring.style.strokeDasharray = String(YS_RING);
    ring.style.strokeDashoffset = String(YS_RING * (1 - Math.max(0, Math.min(100, pct)) / 100));
  }
  overlay.querySelectorAll('[data-ys-step]').forEach((li) => {
    const n = parseInt(li.dataset.ysStep, 10);
    li.classList.toggle('is-done', n < step);
    li.classList.toggle('is-active', n === step);
  });
}

function onYsBeforeUnload(e) {
  if (!window.__ysLeaveGuard) return;
  e.preventDefault();
  e.returnValue = '';
}

function stopYsRefreshClock() {
  if (window.__ysRefreshTimer) {
    clearInterval(window.__ysRefreshTimer);
    window.__ysRefreshTimer = null;
  }
  window.__ysLeaveGuard = false;
  window.removeEventListener('beforeunload', onYsBeforeUnload);
}

function startYsRefreshClock() {
  stopYsRefreshClock();
  const started = Date.now();
  if (window.__loginProfile && window.__loginProfile.leaveGuard) {
    window.__ysLeaveGuard = true;
    window.addEventListener('beforeunload', onYsBeforeUnload);
  }
  const tick = () => {
    const overlay = document.getElementById('loginProgressOverlay');
    if (!overlay) {
      stopYsRefreshClock();
      return;
    }
    const elapsed = (Date.now() - started) / 1000;
    const profile = window.__loginProfile;
    const stage = profile
      ? (profile.stages.find((s) => elapsed < s.until) || profile.stages[profile.stages.length - 1])
      : ysStageFor(elapsed);
    const tau = profile?.tau || 48;
    const eta = profile?.eta || YS_ETA_SEC;
    const pct = Math.min(92, 8 + (1 - Math.exp(-elapsed / tau)) * 84);
    const remain = eta - elapsed;
    paintYsProgress(overlay, {
      ...stage,
      pct,
      elapsed,
      remainText: remain > 0 ? 'kalan ~' + formatYsClock(remain) : 'biraz daha',
    });
  };
  tick();
  window.__ysRefreshTimer = setInterval(tick, 500);
}

async function completeYsLoginProgress() {
  stopYsRefreshClock();
  const overlay = document.getElementById('loginProgressOverlay');
  if (!overlay) return;
  const profile = window.__loginProfile;
  const hold = overlay.querySelector('#lpYsHold');
  const holdText = overlay.querySelector('#lpYsHoldText');
  const titleEl = overlay.querySelector('#lpYsTitle');
  if (titleEl) titleEl.textContent = profile?.doneTitle || 'Giriş hazır';
  if (hold) hold.classList.add('is-done');
  if (holdText) holdText.textContent = profile?.doneHold || 'Token yenilendi. Yemeksepeti açılıyor.';
  const beats = profile?.beats || [
    { step: 3, title: 'Token yenilendi', detail: 'Adres bağlanıyor.', wait: 550 },
    { step: 4, title: 'Yemeksepeti açılıyor', detail: 'Oturum hazır, yönlendiriliyorsunuz.', wait: 450 },
  ];
  for (const beat of beats) {
    paintYsProgress(overlay, {
      step: beat.step,
      title: beat.title,
      detail: beat.detail,
      pct: 100,
      remainText: 'hazır',
    });
    await new Promise((r) => setTimeout(r, beat.wait || 400));
  }
}

function hideLoginProgress() {
  stopYsRefreshClock();
  const overlay = document.getElementById('loginProgressOverlay');
  if (overlay) {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s ease';
    setTimeout(() => overlay.remove(), 300);
  }
}

/**
 * Load user data
 */
async function loadUserData() {
  try {
    // Fetch IP address
    fetchIPAddress();
  } catch (error) {
    console.error('Error loading user data:', error);
  }
}

/**
 * Fetch IP address
 */
async function fetchIPAddress() {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    
    const ipElement = document.getElementById('connectionIP');
    if (ipElement && data.ip) {
      ipElement.textContent = `IP: ${data.ip}`;
    }
  } catch (error) {
    console.error('Error fetching IP:', error);
    const ipElement = document.getElementById('connectionIP');
    if (ipElement) {
      ipElement.textContent = 'IP: Alınamadı';
    }
  }
}

/**
 * Load token history
 */
async function loadTokenHistory() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'GET_TOKEN_HISTORY'
    });
    
    // Token history loaded
  } catch (error) {
    console.error('Error loading token history:', error);
  }
}

/**
 * Load activity logs
 */
async function loadActivityLogs() {
  try {
    const logs = await chrome.storage.local.get('kuponstore_logs');
    const logList = logs.kuponstore_logs || [];
    
    if (logList.length === 0) {
      ui.logContainer.innerHTML = `
        <div class="log-empty">
          <span class="material-symbols-rounded">receipt_long</span>
          <p>Henüz işlem kaydı yok</p>
        </div>
      `;
      try { updateStatusSummary(); } catch (_) {}
      return;
    }

    ui.logContainer.innerHTML = '';

    logList.slice(0, 10).forEach(log => {
      const logItem = createLogItem(log);
      ui.logContainer.appendChild(logItem);
    });

    try { updateStatusSummary(); } catch (_) {}
  } catch (error) {
    console.error('Error loading logs:', error);
  }
}

/**
 * Create log item element
 */
function createLogItem(log) {
  const div = document.createElement('div');
  div.className = 'log-item';
  
  const iconClass = log.type === 'success' ? 'success' : 
                    log.type === 'error' ? 'error' : 'info';
  
  const iconName = log.type === 'success' ? 'check_circle' :
                   log.type === 'error' ? 'error' : 'info';
  
  const time = new Date(log.timestamp).toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit'
  });
  
  div.innerHTML = `
    <div class="log-icon ${iconClass}">
      <span class="material-symbols-rounded">${iconName}</span>
    </div>
    <div class="log-content">
      <div class="log-message">${log.message}</div>
      <div class="log-time">${time}</div>
    </div>
  `;
  
  return div;
}

/**
 * Handle clear logs
 */
async function handleClearLogs() {
  try {
    // Loglar StorageManager tarafından HEM local HEM sync'e yazılıyor ve okuma
    // sync-öncelikli. Yalnız local'i temizlemek yetmez: sync'teki kopya bir
    // sonraki logManager.addLog() çağrısında (getLogs sync'ten okuyup her iki
    // depoya geri yazıyor) logları geri getiriyordu. Bu yüzden iki depoyu da
    // temizliyoruz.
    await Promise.allSettled([
      new Promise((res) => { try { chrome.storage.local.remove('kuponstore_logs', res); } catch (_) { res(); } }),
      new Promise((res) => { try { chrome.storage.sync.remove('kuponstore_logs', res); } catch (_) { res(); } })
    ]);
    await loadActivityLogs();
    showToast('success', 'İşlem kayıtları temizlendi');
  } catch (error) {
    showToast('error', 'Kayıtlar temizlenirken hata oluştu');
  }
}

/**
 * Kısa göreli zaman etiketi (ör. "2 dk", "3 sa", "Dün").
 */
function ksRelativeShort(ts) {
  const diff = Date.now() - Number(ts);
  if (!ts || isNaN(diff) || diff < 0) return '—';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Az önce';
  if (m < 60) return m + ' dk';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' sa';
  const g = Math.floor(h / 24);
  if (g === 1) return 'Dün';
  if (g < 7) return g + ' gün';
  return Math.floor(g / 7) + ' hf';
}

/**
 * Adres etiketini kısa metne çevir (home→Ev, work→İş, other→özel).
 */
function ksAddrLabel(addr) {
  if (!addr) return null;
  if (addr.label === 'other' && addr.customLabel) return addr.customLabel;
  const map = { home: 'Ev', work: 'İş', other: 'Diğer' };
  return map[addr.label] || 'Adres';
}

/**
 * Durum özeti kartlarını (Hesap • Adres • Son giriş) storage'dan doldur.
 * Hem ilk yüklemede hem log/oturum değişiminde çağrılır.
 */
async function updateStatusSummary() {
  if (!window.ui || !ui.statusSummary) return;

  // Hesap: kuponstore üyeliği bağlı mı?
  try {
    const r = await new Promise((res) => chrome.storage.local.get('ks_user', (d) => res(d || {})));
    const u = r.ks_user;
    const connected = !!(u && (u.name || u.username));
    if (ui.scAccount) {
      ui.scAccount.textContent = connected ? 'Bağlı' : 'Bağlı değil';
      ui.scAccount.className = 'sc-v ' + (connected ? 'on' : 'off');
    }
  } catch (_) {}

  // Adres: aktif adres etiketi veya kayıtlı adres sayısı
  try {
    const d = await new Promise((res) =>
      chrome.storage.local.get(['kuponstore_addresses', 'kuponstore_active_address'], (x) => res(x || {})));
    const list = Array.isArray(d.kuponstore_addresses) ? d.kuponstore_addresses : [];
    if (ui.scAddress) {
      if (list.length) {
        const activeId = d.kuponstore_active_address;
        const active = (activeId && list.find((a) => a.id === activeId)) || list[0];
        ui.scAddress.textContent = ksAddrLabel(active) || (list.length + ' adres');
        ui.scAddress.className = 'sc-v';
      } else {
        ui.scAddress.textContent = 'Yok';
        ui.scAddress.className = 'sc-v off';
      }
    }
  } catch (_) {}

  // Son giriş: en son başarılı işlem kaydının zamanı
  try {
    const l = await new Promise((res) => chrome.storage.local.get('kuponstore_logs', (x) => res(x || {})));
    const logs = Array.isArray(l.kuponstore_logs) ? l.kuponstore_logs : [];
    const s = logs.find((x) => x && x.type === 'success') || logs[0];
    if (ui.scLast) {
      ui.scLast.textContent = s && s.timestamp ? ksRelativeShort(s.timestamp) : '—';
      ui.scLast.className = 'sc-v';
    }
  } catch (_) {}
}

/**
 * Update greeting based on time + (varsa) kuponstore.com kullanıcı adı
 *
 * Eklenti kuponstore.com hesabıyla otomatik bağlandıysa storage'da
 * 'ks_user' kaydı olur (telemetry.js tarafından doldurulur).
 * Bu fonksiyon hem ilk yüklemede hem de KS_AUTH_UPDATED mesajında çağrılır.
 */
async function updateGreeting() {
  const hour = new Date().getHours();
  let timeGreeting = 'Hoş geldiniz';
  let timeEmoji = '✨';

  if (hour >= 5 && hour < 12) {
    timeGreeting = 'Günaydın';
    timeEmoji = '☀️';
  } else if (hour >= 12 && hour < 18) {
    timeGreeting = 'İyi günler';
    timeEmoji = '👋';
  } else if (hour >= 18 && hour < 22) {
    timeGreeting = 'İyi akşamlar';
    timeEmoji = '🌆';
  } else {
    timeGreeting = 'İyi geceler';
    timeEmoji = '🌙';
  }

  // İsim sırası: kayıtlı adres adı, sonra kuponstore üyeliği.
  // Adres adı eklenti kapanınca da durur; bir sonraki açılışta selamlama aynı kişiyle gelir.
  let firstName = null;
  try {
    const r = await new Promise((resolve) => {
      chrome.storage.local.get(
        ['ks_user', 'kuponstore_addresses', 'kuponstore_active_address', 'savedAddress'],
        (data) => resolve(data || {})
      );
    });
    const list = Array.isArray(r.kuponstore_addresses) ? r.kuponstore_addresses : [];
    const active = (r.kuponstore_active_address && list.find((a) => a && a.id === r.kuponstore_active_address))
      || list.find((a) => a && (a.autoAddAddress || a.isActive))
      || list[0]
      || null;
    let full = active && active.fullname ? String(active.fullname).trim() : '';
    if (!full && r.savedAddress) {
      try {
        const saved = typeof r.savedAddress === 'string' ? JSON.parse(r.savedAddress) : r.savedAddress;
        if (saved && saved.fullname) full = String(saved.fullname).trim();
      } catch (_) {}
    }
    if (!full) {
      const user = r.ks_user;
      if (user && (user.name || user.username)) full = String(user.name || user.username).trim();
    }
    if (full) firstName = full.split(/\s+/)[0];
  } catch (_) {}

  let html;
  if (firstName) {
    html = `${timeGreeting}, <strong class="greeting-name">${escapeHtmlSafe(firstName)}</strong> ${timeEmoji}`;
  } else {
    html = `${timeGreeting}! ${timeEmoji}`;
  }

  if (ui.greetingText) {
    ui.greetingText.innerHTML = html;
    ui.greetingText.style.display = '';   // gizliydi, görünür yap
  }

  // KuponStore üyelik bağlama banner'ı: yalnız bağlı değilse göster
  if (ui.ksLinkBanner) {
    ui.ksLinkBanner.style.display = firstName ? 'none' : 'flex';
  }
}

/**
 * "Üye Girişi" butonu tıklanınca kuponstore.com'un giriş sayfasını yeni
 * sekmede aç. Kullanıcı orada giriş yapar yapmaz background tarafındaki
 * cookie watcher (telemetry.js) yeni session cookie'sini görüp otomatik
 * reauth eder; ks_user storage'a düşer ve banner kaybolur.
 */
function bindKsLinkBanner() {
  if (!ui.ksLinkBannerBtn) return;
  ui.ksLinkBannerBtn.addEventListener('click', () => {
    const url = 'https://kuponstore.com/login?from=ext';
    try {
      if (chrome?.tabs?.create) {
        chrome.tabs.create({ url, active: true });
      } else {
        window.open(url, '_blank');
      }
    } catch (_) {
      try { window.open(url, '_blank'); } catch (_) {}
    }
  });
}

function escapeHtmlSafe(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * Telemetri tarafı user bilgisini güncellediğinde canlı yenileme.
 */
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'KS_AUTH_UPDATED') {
      updateGreeting();
      updateStatusSummary();
    }
  });
  // Storage değişince de yakala (background SW dışında değişiklik olursa)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.ks_user || changes.kuponstore_addresses ||
        changes.kuponstore_active_address || changes.savedAddress || changes.kuponstore_logs)) {
      updateGreeting();
      updateStatusSummary();
    }
  });
} catch (_) {}

/**
 * Load theme
 */
function loadTheme() {
  chrome.storage.local.get('kuponstore_theme', (result) => {
    const theme = result.kuponstore_theme || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeIcon(theme);
  });
}

/**
 * Toggle theme
 */
function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  
  document.documentElement.setAttribute('data-theme', newTheme);
  chrome.storage.local.set({ kuponstore_theme: newTheme });
  updateThemeIcon(newTheme);
  
  showToast('success', `${newTheme === 'dark' ? 'Koyu' : 'Açık'} tema aktif`);
}

/**
 * Update theme icon
 */
function updateThemeIcon(theme) {
  if (!ui || !ui.themeToggle) return;
  const icon = ui.themeToggle.querySelector('.material-symbols-rounded');
  if (icon) icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
}

/**
 * Get relative time string
 */
function getTimeAgo(timestamp) {
  if (!timestamp) return '';
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'Az önce';
  if (minutes < 60) return `${minutes} dk önce`;
  if (hours < 24) return `${hours} saat önce`;
  if (days < 7) return `${days} gün önce`;
  return new Date(timestamp).toLocaleDateString('tr-TR');
}

/**
 * Show token history
 */
async function showTokenHistory() {
  const modal = document.getElementById('tokenHistoryModal');
  const overlay = document.getElementById('tokenHistoryOverlay');
  const closeBtn = document.getElementById('closeTokenHistoryModal');
  const clearAllBtn = document.getElementById('clearHistoryBtn');
  const listContainer = document.getElementById('tokenHistoryList');

  const platformNames = {
    migros: 'Migros', trendyol: 'Trendyol Yemek', getir: 'Getir',
    yemeksepeti: 'Yemeksepeti', uber: 'Uber Eats', hepsiburada: 'Hepsiburada'
  };
  const platformIcons = {
    migros: 'shopping_cart', trendyol: 'restaurant', getir: 'delivery_dining',
    yemeksepeti: 'fastfood', uber: 'local_taxi', hepsiburada: 'card_giftcard'
  };

  async function renderHistory() {
    try {
      const result = await chrome.storage.local.get('kuponstore_tokens');
      const rawHistory = Array.isArray(result.kuponstore_tokens) ? result.kuponstore_tokens : [];
      const tokenHistoryMaxAge = 24 * 60 * 60 * 1000;
      const now = Date.now();
      // Süresi dolan tokenlar DOM'a hiç eklenmez: görüntülenemez,
      // kopyalanamaz ve geçmiş üzerinden tekrar girişte kullanılamaz.
      const history = rawHistory
        .map((item, storageIndex) => ({ ...item, storageIndex }))
        .filter(item => {
          const timestamp = Number(item.timestamp);
          return Number.isFinite(timestamp) && timestamp > 0 &&
            (now - timestamp) < tokenHistoryMaxAge;
        });

      if (history.length === 0) {
        clearAllBtn.style.display = 'none';
        listContainer.innerHTML = `
          <div class="empty-state">
            <span class="material-symbols-rounded">history</span>
            <h4>Henüz token geçmişi yok</h4>
            <p>Giriş yaptığınız tokenler burada görünecek</p>
          </div>`;
        return;
      }

      clearAllBtn.style.display = 'flex';
      listContainer.innerHTML = history.slice(0, 20).map((item) => {
        const pName = platformNames[item.platform] || item.name || item.platform || 'Bilinmeyen';
        const pIcon = platformIcons[item.platform] || 'key';
        const timeAgo = getTimeAgo(item.timestamp);
        const shortToken = item.token.length > 28 ? item.token.substring(0, 28) + '…' : item.token;
        return `
        <div class="history-item" data-index="${item.storageIndex}">
          <div class="history-icon ${item.platform || ''}">
            <span class="material-symbols-rounded">${pIcon}</span>
          </div>
          <div class="history-content">
            <div class="history-platform">${pName}</div>
            <div class="history-token">${shortToken}</div>
            <div class="history-time">
              <span class="material-symbols-rounded" style="font-size:13px;vertical-align:-2px">schedule</span>
              ${timeAgo}
            </div>
          </div>
          <div class="history-actions">
            <button class="history-use-btn" data-token="${item.token}" title="Bu token ile giriş yap">
              <span class="material-symbols-rounded">login</span>
            </button>
            <button class="history-copy-btn" data-token="${item.token}" title="Kopyala">
              <span class="material-symbols-rounded">content_copy</span>
            </button>
            <button class="history-delete-btn" data-index="${item.storageIndex}" title="Sil">
              <span class="material-symbols-rounded">delete</span>
            </button>
          </div>
        </div>`;
      }).join('');

      // Copy
      listContainer.querySelectorAll('.history-copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          navigator.clipboard.writeText(btn.dataset.token);
          showToast('success', 'Token kopyalandı');
        });
      });

      // Use
      listContainer.querySelectorAll('.history-use-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          ui.tokenInput.value = btn.dataset.token;
          handleTokenInput({ target: ui.tokenInput });
          closeModal();
          showToast('info', 'Token yapıştırıldı');
        });
      });

      // Delete single
      listContainer.querySelectorAll('.history-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const idx = parseInt(btn.dataset.index);
          const res = await chrome.storage.local.get('kuponstore_tokens');
          const tokens = res.kuponstore_tokens || [];
          tokens.splice(idx, 1);
          await chrome.storage.local.set({ kuponstore_tokens: tokens });
          showToast('success', 'Token silindi');
          renderHistory();
        });
      });

    } catch (error) {
      console.error('Error loading token history:', error);
      listContainer.innerHTML = '<p style="padding:16px;color:var(--text-tertiary)">Token geçmişi yüklenemedi</p>';
    }
  }

  // Show modal
  modal.style.display = 'flex';
  setTimeout(() => modal.classList.add('active'), 10);
  await renderHistory();

  // Clear all
  clearAllBtn.onclick = async () => {
    await chrome.storage.local.set({ kuponstore_tokens: [] });
    showToast('success', 'Tüm geçmiş temizlendi');
    renderHistory();
  };

  // Close
  const closeModal = () => {
    modal.classList.remove('active');
    setTimeout(() => modal.style.display = 'none', 300);
  };

  closeBtn.onclick = closeModal;
  overlay.onclick = closeModal;
}

/**
 * Show settings
 */
async function showSettings() {
  const modal = document.getElementById('settingsModal');
  const overlay = document.getElementById('settingsOverlay');
  const closeBtn = document.getElementById('closeSettingsModal');
  
  // Load settings
  try {
    const result = await chrome.storage.local.get([
      'kuponstore_auto_login', 'kuponstore_notifications',
      'kuponstore_block_analytics', 'kuponstore_clear_cache',
      'uberMode'
    ]);
    document.getElementById('autoLoginSetting').checked = result.kuponstore_auto_login || false;
    document.getElementById('notificationsSetting').checked = result.kuponstore_notifications !== false;
    document.getElementById('blockAnalyticsSetting').checked = result.kuponstore_block_analytics !== false;
    document.getElementById('clearCacheSetting').checked = result.kuponstore_clear_cache !== false;
    const uberIosEl = document.getElementById('uberIosModeSetting');
    if (uberIosEl) uberIosEl.checked = result.uberMode === 'ios';
    
    // Save handlers
    const settingsMap = {
      autoLoginSetting: 'kuponstore_auto_login',
      notificationsSetting: 'kuponstore_notifications',
      blockAnalyticsSetting: 'kuponstore_block_analytics',
      clearCacheSetting: 'kuponstore_clear_cache'
    };
    
    Object.entries(settingsMap).forEach(([id, key]) => {
      document.getElementById(id).onchange = (e) => {
        chrome.storage.local.set({ [key]: e.target.checked });
        showToast('success', 'Ayar kaydedildi');
      };
    });

    // Uber iOS modu özel: 'android' | 'ios' string olarak kaydet
    if (uberIosEl) {
      uberIosEl.onchange = (e) => {
        const mode = e.target.checked ? 'ios' : 'android';
        chrome.storage.local.set({ uberMode: mode });
        showToast('success', mode === 'ios'
          ? 'Uber iOS modu açıldı (macOS Safari + JA3 bypass)'
          : 'Uber Android modu (varsayılan)');
      };
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
  
  // Show modal
  modal.style.display = 'flex';
  setTimeout(() => modal.classList.add('active'), 10);
  
  // Close handlers
  const closeModal = () => {
    modal.classList.remove('active');
    setTimeout(() => modal.style.display = 'none', 300);
  };
  
  closeBtn.onclick = closeModal;
  overlay.onclick = closeModal;
}

/**
 * Migros adres hatası — çok basit, güçlü ve yönlendirici uyarı.
 * Kullanıcı kendi başına düzeltebilsin diye kısa cümle + net adımlar.
 */
/**
 * Adres sync hatasını kullanıcıya net göster (Trendyol / diğer platformlar)
 */
function showAddressErrorPopup(options = {}) {
  const {
    platformName = 'Platform',
    message = 'Adres eklenemedi.',
    reason = '',
  } = options;

  return new Promise((resolve) => {
    const existing = document.getElementById('ksAddrErrPopup');
    if (existing) existing.remove();

    const safeMsg = String(message || 'Adres eklenemedi.')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const safePlatform = String(platformName || 'Platform')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const overlay = document.createElement('div');
    overlay.id = 'ksAddrErrPopup';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.62);display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" style="width:100%;max-width:420px;background:#fff;border-radius:20px;box-shadow:0 28px 70px rgba(0,0,0,.32);overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,sans-serif;">
        <div style="background:linear-gradient(135deg,#b91c1c,#dc2626);padding:16px 18px;color:#fff;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="material-symbols-rounded" style="font-size:28px;">error</span>
            <div style="font-size:18px;font-weight:900;">Adres eklenemedi</div>
          </div>
          <div style="margin-top:6px;font-size:13px;opacity:.9;font-weight:600;">${safePlatform}</div>
        </div>
        <div style="padding:16px 18px;">
          <div style="font-size:12px;font-weight:800;color:#991b1b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">Alınan hata</div>
          <div style="padding:12px 14px;border-radius:12px;background:#fef2f2;border:1px solid #fecaca;color:#7f1d1d;font-size:14px;line-height:1.55;font-weight:600;word-break:break-word;white-space:pre-line;">
            ${safeMsg}
          </div>
          ${reason ? `<div style="margin-top:8px;font-size:11px;color:#94a3b8;">Kod: ${String(reason).replace(/</g, '')}</div>` : ''}
        </div>
        <div style="padding:0 18px 18px;display:flex;flex-direction:column;gap:8px;">
          <button type="button" id="ksAddrErrFix" style="width:100%;min-height:48px;border:0;border-radius:14px;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-weight:900;font-size:15px;cursor:pointer;">
            Adresi düzelt
          </button>
          <button type="button" id="ksAddrErrClose" style="width:100%;min-height:42px;border:0;border-radius:12px;background:#f1f5f9;color:#475569;font-weight:700;font-size:14px;cursor:pointer;">
            Siteye devam et
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const finish = (openModal) => {
      overlay.remove();
      if (openModal && window.addressModalInstance?.open) {
        try { window.addressModalInstance.open(); } catch (_) {}
      }
      resolve(openModal);
    };

    overlay.querySelector('#ksAddrErrFix')?.addEventListener('click', () => finish(true));
    overlay.querySelector('#ksAddrErrClose')?.addEventListener('click', () => finish(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });
  });
}

function showMigrosAddressHelpPopup(options = {}) {
  const {
    reason = 'missing_coords',
    openAddressModal = true,
  } = options;

  return new Promise((resolve) => {
    const existing = document.getElementById('ksMigrosAddrHelp');
    if (existing) existing.remove();

    const isNoAddr = reason === 'no_saved_address';
    const title = isNoAddr ? 'Önce adres ekleyin' : 'Adres eklenmedi';
    const lead = isNoAddr
      ? 'Migros’a girmek için önce doğru adres kaydetmelisiniz.'
      : 'Adresiniz eklenmedi. Sebep: Haritada konumunuzu doğru işaretlemediniz.';

    const overlay = document.createElement('div');
    overlay.id = 'ksMigrosAddrHelp';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.62);display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" style="width:100%;max-width:440px;background:#fff;border-radius:20px;box-shadow:0 28px 70px rgba(0,0,0,.32);overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,sans-serif;">
        <div style="background:linear-gradient(135deg,#c2410c,#ea580c);padding:16px 18px;color:#fff;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="material-symbols-rounded" style="font-size:28px;">warning</span>
            <div style="font-size:18px;font-weight:900;letter-spacing:.2px;">${title}</div>
          </div>
          <div style="margin-top:8px;font-size:14.5px;line-height:1.45;font-weight:600;opacity:.95;">${lead}</div>
        </div>
        <div style="padding:16px 18px 6px;">
          <div style="font-size:13px;font-weight:800;color:#9a3412;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;">Nasıl düzelteceksiniz?</div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <div style="display:flex;gap:10px;align-items:flex-start;background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:10px 12px;">
              <div style="width:26px;height:26px;border-radius:999px;background:#ea580c;color:#fff;font-weight:900;font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">1</div>
              <div style="font-size:14.5px;line-height:1.45;color:#1e293b;"><b>Adresi aratın</b><br><span style="color:#64748b;">Google Maps’te nasıl yazıyorsa <b>aynen öyle</b> yazın.</span></div>
            </div>
            <div style="display:flex;gap:10px;align-items:flex-start;background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:10px 12px;">
              <div style="width:26px;height:26px;border-radius:999px;background:#ea580c;color:#fff;font-weight:900;font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">2</div>
              <div style="font-size:14.5px;line-height:1.45;color:#1e293b;"><b>Listeden seçin</b><br><span style="color:#64748b;">Çıkan sonuçlardan <b>doğru adrese</b> tıklayın.</span></div>
            </div>
            <div style="display:flex;gap:10px;align-items:flex-start;background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:10px 12px;">
              <div style="width:26px;height:26px;border-radius:999px;background:#ea580c;color:#fff;font-weight:900;font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">3</div>
              <div style="font-size:14.5px;line-height:1.45;color:#1e293b;"><b>Haritada pin koyun</b><br><span style="color:#64748b;">İğneyi <b>evinizin üstüne</b> getirin. Bu adım şart.</span></div>
            </div>
            <div style="display:flex;gap:10px;align-items:flex-start;background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:10px 12px;">
              <div style="width:26px;height:26px;border-radius:999px;background:#ea580c;color:#fff;font-weight:900;font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">4</div>
              <div style="font-size:14.5px;line-height:1.45;color:#1e293b;"><b>Kaydet → tekrar giriş</b><br><span style="color:#64748b;">Kaydet’e basın, sonra token ile tekrar giriş yapın.</span></div>
            </div>
          </div>
          <div style="margin:14px 0 0;padding:10px 12px;border-radius:12px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b;font-size:13.5px;line-height:1.45;font-weight:700;">
            Sadece il/ilçe yazmak yetmez. Google Maps’teki gibi seçmezseniz adres eklenmez.
          </div>
        </div>
        <div style="padding:14px 18px 18px;display:flex;flex-direction:column;gap:8px;">
          <button type="button" id="ksMigrosAddrHelpFix" style="width:100%;min-height:52px;border:0;border-radius:14px;background:linear-gradient(135deg,#c2410c,#ea580c);color:#fff;font-weight:900;font-size:15.5px;cursor:pointer;">
            Adresi şimdi düzelteceğim
          </button>
          <button type="button" id="ksMigrosAddrHelpClose" style="width:100%;min-height:42px;border:0;border-radius:12px;background:#f1f5f9;color:#475569;font-weight:700;font-size:14px;cursor:pointer;">
            Sonra yapacağım
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const finish = (openModal) => {
      overlay.remove();
      if (openModal && openAddressModal && window.addressModalInstance?.open) {
        try { window.addressModalInstance.open(); } catch (_) {}
      }
      resolve();
    };

    overlay.querySelector('#ksMigrosAddrHelpFix')?.addEventListener('click', () => finish(true));
    overlay.querySelector('#ksMigrosAddrHelpClose')?.addEventListener('click', () => finish(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });
  });
}

/**
 * Show toast notification
 */
function showToast(type, message) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const iconName = type === 'success' ? 'check_circle' :
                   type === 'error' ? 'error' : 'info';
  
  toast.innerHTML = `
    <span class="material-symbols-rounded toast-icon">${iconName}</span>
    <span class="toast-message">${message}</span>
  `;
  
  ui.toastContainer.appendChild(toast);
  
  // Auto remove after 3 seconds
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

/**
 * Show loading overlay
 */
function showLoading(text = 'İşlem yapılıyor...') {
  ui.loadingText.textContent = text;
  ui.loadingOverlay.style.display = 'flex';
}

/**
 * Hide loading overlay
 */
function hideLoading() {
  ui.loadingOverlay.style.display = 'none';
}

/**
 * Check update status and show banner or blocker
 */
async function checkUpdateStatus() {
  try {
    const res = await fetch(CONFIG.updateCheckUrl, {
      method: 'GET',
      headers: { 'X-Extension-Version': CONFIG.version }
    });

    if (res.ok) {
      const data = await res.json();
      if (data.latestVersion) {
        const toArr = v => v.replace(/[^0-9.]/g, '').split('.').map(Number);
        const isNewer = (local, remote) => {
          const l = toArr(local), r = toArr(remote);
          for (let i = 0; i < Math.max(l.length, r.length); i++) {
            if ((r[i]||0) > (l[i]||0)) return true;
            if ((r[i]||0) < (l[i]||0)) return false;
          }
          return false;
        };

        const hasUpdate = isNewer(CONFIG.version, data.latestVersion);
        const isMandatory = data.type === 'mandatory' && data.minRequiredVersion && isNewer(CONFIG.version, data.minRequiredVersion);

        const info = {
          hasUpdate, isMandatory,
          latestVersion: data.latestVersion,
          currentVersion: CONFIG.version,
          message: data.message || '',
          changelog: data.changelog || [],
          downloadUrl: data.downloadUrl || 'https://kuponstore.com/extension',
          checkedAt: Date.now()
        };

        await chrome.storage.local.set({ kuponstore_update_info: info });

        if (!hasUpdate) return;
        if (isMandatory) return showUpdateBlocker(info);
        return showUpdateBanner(info);
      }
    }
  } catch (e) {
    console.warn('[KuponStore] Live update check failed, reading cache:', e.message);
  }

  // Canlı kontrol başarısızsa cache'den oku
  try {
    const result = await chrome.storage.local.get('kuponstore_update_info');
    const info = result.kuponstore_update_info;
    if (!info || !info.hasUpdate) return;

    if (info.isMandatory) showUpdateBlocker(info);
    else showUpdateBanner(info);
  } catch (e) {
    console.warn('[KuponStore] Could not read update info:', e.message);
  }
}

function showUpdateBanner(info) {
  const banner = document.getElementById('updateBanner');
  const msg = document.getElementById('updateBannerMsg');
  const btn = document.getElementById('updateBannerBtn');
  const closeBtn = document.getElementById('updateBannerClose');

  msg.textContent = info.message || `v${info.latestVersion} sürümü kullanılabilir.`;
  btn.href = info.downloadUrl;

  banner.style.display = 'flex';
  requestAnimationFrame(() => banner.classList.add('visible'));

  closeBtn.onclick = () => {
    banner.classList.remove('visible');
    setTimeout(() => banner.style.display = 'none', 300);
  };
}

function showUpdateBlocker(info) {
  const blocker = document.getElementById('updateBlocker');
  const msg = document.getElementById('updateBlockerMsg');
  const btn = document.getElementById('updateBlockerBtn');
  const current = document.getElementById('updateBlockerCurrent');
  const latest = document.getElementById('updateBlockerLatest');
  const changelog = document.getElementById('updateBlockerChangelog');
  const exportBtn = document.getElementById('updateBlockerExportBtn');

  msg.textContent = info.message || 'Bu eklenti sürümü artık desteklenmiyor. Devam etmek için lütfen güncelleyin.';
  btn.href = info.downloadUrl;
  current.textContent = `v${info.currentVersion}`;
  latest.textContent = `v${info.latestVersion}`;

  if (info.changelog && info.changelog.length) {
    changelog.innerHTML = info.changelog.map(c => `<li>${c}</li>`).join('');
  }

  if (exportBtn && !exportBtn.dataset.bound) {
    exportBtn.dataset.bound = '1';
    exportBtn.addEventListener('click', () => exportUserData(info));
  }

  blocker.style.display = 'flex';
  requestAnimationFrame(() => blocker.classList.add('visible'));
}

/**
 * Kullanıcının kayıtlı adreslerini JSON olarak dışa aktarır.
 * Zorunlu güncelleme ekranında bile çalışır — sadece chrome.storage.local okur.
 */
async function exportUserData(info) {
  const btn = document.getElementById('updateBlockerExportBtn');
  const originalLabel = btn ? btn.innerHTML : '';
  try {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="material-symbols-rounded">hourglass_top</span> Hazırlanıyor...';
    }

    const data = await chrome.storage.local.get(['kuponstore_addresses']);

    const addresses = Array.isArray(data.kuponstore_addresses) ? data.kuponstore_addresses : [];

    const json = JSON.stringify(addresses, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const filename = `kuponstore-addresses-${Date.now()}.json`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch (_) {}
      try { a.remove(); } catch (_) {}
    }, 1500);

    if (btn) {
      btn.innerHTML = '<span class="material-symbols-rounded">check_circle</span> İndirildi';
      setTimeout(() => {
        btn.innerHTML = originalLabel;
        btn.disabled = false;
      }, 2200);
    }

    if (typeof showToast === 'function') {
      showToast(`${addresses.length} adres indirildi.`, 'success');
    }
  } catch (e) {
    console.error('[KuponStore] Adres dışa aktarma hatası:', e);
    if (btn) {
      btn.innerHTML = '<span class="material-symbols-rounded">error</span> Hata oluştu';
      setTimeout(() => {
        btn.innerHTML = originalLabel;
        btn.disabled = false;
      }, 2500);
    }
    if (typeof showToast === 'function') {
      showToast('Adres indirme başarısız: ' + (e.message || e), 'error');
    } else {
      alert('Adres indirme başarısız: ' + (e.message || e));
    }
  }
}

// Add slideOut animation to CSS
const style = document.createElement('style');
style.textContent = `
  @keyframes slideOut {
    to {
      transform: translateX(100%);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);
