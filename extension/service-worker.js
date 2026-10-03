const CATALOG_URL = 'https://raw.githubusercontent.com/mellefresh13-tech/proxy-aggregator/main/data/servers.json';
const IP_CHECK_URL = 'https://api.ipify.org?format=json';

let activeProxy = null;
let authAttempts = new Map();

async function loadState() {
  const state = await chrome.storage.local.get(['activeProxy']);
  activeProxy = state.activeProxy || null;
}

async function saveState() {
  await chrome.storage.local.set({ activeProxy });
}

function proxyRules(proxy) {
  const scheme = proxy.protocol === 'socks4' ? 'socks4' : 'socks5';
  if (proxy.protocol === 'http' || proxy.protocol === 'https') {
    return {
      mode: 'fixed_servers',
      rules: {
        singleProxy: { scheme: 'http', host: proxy.host, port: proxy.port },
        bypassList: ['<local>']
      }
    };
  }
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme, host: proxy.host, port: proxy.port },
      bypassList: ['<local>']
    }
  };
}

async function setDirect() {
  await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' });
  activeProxy = null;
  authAttempts.clear();
  await saveState();
}

async function activate(proxy) {
  await chrome.proxy.settings.set({ value: proxyRules(proxy), scope: 'regular' });
  activeProxy = proxy;
  authAttempts.clear();
  await saveState();
}

async function fetchCatalog() {
  const response = await fetch(`${CATALOG_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
  return response.json();
}

async function verifyConnection() {
  const started = performance.now();
  const response = await fetch(`${IP_CHECK_URL}&t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`IP check HTTP ${response.status}`);
  const data = await response.json();
  return { exitIp: data.ip || null, measuredLatencyMs: Math.round(performance.now() - started) };
}

function candidatesForCountry(catalog, code) {
  return (catalog.proxies || [])
    .filter(p => p.country === code && (!p.auth || p.protocol === 'http' || p.protocol === 'https'))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

async function connectCountry(code) {
  const catalog = await fetchCatalog();
  const candidates = candidatesForCountry(catalog, code);
  if (!candidates.length) throw new Error('No compatible proxy in this country');

  let lastError = null;
  for (const proxy of candidates.slice(0, 5)) {
    try {
      await activate(proxy);
      const check = await verifyConnection();
      activeProxy = { ...proxy, exit_ip_runtime: check.exitIp, latency_runtime_ms: check.measuredLatencyMs };
      await saveState();
      return activeProxy;
    } catch (error) {
      lastError = error;
      await setDirect();
    }
  }
  throw lastError || new Error('All candidate proxies failed');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'catalog') {
      return { ok: true, catalog: await fetchCatalog() };
    }
    if (message.type === 'connect') {
      return { ok: true, proxy: await connectCountry(message.country) };
    }
    if (message.type === 'disconnect') {
      await setDirect();
      return { ok: true };
    }
    if (message.type === 'state') {
      await loadState();
      return { ok: true, proxy: activeProxy };
    }
    throw new Error('Unknown message');
  })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy || !activeProxy || !activeProxy.auth) {
      callback({});
      return;
    }
    const key = details.requestId;
    const attempts = authAttempts.get(key) || 0;
    if (attempts >= 1) {
      authAttempts.delete(key);
      callback({ cancel: true });
      return;
    }
    authAttempts.set(key, attempts + 1);
    callback({
      authCredentials: {
        username: activeProxy.auth.username,
        password: activeProxy.auth.password
      }
    });
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

chrome.webRequest.onCompleted.addListener(
  details => authAttempts.delete(details.requestId),
  { urls: ['<all_urls>'] }
);
chrome.webRequest.onErrorOccurred.addListener(
  details => authAttempts.delete(details.requestId),
  { urls: ['<all_urls>'] }
);

loadState().catch(() => {});
