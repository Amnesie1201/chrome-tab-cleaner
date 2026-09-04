"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getComparisonKey,
  getTabGroupName,
  isSupportedUrl,
  isTrackingParameter,
  isWhitelisted,
  normalizeDomainRule,
  normalizeUrl
} = require("../url_utils.js");

test("supports only HTTP and HTTPS pages", () => {
  assert.equal(isSupportedUrl("https://example.com"), true);
  assert.equal(isSupportedUrl("http://example.com"), true);
  assert.equal(isSupportedUrl("chrome://newtab"), false);
  assert.equal(isSupportedUrl("not a url"), false);
});

test("normalizes fragments, tracking parameters, and query ordering", () => {
  const firstUrl =
    "https://Example.com/article?utm_source=newsletter&b=2&a=1#comments";
  const secondUrl = "https://example.com/article?a=1&b=2";

  assert.equal(normalizeUrl(firstUrl), normalizeUrl(secondUrl));
  assert.equal(normalizeUrl(firstUrl), "https://example.com/article?a=1&b=2");
});

test("same-site matching ignores paths, queries, and top-level domains", () => {
  const ledgerUrl =
    "https://portal.example.net/inventory/list?current=1&pageSize=10";
  const processUrl =
    "https://portal.example.com/inventory/process"
    + "?current=1&pageSize=10&store%5Bsearch%5D=";

  assert.equal(
    getComparisonKey(ledgerUrl, "same_site"),
    getComparisonKey(processUrl, "same_site")
  );
  assert.notEqual(
    getComparisonKey(ledgerUrl, "same_page"),
    getComparisonKey(processUrl, "same_page")
  );
});

test("uses the first hostname label as the tab group name", () => {
  assert.equal(
    getTabGroupName(
      "https://issues.example.com/tickets/view?id=46314179"
    ),
    "issues"
  );
  assert.equal(getTabGroupName("https://example.com/"), "example");
  assert.equal(getTabGroupName("chrome://newtab"), "");
});

test("removes tracking parameter names case-insensitively", () => {
  assert.equal(isTrackingParameter("UTM_Medium"), true);
  assert.equal(isTrackingParameter("fbclid"), true);
  assert.equal(isTrackingParameter("document_id"), false);
  assert.equal(
    normalizeUrl("https://example.com/?GCLID=123&document_id=456"),
    "https://example.com/?document_id=456"
  );
});

test("keeps repeated functional parameters while sorting them", () => {
  assert.equal(
    normalizeUrl("https://example.com/search?tag=b&q=test&tag=a"),
    "https://example.com/search?q=test&tag=b&tag=a"
  );
});

test("normalizes domain rules from common input formats", () => {
  assert.equal(normalizeDomainRule("*.Example.com"), "example.com");
  assert.equal(
    normalizeDomainRule("https://docs.example.com/path"),
    "docs.example.com"
  );
  assert.equal(normalizeDomainRule(""), "");
});

test("whitelist rules include exact domains and subdomains", () => {
  const domainWhitelist = ["example.com", "mail.google.com"];

  assert.equal(
    isWhitelisted("https://example.com/document", domainWhitelist),
    true
  );
  assert.equal(
    isWhitelisted("https://docs.example.com/document", domainWhitelist),
    true
  );
  assert.equal(
    isWhitelisted("https://notexample.com/document", domainWhitelist),
    false
  );
});
