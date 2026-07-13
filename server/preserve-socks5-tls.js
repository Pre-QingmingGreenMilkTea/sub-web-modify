"use strict";

const YAML = require("yaml");

const TLS_FIELDS = [
  "tls",
  "sni",
  "servername",
  "skip-cert-verify",
  "client-fingerprint",
  "fingerprint",
  "alpn"
];

function isSocks5(proxy) {
  const type = String(proxy && proxy.type || "").toLowerCase();
  return type === "socks5" || type === "socks";
}

function identity(proxy) {
  if (!proxy || proxy.server == null || proxy.port == null) return null;

  return JSON.stringify([
    String(proxy.server).trim().toLowerCase(),
    String(proxy.port).trim(),
    proxy.username == null ? "" : String(proxy.username),
    proxy.password == null ? "" : String(proxy.password)
  ]);
}

function parseConfig(body) {
  const config = YAML.parse(String(body).replace(/^\uFEFF/, ""));
  if (!config || !Array.isArray(config.proxies)) return null;
  return config;
}

function collectTlsMetadata(sourceBodies) {
  const metadata = new Map();

  for (const body of sourceBodies) {
    let config;
    try {
      config = parseConfig(body);
    } catch (_) {
      continue;
    }
    if (!config) continue;

    for (const proxy of config.proxies) {
      if (!isSocks5(proxy)) continue;
      const key = identity(proxy);
      if (!key) continue;

      const fields = metadata.get(key) || {};
      for (const field of TLS_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(proxy, field)) {
          fields[field] = proxy[field];
        }
      }
      if (Object.keys(fields).length > 0) metadata.set(key, fields);
    }
  }

  return metadata;
}

function restoreSocks5Tls(sourceBodies, convertedBody) {
  const metadata = collectTlsMetadata(sourceBodies);
  if (metadata.size === 0) return { body: convertedBody, restored: 0 };

  let converted;
  try {
    converted = parseConfig(convertedBody);
  } catch (_) {
    return { body: convertedBody, restored: 0 };
  }
  if (!converted) return { body: convertedBody, restored: 0 };

  let restored = 0;
  for (const proxy of converted.proxies) {
    if (!isSocks5(proxy)) continue;
    const fields = metadata.get(identity(proxy));
    if (!fields) continue;

    for (const [field, value] of Object.entries(fields)) proxy[field] = value;
    restored += 1;
  }

  if (restored === 0) return { body: convertedBody, restored: 0 };
  return { body: YAML.stringify(converted), restored };
}

module.exports = { restoreSocks5Tls };
