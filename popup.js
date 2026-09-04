"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  deduplication_enabled: true,
  domain_whitelist: [],
  matching_strategy: "same_site"
});

const duplicateDecision = document.querySelector("#duplicate_decision");
const pendingDuplicateCount = document.querySelector("#pending_duplicate_count");
const duplicateTargetTitle = document.querySelector("#duplicate_target_title");
const duplicateTargetUrl = document.querySelector("#duplicate_target_url");
const targetPreviewImage = document.querySelector("#target_preview_image");
const targetPreviewFallback = document.querySelector("#target_preview_fallback");
const closeExistingButton = document.querySelector("#close_existing");
const keepButton = document.querySelector("#keep_duplicate");
const clearPendingButton = document.querySelector("#clear_pending_duplicates");
const enabledInput = document.querySelector("#deduplication_enabled");
const extensionStatus = document.querySelector("#extension_status");
const matchingStrategyInputs = document.querySelectorAll(
  "input[name='matching_strategy']"
);
const whitelistInput = document.querySelector("#domain_whitelist");
const whitelistCount = document.querySelector("#whitelist_count");
const duplicatesPrevented = document.querySelector("#duplicates_prevented");
const lastDuplicate = document.querySelector("#last_duplicate");
const currentDuplicateSummary = document.querySelector("#current_duplicate_summary");
const cleanupButton = document.querySelector("#cleanup_duplicates");
const saveButton = document.querySelector("#save_settings");
const saveStatus = document.querySelector("#save_status");
const historyPanel = document.querySelector("#history_panel");
const historySearch = document.querySelector("#history_search");
const historyCount = document.querySelector("#history_count");
const historyResults = document.querySelector("#history_results");
const historyEmpty = document.querySelector("#history_empty");
let currentPendingDecision = null;
let isCompactMode = false;
let historySearchTimer = null;

void initializePopup();

enabledInput.addEventListener("change", async () => {
  await chrome.storage.sync.set({
    deduplication_enabled: enabledInput.checked
  });
  renderEnabledStatus(enabledInput.checked);
});

for (const input of matchingStrategyInputs) {
  input.addEventListener("change", async () => {
    if (!input.checked) {
      return;
    }

    await chrome.storage.sync.set({
      matching_strategy: input.value
    });
    await refreshDuplicateScan();
  });
}

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  saveStatus.textContent = "";

  const domainWhitelist = parseDomainWhitelist(whitelistInput.value);
  await chrome.storage.sync.set({
    domain_whitelist: domainWhitelist
  });

  whitelistInput.value = domainWhitelist.join("\n");
  renderWhitelistCount(domainWhitelist.length);
  saveStatus.textContent = "已保存";
  saveButton.disabled = false;
  await refreshDuplicateScan();

  setTimeout(() => {
    saveStatus.textContent = "";
  }, 1800);
});

cleanupButton.addEventListener("click", async () => {
  cleanupButton.disabled = true;
  cleanupButton.textContent = "整理中";

  try {
    const response = await sendWindowMessage("cleanup_duplicates");
    currentDuplicateSummary.textContent = response.closed_count > 0
      ? `已关闭 ${response.closed_count} 个重复标签`
      : "当前窗口没有重复标签";
    await refreshStatistics();
  } catch {
    currentDuplicateSummary.textContent = "整理失败，请重新加载扩展";
  } finally {
    cleanupButton.textContent = "整理";
  }
});

historyPanel.addEventListener("toggle", () => {
  if (!historyPanel.open) {
    return;
  }

  void refreshPageHistory(historySearch.value);
  historySearch.focus();
});

historySearch.addEventListener("input", () => {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => {
    void refreshPageHistory(historySearch.value);
  }, 120);
});

closeExistingButton.addEventListener("click", () => {
  void resolveCurrentDecision("close_existing");
});

keepButton.addEventListener("click", () => {
  void resolveCurrentDecision("keep");
});

clearPendingButton.addEventListener("click", async () => {
  closeExistingButton.disabled = true;
  keepButton.disabled = true;
  clearPendingButton.disabled = true;
  clearPendingButton.textContent = "清除中";

  try {
    await sendWindowMessage("clear_pending_duplicates");
    await refreshPendingDecision();
  } catch {
    duplicateTargetTitle.textContent = "清除失败，请重新加载扩展";
  } finally {
    closeExistingButton.disabled = false;
    keepButton.disabled = false;
    clearPendingButton.disabled = false;
    clearPendingButton.textContent = "清除待办";
  }
});

targetPreviewImage.addEventListener("error", () => {
  targetPreviewImage.hidden = true;
  targetPreviewFallback.hidden = false;
});

async function initializePopup() {
  try {
    const [settings, statistics, popupContext] = await Promise.all([
      chrome.storage.sync.get(DEFAULT_SETTINGS),
      chrome.storage.local.get({
        duplicates_prevented: 0,
        last_duplicate: null
      }),
      sendWindowMessage("consume_popup_context")
    ]);

    enabledInput.checked = settings.deduplication_enabled;
    renderMatchingStrategy(settings.matching_strategy);
    whitelistInput.value = settings.domain_whitelist.join("\n");
    renderWhitelistCount(settings.domain_whitelist.length);
    duplicatesPrevented.textContent =
      new Intl.NumberFormat("zh-CN").format(statistics.duplicates_prevented);

    renderEnabledStatus(settings.deduplication_enabled);
    renderLastDuplicate(statistics.last_duplicate);

    const hasPendingDecision = await refreshPendingDecision();
    setPopupDisplayMode(
      popupContext.display_mode === "decision" && hasPendingDecision
        ? "decision"
        : "full"
    );

    if (!isCompactMode) {
      await Promise.all([
        refreshDuplicateScan(),
        refreshPageHistory("")
      ]);
    }
  } finally {
    document.body.classList.remove("initializing");
  }
}

function renderEnabledStatus(isEnabled) {
  extensionStatus.textContent = isEnabled ? "重复标签提醒已开启" : "重复标签提醒已暂停";
}

function renderMatchingStrategy(matchingStrategy) {
  for (const input of matchingStrategyInputs) {
    input.checked = input.value === matchingStrategy;
  }
}

async function refreshPageHistory(query) {
  try {
    const response = await sendWindowMessage("search_page_history", { query });
    historyCount.textContent = `${response.total_count} 条`;
    renderPageHistory(response.records, Boolean(query.trim()));
  } catch {
    historyResults.replaceChildren();
    historyEmpty.textContent = "记录加载失败";
    historyEmpty.hidden = false;
  }
}

function renderPageHistory(records, isFiltering) {
  const fragment = document.createDocumentFragment();

  for (const record of records) {
    const link = document.createElement("a");
    link.className = "history_item";
    link.href = record.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = record.url;

    const title = document.createElement("span");
    title.className = "history_item_title";
    title.textContent = record.title || new URL(record.url).hostname;

    const metadata = document.createElement("span");
    metadata.className = "history_item_metadata";

    const domain = document.createElement("span");
    domain.textContent = new URL(record.url).hostname;

    const timing = document.createElement("span");
    timing.textContent = `${formatVisitTime(record.opened_at)} · ${formatDuration(record.duration_ms)}`;

    metadata.append(domain, timing);
    link.append(title, metadata);
    fragment.append(link);
  }

  historyResults.replaceChildren(fragment);
  historyEmpty.textContent = isFiltering ? "没有匹配的记录" : "暂无访问记录";
  historyEmpty.hidden = records.length > 0;
}

function formatVisitTime(timestamp) {
  const visitedAt = new Date(timestamp);
  const today = new Date();
  const isToday = visitedAt.toDateString() === today.toDateString();

  return new Intl.DateTimeFormat("zh-CN", isToday
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }
  ).format(visitedAt);
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} 分钟`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function renderLastDuplicate(record) {
  if (!record) {
    lastDuplicate.textContent = "暂无拦截记录";
    lastDuplicate.title = "";
    return;
  }

  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(record.prevented_at));
  const targetTitle = record.target_title || new URL(record.url).hostname;
  const summary = `${time} · ${targetTitle}`;

  lastDuplicate.textContent = summary;
  lastDuplicate.title = summary;
}

async function refreshDuplicateScan() {
  cleanupButton.disabled = true;
  currentDuplicateSummary.textContent = "正在扫描当前窗口";

  try {
    const response = await sendWindowMessage("scan_duplicates");
    currentDuplicateSummary.textContent = response.duplicate_count > 0
      ? `当前发现 ${response.duplicate_count} 个重复标签`
      : "当前窗口没有重复标签";
    cleanupButton.disabled = response.duplicate_count === 0;
  } catch {
    currentDuplicateSummary.textContent = "扫描失败，请重新加载扩展";
  }
}

async function refreshPendingDecision() {
  try {
    const response = await sendWindowMessage("get_pending_duplicate");
    currentPendingDecision = response.decision;
    duplicateDecision.hidden = !currentPendingDecision;

    if (!currentPendingDecision) {
      return false;
    }

    pendingDuplicateCount.textContent = response.pending_count > 1
      ? `${response.pending_count} 项待处理`
      : "待处理";
    duplicateTargetTitle.textContent = currentPendingDecision.target_title
      || "此网页已在当前窗口打开";
    duplicateTargetUrl.textContent = currentPendingDecision.target_url
      || currentPendingDecision.duplicate_url;
    duplicateTargetUrl.title = duplicateTargetUrl.textContent;
    renderTargetPreview(currentPendingDecision.target_thumbnail_data_url);
    return true;
  } catch {
    currentPendingDecision = null;
    duplicateDecision.hidden = true;
    return false;
  }
}

function renderTargetPreview(thumbnailDataUrl) {
  if (!thumbnailDataUrl) {
    targetPreviewImage.removeAttribute("src");
    targetPreviewImage.hidden = true;
    targetPreviewFallback.hidden = false;
    return;
  }

  targetPreviewImage.src = thumbnailDataUrl;
  targetPreviewImage.hidden = false;
  targetPreviewFallback.hidden = true;
}

async function resolveCurrentDecision(choice) {
  if (!currentPendingDecision) {
    return;
  }

  const activeButton = choice === "close_existing"
    ? closeExistingButton
    : keepButton;
  const activeButtonLabel = activeButton.textContent;

  closeExistingButton.disabled = true;
  keepButton.disabled = true;
  activeButton.textContent = choice === "close_existing"
    ? "正在关闭"
    : "正在保留";
  activeButton.setAttribute("aria-busy", "true");

  try {
    await sendWindowMessage("resolve_duplicate", {
      choice,
      duplicate_tab_id: currentPendingDecision.duplicate_tab_id
    });
    const hasPendingDecision = await refreshPendingDecision();

    if (isCompactMode && !hasPendingDecision) {
      window.close();
      return;
    }

    await Promise.all([refreshDuplicateScan(), refreshStatistics()]);
  } catch {
    duplicateTargetTitle.textContent = "操作失败，请重新加载扩展";
  } finally {
    activeButton.textContent = activeButtonLabel;
    activeButton.removeAttribute("aria-busy");
    closeExistingButton.disabled = false;
    keepButton.disabled = false;
  }
}

function setPopupDisplayMode(displayMode) {
  isCompactMode = displayMode === "decision";
  document.body.classList.toggle("compact_mode", isCompactMode);
}

function renderWhitelistCount(count) {
  whitelistCount.textContent = `${count} 个`;
}

async function refreshStatistics() {
  const statistics = await chrome.storage.local.get({
    duplicates_prevented: 0,
    last_duplicate: null
  });

  duplicatesPrevented.textContent =
    new Intl.NumberFormat("zh-CN").format(statistics.duplicates_prevented);
  renderLastDuplicate(statistics.last_duplicate);
}

async function sendWindowMessage(type, payload = {}) {
  const currentWindow = await chrome.windows.getCurrent();
  const response = await chrome.runtime.sendMessage({
    ...payload,
    type,
    window_id: currentWindow.id
  });

  if (!response || response.error) {
    throw new Error(response?.error || "No response from service worker");
  }

  return response;
}

function parseDomainWhitelist(rawValue) {
  const uniqueDomains = new Set();

  for (const value of rawValue.split(/[\n,]/)) {
    const normalizedDomain = UrlUtils.normalizeDomainRule(value);
    if (normalizedDomain) {
      uniqueDomains.add(normalizedDomain);
    }
  }

  return Array.from(uniqueDomains).sort();
}
