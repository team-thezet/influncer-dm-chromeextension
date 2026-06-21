// Dev-only hot reload for the UNPACKED extension.
//
// No-op (returns immediately) when:
//   - running in the web harness (chrome.runtime.getManifest is absent), or
//   - installed from the Web Store (the runtime manifest has `update_url`).
// So this is safe to ship: a published build never polls anything.
//
// In an unpacked dev build it polls the dev server's /__version__ and:
//   - manifest.json / service-worker.js changed → chrome.runtime.reload()
//   - any other src file changed               → location.reload() (panel only)

const ENDPOINT = 'http://127.0.0.1:8137/__version__';

function isUnpackedExtension() {
  try {
    const mf = globalThis.chrome?.runtime?.getManifest?.();
    return !!mf && !('update_url' in mf);
  } catch {
    return false;
  }
}

async function fetchVersion(timeoutMs = 1200) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(ENDPOINT, { signal: ac.signal, cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function startDevReload() {
  if (!isUnpackedExtension()) return;
  let last = null;
  let delay = 1500;

  const tick = async () => {
    const v = await fetchVersion();
    if (v) {
      delay = 1500;
      if (last) {
        if (v.criticalMtime !== last.criticalMtime) {
          console.info('[dev-reload] manifest/SW changed → reloading extension');
          chrome.runtime.reload();
          return;
        }
        if (v.uiMtime !== last.uiMtime) {
          console.info('[dev-reload] file changed → reloading panel');
          location.reload();
          return;
        }
      }
      last = v;
    } else {
      delay = Math.min(delay * 2, 10000); // dev server down → back off quietly
    }
    setTimeout(tick, delay);
  };

  tick();
}
