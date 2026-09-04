(function initializeTabUtils(globalScope) {
  "use strict";

  const urlUtils = globalScope.UrlUtils
    || (typeof require !== "undefined" ? require("./url_utils.js") : null);

  function getDuplicateGroups(
    tabs,
    domainWhitelist = [],
    matchingStrategy = "same_page"
  ) {
    const tabsByComparisonKey = new Map();

    for (const tab of tabs) {
      const rawUrl = tab.pendingUrl || tab.url;
      if (!urlUtils.isSupportedUrl(rawUrl)
        || urlUtils.isWhitelisted(rawUrl, domainWhitelist)) {
        continue;
      }

      const comparisonKey = urlUtils.getComparisonKey(rawUrl, matchingStrategy);
      if (!comparisonKey) {
        continue;
      }

      const matchingTabs = tabsByComparisonKey.get(comparisonKey) || [];
      matchingTabs.push(tab);
      tabsByComparisonKey.set(comparisonKey, matchingTabs);
    }

    return Array.from(tabsByComparisonKey.entries())
      .filter(([, matchingTabs]) => matchingTabs.length > 1)
      .map(([comparisonKey, matchingTabs]) => ({
        comparison_key: comparisonKey,
        tabs: matchingTabs
      }));
  }

  function selectKeeper(tabs) {
    return [...tabs].sort((leftTab, rightTab) => {
      if (leftTab.pinned !== rightTab.pinned) {
        return leftTab.pinned ? -1 : 1;
      }

      if (leftTab.active !== rightTab.active) {
        return leftTab.active ? -1 : 1;
      }

      return leftTab.index - rightTab.index;
    })[0];
  }

  function selectMostRecentTab(tabs) {
    return [...tabs].sort((leftTab, rightTab) => {
      const leftLastAccessed = Number(leftTab.lastAccessed) || 0;
      const rightLastAccessed = Number(rightTab.lastAccessed) || 0;
      if (leftLastAccessed !== rightLastAccessed) {
        return rightLastAccessed - leftLastAccessed;
      }

      if (leftTab.index !== rightTab.index) {
        return rightTab.index - leftTab.index;
      }

      return rightTab.id - leftTab.id;
    })[0];
  }

  function summarizeDuplicateGroups(groups) {
    return {
      duplicate_count: groups.reduce(
        (total, group) => total + group.tabs.length - 1,
        0
      ),
      group_count: groups.length
    };
  }

  const tabUtils = {
    getDuplicateGroups,
    selectKeeper,
    selectMostRecentTab,
    summarizeDuplicateGroups
  };

  globalScope.TabUtils = tabUtils;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = tabUtils;
  }
}(globalThis));
