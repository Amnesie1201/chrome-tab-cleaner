"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");

function createEvent() {
  let listener;
  return {
    addListener(callback) {
      listener = callback;
    },
    dispatch(...args) {
      return listener(...args);
    }
  };
}

function createBackgroundHarness(
  tabs,
  { deferTimers = false, tabGroupStates = {} } = {}
) {
  const calls = {
    activated_tab_ids: [],
    captured_window_ids: [],
    cleared_notification_ids: [],
    focused_window_ids: [],
    notifications: [],
    popup_open_count: 0,
    removed_tab_ids: [],
    requested_tab_group_ids: [],
    tab_group_requests: [],
    tab_group_updates: []
  };
  const localStorage = {
    duplicates_prevented: 0,
    last_duplicate: null
  };
  const sessionStorage = {};
  const activeNotifications = {};
  const pendingTimers = new Map();
  let nextTimerId = 1;

  const events = {
    installed: createEvent(),
    message: createEvent(),
    notification_button_clicked: createEvent(),
    notification_closed: createEvent(),
    startup: createEvent(),
    tab_activated: createEvent(),
    tab_created: createEvent(),
    tab_removed: createEvent(),
    tab_updated: createEvent()
  };

  const context = vm.createContext({
    URL,
    URLSearchParams,
    console,
    clearTimeout(timerId) {
      pendingTimers.delete(timerId);
    },
    fetch() {
      return Promise.resolve();
    },
    setTimeout(callback) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      if (deferTimers) {
        pendingTimers.set(timerId, callback);
      } else {
        callback();
      }
      return timerId;
    },
    chrome: {
      action: {
        async openPopup() {
          calls.popup_open_count += 1;
        },
        async setBadgeBackgroundColor() {},
        async setBadgeText() {}
      },
      notifications: {
        onButtonClicked: events.notification_button_clicked,
        onClosed: events.notification_closed,
        async clear(notificationId) {
          calls.cleared_notification_ids.push(notificationId);
          delete activeNotifications[notificationId];
          return true;
        },
        async create(notificationId, options) {
          activeNotifications[notificationId] = options;
          calls.notifications.push({ notificationId, options });
          return notificationId;
        },
        async getAll() {
          return activeNotifications;
        }
      },
      runtime: {
        onInstalled: events.installed,
        onMessage: events.message,
        onStartup: events.startup
      },
      storage: {
        local: {
          async get(defaults) {
            return { ...defaults, ...localStorage };
          },
          async set(values) {
            Object.assign(localStorage, values);
          }
        },
        session: {
          async get(defaults) {
            return { ...defaults, ...sessionStorage };
          },
          async set(values) {
            Object.assign(sessionStorage, values);
          }
        },
        sync: {
          async get(defaults) {
            return defaults;
          },
          async set() {}
        }
      },
      tabGroups: {
        TAB_GROUP_ID_NONE: -1,
        async get(groupId) {
          calls.requested_tab_group_ids.push(groupId);
          return {
            collapsed: false,
            id: groupId,
            ...tabGroupStates[groupId]
          };
        },
        async update(groupId, updateProperties) {
          calls.tab_group_updates.push({ groupId, updateProperties });
        }
      },
      tabs: {
        onActivated: events.tab_activated,
        onCreated: events.tab_created,
        onRemoved: events.tab_removed,
        onUpdated: events.tab_updated,
        async query() {
          return tabs;
        },
        async get(tabId) {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (!tab) {
            throw new Error(`Unknown tab ${tabId}`);
          }
          return tab;
        },
        async group(groupProperties) {
          calls.tab_group_requests.push(groupProperties);
          const groupId = groupProperties.groupId
            ?? 100 + calls.tab_group_requests.length;
          for (const tabId of groupProperties.tabIds) {
            const tab = tabs.find((candidate) => candidate.id === tabId);
            if (tab) {
              tab.groupId = groupId;
            }
          }
          return groupId;
        },
        async captureVisibleTab(windowId) {
          calls.captured_window_ids.push(windowId);
          return "data:image/jpeg;base64,dGh1bWJuYWls";
        },
        async remove(tabIds) {
          const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
          calls.removed_tab_ids.push(...ids);
        },
        async update(tabId, updateProperties = {}) {
          calls.activated_tab_ids.push(tabId);
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (tab && updateProperties.active) {
            for (const candidate of tabs) {
              if (candidate.windowId === tab.windowId) {
                candidate.active = candidate.id === tabId;
              }
            }
            events.tab_activated.dispatch({
              tabId,
              windowId: tab.windowId
            });
          }
          return tab;
        }
      },
      windows: {
        async update(windowId) {
          calls.focused_window_ids.push(windowId);
        }
      }
    }
  });

  context.globalThis = context;
  context.importScripts = (...filenames) => {
    for (const filename of filenames) {
      const source = fs.readFileSync(path.join(projectRoot, filename), "utf8");
      vm.runInContext(source, context, { filename });
    }
  };

  const backgroundSource = fs.readFileSync(
    path.join(projectRoot, "background.js"),
    "utf8"
  );
  vm.runInContext(backgroundSource, context, { filename: "background.js" });

  return {
    calls,
    events,
    flushTimers() {
      const callbacks = Array.from(pendingTimers.values());
      pendingTimers.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
    localStorage
  };
}

test("primary decision closes the existing tab and keeps the new tab", async () => {
  const url =
    "https://portal.example.com/inventory/process"
    + "?current=1&pageSize=10&store%5Bcategory%5D=hardware"
    + "&store%5Bsearch%5D=";
  const tabs = [
    {
      id: 11,
      windowId: 1,
      index: 0,
      url: "https://portal.example.net/inventory/list"
        + "?current=1&pageSize=10",
      active: false,
      pinned: false,
      status: "complete"
    },
    {
      id: 12,
      windowId: 1,
      index: 1,
      url,
      active: true,
      pinned: false,
      status: "complete"
    }
  ];
  const { calls, events, localStorage } = createBackgroundHarness(tabs);

  tabs[0].active = true;
  tabs[1].active = false;
  events.tab_activated.dispatch({ tabId: 11, windowId: 1 });
  await new Promise((resolve) => setImmediate(resolve));

  tabs[0].active = false;
  tabs[1].active = true;
  events.tab_updated.dispatch(12, { status: "complete" }, tabs[1]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.notifications[0].options.title, "发现重复标签页");
  assert.equal(
    calls.notifications[0].options.buttons[0].title,
    "关闭旧标签"
  );
  assert.equal(
    calls.notifications[0].options.buttons[1].title,
    "保留并分组"
  );
  assert.equal(calls.popup_open_count, 1);
  assert.deepEqual(calls.removed_tab_ids, []);
  assert.equal(localStorage.duplicates_prevented, 0);

  const automaticPopupContext = await dispatchMessage(events, {
    type: "consume_popup_context",
    window_id: 1
  });
  const manualPopupContext = await dispatchMessage(events, {
    type: "consume_popup_context",
    window_id: 1
  });
  assert.equal(automaticPopupContext.display_mode, "decision");
  assert.equal(manualPopupContext.display_mode, "full");

  const pendingResponse = await new Promise((resolve) => {
    events.message.dispatch(
      { type: "get_pending_duplicate", window_id: 1 },
      {},
      resolve
    );
  });
  assert.equal(pendingResponse.pending_count, 1);
  assert.equal(pendingResponse.decision.duplicate_tab_id, 12);
  assert.equal(
    pendingResponse.decision.target_thumbnail_data_url,
    "data:image/jpeg;base64,dGh1bWJuYWls"
  );

  events.notification_button_clicked.dispatch(
    calls.notifications[0].notificationId,
    0
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.activated_tab_ids, []);
  assert.deepEqual(calls.focused_window_ids, []);
  assert.deepEqual(calls.removed_tab_ids, [11]);
  assert.equal(localStorage.duplicates_prevented, 1);
});

test("captures an uncached background target before showing the prompt", async () => {
  const tabs = [
    {
      ...createTab(1, "https://portal.example.net/inventory/list"),
      active: false,
      status: "complete"
    },
    {
      ...createTab(2, "https://portal.example.com/inventory/process"),
      active: true,
      status: "complete"
    }
  ];
  const { calls, events } = createBackgroundHarness(tabs);

  events.tab_updated.dispatch(2, { status: "complete" }, tabs[1]);
  await new Promise((resolve) => setImmediate(resolve));

  const pendingResponse = await dispatchMessage(events, {
    type: "get_pending_duplicate",
    window_id: 1
  });

  assert.deepEqual(calls.activated_tab_ids, [1, 2]);
  assert.ok(calls.captured_window_ids.includes(1));
  assert.equal(
    pendingResponse.decision.target_thumbnail_data_url,
    "data:image/jpeg;base64,dGh1bWJuYWls"
  );
});

test("closes the most recently accessed old duplicate", async () => {
  const tabs = [
    {
      ...createTab(31, "https://example.com/first"),
      index: 0,
      lastAccessed: 100,
      status: "complete"
    },
    {
      ...createTab(32, "https://example.com/recent"),
      index: 1,
      lastAccessed: 300,
      status: "complete"
    },
    {
      ...createTab(33, "https://example.com/new"),
      active: true,
      index: 2,
      lastAccessed: 400,
      status: "complete"
    }
  ];
  const { calls, events } = createBackgroundHarness(tabs);

  events.tab_updated.dispatch(33, { status: "complete" }, tabs[2]);
  await new Promise((resolve) => setImmediate(resolve));
  const pendingResponse = await dispatchMessage(events, {
    type: "get_pending_duplicate",
    window_id: 1
  });

  assert.equal(pendingResponse.decision.target_tab_id, 32);

  await dispatchMessage(events, {
    type: "resolve_duplicate",
    duplicate_tab_id: 33,
    choice: "close_existing"
  });
  assert.deepEqual(calls.removed_tab_ids, [32]);
});

test("does not activate a thumbnail target in a collapsed tab group", async () => {
  const tabs = [
    {
      ...createTab(41, "https://example.com/old"),
      active: false,
      groupId: 7,
      status: "complete"
    },
    {
      ...createTab(42, "https://example.com/new"),
      active: true,
      status: "complete"
    }
  ];
  const { calls, events } = createBackgroundHarness(tabs, {
    tabGroupStates: {
      7: { collapsed: true }
    }
  });

  events.tab_updated.dispatch(42, { status: "complete" }, tabs[1]);
  await new Promise((resolve) => setImmediate(resolve));
  const pendingResponse = await dispatchMessage(events, {
    type: "get_pending_duplicate",
    window_id: 1
  });

  assert.deepEqual(calls.requested_tab_group_ids, [7]);
  assert.deepEqual(calls.activated_tab_ids, []);
  assert.equal(pendingResponse.decision.target_tab_id, 41);
  assert.equal(pendingResponse.decision.target_thumbnail_data_url, null);

  await dispatchMessage(events, {
    type: "resolve_duplicate",
    duplicate_tab_id: 42,
    choice: "keep"
  });
  assert.equal(calls.tab_group_requests.length, 1);
  assert.equal(calls.tab_group_requests[0].groupId, 7);
  assert.deepEqual(Array.from(calls.tab_group_requests[0].tabIds), [42]);
  assert.equal(calls.tab_group_updates[0].groupId, 7);
  assert.equal(calls.tab_group_updates[0].updateProperties.title, "example");
  assert.equal(
    Object.hasOwn(calls.tab_group_updates[0].updateProperties, "collapsed"),
    false
  );
});

test("moves the new tab into the old tab group before closing the old tab", async () => {
  const tabs = [
    {
      ...createTab(61, "https://example.com/old"),
      active: false,
      groupId: 9,
      status: "complete"
    },
    {
      ...createTab(62, "https://example.com/new"),
      active: true,
      status: "complete"
    }
  ];
  const { calls, events } = createBackgroundHarness(tabs, {
    tabGroupStates: {
      9: { collapsed: true }
    }
  });

  events.tab_updated.dispatch(62, { status: "complete" }, tabs[1]);
  await new Promise((resolve) => setImmediate(resolve));
  const response = await dispatchMessage(events, {
    type: "resolve_duplicate",
    duplicate_tab_id: 62,
    choice: "close_existing"
  });

  assert.equal(response.resolved, true);
  assert.equal(calls.tab_group_requests.length, 1);
  assert.equal(calls.tab_group_requests[0].groupId, 9);
  assert.deepEqual(Array.from(calls.tab_group_requests[0].tabIds), [62]);
  assert.deepEqual(calls.removed_tab_ids, [61]);
  assert.deepEqual(calls.tab_group_updates, []);
});

test("keep choice groups both tabs using the first hostname label", async () => {
  const tabs = [
    createTab(
      1,
      "https://issues.example.com/tickets/view?id=100"
    ),
    createTab(
      2,
      "https://issues.example.com/tickets/view?id=46314179"
    )
  ];
  const { calls, events, localStorage } = createBackgroundHarness(tabs);

  events.tab_updated.dispatch(2, { status: "complete" }, tabs[1]);
  await new Promise((resolve) => setImmediate(resolve));
  const response = await new Promise((resolve) => {
    events.message.dispatch(
      {
        type: "resolve_duplicate",
        duplicate_tab_id: 2,
        choice: "keep"
      },
      {},
      resolve
    );
  });

  assert.equal(response.resolved, true);
  assert.deepEqual(calls.activated_tab_ids, []);
  assert.deepEqual(calls.removed_tab_ids, []);
  assert.equal(localStorage.duplicates_prevented, 0);
  assert.equal(calls.tab_group_requests.length, 1);
  assert.deepEqual(
    Array.from(calls.tab_group_requests[0].tabIds),
    [1, 2]
  );
  assert.equal(calls.tab_group_requests[0].createProperties.windowId, 1);
  assert.equal(calls.tab_group_updates[0].groupId, 101);
  assert.equal(calls.tab_group_updates[0].updateProperties.title, "issues");
});

test("clears all pending duplicate decisions in the current window", async () => {
  const tabs = [
    {
      ...createTab(51, "https://example.com/original"),
      status: "complete"
    }
  ];
  const { calls, events } = createBackgroundHarness(tabs);

  const secondTab = {
    ...createTab(52, "https://example.com/second"),
    active: true,
    status: "complete"
  };
  tabs.push(secondTab);
  events.tab_updated.dispatch(52, { status: "complete" }, secondTab);
  await new Promise((resolve) => setImmediate(resolve));

  secondTab.active = false;
  const thirdTab = {
    ...createTab(53, "https://example.com/third"),
    active: true,
    status: "complete"
  };
  tabs.push(thirdTab);
  events.tab_updated.dispatch(53, { status: "complete" }, thirdTab);
  await new Promise((resolve) => setImmediate(resolve));

  const beforeClear = await dispatchMessage(events, {
    type: "get_pending_duplicate",
    window_id: 1
  });
  assert.equal(beforeClear.pending_count, 2);

  const response = await dispatchMessage(events, {
    type: "clear_pending_duplicates",
    window_id: 1
  });
  const afterClear = await dispatchMessage(events, {
    type: "get_pending_duplicate",
    window_id: 1
  });

  assert.equal(response.cleared_count, 2);
  assert.equal(afterClear.pending_count, 0);
  assert.equal(calls.cleared_notification_ids.length, 2);
  assert.deepEqual(calls.removed_tab_ids, []);
});

test("persists page visits and searches them by title", async () => {
  const firstUrl = "https://example.com/ledger";
  const secondUrl = "https://example.com/process";
  const tab = {
    ...createTab(7, firstUrl),
    active: true,
    status: "complete",
    title: "Asset Ledger"
  };
  const {
    events,
    flushTimers,
    localStorage
  } = createBackgroundHarness([tab], { deferTimers: true });

  events.tab_updated.dispatch(7, { status: "complete" }, tab);
  assert.deepEqual(localStorage.page_visit_history, undefined);
  flushTimers();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(localStorage.page_visit_history.length, 1);
  assert.equal(localStorage.page_visit_history[0].url, firstUrl);
  assert.equal(localStorage.page_visit_history[0].title, "Asset Ledger");
  assert.equal(typeof localStorage.page_visit_history[0].opened_at, "number");

  await new Promise((resolve) => setTimeout(resolve, 2));
  events.tab_updated.dispatch(7, { status: "loading" }, {
    ...tab,
    status: "loading"
  });
  tab.url = secondUrl;
  tab.title = "Asset Appropriation";
  events.tab_updated.dispatch(7, { status: "complete" }, tab);
  flushTimers();
  await new Promise((resolve) => setImmediate(resolve));

  const response = await dispatchMessage(events, {
    type: "search_page_history",
    query: "LEDGER"
  });

  assert.equal(response.total_count, 2);
  assert.equal(response.records.length, 1);
  assert.equal(response.records[0].title, "Asset Ledger");
  assert.ok(response.records[0].duration_ms >= 0);
  assert.equal(response.records[0].is_open, false);
});

test("does not record URL-only updates or pages that resume loading", async () => {
  const tab = {
    ...createTab(8, "https://example.com/loading"),
    active: true,
    status: "complete",
    title: "Loading"
  };
  const {
    events,
    flushTimers,
    localStorage
  } = createBackgroundHarness([tab], { deferTimers: true });

  events.tab_updated.dispatch(8, { url: tab.url }, tab);
  events.tab_updated.dispatch(8, { status: "complete" }, tab);
  events.tab_updated.dispatch(8, { status: "loading" }, {
    ...tab,
    status: "loading"
  });
  flushTimers();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(localStorage.page_visit_history, undefined);
});

test("does not backfill existing tabs and clears incompatible history once", async () => {
  const tab = {
    ...createTab(9, "https://example.com/already-open"),
    active: true,
    status: "complete",
    title: "Already open"
  };
  const { events, localStorage } = createBackgroundHarness([tab]);
  localStorage.page_visit_history = [{
    duration_ms: 0,
    id: "stale",
    opened_at: Date.now(),
    tab_id: 9,
    title: "Loading",
    url: tab.url
  }];

  events.startup.dispatch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(localStorage.page_visit_history.length, 1);

  await events.installed.dispatch({ reason: "update" });
  assert.deepEqual(Array.from(localStorage.page_visit_history), []);
  assert.equal(localStorage.page_history_schema_version, 2);
});

test("discards the old page visit when duplicate cleanup closes it", async () => {
  const oldTab = {
    ...createTab(21, "https://example.com/old"),
    active: true,
    status: "complete",
    title: "Old page"
  };
  const tabs = [oldTab];
  const { events, localStorage } = createBackgroundHarness(tabs);

  events.tab_updated.dispatch(21, { status: "complete" }, oldTab);
  await new Promise((resolve) => setImmediate(resolve));

  const newTab = {
    ...createTab(22, "https://example.com/new"),
    active: true,
    status: "complete",
    title: "New page"
  };
  oldTab.active = false;
  tabs.push(newTab);
  events.tab_updated.dispatch(22, { status: "complete" }, newTab);
  await new Promise((resolve) => setImmediate(resolve));

  const response = await dispatchMessage(events, {
    type: "resolve_duplicate",
    duplicate_tab_id: 22,
    choice: "close_existing"
  });

  assert.equal(response.resolved, true);
  assert.deepEqual(
    Array.from(localStorage.page_visit_history, (visit) => visit.url),
    [newTab.url]
  );
});

test("popup scan reports duplicates already present in the window", async () => {
  const tabs = [
    createTab(1, "https://example.com/page"),
    createTab(2, "https://example.com/page#section"),
    createTab(3, "https://example.com/other")
  ];
  const { events } = createBackgroundHarness(tabs);

  const response = await new Promise((resolve) => {
    const keepsChannelOpen = events.message.dispatch(
      { type: "scan_duplicates", window_id: 1 },
      {},
      resolve
    );
    assert.equal(keepsChannelOpen, true);
  });

  assert.equal(response.duplicate_count, 2);
  assert.equal(response.group_count, 1);
});

function createTab(id, url) {
  return {
    id,
    windowId: 1,
    index: id,
    url,
    active: false,
    pinned: false
  };
}

function dispatchMessage(events, message) {
  return new Promise((resolve) => {
    events.message.dispatch(message, {}, resolve);
  });
}
