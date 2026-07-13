"use strict";

const dns = require("node:dns").promises;
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { restoreSocks5Tls } = require("./preserve-socks5-tls");

const PORT = Number(process.env.PORT || 80);
const UPSTREAM = new URL(process.env.SUBCONVERTER_UPSTREAM || "https://api.v1.mk");
const DIST = path.resolve(__dirname, "..", "dist");
const MAX_UPSTREAM_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_COUNT = 16;
const FETCH_TIMEOUT_MS = 45_000;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
  }

  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateAddress(normalized.slice("::ffff:".length));
  }
  return normalized === "::1" || normalized === "::" ||
    normalized.startsWith("fc") || normalized.startsWith("fd") ||
    normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb");
}

async function validateSourceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("unsupported source protocol");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) {
    throw new Error("private source hostname");
  }

  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error("private source address");
  }
  return url;
}

async function fetchLimited(url, options, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      redirect: options.redirect || "follow",
      signal: controller.signal
    });
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > maxBytes) throw new Error("response is too large");

    if (!response.body) return { response, body: Buffer.alloc(0) };
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("response is too large");
      }
      chunks.push(Buffer.from(value));
    }
    return { response, body: Buffer.concat(chunks, total) };
  } finally {
    clearTimeout(timer);
  }
}

function upstreamUrl(requestUrl) {
  const incoming = new URL(requestUrl, "http://localhost");
  return new URL(incoming.pathname + incoming.search, UPSTREAM);
}

function copyResponseHeaders(response, outgoing) {
  const skipped = new Set([
    "connection", "content-encoding", "content-length", "keep-alive",
    "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade"
  ]);
  response.headers.forEach((value, name) => {
    if (!skipped.has(name.toLowerCase())) outgoing.setHeader(name, value);
  });
  outgoing.setHeader("access-control-allow-origin", "*");
}

async function loadSourceBodies(searchParams, userAgent) {
  const value = searchParams.get("url");
  if (!value) return [];

  const sourceUrls = value.split("|").map(item => item.trim()).filter(Boolean);
  const selected = sourceUrls.slice(0, MAX_SOURCE_COUNT);
  const results = await Promise.allSettled(selected.map(async item => {
    let url = await validateSourceUrl(item);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const { response, body } = await fetchLimited(url, {
        redirect: "manual",
        headers: { "user-agent": searchParams.get("diyua") || userAgent }
      }, MAX_SOURCE_BYTES);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects === 5) throw new Error("invalid source redirect");
        url = await validateSourceUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new Error("source request failed");
      return body.toString("utf8");
    }
    throw new Error("too many source redirects");
  }));

  return results.filter(item => item.status === "fulfilled").map(item => item.value);
}

async function proxyRequest(req, res, repairClash) {
  const requestUrl = new URL(req.url, "http://localhost");
  const userAgent = req.headers["user-agent"] || "sub-web-modify";
  const { response, body } = await fetchLimited(upstreamUrl(req.url), {
    method: req.method,
    headers: { "accept": req.headers.accept || "*/*", "user-agent": userAgent }
  }, MAX_UPSTREAM_BYTES);

  let output = body;
  let restored = 0;
  const target = String(requestUrl.searchParams.get("target") || "").toLowerCase();
  if (repairClash && req.method !== "HEAD" && response.ok && (target === "clash" || target === "clashr")) {
    const sources = await loadSourceBodies(requestUrl.searchParams, userAgent);
    const result = restoreSocks5Tls(sources, body.toString("utf8"));
    output = Buffer.from(result.body, "utf8");
    restored = result.restored;
  }

  res.statusCode = response.status;
  copyResponseHeaders(response, res);
  res.setHeader("content-length", output.length);
  if (repairClash) res.setHeader("x-socks5-tls-restored", String(restored));
  if (req.method === "HEAD") return res.end();
  res.end(output);
}

function staticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(DIST, relative || "index.html");
  if (candidate !== DIST && !candidate.startsWith(DIST + path.sep)) return null;
  return candidate;
}

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  const pathname = new URL(req.url, "http://localhost").pathname;
  let filename = staticPath(pathname);
  if (!filename) {
    res.statusCode = 400;
    return res.end("Bad Request");
  }

  try {
    const stat = await fs.promises.stat(filename);
    if (stat.isDirectory()) filename = path.join(filename, "index.html");
  } catch (_) {
    filename = path.join(DIST, "index.html");
  }

  try {
    const body = await fs.promises.readFile(filename);
    res.statusCode = 200;
    res.setHeader("content-type", MIME_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream");
    res.setHeader("content-length", body.length);
    res.setHeader("x-content-type-options", "nosniff");
    if (path.extname(filename).toLowerCase() === ".html") res.setHeader("cache-control", "no-cache");
    if (req.method === "HEAD") return res.end();
    res.end(body);
  } catch (_) {
    res.statusCode = 404;
    res.end("Not Found");
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  try {
    if (pathname === "/healthz") {
      res.statusCode = 200;
      return res.end("ok");
    }
    if (pathname === "/sub") return await proxyRequest(req, res, true);
    if (pathname === "/version") return await proxyRequest(req, res, false);
    return await serveStatic(req, res);
  } catch (error) {
    console.error(`request failed for ${pathname}: ${error.message}`);
    if (!res.headersSent) res.statusCode = 502;
    res.end("Bad Gateway");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`sub-web-modify listening on port ${PORT}`);
});

function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  server.close(error => {
    if (error) {
      console.error(`shutdown failed: ${error.message}`);
      process.exit(1);
    }
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
