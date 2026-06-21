// Dev-only shim — INERT inside a real packed extension.
//
// When sidepanel.html / options.html are opened as a plain web page (via a local
// dev server, for fast iteration) instead of being loaded as an unpacked
// extension, the `chrome.*` APIs don't exist. This provides just enough of them,
// backed by localStorage + window.open, so the UI runs in a normal browser tab.
//
// In a real extension `chrome.storage.local` already exists, so the guard below
// is false and this file does nothing — shipped behavior is never affected.

if (typeof chrome === 'undefined' || !chrome?.storage?.local) {
  const STORE_KEY = '__igorg_devstore__';
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    } catch {
      return {};
    }
  };
  const write = (obj) => localStorage.setItem(STORE_KEY, JSON.stringify(obj));

  globalThis.chrome = {
    __dev: true,
    storage: {
      local: {
        async get(key) {
          const all = read();
          if (key == null) return { ...all };
          if (typeof key === 'string') return key in all ? { [key]: all[key] } : {};
          if (Array.isArray(key)) {
            const out = {};
            for (const k of key) if (k in all) out[k] = all[k];
            return out;
          }
          const out = {};
          for (const k of Object.keys(key)) out[k] = k in all ? all[k] : key[k];
          return out;
        },
        async set(obj) {
          write({ ...read(), ...obj });
        },
        async remove(keys) {
          const all = read();
          for (const k of [].concat(keys)) delete all[k];
          write(all);
        },
        async clear() {
          write({});
        },
      },
    },
    tabs: {
      async create({ url }) {
        window.open(url, '_blank', 'noopener');
        return { id: -1, url };
      },
      update(_id, { url }, cb) {
        window.open(url, '_blank', 'noopener');
        if (cb) cb({ id: _id, url });
      },
    },
    sidePanel: {
      async setPanelBehavior() {},
      async open() {},
    },
    runtime: { onInstalled: { addListener() {} }, lastError: null },
    action: {},
  };
  console.info('[dev-shim] running in web-harness mode (chrome.* polyfilled via localStorage)');
}
