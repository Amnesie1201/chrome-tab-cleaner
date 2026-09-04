importScripts("url_utils.js");
importScripts("tab_utils.js");

const DEFAULT_SETTINGS = Object.freeze({
  deduplication_enabled: true,
  domain_whitelist: [],
  matching_strategy: "same_site"
});

const DUPLICATE_NOTIFICATION_PREFIX = "tab-keeper-duplicate";
const ACKNOWLEDGED_DUPLICATES_KEY = "acknowledged_duplicate_urls";
const PENDING_DUPLICATES_KEY = "pending_duplicate_decisions";
const POPUP_LAUNCH_CONTEXT_KEY = "popup_launch_context";
const TAB_THUMBNAILS_KEY = "tab_thumbnails";
const PAGE_VISIT_HISTORY_KEY = "page_visit_history";
const PAGE_HISTORY_SCHEMA_VERSION_KEY = "page_history_schema_version";
const ACTIVE_PAGE_VISITS_KEY = "active_page_visits";
const MAX_CACHED_THUMBNAILS = 6;
const MAX_PAGE_VISITS = 2000;
const MAX_HISTORY_RESULTS = 30;
const PAGE_HISTORY_SCHEMA_VERSION = 2;
const PAGE_LOAD_SETTLE_DELAY_MS = 800;
const scheduledTabUrls = new Map();
const scheduledHistoryVisits = new Map();
const thumbnailCaptureTimers = new Map();
const suppressedThumbnailActivations = new Set();
let processingQueue = Promise.resolve();
let historyQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const existingSettings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(existingSettings);

  const storedLocalData = await chrome.storage.local.get({
    duplicates_prevented: 0,
    last_duplicate: null,
    [PAGE_VISIT_HISTORY_KEY]: [],
    [PAGE_HISTORY_SCHEMA_VERSION_KEY]: 0
  });
  const pageVisitHistory = storedLocalData[PAGE_HISTORY_SCHEMA_VERSION_KEY]
    < PAGE_HISTORY_SCHEMA_VERSION
    ? []
    : storedLocalData[PAGE_VISIT_HISTORY_KEY];
  await chrome.storage.local.set({
    ...storedLocalData,
    [PAGE_VISIT_HISTORY_KEY]: pageVisitHistory,
    [PAGE_HISTORY_SCHEMA_VERSION_KEY]: PAGE_HISTORY_SCHEMA_VERSION
  });
  await chrome.storage.session.set({
    [ACTIVE_PAGE_VISITS_KEY]: {},
    [ACKNOWLEDGED_DUPLICATES_KEY]: {},
    [PENDING_DUPLICATES_KEY]: {},
    [POPUP_LAUNCH_CONTEXT_KEY]: null,
    [TAB_THUMBNAILS_KEY]: {}
  });
  await captureActiveTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void captureActiveTabs();
});

chrome.tabs.onCreated.addListener((tab) => {
  const currentUrl = tab.pendingUrl || tab.url;
  if (tab.status === "complete" && UrlUtils.isSupportedUrl(currentUrl)) {
    scheduleTabCheck(tab.id, currentUrl, tab.windowId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const eventTime = Date.now();
  if (changeInfo.status === "loading") {
    cancelScheduledHistoryVisit(tabId);
    enqueueHistoryTask(() => finishPageVisit(tabId, eventTime));
  }
  if (changeInfo.title) {
    enqueueHistoryTask(() => updatePageVisitTitle(tabId, changeInfo.title));
  }

  if (changeInfo.status !== "complete") {
    return;
  }

  const currentUrl = tab.url;
  scheduleHistoryVisit(tabId, currentUrl, eventTime);
  if (!UrlUtils.isSupportedUrl(currentUrl)) {
    return;
  }

  scheduleTabCheck(tabId, currentUrl, tab.windowId);
  if (tab.active) {
    scheduleThumbnailCapture(tabId, tab.windowId);
  }
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (suppressedThumbnailActivations.delete(tabId)) {
    return;
  }

  scheduleThumbnailCapture(tabId, windowId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelScheduledHistoryVisit(tabId);
  enqueueHistoryTask(() => finishPageVisit(tabId, Date.now()));
  scheduledTabUrls.delete(tabId);
  clearTimeout(thumbnailCaptureTimers.get(tabId));
  thumbnailCaptureTimers.delete(tabId);
  void handleRemovedTab(tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const supportedMessageTypes = [
    "clear_pending_duplicates",
    "cleanup_duplicates",
    "consume_popup_context",
    "get_pending_duplicate",
    "search_page_history",
    "resolve_duplicate",
    "scan_duplicates"
  ];
  if (!message || !supportedMessageTypes.includes(message.type)) {
    return false;
  }

  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      console.warn("Tab Keeper message failed:", error);
      sendResponse({ error: error.message });
    });

  return true;
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (!notificationId.startsWith(`${DUPLICATE_NOTIFICATION_PREFIX}|`)) {
    return;
  }

  void handleNotificationDecision(notificationId, buttonIndex);
});

chrome.notifications.onClosed.addListener((notificationId) => {
  if (notificationId.startsWith(`${DUPLICATE_NOTIFICATION_PREFIX}|`)) {
    void refreshDecisionBadge();
  }
});

function scheduleTabCheck(tabId, rawUrl, windowId) {
  const normalizedUrl = UrlUtils.normalizeUrl(rawUrl);
  if (!normalizedUrl || scheduledTabUrls.get(tabId) === normalizedUrl) {
    return;
  }

  scheduledTabUrls.set(tabId, normalizedUrl);
  processingQueue = processingQueue
    .then(async () => {
      if (scheduledTabUrls.get(tabId) !== normalizedUrl) {
        return;
      }

      scheduledTabUrls.delete(tabId);
      await handleNavigatedTab(tabId, rawUrl, windowId);
    })
    .catch((error) => {
      console.warn("Tab Keeper could not process a tab:", error);
    });
}

async function handleNavigatedTab(tabId, rawUrl, windowId) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  if (!settings.deduplication_enabled
    || UrlUtils.isWhitelisted(rawUrl, settings.domain_whitelist)) {
    return;
  }

  const comparisonKey = UrlUtils.getComparisonKey(
    rawUrl,
    settings.matching_strategy
  );
  if (await isAcknowledgedDuplicate(tabId, comparisonKey)) {
    return;
  }

  const tabsInWindow = await chrome.tabs.query({ windowId });
  const duplicateTabs = tabsInWindow.filter((tab) => {
    if (tab.id === tabId) {
      return false;
    }

    const tabUrl = tab.pendingUrl || tab.url;
    return UrlUtils.getComparisonKey(tabUrl, settings.matching_strategy)
      === comparisonKey;
  });

  if (duplicateTabs.length === 0) {
    return;
  }

  const targetTab = TabUtils.selectMostRecentTab(duplicateTabs);
  await acknowledgeDuplicate(tabId, comparisonKey);
  await ensureTargetThumbnail(targetTab, tabId);
  await showDuplicatePrompt(tabId, rawUrl, targetTab);
}

async function handleMessage(message) {
  if (message.type === "clear_pending_duplicates") {
    return clearPendingDuplicates(message.window_id);
  }

  if (message.type === "consume_popup_context") {
    return consumePopupContext();
  }

  if (message.type === "get_pending_duplicate") {
    return getPendingDuplicate(message.window_id);
  }

  if (message.type === "resolve_duplicate") {
    return resolvePendingDuplicate(message.duplicate_tab_id, message.choice);
  }

  if (message.type === "search_page_history") {
    return enqueueHistoryTask(() => searchPageHistory(message.query));
  }

  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const tabs = await chrome.tabs.query({ windowId: message.window_id });
  const groups = TabUtils.getDuplicateGroups(
    tabs,
    settings.domain_whitelist,
    settings.matching_strategy
  );

  if (message.type === "scan_duplicates") {
    return TabUtils.summarizeDuplicateGroups(groups);
  }

  const tabsToClose = [];
  for (const group of groups) {
    const keeper = TabUtils.selectKeeper(group.tabs);
    tabsToClose.push(...group.tabs.filter((tab) => tab.id !== keeper.id));
  }

  if (tabsToClose.length > 0) {
    await enqueueHistoryTask(async () => {
      for (const tab of tabsToClose) {
        await discardPageVisit(tab.id);
      }
    });
    await Promise.all(
      tabsToClose.map((tab) => clearPendingDuplicate(tab.id))
    );
    await chrome.tabs.remove(tabsToClose.map((tab) => tab.id));
    const lastClosedTab = tabsToClose[tabsToClose.length - 1];
    await recordPreventedDuplicates(
      tabsToClose.length,
      lastClosedTab.url,
      lastClosedTab.title || lastClosedTab.url
    );
  }

  return {
    closed_count: tabsToClose.length,
    duplicate_count: 0,
    group_count: 0
  };
}

function enqueueHistoryTask(task) {
  historyQueue = historyQueue
    .then(task)
    .catch((error) => {
      console.warn("Tab Keeper could not update page history:", error);
    });
  return historyQueue;
}

function scheduleHistoryVisit(tabId, expectedUrl, openedAt) {
  cancelScheduledHistoryVisit(tabId);

  const timerId = setTimeout(() => {
    scheduledHistoryVisits.delete(tabId);
    enqueueHistoryTask(async () => {
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        return;
      }

      const currentUrl = tab.pendingUrl || tab.url;
      if (tab.status !== "complete" || currentUrl !== expectedUrl) {
        return;
      }

      await startPageVisit(tabId, tab, openedAt);
    });
  }, PAGE_LOAD_SETTLE_DELAY_MS);
  scheduledHistoryVisits.set(tabId, timerId);
}

function cancelScheduledHistoryVisit(tabId) {
  clearTimeout(scheduledHistoryVisits.get(tabId));
  scheduledHistoryVisits.delete(tabId);
}

async function startPageVisit(tabId, tab, openedAt) {
  const rawUrl = tab.pendingUrl || tab.url;
  if (tab.incognito || !UrlUtils.isSupportedUrl(rawUrl)) {
    await finishPageVisit(tabId, openedAt);
    return;
  }

  let activeVisits = await getActivePageVisits();
  const existingVisit = activeVisits[tabId];
  if (existingVisit?.url === rawUrl) {
    if (tab.title && tab.title !== existingVisit.title) {
      await updatePageVisitTitle(tabId, tab.title);
    }
    return;
  }

  if (existingVisit) {
    await finishPageVisit(tabId, openedAt);
    activeVisits = await getActivePageVisits();
  }

  const title = tab.title || new URL(rawUrl).hostname;
  const visitId = `${openedAt}-${tabId}-${Math.random().toString(36).slice(2, 8)}`;
  const visit = {
    duration_ms: 0,
    id: visitId,
    opened_at: openedAt,
    tab_id: tabId,
    title,
    url: rawUrl
  };
  const storedValues = await chrome.storage.local.get({
    [PAGE_VISIT_HISTORY_KEY]: []
  });
  const history = [visit, ...storedValues[PAGE_VISIT_HISTORY_KEY]]
    .slice(0, MAX_PAGE_VISITS);

  activeVisits[tabId] = {
    opened_at: openedAt,
    title,
    url: rawUrl,
    visit_id: visitId
  };
  await Promise.all([
    chrome.storage.local.set({
      [PAGE_VISIT_HISTORY_KEY]: history
    }),
    chrome.storage.session.set({
      [ACTIVE_PAGE_VISITS_KEY]: activeVisits
    })
  ]);
}

async function finishPageVisit(tabId, endedAt) {
  const activeVisits = await getActivePageVisits();
  const activeVisit = activeVisits[tabId];
  if (!activeVisit) {
    return;
  }

  const storedValues = await chrome.storage.local.get({
    [PAGE_VISIT_HISTORY_KEY]: []
  });
  const history = storedValues[PAGE_VISIT_HISTORY_KEY].map((visit) => {
    if (visit.id !== activeVisit.visit_id) {
      return visit;
    }

    return {
      ...visit,
      duration_ms: Math.max(0, endedAt - activeVisit.opened_at)
    };
  });

  delete activeVisits[tabId];
  await Promise.all([
    chrome.storage.local.set({
      [PAGE_VISIT_HISTORY_KEY]: history
    }),
    chrome.storage.session.set({
      [ACTIVE_PAGE_VISITS_KEY]: activeVisits
    })
  ]);
}

async function discardPageVisit(tabId) {
  cancelScheduledHistoryVisit(tabId);

  const activeVisits = await getActivePageVisits();
  const activeVisit = activeVisits[tabId];
  if (!activeVisit) {
    return;
  }

  const storedValues = await chrome.storage.local.get({
    [PAGE_VISIT_HISTORY_KEY]: []
  });
  const history = storedValues[PAGE_VISIT_HISTORY_KEY]
    .filter((visit) => visit.id !== activeVisit.visit_id);

  delete activeVisits[tabId];
  await Promise.all([
    chrome.storage.local.set({
      [PAGE_VISIT_HISTORY_KEY]: history
    }),
    chrome.storage.session.set({
      [ACTIVE_PAGE_VISITS_KEY]: activeVisits
    })
  ]);
}

async function updatePageVisitTitle(tabId, title) {
  const activeVisits = await getActivePageVisits();
  const activeVisit = activeVisits[tabId];
  if (!activeVisit || !title || activeVisit.title === title) {
    return;
  }

  const storedValues = await chrome.storage.local.get({
    [PAGE_VISIT_HISTORY_KEY]: []
  });
  const history = storedValues[PAGE_VISIT_HISTORY_KEY].map((visit) => (
    visit.id === activeVisit.visit_id
      ? { ...visit, title }
      : visit
  ));

  activeVisit.title = title;
  await Promise.all([
    chrome.storage.local.set({
      [PAGE_VISIT_HISTORY_KEY]: history
    }),
    chrome.storage.session.set({
      [ACTIVE_PAGE_VISITS_KEY]: activeVisits
    })
  ]);
}

async function searchPageHistory(query) {
  const now = Date.now();
  const activeVisits = await getActivePageVisits();
  const activeVisitsById = new Map(
    Object.values(activeVisits).map((visit) => [visit.visit_id, visit])
  );
  const storedValues = await chrome.storage.local.get({
    [PAGE_VISIT_HISTORY_KEY]: []
  });
  const history = storedValues[PAGE_VISIT_HISTORY_KEY].map((visit) => {
    const activeVisit = activeVisitsById.get(visit.id);
    if (!activeVisit) {
      return visit;
    }

    return {
      ...visit,
      duration_ms: Math.max(0, now - activeVisit.opened_at)
    };
  });
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  const matchingVisits = history.filter((visit) => (
    !normalizedQuery
      || String(visit.title || "").toLocaleLowerCase().includes(normalizedQuery)
  ));

  return {
    records: matchingVisits.slice(0, MAX_HISTORY_RESULTS).map((visit) => ({
      ...visit,
      is_open: activeVisitsById.has(visit.id)
    })),
    total_count: history.length
  };
}

async function getActivePageVisits() {
  const storedValues = await chrome.storage.session.get({
    [ACTIVE_PAGE_VISITS_KEY]: {}
  });
  return storedValues[ACTIVE_PAGE_VISITS_KEY];
}

async function recordPreventedDuplicates(count, url, targetTitle) {
  const { duplicates_prevented: duplicatesPrevented } =
    await chrome.storage.local.get({ duplicates_prevented: 0 });

  await chrome.storage.local.set({
    duplicates_prevented: duplicatesPrevented + count,
    last_duplicate: {
      target_title: targetTitle,
      url,
      prevented_at: new Date().toISOString()
    }
  });
}

async function showDuplicatePrompt(duplicateTabId, duplicateUrl, targetTab) {
  const notificationId = [
    DUPLICATE_NOTIFICATION_PREFIX,
    duplicateTabId,
    targetTab.id,
    targetTab.windowId,
    Date.now()
  ].join("|");

  await storePendingDuplicate({
    created_at: Date.now(),
    duplicate_tab_id: duplicateTabId,
    duplicate_url: duplicateUrl,
    notification_id: notificationId,
    target_tab_id: targetTab.id,
    target_title: targetTab.title || "",
    target_url: targetTab.url || "",
    window_id: targetTab.windowId
  });
  await refreshDecisionBadge();

  try {
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "发现重复标签页",
      message: targetTab.title
        ? `“${targetTab.title}”已经打开。`
        : "这个网页已经在当前窗口打开。",
      contextMessage: "Tab Keeper",
      buttons: [
        { title: "关闭旧标签" },
        { title: "保留并分组" }
      ],
      requireInteraction: true
    });
  } catch (error) {
    console.warn("Tab Keeper could not show a system notification:", error);
  }

  if (typeof chrome.action.openPopup === "function") {
    await chrome.storage.session.set({
      [POPUP_LAUNCH_CONTEXT_KEY]: {
        created_at: Date.now(),
        display_mode: "decision"
      }
    });

    try {
      await chrome.action.openPopup();
    } catch {
      await chrome.storage.session.set({
        [POPUP_LAUNCH_CONTEXT_KEY]: null
      });
      // Chrome may require a user gesture; the badge remains as a fallback.
    }
  }
}

async function handleNotificationDecision(notificationId, buttonIndex) {
  const notificationParts = notificationId.split("|");
  const duplicateTabId = Number(notificationParts[1]);

  await resolvePendingDuplicate(
    duplicateTabId,
    buttonIndex === 0 ? "close_existing" : "keep"
  );
}

async function getPendingDuplicate(windowId) {
  const pendingDuplicates = await getPendingDuplicates();
  const matchingDecisions = Object.values(pendingDuplicates)
    .filter((decision) => decision.window_id === windowId)
    .sort((left, right) => right.created_at - left.created_at);
  const decision = matchingDecisions[0] || null;

  if (decision) {
    const thumbnails = await getTabThumbnails();
    const thumbnail = thumbnails[decision.target_tab_id];
    decision.target_thumbnail_data_url = thumbnail?.data_url || null;
  }

  return {
    decision,
    pending_count: matchingDecisions.length
  };
}

async function consumePopupContext() {
  const storedValues = await chrome.storage.session.get({
    [POPUP_LAUNCH_CONTEXT_KEY]: null
  });
  const popupContext = storedValues[POPUP_LAUNCH_CONTEXT_KEY];

  await chrome.storage.session.set({
    [POPUP_LAUNCH_CONTEXT_KEY]: null
  });

  const isRecentAutomaticPopup = popupContext
    && popupContext.display_mode === "decision"
    && Date.now() - popupContext.created_at < 5000;

  return {
    display_mode: isRecentAutomaticPopup ? "decision" : "full"
  };
}

async function resolvePendingDuplicate(duplicateTabId, choice) {
  const pendingDuplicates = await getPendingDuplicates();
  const decision = pendingDuplicates[duplicateTabId];
  if (!decision) {
    return { resolved: false };
  }

  try {
    if (choice === "close_existing") {
      const targetTab = await chrome.tabs.get(decision.target_tab_id);

      await moveDuplicateToTargetGroup(decision.duplicate_tab_id, targetTab);
      await enqueueHistoryTask(() => discardPageVisit(decision.target_tab_id));
      await chrome.tabs.remove(decision.target_tab_id);
      await recordPreventedDuplicates(
        1,
        targetTab.url,
        targetTab.title || targetTab.url
      );
    } else if (choice === "keep") {
      await groupDuplicateTabs(decision);
    }

    await clearPendingDuplicate(duplicateTabId);
    await chrome.notifications.clear(decision.notification_id);
    await refreshDecisionBadge();
    return { choice, resolved: true };
  } catch (error) {
    console.warn("Tab Keeper could not apply the duplicate choice:", error);
    return { error: error.message, resolved: false };
  }
}

async function moveDuplicateToTargetGroup(duplicateTabId, targetTab) {
  const ungroupedId = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;
  if (!Number.isInteger(targetTab.groupId)
    || targetTab.groupId === ungroupedId) {
    return;
  }

  await chrome.tabs.group({
    groupId: targetTab.groupId,
    tabIds: [duplicateTabId]
  });
}

async function groupDuplicateTabs(decision) {
  const [duplicateTab, targetTab] = await Promise.all([
    chrome.tabs.get(decision.duplicate_tab_id),
    chrome.tabs.get(decision.target_tab_id)
  ]);
  const ungroupedId = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;
  const targetGroupId = Number.isInteger(targetTab.groupId)
    ? targetTab.groupId
    : ungroupedId;
  const duplicateGroupId = Number.isInteger(duplicateTab.groupId)
    ? duplicateTab.groupId
    : ungroupedId;
  let groupId;

  if (targetGroupId !== ungroupedId) {
    groupId = targetGroupId;
    if (duplicateGroupId !== groupId) {
      await chrome.tabs.group({
        groupId,
        tabIds: [duplicateTab.id]
      });
    }
  } else if (duplicateGroupId !== ungroupedId) {
    groupId = duplicateGroupId;
    await chrome.tabs.group({
      groupId,
      tabIds: [targetTab.id]
    });
  } else {
    groupId = await chrome.tabs.group({
      createProperties: {
        windowId: decision.window_id
      },
      tabIds: [targetTab.id, duplicateTab.id]
    });
  }

  const groupName = UrlUtils.getTabGroupName(
    decision.duplicate_url || duplicateTab.url
  );
  if (groupName) {
    await chrome.tabGroups.update(groupId, {
      title: groupName
    });
  }
}

async function isAcknowledgedDuplicate(tabId, normalizedUrl) {
  const storedValues = await chrome.storage.session.get({
    [ACKNOWLEDGED_DUPLICATES_KEY]: {}
  });
  const acknowledgedUrls = storedValues[ACKNOWLEDGED_DUPLICATES_KEY];

  if (acknowledgedUrls[tabId] === normalizedUrl) {
    return true;
  }

  if (acknowledgedUrls[tabId]) {
    delete acknowledgedUrls[tabId];
    await chrome.storage.session.set({
      [ACKNOWLEDGED_DUPLICATES_KEY]: acknowledgedUrls
    });
  }

  return false;
}

async function acknowledgeDuplicate(tabId, normalizedUrl) {
  const storedValues = await chrome.storage.session.get({
    [ACKNOWLEDGED_DUPLICATES_KEY]: {}
  });
  const acknowledgedUrls = storedValues[ACKNOWLEDGED_DUPLICATES_KEY];
  acknowledgedUrls[tabId] = normalizedUrl;

  await chrome.storage.session.set({
    [ACKNOWLEDGED_DUPLICATES_KEY]: acknowledgedUrls
  });
}

async function clearAcknowledgedDuplicate(tabId) {
  const storedValues = await chrome.storage.session.get({
    [ACKNOWLEDGED_DUPLICATES_KEY]: {}
  });
  const acknowledgedUrls = storedValues[ACKNOWLEDGED_DUPLICATES_KEY];
  if (!acknowledgedUrls[tabId]) {
    return;
  }

  delete acknowledgedUrls[tabId];
  await chrome.storage.session.set({
    [ACKNOWLEDGED_DUPLICATES_KEY]: acknowledgedUrls
  });
}

async function getPendingDuplicates() {
  const storedValues = await chrome.storage.session.get({
    [PENDING_DUPLICATES_KEY]: {}
  });
  return storedValues[PENDING_DUPLICATES_KEY];
}

async function setPendingDuplicates(pendingDuplicates) {
  await chrome.storage.session.set({
    [PENDING_DUPLICATES_KEY]: pendingDuplicates
  });
}

async function storePendingDuplicate(decision) {
  const pendingDuplicates = await getPendingDuplicates();
  pendingDuplicates[decision.duplicate_tab_id] = decision;
  await setPendingDuplicates(pendingDuplicates);
}

async function clearPendingDuplicate(tabId) {
  const pendingDuplicates = await getPendingDuplicates();
  if (!pendingDuplicates[tabId]) {
    return;
  }

  delete pendingDuplicates[tabId];
  await setPendingDuplicates(pendingDuplicates);
}

async function clearPendingDuplicates(windowId) {
  const pendingDuplicates = await getPendingDuplicates();
  const decisionsToClear = Object.values(pendingDuplicates)
    .filter((decision) => decision.window_id === windowId);

  for (const decision of decisionsToClear) {
    delete pendingDuplicates[decision.duplicate_tab_id];
  }

  await setPendingDuplicates(pendingDuplicates);
  await Promise.all(
    decisionsToClear.map((decision) => (
      chrome.notifications.clear(decision.notification_id)
    ))
  );
  await refreshDecisionBadge();

  return {
    cleared_count: decisionsToClear.length
  };
}

async function ensureTargetThumbnail(targetTab, duplicateTabId) {
  const thumbnails = await getTabThumbnails();
  if (thumbnails[targetTab.id]?.data_url) {
    return;
  }

  let duplicateTab;
  try {
    duplicateTab = await chrome.tabs.get(duplicateTabId);
  } catch {
    return;
  }

  if (targetTab.windowId !== duplicateTab.windowId) {
    return;
  }

  if (targetTab.active) {
    await captureTabThumbnail(targetTab.id, targetTab.windowId, true);
    return;
  }

  if (await isTabInCollapsedGroup(targetTab)) {
    return;
  }

  if (!duplicateTab.active) {
    return;
  }

  suppressedThumbnailActivations.add(targetTab.id);
  suppressedThumbnailActivations.add(duplicateTabId);

  try {
    await chrome.tabs.update(targetTab.id, { active: true });
    await wait(120);
    await captureTabThumbnail(targetTab.id, targetTab.windowId, true);
  } catch (error) {
    console.debug("Tab Keeper could not create an on-demand thumbnail:", error);
  } finally {
    try {
      await chrome.tabs.update(duplicateTabId, { active: true });
    } catch {
      // The duplicate tab may have been closed while the capture was running.
    }
  }
}

async function isTabInCollapsedGroup(tab) {
  const ungroupedId = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;
  if (!Number.isInteger(tab.groupId) || tab.groupId === ungroupedId) {
    return false;
  }

  try {
    const group = await chrome.tabGroups.get(tab.groupId);
    return group.collapsed;
  } catch {
    return false;
  }
}

function scheduleThumbnailCapture(tabId, windowId) {
  clearTimeout(thumbnailCaptureTimers.get(tabId));

  const timerId = setTimeout(() => {
    thumbnailCaptureTimers.delete(tabId);
    void captureTabThumbnail(tabId, windowId);
  }, 500);
  thumbnailCaptureTimers.set(tabId, timerId);
}

async function captureActiveTabs() {
  const activeTabs = await chrome.tabs.query({ active: true });
  for (const tab of activeTabs) {
    const rawUrl = tab.pendingUrl || tab.url;
    if (UrlUtils.isSupportedUrl(rawUrl)) {
      scheduleThumbnailCapture(tab.id, tab.windowId);
    }
  }
}

async function captureTabThumbnail(tabId, windowId, force = false) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const rawUrl = tab.pendingUrl || tab.url;
    if (!tab.active || tab.status !== "complete" || !UrlUtils.isSupportedUrl(rawUrl)) {
      return;
    }

    const thumbnails = await getTabThumbnails();
    const existingThumbnail = thumbnails[tabId];
    if (!force
      && existingThumbnail?.url === rawUrl
      && Date.now() - existingThumbnail.captured_at < 5000) {
      return existingThumbnail.data_url;
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 35
    });
    thumbnails[tabId] = {
      captured_at: Date.now(),
      data_url: dataUrl,
      url: rawUrl
    };

    const retainedThumbnails = Object.fromEntries(
      Object.entries(thumbnails)
        .sort(([, left], [, right]) => right.captured_at - left.captured_at)
        .slice(0, MAX_CACHED_THUMBNAILS)
    );
    await chrome.storage.session.set({
      [TAB_THUMBNAILS_KEY]: retainedThumbnails
    });
    return dataUrl;
  } catch (error) {
    console.debug("Tab Keeper could not capture a tab thumbnail:", error);
    return null;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getTabThumbnails() {
  const storedValues = await chrome.storage.session.get({
    [TAB_THUMBNAILS_KEY]: {}
  });
  return storedValues[TAB_THUMBNAILS_KEY];
}

async function clearTabThumbnail(tabId) {
  const thumbnails = await getTabThumbnails();
  if (!thumbnails[tabId]) {
    return;
  }

  delete thumbnails[tabId];
  await chrome.storage.session.set({
    [TAB_THUMBNAILS_KEY]: thumbnails
  });
}

async function handleRemovedTab(tabId) {
  await Promise.all([
    clearAcknowledgedDuplicate(tabId),
    clearPendingDuplicate(tabId),
    clearTabThumbnail(tabId),
    clearNotificationsForTab(tabId)
  ]);
  await refreshDecisionBadge();
}

async function clearNotificationsForTab(tabId) {
  const notifications = await chrome.notifications.getAll();
  const matchingPrefix = `${DUPLICATE_NOTIFICATION_PREFIX}|${tabId}|`;

  await Promise.all(
    Object.keys(notifications)
      .filter((notificationId) => notificationId.startsWith(matchingPrefix))
      .map((notificationId) => chrome.notifications.clear(notificationId))
  );
}

async function refreshDecisionBadge() {
  const pendingDuplicates = await getPendingDuplicates();
  const pendingCount = Object.keys(pendingDuplicates).length;

  await chrome.action.setBadgeBackgroundColor({ color: "#B45309" });
  await chrome.action.setBadgeText({
    text: pendingCount > 0 ? String(pendingCount) : ""
  });
}
