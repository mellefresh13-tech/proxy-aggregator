const $ = id => document.getElementById(id);

let catalog = null;
let active = null;

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

function renderCountries() {
  const select = $('country');
  select.innerHTML = '';

  for (const country of catalog.countries || []) {
    const option = document.createElement('option');
    option.value = country.code;
    option.textContent = `${country.name} · ${country.count}`;
    select.appendChild(option);
  }

  $('toggle').disabled = !select.options.length;

  if (!select.options.length) {
    select.innerHTML = '<option>No working countries</option>';
  }
}

function renderState() {
  const connected = Boolean(active);

  $('state-label').textContent = connected ? 'Connected' : 'Disconnected';
  $('state-dot').classList.toggle('on', connected);
  $('state-dot').title = connected ? 'Connected' : 'Disconnected';

  const toggle = $('toggle');
  toggle.disabled = false;
  toggle.textContent = connected ? 'Disconnect' : 'Connect';
  toggle.classList.toggle('connected', connected);

  $('next').hidden = !connected;
  renderDetails(active);

  if (connected) {
    setStatus(`${active.country_name || active.country} · ${active.host}:${active.port}`);
  } else {
    setStatus(`${catalog?.count || 0} working proxies · ${catalog?.countries_count || 0} countries`);
  }
}

async function init() {
  const [catalogResult, stateResult] = await Promise.all([
    send({ type: 'catalog' }),
    send({ type: 'state' })
  ]);

  if (!catalogResult?.ok) throw new Error(catalogResult?.error || 'Catalog unavailable');

  catalog = catalogResult.catalog;
  active = stateResult?.ok ? stateResult.proxy : null;

  $('catalog-age').textContent = formatAge(catalog.generated_at);
  $('catalog-source').textContent = catalogResult.cached ? 'cached' : 'live';

  renderCountries();
  if (active) $('country').value = active.country;
  renderState();
}

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
      setStatus('Disconnected');
    } else {
      const country = $('country').value;
      setStatus('Connecting…');
      const result = await send({ type: 'connect', country });

      if (!result?.ok) throw new Error(result?.error || 'Connection failed');

      active = result.proxy;
      renderState();
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
    renderState();
    setStatus(`Connected via another ${active.country_name || active.country} server`);
  } catch (error) {
    setStatus(error.message || 'Next server unavailable', true);
  } finally {
    $('toggle').disabled = false;
    $('next').disabled = !active;
  }
});

$('country').addEventListener('change', () => {
  if (active) {
    setStatus('Disconnect to change location.');
  }
});

init().catch(error => setStatus(error.message || 'Catalog unavailable', true));
