/**
 * API Compatibility Layer for Orion Browser (iOS)
 * declarativeNetRequest ve browsingData desteklenmiyorsa
 * webRequest ve manuel temizleme fallback'leri sağlar
 */

const requestHeaderRules = new Map();
const sessionHeaderRules = new Map();
let webRequestListenersSetup = false;

function isDeclarativeNetRequestSupported() {
  return !!(chrome.declarativeNetRequest &&
            chrome.declarativeNetRequest.updateSessionRules);
}

function isWebRequestSupported() {
  return !!(chrome.webRequest &&
            chrome.webRequest.onBeforeSendHeaders);
}

function isBrowsingDataSupported() {
  return !!(chrome.browsingData &&
            chrome.browsingData.remove);
}

const RequestHeaderManager = {
  async updateSessionRules(options) {
    const { addRules = [], removeRuleIds = [] } = options;

    if (isDeclarativeNetRequestSupported()) {
      try {
        await chrome.declarativeNetRequest.updateSessionRules(options);
        return;
      } catch (error) {
        console.warn('declarativeNetRequest failed, falling back to webRequest:', error);
      }
    }

    if (isWebRequestSupported()) {
      removeRuleIds.forEach(id => sessionHeaderRules.delete(id));
      addRules.forEach(rule => sessionHeaderRules.set(rule.id, rule));
      this._setupWebRequestListener();
      return;
    }

    throw new Error('Neither declarativeNetRequest nor webRequest is supported');
  },

  async updateDynamicRules(options) {
    const { addRules = [], removeRuleIds = [] } = options;

    if (isDeclarativeNetRequestSupported()) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules(options);
        return;
      } catch (error) {
        console.warn('declarativeNetRequest dynamic failed, falling back to webRequest:', error);
      }
    }

    if (isWebRequestSupported()) {
      removeRuleIds.forEach(id => requestHeaderRules.delete(id));
      addRules.forEach(rule => requestHeaderRules.set(rule.id, rule));
      this._setupWebRequestListener();
      return;
    }

    throw new Error('Neither declarativeNetRequest nor webRequest is supported');
  },

  async getSessionRules() {
    if (isDeclarativeNetRequestSupported()) {
      try {
        return await chrome.declarativeNetRequest.getSessionRules();
      } catch (error) {
        console.warn('getSessionRules failed:', error);
      }
    }
    return Array.from(sessionHeaderRules.values());
  },

  async getDynamicRules() {
    if (isDeclarativeNetRequestSupported()) {
      try {
        return await chrome.declarativeNetRequest.getDynamicRules();
      } catch (error) {
        console.warn('getDynamicRules failed:', error);
      }
    }
    return Array.from(requestHeaderRules.values());
  },

  _setupWebRequestListener() {
    if (webRequestListenersSetup) return;
    webRequestListenersSetup = true;

    const getAllRules = () => {
      return [
        ...Array.from(sessionHeaderRules.values()),
        ...Array.from(requestHeaderRules.values())
      ];
    };

    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        const rules = getAllRules();
        for (const rule of rules) {
          if (rule.action && rule.action.type === 'block') {
            if (this._matchesCondition(details.url, rule.condition)) {
              return { cancel: true };
            }
          }
        }
        return { cancel: false };
      },
      { urls: ['<all_urls>'] },
      ['blocking']
    );

    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        const rules = getAllRules();
        let headers = details.requestHeaders || [];

        for (const rule of rules) {
          if (!this._matchesCondition(details.url, rule.condition)) continue;
          if (rule.action && rule.action.requestHeaders) {
            for (const headerMod of rule.action.requestHeaders) {
              const headerName = headerMod.header.toLowerCase();
              if (headerMod.operation === 'set') {
                headers = headers.filter(h => h.name.toLowerCase() !== headerName);
                headers.push({ name: headerMod.header, value: headerMod.value });
              } else if (headerMod.operation === 'remove') {
                headers = headers.filter(h => h.name.toLowerCase() !== headerName);
              } else if (headerMod.operation === 'append') {
                const existing = headers.find(h => h.name.toLowerCase() === headerName);
                if (existing) {
                  existing.value += ', ' + headerMod.value;
                } else {
                  headers.push({ name: headerMod.header, value: headerMod.value });
                }
              }
            }
          }
        }
        return { requestHeaders: headers };
      },
      { urls: ['<all_urls>'] },
      ['blocking', 'requestHeaders', 'extraHeaders']
    );
  },

  _matchesCondition(url, condition) {
    if (!condition) return false;
    if (condition.urlFilter) {
      const filter = condition.urlFilter;
      if (url.includes(filter)) return true;
      try {
        const regexPattern = filter
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*');
        const regex = new RegExp(regexPattern, 'i');
        if (!regex.test(url)) return false;
      } catch (e) {
        if (!url.includes(filter)) return false;
      }
    }
    return true;
  }
};

const BrowsingDataManager = {
  async remove(options, dataToRemove) {
    if (isBrowsingDataSupported()) {
      try {
        await chrome.browsingData.remove(options, dataToRemove);
        return true;
      } catch (error) {
        console.warn('browsingData API failed, using fallback:', error);
      }
    }

    const { origins } = options;
    const promises = [];

    if (dataToRemove.cookies && origins && origins.length > 0) {
      for (const origin of origins) {
        const domain = new URL(origin).hostname;
        promises.push(this._clearCookiesForDomain(domain));
      }
    }

    if (dataToRemove.localStorage && origins && origins.length > 0) {
      for (const origin of origins) {
        promises.push(this._clearLocalStorageForOrigin(origin));
      }
    }

    if (dataToRemove.indexedDB && origins && origins.length > 0) {
      for (const origin of origins) {
        promises.push(this._clearIndexedDBForOrigin(origin));
      }
    }

    await Promise.allSettled(promises);
    return true;
  },

  async _clearCookiesForDomain(domain) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      const promises = cookies.map(cookie => {
        const url = `http${cookie.secure ? 's' : ''}://${cookie.domain.replace(/^\./, '')}${cookie.path}`;
        return chrome.cookies.remove({ url, name: cookie.name });
      });
      await Promise.all(promises);
    } catch (error) {
      console.error('Error clearing cookies for ' + domain + ':', error);
    }
  },

  async _clearLocalStorageForOrigin(origin) {
    try {
      const tabs = await chrome.tabs.query({ url: origin + '/*' });
      let tabId;
      if (tabs.length > 0) {
        tabId = tabs[0].id;
      } else {
        const tab = await chrome.tabs.create({ url: origin, active: false });
        tabId = tab.id;
        await new Promise(resolve => {
          const listener = (updatedTabId, info) => {
            if (updatedTabId === tabId && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
        }
      });
    } catch (error) {
      console.error('Error clearing localStorage for ' + origin + ':', error);
    }
  },

  async _clearIndexedDBForOrigin(origin) {
    try {
      const tabs = await chrome.tabs.query({ url: origin + '/*' });
      let tabId;
      if (tabs.length > 0) {
        tabId = tabs[0].id;
      } else {
        const tab = await chrome.tabs.create({ url: origin, active: false });
        tabId = tab.id;
        await new Promise(resolve => {
          const listener = (updatedTabId, info) => {
            if (updatedTabId === tabId && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          try {
            if (window.indexedDB && indexedDB.databases) {
              indexedDB.databases().then(dbs => {
                dbs.forEach(db => { if (db.name) indexedDB.deleteDatabase(db.name); });
              });
            }
          } catch (e) {}
        }
      });
    } catch (error) {
      console.error('Error clearing IndexedDB for ' + origin + ':', error);
    }
  }
};

if (typeof self !== 'undefined') {
  self.RequestHeaderManager = RequestHeaderManager;
  self.BrowsingDataManager = BrowsingDataManager;
  self.isDeclarativeNetRequestSupported = isDeclarativeNetRequestSupported;
  self.isWebRequestSupported = isWebRequestSupported;
  self.isBrowsingDataSupported = isBrowsingDataSupported;
}
