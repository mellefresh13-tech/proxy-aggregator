const $ = id => document.getElementById(id);
let catalog = null;
let active = null;

function send(message) {
  return new Promise(resolve => chrome.runtime.sendMessage(message, resolve));
}

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').style.color = error ? '#ff7b7b' : '';
}

function renderDetails(proxy) {
  if (!proxy) {
    $('details').hidden = true;
    return;
  }
  $('details').hidden = false;
  $('d-country').textContent = proxy.country_name || proxy.country || '—';
  $('d-ip').textContent = proxy.exit_ip_runtime || proxy.exit_ip || '—';
  $('d-ping').textContent = proxy.latency_runtime_ms ? `${proxy.latency_runtime_ms} ms` : (proxy.latency_ms ? `${proxy.latency_ms} ms` : '—');
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
    option.textContent = `${country.name} (${country.count})`;
    select.appendChild(option);
  }
  if (!select.options.length) {
    select.innerHTML = '<option>No working countries</option>';
    $('toggle').disabled = true;
  } else {
    $('toggle').disabled = false;
  }
}

function renderButton() {
  const button = $('toggle');
  $('next').hidden = !active;
  if (active) {
    button.textContent = 'ВЫКЛ';
    button.classList.add('on');
    setStatus(`Connected via ${active.country_name || active.country}`);
  } else {
    button.textContent = 'ВКЛ';
    button.classList.remove('on');
  }
  renderDetails(active);
}

async function init() {
  const [catalogResult, stateResult] = await Promise.all([
    send({ type: 'catalog' }),
    send({ type: 'state' })
  ]);
  if (!catalogResult.ok) throw new Error(catalogResult.error);
  catalog = catalogResult.catalog;
  active = stateResult.ok ? stateResult.proxy : null;
  $('catalog-age').textContent = catalog.generated_at ? new Date(catalog.generated_at).toLocaleString() : '';
  renderCountries();
  if (active) $('country').value = active.country;
  renderButton();
  if (!active) setStatus(`${catalog.count || 0} working proxies in ${catalog.countries_count || 0} countries`);
}

$('next').addEventListener('click', async () => {
  $('toggle').disabled = true;
  $('next').disabled = true;
  try {
    setStatus('Switching server…');
    const result = await send({ type: 'next' });
    if (!result.ok) throw new Error(result.error);
    active = result.proxy;
    renderButton();
    setStatus(`Connected via another ${active.country_name || active.country} server`);
  } catch (error) {
    setStatus(error.message || 'Next server unavailable', true);
  } finally {
    $('toggle').disabled = false;
    $('next').disabled = false;
  }
});

$('toggle').addEventListener('click', async () => {
  $('toggle').disabled = true;
  $('next').disabled = true;
  try {
    if (active) {
      const result = await send({ type: 'disconnect' });
      if (!result.ok) throw new Error(result.error);
      active = null;
      renderButton();
      setStatus('Disconnected');
    } else {
      setStatus('Connecting…');
      const result = await send({ type: 'connect', country: $('country').value });
      if (!result.ok) throw new Error(result.error);
      active = result.proxy;
      renderButton();
    }
  } catch (error) {
    active = null;
    renderButton();
    setStatus(error.message || 'Connection failed', true);
  } finally {
    $('toggle').disabled = false;
    $('next').disabled = false;
  }
});

$('country').addEventListener('change', () => {
  if (!active) return;
  setStatus('Country changed. Press ВКЛ after disconnecting.');
});

init().catch(error => setStatus(error.message || 'Catalog unavailable', true));
