#!/usr/bin/env python3
import concurrent.futures
import hashlib
import json
import os
import re
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data"
OUT.mkdir(exist_ok=True)

CATALOG_TIMEOUT = float(os.getenv("CHECK_TIMEOUT", "7"))
FETCH_TIMEOUT = float(os.getenv("FETCH_TIMEOUT", "25"))
MAX_CANDIDATES = int(os.getenv("MAX_CANDIDATES", "1500"))
CHECK_WORKERS = int(os.getenv("CHECK_WORKERS", "40"))
SPEED_PER_COUNTRY = int(os.getenv("SPEED_PER_COUNTRY", "2"))
SPEED_LIMIT_MB = float(os.getenv("SPEED_LIMIT_MB", "3"))
SPEED_URL = os.getenv("SPEED_URL", "https://speed.cloudflare.com/__down?bytes=3000000")
IP_URL = os.getenv("IP_URL", "https://api.ipify.org?format=json")
USER_AGENT = "proxy-aggregator/1.0 (+https://github.com/mellefresh13-tech/proxy-aggregator)"

EUROPE_PRIORITY = {
    "PL": 1.30, "NL": 1.30, "DE": 1.25, "FR": 1.20, "BE": 1.20,
    "CZ": 1.15, "AT": 1.15, "SE": 1.10, "DK": 1.10, "FI": 1.10,
    "NO": 1.10, "ES": 1.05, "IT": 1.05, "PT": 1.05, "IE": 1.05,
    "CH": 1.05, "LU": 1.05, "GB": 1.05
}

COUNTRY_NAMES = {
    "PL":"Poland","NL":"Netherlands","DE":"Germany","FR":"France","BE":"Belgium",
    "CZ":"Czechia","AT":"Austria","SE":"Sweden","DK":"Denmark","FI":"Finland",
    "NO":"Norway","ES":"Spain","IT":"Italy","PT":"Portugal","IE":"Ireland",
    "CH":"Switzerland","LU":"Luxembourg","GB":"United Kingdom","UA":"Ukraine",
    "RO":"Romania","HU":"Hungary","SK":"Slovakia","SI":"Slovenia","HR":"Croatia",
    "EE":"Estonia","LV":"Latvia","LT":"Lithuania","BG":"Bulgaria","GR":"Greece",
    "US":"United States","CA":"Canada","JP":"Japan","SG":"Singapore","AU":"Australia"
}


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def norm_protocol(value):
    if not value:
        return None
    value = str(value).lower().strip().replace("proxy://", "")
    aliases = {"socks": "socks5", "socks5h": "socks5", "https": "http", "http-connect": "http"}
    return aliases.get(value, value) if value in {"http", "https", "socks", "socks4", "socks5", "socks5h", "http-connect"} else None


def normalize_country(value):
    if not value:
        return None
    value = str(value).strip()
    if len(value) == 2:
        return value.upper()
    reverse = {v.lower(): k for k, v in COUNTRY_NAMES.items()}
    return reverse.get(value.lower())


def make_proxy(protocol, host, port, country=None, username=None, password=None, source=None, latency=None, uptime=None, anonymity=None):
    if not host or not port:
        return None
    try:
        port = int(port)
        if not 1 <= port <= 65535:
            return None
    except Exception:
        return None
    protocol = norm_protocol(protocol) or "http"
    return {
        "id": hashlib.sha256(f"{protocol}|{host}|{port}".encode()).hexdigest()[:16],
        "protocol": protocol,
        "host": host.strip(),
        "port": port,
        "country": normalize_country(country),
        "username": username,
        "password": password,
        "source": source,
        "source_latency_ms": safe_float(latency),
        "source_uptime": safe_float(uptime),
        "anonymity": anonymity,
    }


def safe_float(v):
    try:
        return float(v) if v is not None and v != "" else None
    except Exception:
        return None


def from_url(value, defaults):
    value = value.strip()
    if not value or value.startswith("#"):
        return None
    if "://" not in value:
        value = f"{defaults.get('protocol') or 'http'}://{value}"
    try:
        u = urlparse(value)
        host = u.hostname
        port = u.port
        return make_proxy(
            u.scheme, host, port,
            defaults.get("country"),
            unquote(u.username) if u.username else None,
            unquote(u.password) if u.password else None,
            defaults.get("source"),
            defaults.get("latency"), defaults.get("uptime"), defaults.get("anonymity")
        )
    except Exception:
        return None


def find_value(obj, *keys):
    if not isinstance(obj, dict):
        return None
    lower = {str(k).lower(): v for k, v in obj.items()}
    for k in keys:
        if k.lower() in lower:
            return lower[k.lower()]
    return None


def parse_json_payload(payload, defaults):
    out = []
    if isinstance(payload, dict):
        for key in ("proxies", "data", "results", "items", "list"):
            value = find_value(payload, key)
            if isinstance(value, (list, dict)):
                return parse_json_payload(value, defaults)
        host = find_value(payload, "host", "ip", "proxy", "address", "server")
        port = find_value(payload, "port")
        if host and port:
            if isinstance(host, str) and (":" in host or "://" in host):
                p = from_url(host, {**defaults, "protocol": find_value(payload, "protocol", "scheme") or defaults.get("protocol")})
                if p:
                    p["country"] = normalize_country(find_value(payload, "country_code", "countryCode", "country") or defaults.get("country"))
                    p["username"] = find_value(payload, "username", "user", "login") or p["username"]
                    p["password"] = find_value(payload, "password", "pass", "pwd") or p["password"]
                    p["source_latency_ms"] = safe_float(find_value(payload, "latency_ms", "latency", "ping") or defaults.get("latency"))
                    p["source_uptime"] = safe_float(find_value(payload, "uptime_percent", "uptime") or defaults.get("uptime"))
                    p["anonymity"] = find_value(payload, "anonymity", "anon") or defaults.get("anonymity")
                    return [p]
            p = make_proxy(find_value(payload, "protocol", "scheme") or defaults.get("protocol"), host, port,
                           find_value(payload, "country_code", "countryCode", "country") or defaults.get("country"),
                           find_value(payload, "username", "user", "login"),
                           find_value(payload, "password", "pass", "pwd"), defaults.get("source"),
                           find_value(payload, "latency_ms", "latency", "ping"),
                           find_value(payload, "uptime_percent", "uptime"),
                           find_value(payload, "anonymity", "anon"))
            return [p] if p else []
        out = []
        for value in payload.values():
            if isinstance(value, (dict, list)):
                out.extend(parse_json_payload(value, defaults))
        return out
    if isinstance(payload, list):
        for item in payload:
            out.extend(parse_json_payload(item, defaults) if isinstance(item, (dict, list)) else parse_text(str(item), defaults))
    return out


def parse_text(text, defaults):
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        # Accept protocol://user:pass@host:port, user:pass@host:port and plain host:port.
        p = from_url(line.split(",")[0].strip(), defaults)
        if p:
            out.append(p)
    return out


def fetch_source(source):
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json,text/plain,*/*"}
    response = requests.get(source["url"], headers=headers, timeout=FETCH_TIMEOUT)
    response.raise_for_status()
    defaults = {"source": source["id"], "protocol": source.get("protocol"), "country": source.get("country")}
    if source.get("format") == "json":
        return parse_json_payload(response.json(), defaults)
    return parse_text(response.text, defaults)


def proxy_url(p):
    auth = ""
    if p.get("username") is not None:
        auth = f"{quote(str(p['username']), safe='')}:{quote(str(p.get('password') or ''), safe='')}@"
    return f"{p['protocol']}://{auth}{p['host']}:{p['port']}"


def check_proxy(p):
    started = time.perf_counter()
    proxies = {"http": proxy_url(p), "https": proxy_url(p)}
    if p["protocol"] in {"socks4", "socks5"}:
        # requests delegates SOCKS to PySocks installed by requirements.txt.
        proxies = {"http": proxy_url(p), "https": proxy_url(p)}
    try:
        r = requests.get(IP_URL, proxies=proxies, timeout=CATALOG_TIMEOUT, headers={"User-Agent": USER_AGENT})
        r.raise_for_status()
        elapsed = (time.perf_counter() - started) * 1000
        try:
            exit_ip = r.json().get("ip")
        except Exception:
            exit_ip = r.text.strip()
        if not exit_ip or len(exit_ip) > 80:
            return None
        result = dict(p)
        result.update({"latency_ms": round(elapsed, 1), "exit_ip": exit_ip, "verified": True})
        return result
    except Exception:
        return None


def speed_test(p):
    proxies = {"http": proxy_url(p), "https": proxy_url(p)}
    started = time.perf_counter()
    received = 0
    try:
        with requests.get(SPEED_URL, proxies=proxies, timeout=max(CATALOG_TIMEOUT, 10),
                          headers={"User-Agent": USER_AGENT}, stream=True) as r:
            r.raise_for_status()
            limit = int(SPEED_LIMIT_MB * 1024 * 1024)
            for chunk in r.iter_content(64 * 1024):
                if not chunk:
                    continue
                received += len(chunk)
                if received >= limit:
                    break
        seconds = time.perf_counter() - started
        if seconds <= 0 or received < 100 * 1024:
            return None
        return round((received * 8 / seconds) / 1_000_000, 2)
    except Exception:
        return None


def score(p):
    latency = p.get("latency_ms") or 5000
    speed = p.get("speed_mbps") or 0
    uptime = p.get("source_uptime")
    uptime_norm = min(max((uptime or 70) / 100, 0), 1)
    latency_norm = max(0, min(1, 1 - latency / 2000))
    # Speed is only measured for a small sample per country. Treat an unmeasured
    # speed as neutral rather than as zero, otherwise most otherwise-good proxies
    # would be unfairly penalized.
    speed_norm = max(0, min(1, (speed / 50) if speed else 0.5))
    source_bonus = 0.03 if p.get("source_latency_ms") is not None else 0
    base = (0.50 * uptime_norm + 0.25 * latency_norm + 0.25 * speed_norm + source_bonus) * 100
    return round(min(100, base), 2)


def main():
    with open(ROOT / "sources.json", encoding="utf-8") as f:
        sources = json.load(f)
    candidates = {}
    source_stats = {}
    for source in sources:
        try:
            items = fetch_source(source)
            source_stats[source["id"]] = {"fetched": len(items), "error": None}
            for p in items:
                if not p:
                    continue
                key = f"{p['protocol']}|{p['host']}|{p['port']}"
                if key not in candidates:
                    candidates[key] = p
        except Exception as exc:
            source_stats[source["id"]] = {"fetched": 0, "error": str(exc)[:200]}

    # Spread the check budget across countries first, then use the remaining
    # budget for the strongest candidates. This prevents a large source such as
    # HProxy from consuming the whole 1500-check budget and hiding other countries.
    values = list(candidates.values())
    known = [p for p in values if p.get("country")]
    unknown = [p for p in values if not p.get("country")]

    by_country_candidates = {}
    for p in known:
        by_country_candidates.setdefault(p["country"], []).append(p)

    def candidate_rank(p):
        return (
            1 if p.get("source_latency_ms") is not None else 0,
            -(p.get("source_latency_ms") or 99999),
            1 if p.get("source_uptime") is not None else 0,
            p.get("source_uptime") or 0
        )

    for items in by_country_candidates.values():
        items.sort(key=candidate_rank, reverse=True)

    # Give every country a chance to appear in the catalog.
    per_country = max(1, MAX_CANDIDATES // max(1, len(by_country_candidates)))
    selected = []
    remaining = []

    for country in sorted(by_country_candidates):
        items = by_country_candidates[country]
        selected.extend(items[:per_country])
        remaining.extend(items[per_country:])

    # Fill the rest by source metadata quality, without country bias.
    remaining.extend(unknown)
    remaining.sort(key=candidate_rank, reverse=True)
    if len(selected) > MAX_CANDIDATES:
        selected = selected[:MAX_CANDIDATES]
    else:
        selected.extend(remaining[:MAX_CANDIDATES - len(selected)])
    values = selected

    verified = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=CHECK_WORKERS) as pool:
        futures = [pool.submit(check_proxy, p) for p in values]
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            if result:
                verified.append(result)

    # If a source did not supply country metadata, keep the proxy out of the country UI
    # rather than guessing. A future enrichment stage can add country safely.
    by_country = {}
    for p in verified:
        country = p.get("country")
        if country:
            by_country.setdefault(country, []).append(p)

    # Speed is measured only for the best latency/reliability candidates per country.
    for country, items in by_country.items():
        items.sort(key=lambda p: (p.get("latency_ms") or 99999, -(p.get("source_uptime") or 0)))
        for p in items[:SPEED_PER_COUNTRY]:
            p["speed_mbps"] = speed_test(p)

    all_verified = []
    for country, items in by_country.items():
        for p in items:
            p["score"] = score(p)
            p["last_checked"] = now_iso()
            # Do not publish source credentials under a separate secret store: these are
            # only retained when the public source itself supplied them.
            public = {
                "id": p["id"], "protocol": p["protocol"], "host": p["host"], "port": p["port"],
                "country": country, "country_name": COUNTRY_NAMES.get(country, country),
                "latency_ms": p.get("latency_ms"), "speed_mbps": p.get("speed_mbps"),
                "score": p["score"], "exit_ip": p.get("exit_ip"), "source": p.get("source"),
                "last_checked": p["last_checked"]
            }
            if p.get("username") is not None:
                public["auth"] = {"username": p["username"], "password": p.get("password") or ""}
            all_verified.append(public)

    countries = {}
    for p in all_verified:
        countries.setdefault(p["country"], []).append(p)
    for code, items in countries.items():
        items.sort(key=lambda x: (x.get("score") or 0), reverse=True)

    all_verified.sort(key=lambda x: (x.get("score") or 0), reverse=True)
    catalog = {
        "version": 1,
        "generated_at": now_iso(),
        "count": len(all_verified),
        "countries_count": len(countries),
        "countries": [
            {"code": code, "name": COUNTRY_NAMES.get(code, code), "count": len(items), "best": items[0]["id"]}
            for code, items in sorted(countries.items(), key=lambda kv: (-max((x.get("score") or 0) for x in kv[1]), kv[0]))
        ],
        "proxies": all_verified
    }
    stats = {
        "generated_at": catalog["generated_at"],
        "candidates_unique": len(candidates),
        "candidates_checked": len(values),
        "verified": len(all_verified),
        "countries": len(countries),
        "sources": source_stats
    }
    (OUT / "servers.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "countries.json").write_text(json.dumps(catalog["countries"], ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
