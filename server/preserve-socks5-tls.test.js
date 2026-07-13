"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const YAML = require("yaml");
const { restoreSocks5Tls } = require("./preserve-socks5-tls");

test("restores TLS metadata on the matching SOCKS5 node", () => {
  const source = YAML.stringify({
    proxies: [{
      name: "US - Silicon Valley - 12",
      type: "socks5",
      server: "proxy.example.com",
      port: 1443,
      username: "user",
      password: "pass",
      tls: true,
      sni: "proxy.example.com",
      "skip-cert-verify": false
    }]
  });
  const converted = YAML.stringify({
    proxies: [{
      name: "US - Silicon Valley - 12",
      type: "socks5",
      server: "proxy.example.com",
      port: 1443,
      username: "user",
      password: "pass",
      udp: true,
      "skip-cert-verify": true
    }]
  });

  const result = restoreSocks5Tls([source], converted);
  const proxy = YAML.parse(result.body).proxies[0];

  assert.equal(result.restored, 1);
  assert.equal(proxy.tls, true);
  assert.equal(proxy.sni, "proxy.example.com");
  assert.equal(proxy["skip-cert-verify"], false);
  assert.equal(proxy.udp, true);
});

test("does not match a node with different credentials", () => {
  const source = YAML.stringify({
    proxies: [{
      name: "source",
      type: "socks5",
      server: "proxy.example.com",
      port: 443,
      username: "user",
      password: "correct",
      tls: true
    }]
  });
  const converted = YAML.stringify({
    proxies: [{
      name: "converted",
      type: "socks5",
      server: "proxy.example.com",
      port: 443,
      username: "user",
      password: "different"
    }]
  });

  const result = restoreSocks5Tls([source], converted);
  assert.equal(result.restored, 0);
  assert.equal(result.body, converted);
});
