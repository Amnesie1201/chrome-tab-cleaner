"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../url_utils.js");
const {
  getDuplicateGroups,
  selectKeeper,
  selectMostRecentTab,
  summarizeDuplicateGroups
} = require("../tab_utils.js");

function createTab(id, url, overrides = {}) {
  return {
    id,
    url,
    index: id,
    active: false,
    pinned: false,
    ...overrides
  };
}

test("groups tabs after URL normalization", () => {
  const tabs = [
    createTab(1, "https://example.com/page?current=1&utm_source=test#top"),
    createTab(2, "https://example.com/page?current=1"),
    createTab(3, "https://example.com/other")
  ];

  const groups = getDuplicateGroups(tabs);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].tabs.map((tab) => tab.id), [1, 2]);
  assert.deepEqual(summarizeDuplicateGroups(groups), {
    duplicate_count: 1,
    group_count: 1
  });
});

test("groups different paths when using same-site matching", () => {
  const tabs = [
    createTab(
      1,
      "https://portal.example.net/inventory/list?current=1&pageSize=10"
    ),
    createTab(
      2,
      "https://portal.example.com/inventory/process"
    ),
    createTab(3, "https://other.example.net/")
  ];

  const groups = getDuplicateGroups(tabs, [], "same_site");

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].tabs.map((tab) => tab.id), [1, 2]);
});

test("does not group whitelisted domains", () => {
  const tabs = [
    createTab(1, "https://docs.example.com/page"),
    createTab(2, "https://docs.example.com/page")
  ];

  assert.deepEqual(getDuplicateGroups(tabs, ["example.com"]), []);
});

test("selects a pinned tab before active and lower-index tabs", () => {
  const tabs = [
    createTab(1, "https://example.com", { active: true, index: 0 }),
    createTab(2, "https://example.com", { pinned: true, index: 2 }),
    createTab(3, "https://example.com", { index: 1 })
  ];

  assert.equal(selectKeeper(tabs).id, 2);
});

test("selects the active tab when no duplicate is pinned", () => {
  const tabs = [
    createTab(1, "https://example.com", { index: 0 }),
    createTab(2, "https://example.com", { active: true, index: 2 })
  ];

  assert.equal(selectKeeper(tabs).id, 2);
});

test("selects the most recently accessed duplicate tab", () => {
  const tabs = [
    createTab(1, "https://example.com", {
      index: 0,
      lastAccessed: 100
    }),
    createTab(2, "https://example.com", {
      index: 1,
      lastAccessed: 300
    }),
    createTab(3, "https://example.com", {
      index: 2,
      lastAccessed: 200
    })
  ];

  assert.equal(selectMostRecentTab(tabs).id, 2);
});

test("uses the rightmost tab when access times are unavailable", () => {
  const tabs = [
    createTab(1, "https://example.com", { index: 0 }),
    createTab(2, "https://example.com", { index: 3 }),
    createTab(3, "https://example.com", { index: 1 })
  ];

  assert.equal(selectMostRecentTab(tabs).id, 2);
});
