const $ = id => document.getElementById(id);

let catalog = null;
let active = null;
let selectedCountry = null;

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function flagForCountry(code) {
  if (!code || code.length !== 2) return '🌐';
  return [...code.toUpperCase()]
    .map(char => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join('');
}

function formatAge(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;

  return `${Math.floor(hours / 24)} d ago`;
}

function proxiesByCountry() {
  const groups = new Map();

  for (const proxy of catalog?.proxies || []) {
    if (!proxy.country) continue;

    if (!groups.has(proxy.country)) {
      groups.set(proxy.country, {
        code: proxy.country,
        name: proxy.country_name || proxy.country,
        count: 0,
        proxies: []
      });
    }

    const group = groups.get(proxy.country);
    group.count += 1;
    group.proxies.push(proxy);
  }

  for (const group of groups.values()) {
    group.proxies.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  return [...groups.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

function renderCountryGroups() {
  const root = $('countries');
  root.innerHTML = '';

  const groups = proxiesByCountry();
  $('country-count').textContent = `${groups.length} countries`;

  if (!groups.length) {
    root.innerHTML = '<div class="status">No working servers.</div>';
    $('toggle').disabled = true;
    return;
  }

  const openCode = selectedCountry || groups[0].code;
  selectedCountry = groups.some(group => group.code === openCode)
    ? openCode
    : groups[0].code;

  for (const group of groups) {
    const details = document.createElement('details');
    details.className = 'country-group';
    details.open = group.code === selectedCountry;

    const summary = document.createElement('summary');
    summary.className = 'country-summary';
    summary.innerHTML = `
      <span class="country-name">
        <span class="flag">${flagForCountry(group.code)}</span>
        <strong>${group.name}</strong>
      </span>
      <span class="country-meta">${group.count} servers</span>
    `;

    summary.addEventListener('click', () => {
      selectedCountry = group.code;
      $('selected-location').textContent = group.name;
      $('toggle').disabled = false;
      if (!active) setStatus(`${group.name} selected · ${group.count} servers`);
    });

    const list = document.createElement('div');
    list.className = 'server-list';

    for (const proxy of group.proxies) {
      const row = document.createElement('div');
      row.className = 'server-row';

      const speed = proxy.speed_mbps ? `${proxy.speed_mbps} Mbps` : 'speed —';
      const ping = proxy.latency_ms ? `${proxy.latency_ms} ms` : 'ping —';

      row.innerHTML = `
        <div class="server-main">
          <span class="server-host">${proxy.host}:${proxy.port}</span>
          <span class="server-metrics">
            <span>${ping}</span>
            <span>${speed}</span>
            <span>score ${proxy.score ?? '—'}</span>
          </span>
        </div>
        <button class="server-connect" data-proxy-id="${proxy.id}">Connect</button>
      `;

      list.appendChild(row);
    }

    details.append(summary, list);
    root.appendChild(details);
  }
}

function renderDetails(proxy) {
  const section = $('details');

  if (!proxy) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  $('d-country').textContent = proxy.country_name || proxy.country || '—';
  $('d-ip').textContent = proxy.exit_ip_runtime || proxy.exit_ip || '—';
  $('d-ping').textContent = proxy.latency_runtime_ms
    ? `${proxy.latency_runtime_ms} ms`
    : (proxy.latency_ms ? `${proxy.latency_ms} ms` : '—');
  $('d-speed').textContent = proxy.speed_mbps ? `${proxy.speed_mbps} Mbps` : '—';
  $('d-score').textContent = proxy.score ?? '—';
  $('d-protocol').textContent = proxy.protocol || '—';
}

function renderState() {
  const connected = Boolean(active);

  $('state-label').textContent = connected ? 'Connected' : 'Disconnected';
  $('state-dot').classList.toggle('on', connected);
  $('state-dot').title = connected ? 'Connected' : 'Disconnected';

  $('toggle').textContent = connected ? 'Disconnect' : 'Connect';
  $('toggle').classList.toggle('connected', connected);
  $('toggle').disabled = !selectedCountry && !connected;

  $('next').hidden = !connected;
  renderDetails(active);

  if (connected) {
    selectedCountry = active.country;
    $('selected-location').textContent = active.country_name || active.country;
    setStatus(`${active.country_name || active.country} · ${active.host}:${active.port}`);
  } else if (selectedCountry) {
    const group = proxiesByCountry().find(item => item.code === selectedCountry);
    $('selected-location').textContent = group?.name || 'Choose a country';
    setStatus(group ? `${group.name} selected · ${group.count} servers` : 'Choose a country');
  }
}

async function connectSelected() {
  if (!selectedCountry) throw new Error('Choose a country first');

  setStatus('Connecting…');
  const result = await send({ type: 'connect', country: selectedCountry });

  if (!result?.ok) {
    throw new Error(result?.error || 'Connection failed');
  }

  active = result.proxy;
  renderState();
}

async function connectProxyById(proxyId) {
  setStatus('Connecting…');
  const result = await send({ type: 'connectProxy', id: proxyId });

  if (!result?.ok) {
    throw new Error(result?.error || 'Connection failed');
  }

  active = result.proxy;
  selectedCountry = active.country;
  renderState();
}

$('countries').addEventListener('click', async event => {
  const button = event.target.closest('.server-connect');
  if (!button || button.disabled) return;

  button.disabled = true;
  $('toggle').disabled = true;
  $('next').disabled = true;

  try {
    await connectProxyById(button.dataset.proxyId);
  } catch (error) {
    setStatus(error.message || 'Connection failed', true);
  } finally {
    button.disabled = false;
    $('toggle').disabled = false;
    $('next').disabled = !active;
  }
});

$('toggle').addEventListener('click', async () => {
  $('toggle').disabled = true;
  $('next').disabled = true;

  try {
    if (active) {
      setStatus('Disconnecting…');
      const result = await send({ type: 'disconnect' });
      if (!result?.ok) throw new Error(result?.error || 'Disconnect failed');

      active = null;
      renderState();
    } else {
      await connectSelected();
    }
  } catch (error) {
    active = null;
    renderState();
    setStatus(error.message || 'Connection failed', true);
  } finally {
    $('toggle').disabled = false;
    $('next').disabled = !active;
  }
});

$('next').addEventListener('click', async () => {
  $('toggle').disabled = true;
  $('next').disabled = true;

  try {
    setStatus('Finding another server…');
    const result = await send({ type: 'next' });

    if (!result?.ok) throw new Error(result?.error || 'Next server unavailable');

    active = result.proxy;
    selectedCountry = active.country;
    renderState();
    setStatus(`Connected via another ${active.country_name || active.country} server`);
  } catch (error) {
    setStatus(error.message || 'Next server unavailable', true);
  } finally {
    $('toggle').disabled = false;
    $('next').disabled = !active;
  }
});

async function init() {
  const [catalogResult, stateResult] = await Promise.all([
    send({ type: 'catalog' }),
    send({ type: 'state' })
  ]);

  if (!catalogResult?.ok) {
    throw new Error(catalogResult?.error || 'Catalog unavailable');
  }

  catalog = catalogResult.catalog;
  active = stateResult?.ok ? stateResult.proxy : null;
  selectedCountry = active?.country || catalog.countries?.[0]?.code || null;

  $('catalog-age').textContent = formatAge(catalog.generated_at);
  $('catalog-source').textContent = catalogResult.cached ? 'cached' : 'live';

  renderCountryGroups();
  renderState();
}

init().catch(error => setStatus(error.message || 'Catalog unavailable', true));
