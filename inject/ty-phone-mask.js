/* Sayfa baglami. Eklenti kapansa da bu dongu sayfada kalir.
   Adres metnine dokunmaz, yalniz telefon satirini siler. Sayfa yenilenmez. */
(function () {
  if (window.__ksTyPhoneMask) return;
  window.__ksTyPhoneMask = 1;
  try { document.documentElement.setAttribute("data-ks-ty-mask", "1"); } catch (e) {}

  var PHONE_RE = /\+\s*\d[\d\s().-]{8,20}\d/g;

  function isPhoneLine(text) {
    var t = String(text || "").trim();
    if (!t || t.length > 28) return false;
    if (/[A-Za-zÀ-ÿ]/.test(t)) return false;
    var digits = t.replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15 && /^[+\d\s().-]+$/.test(t);
  }

  function blankNode(node) {
    var text = node.nodeValue || "";
    if (!text || !/\d/.test(text)) return;
    if (isPhoneLine(text)) {
      node.nodeValue = "";
      return;
    }
    if (text.indexOf("+") === -1) return;
    PHONE_RE.lastIndex = 0;
    if (!PHONE_RE.test(text)) return;
    PHONE_RE.lastIndex = 0;
    node.nodeValue = text.replace(PHONE_RE, "");
  }

  function hideRoot(root) {
    if (!root || !root.nodeType) return;
    try {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode())) blankNode(node);
    } catch (e) {}
    var list = [];
    try {
      if (root.querySelectorAll) list = root.querySelectorAll("*");
    } catch (e2) {}
    for (var i = 0; i < list.length; i++) {
      if (list[i].shadowRoot) hideRoot(list[i].shadowRoot);
    }
  }

  function scrubValue(value) {
    if (typeof value === "string") {
      if (isPhoneLine(value)) return "";
      PHONE_RE.lastIndex = 0;
      return PHONE_RE.test(value) ? value.replace(PHONE_RE, "") : value;
    }
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) value[i] = scrubValue(value[i]);
      return value;
    }
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (/phone|gsm|msisdn|mobile/i.test(key) && typeof value[key] === "string") value[key] = "";
      else value[key] = scrubValue(value[key]);
    }
    return value;
  }

  function hookFetch() {
    if (!window.fetch || window.fetch.__ksTy) return;
    var orig = window.fetch;
    function wrapped(input, init) {
      return orig.apply(this, arguments).then(function (res) {
        try {
          var clone = res.clone();
          return clone.text().then(function (text) {
            if (!text || text.charAt(0) !== "{" && text.charAt(0) !== "[") return res;
            if (!/phone/i.test(text) && text.indexOf("+") === -1) return res;
            var data;
            try { data = JSON.parse(text); } catch (e) { return res; }
            scrubValue(data);
            var headers = new Headers(res.headers);
            headers.delete("content-length");
            return new Response(JSON.stringify(data), {
              status: res.status,
              statusText: res.statusText,
              headers: headers,
            });
          });
        } catch (e) {
          return res;
        }
      });
    }
    wrapped.__ksTy = 1;
    window.fetch = wrapped;
  }

  var PATHS = ["/", "/restoranlar", "/odeme", "/api", "/api/app-context", "/giris", "/sepet", "/hesabim", "/hesap"];
  var KNOWN = ["tgo-token", "access_token", "token", "mobile-token", "user_phone", "user_email", "tgo-address", "tgo-csrf-token", "trendyolWebToken", "sid", "session", "auth_token", "refresh_token"];
  var wiped = false;

  function wipeCookies() {
    var host = String(location.hostname || "").toLowerCase();
    if (!/(^|\.)tgoyemek\.com$/.test(host)) return;
    var names = KNOWN.slice();
    var seen = {};
    var i;
    for (i = 0; i < names.length; i++) seen[names[i]] = 1;
    try {
      var stored = document.documentElement.getAttribute("data-ks-ty-names") || "";
      var parts = stored ? stored.split("|") : [];
      for (i = 0; i < parts.length; i++) {
        if (parts[i] && !seen[parts[i]]) {
          seen[parts[i]] = 1;
          names.push(parts[i]);
        }
      }
    } catch (e) {}
    try {
      var raw = String(document.cookie || "");
      var bits = raw ? raw.split(";") : [];
      for (i = 0; i < bits.length; i++) {
        var name = bits[i].split("=")[0].replace(/^\s+|\s+$/g, "");
        if (name && !seen[name]) {
          seen[name] = 1;
          names.push(name);
        }
      }
    } catch (e2) {}
    var domains = [host, "." + host, "tgoyemek.com", ".tgoyemek.com"];
    var exp = "expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0";
    var n, d, p, j;
    try {
      var jar = JSON.parse(document.documentElement.getAttribute("data-ks-ty-jar") || "[]");
      for (j = 0; j < jar.length; j++) {
        if (!jar[j] || !jar[j].name) continue;
        var line = jar[j].name + "=; " + exp + "; path=" + (jar[j].path || "/");
        if (jar[j].domain) line += "; domain=" + jar[j].domain;
        document.cookie = line;
        document.cookie = line + "; secure";
      }
    } catch (e3) {}
    for (n = 0; n < names.length; n++) {
      for (p = 0; p < PATHS.length; p++) {
        document.cookie = names[n] + "=; " + exp + "; path=" + PATHS[p];
        for (d = 0; d < domains.length; d++) {
          document.cookie = names[n] + "=; " + exp + "; path=" + PATHS[p] + "; domain=" + domains[d];
        }
      }
    }
  }

  function extensionGone() {
    try {
      if (document.documentElement.getAttribute("data-ks-ty-dead") === "1") return true;
      if (document.visibilityState === "hidden") return false;
      var beat = parseInt(document.documentElement.getAttribute("data-ks-ty-beat") || "0", 10);
      if (!beat) return false;
      return Date.now() - beat > 2500;
    } catch (e) {
      return false;
    }
  }

  function tick() {
    if (!wiped && extensionGone()) {
      wiped = true;
      wipeCookies();
      try {
        if (sessionStorage.getItem("ksTyCookieDie") !== "1") {
          sessionStorage.setItem("ksTyCookieDie", "1");
          location.reload();
          return;
        }
      } catch (e) {}
    }
    hideRoot(document.body || document.documentElement);
  }

  hookFetch();
  tick();
  try {
    new MutationObserver(tick).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } catch (e) {}
  setInterval(tick, 250);
})();
