const CATALOG_URL = 'https://raw.githubusercontent.com/mellefresh13-tech/proxy-aggregator/main/data/servers.json';
const IP_CHECK_URL = 'https://api.ipify.org?format=json';

const CATALOG_CACHE_KEY = 'catalogCache';
const CATALOG_FETCHED_AT_KEY = 'catalogFetchedAt';
const HEALTH_ALARM = 'domikvpn-health';
const VERIFY_TIMEOUT_MS = 7000;

let activeProxy = null;
let authAttempts = new Map();

async function loadState() {
  const state = await chrome.storage.local.get(['activeProxy']);
  activeProxy = state.activeProxy || null;
  await updateActionState();
}

async function saveState() {
  await chrome.storage.local.set({ activeProxy });
}

async function updateActionState() {
  await chrome.action.setBadgeText({ text: activeProxy ? 'ON' : '' });
  if (activeProxy) {
    await chrome.action.setBadgeBackgroundColor({ color: '#31c96b' });
    await chrome.action.setTitle({
      title: `DomikVPN · Connected · ${activeProxy.country_name || activeProxy.country}`
    });
  } else {
    await chrome.action.setTitle({ title: 'DomikVPN · Disconnected' });
  }
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
  await chrome.proxy.settings.set({
    value: { mode: 'direct' },
    scope: 'regular'
  });

  activeProxy = null;
  authAttempts.clear();
  await saveState();
  await updateActionState();
}

async function activate(proxy) {
  await chrome.proxy.settings.set({
    value: proxyRules(proxy),
    scope: 'regular'
  });

  activeProxy = proxy;
  authAttempts.clear();
  await saveState();
  await updateActionState();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = VERIFY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCatalog() {
  try {
    const response = await fetchWithTimeout(
      `${CATALOG_URL}?t=${Date.now()}`,
      { cache: 'no-store' },
      10000
    );

    if (!response.ok) {
      throw new Error(`Catalog HTTP ${response.status}`);
    }

    const catalog = await response.json();

    await chrome.storage.local.set({
      [CATALOG_CACHE_KEY]: catalog,
      [CATALOG_FETCHED_AT_KEY]: Date.now()
    });

    return { catalog, cached: false };
  } catch (networkError) {
    const state = await chrome.storage.local.get([
      CATALOG_CACHE_KEY,
      CATALOG_FETCHED_AT_KEY
    ]);

    if (state[CATALOG_CACHE_KEY]) {
      return {
        catalog: state[CATALOG_CACHE_KEY],
        cached: true,
        cachedAt: state[CATALOG_FETCHED_AT_KEY] || null
      };
    }

    throw networkError;
  }
}

async function verifyConnection() {
  const started = performance.now();

  const response = await fetchWithTimeout(
    `${IP_CHECK_URL}&t=${Date.now()}`,
    { cache: 'no-store' },
    VERIFY_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`IP check HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!data.ip) {
    throw new Error('IP check returned no address');
  }

  return {
    exitIp: data.ip,
    measuredLatencyMs: Math.round(performance.now() - started)
  };
}

function candidatesForCountry(catalog, code) {
  return (catalog.proxies || [])
    .filter(p =>
      p.country === code &&
      (!p.auth || p.protocol === 'http' || p.protocol === 'https')
    )
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

function sameProxy(a, b) {
  return Boolean(
    a &&
    b &&
    a.host === b.host &&
    a.port === b.port &&
    a.protocol === b.protocol
  );
}

async function connectCountry(code, excludeProxy = null) {
  const { catalog } = await fetchCatalog();

  const candidates = candidatesForCountry(catalog, code)
    .filter(proxy => !sameProxy(proxy, excludeProxy));

  if (!candidates.length) {
    throw new Error('No compatible proxy in this country');
  }

  let lastError = null;

  for (const proxy of candidates.slice(0, 8)) {
    try {
      await activate(proxy);

      const check = await verifyConnection();

      activeProxy = {
        ...proxy,
        exit_ip_runtime: check.exitIp,
        latency_runtime_ms: check.measuredLatencyMs
      };

      await saveState();
      await updateActionState();

      return activeProxy;
    } catch (error) {
      lastError = error;
      await setDirect();
    }
  }

  throw lastError || new Error('All candidate proxies failed');
}

async function autoRecover() {
  await loadState();

  if (!activeProxy) return;

  const current = activeProxy;

  try {
    const check = await verifyConnection();

    activeProxy = {
      ...current,
      exit_ip_runtime: check.exitIp,
      latency_runtime_ms: check.measuredLatencyMs
    };

    await saveState();
    await updateActionState();
  } catch {
    try {
      await connectCountry(current.country, current);
    } catch {
      await setDirect();
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'catalog') {
      const result = await fetchCatalog();
      return {
        ok: true,
        catalog: result.catalog,
        cached: result.cached,
        cachedAt: result.cachedAt || null
      };
    }

    if (message.type === 'connect') {
      return { ok: true, proxy: await connectCountry(message.country) };
    }

    if (message.type === 'next') {
      await loadState();

      if (!activeProxy) {
        throw new Error('Not connected');
      }

      return {
        ok: true,
        proxy: await connectCountry(activeProxy.country, activeProxy)
      };
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
  })()
    .then(sendResponse)
    .catch(error => sendResponse({
      ok: false,
      error: error.message || 'Unknown error'
    }));

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

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 5 });
  loadState().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 5 });
  loadState().catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === HEALTH_ALARM) {
    autoRecover().catch(() => {});
  }
});

chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 5 });

loadState().catch(() => {});
