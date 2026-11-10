/* Eklenti acikken tgoyemek cerezlerini sayfanin silebilecegi hale getirir.
   Kapanma aninda (port kopunca) bu sekmenin tgoyemek cerezleri silinir ve sayfa bir kez yenilenir. */
(function () {
  if (window.top !== window) return;
  var host = String(location.hostname || "").toLowerCase();
  if (!/(^|\.)tgoyemek\.com$/.test(host) && !/(^|\.)tgoapps\.com$/.test(host)) return;

  var KNOWN = [
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
    "refresh_token",
    "tgo-missing-user-info-popup-date",
    "tgo-missing-user-info-popup-basket-date"
  ];
  var PATHS = ["/", "/restoranlar", "/odeme", "/api", "/api/app-context", "/giris", "/sepet", "/hesabim", "/hesap"];
  var dying = false;
  var port = null;

  function alive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function beat() {
    if (!alive()) return;
    try {
      document.documentElement.setAttribute("data-ks-ty-beat", String(Date.now()));
      sessionStorage.removeItem("ksTyCookieDie");
    } catch (e) {}
  }

  function rememberNames(names) {
    if (!names || !names.length) return;
    try {
      var prev = document.documentElement.getAttribute("data-ks-ty-names") || "";
      var set = {};
      var i;
      var parts = prev ? prev.split("|") : [];
      for (i = 0; i < parts.length; i++) if (parts[i]) set[parts[i]] = 1;
      for (i = 0; i < names.length; i++) if (names[i]) set[names[i]] = 1;
      var out = [];
      for (var key in set) if (Object.prototype.hasOwnProperty.call(set, key)) out.push(key);
      document.documentElement.setAttribute("data-ks-ty-names", out.join("|"));
    } catch (e) {}
  }

  function lease() {
    if (!alive()) return;
    try {
      chrome.runtime.sendMessage({ action: "ksTyLeaseNow" }, function (res) {
        try { void chrome.runtime.lastError; } catch (e) {}
        if (res && res.names) rememberNames(res.names);
        if (res && res.jar) {
          try { document.documentElement.setAttribute("data-ks-ty-jar", JSON.stringify(res.jar)); } catch (e2) {}
        }
      });
    } catch (e) {}
  }

  function cookieNames() {
    var set = {};
    var i;
    for (i = 0; i < KNOWN.length; i++) set[KNOWN[i]] = 1;
    try {
      var stored = document.documentElement.getAttribute("data-ks-ty-names") || "";
      var parts = stored ? stored.split("|") : [];
      for (i = 0; i < parts.length; i++) if (parts[i]) set[parts[i]] = 1;
    } catch (e) {}
    try {
      var raw = String(document.cookie || "");
      var bits = raw ? raw.split(";") : [];
      for (i = 0; i < bits.length; i++) {
        var name = bits[i].split("=")[0].replace(/^\s+|\s+$/g, "");
        if (name) set[name] = 1;
      }
    } catch (e2) {}
    var out = [];
    for (var key in set) if (Object.prototype.hasOwnProperty.call(set, key)) out.push(key);
    return out;
  }

  function dropCookie(name, path, domain, secure) {
    var exp = "expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0";
    var line = name + "=; " + exp + "; path=" + (path || "/");
    if (domain) line += "; domain=" + domain;
    if (secure) line += "; secure";
    document.cookie = line;
  }

  function wipeTgoyemekCookies() {
    if (!/(^|\.)tgoyemek\.com$/.test(host)) return;
    var names = cookieNames();
    var domains = [host, "." + host, "tgoyemek.com", ".tgoyemek.com"];
    var n, d, p, i;
    try {
      var jar = JSON.parse(document.documentElement.getAttribute("data-ks-ty-jar") || "[]");
      if (jar && jar.length) {
        for (i = 0; i < jar.length; i++) {
          if (!jar[i] || !jar[i].name) continue;
          dropCookie(jar[i].name, jar[i].path || "/", jar[i].domain || "", false);
          dropCookie(jar[i].name, jar[i].path || "/", jar[i].domain || "", true);
        }
      }
    } catch (e) {}
    for (n = 0; n < names.length; n++) {
      for (p = 0; p < PATHS.length; p++) {
        dropCookie(names[n], PATHS[p], "", false);
        dropCookie(names[n], PATHS[p], "", true);
        for (d = 0; d < domains.length; d++) {
          dropCookie(names[n], PATHS[p], domains[d], false);
          dropCookie(names[n], PATHS[p], domains[d], true);
        }
      }
    }
  }

  function dieAndClear() {
    if (dying) return;
    dying = true;
    try { document.documentElement.setAttribute("data-ks-ty-dead", "1"); } catch (e) {}
    wipeTgoyemekCookies();
    try {
      if (sessionStorage.getItem("ksTyCookieDie") === "1") return;
      sessionStorage.setItem("ksTyCookieDie", "1");
    } catch (e2) {}
    try { location.reload(); } catch (e3) {}
  }

  function connect() {
    if (!alive() || port) return;
    try {
      port = chrome.runtime.connect({ name: "ks-ty-life" });
      port.onDisconnect.addListener(function () {
        port = null;
        if (alive()) {
          connect();
          return;
        }
        dieAndClear();
      });
    } catch (e) {
      port = null;
    }
  }

  function plant(code) {
    if (!code) return;
    if (document.documentElement && document.documentElement.getAttribute("data-ks-ty-mask") === "1") return;
    var nonce = "";
    try {
      var found = document.querySelector("script[nonce], style[nonce], [nonce]");
      if (found) nonce = found.nonce || found.getAttribute("nonce") || "";
    } catch (e) {}
    try {
      var inline = document.createElement("script");
      if (nonce) {
        inline.setAttribute("nonce", nonce);
        try { inline.nonce = nonce; } catch (e2) {}
      }
      inline.textContent = code;
      (document.documentElement || document.head).appendChild(inline);
    } catch (e3) {}
  }

  function injectMask() {
    if (!alive()) return;
    if (document.documentElement && document.documentElement.getAttribute("data-ks-ty-mask") === "1") return;
    if (window.__ksTyMaskSrc) {
      plant(window.__ksTyMaskSrc);
      return;
    }
    try {
      fetch(chrome.runtime.getURL("inject/ty-phone-mask.js"))
        .then(function (r) { return r.text(); })
        .then(function (code) {
          window.__ksTyMaskSrc = code;
          plant(code);
        })
        .catch(function () {});
    } catch (e) {}
  }

  connect();
  injectMask();
  beat();
  lease();
  setInterval(function () {
    if (alive()) {
      beat();
      connect();
      injectMask();
      return;
    }
    dieAndClear();
  }, 300);
  setInterval(lease, 2000);
})();
