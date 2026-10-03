# Proxy Aggregator

Public-proxy aggregator for a Chrome extension. GitHub Actions discovers public proxy candidates, normalizes them, verifies connectivity, measures latency, measures speed for shortlisted candidates, scores them, and publishes a compact catalog for the extension.

## Architecture

```text
public sources -> discovery -> normalize/dedupe -> connectivity check
                                           -> country/IP enrichment
                                           -> latency
                                           -> speed shortlist
                                           -> score
                                           -> data/servers.json
                                           -> Chrome extension
```

The first implementation deliberately supports **public sources only**. Authentication is supported when a source explicitly publishes credentials for the proxy (for example `user:password@host:port` or equivalent JSON fields). Credentials are never guessed, brute-forced, or taken from unrelated secrets.

## Sources

Initial sources are public GitHub datasets from HProxy, Proxifly, ProxyScrape, Proxio and Databay. These projects publish machine-readable proxy lists and perform their own checks; this project performs a second independent check before a proxy is published in our catalog.

## Catalog contract

`data/servers.json` is the extension's public API. It contains only currently verified proxies, grouped by country, with protocol, endpoint, measured latency, optional speed, exit IP, and score. The extension never needs to know where a proxy came from.

## Local run

```bash
python -m pip install -r requirements.txt
python scripts/aggregate.py
```

Environment variables:

- `MAX_CANDIDATES` — total candidates checked (default 1500)
- `CHECK_WORKERS` — parallel connectivity workers (default 40)
- `SPEED_PER_COUNTRY` — speed tests per country (default 2)
- `SPEED_LIMIT_MB` — maximum bytes downloaded per speed test (default 3)

## GitHub Actions

The catalog workflow runs every 3 hours and can also be started manually. It commits `data/servers.json`, `data/countries.json` and `data/stats.json` when the generated catalog changes.

## Chrome extension

The extension is in `extension/`. It is Manifest V3 and uses `chrome.proxy` directly; no executable, VPS or external backend is required. Load `extension/` through `chrome://extensions` -> Developer mode -> Load unpacked.

Public proxies are inherently untrusted and unstable. Do not use them for passwords, banking, cookies, or other sensitive traffic.