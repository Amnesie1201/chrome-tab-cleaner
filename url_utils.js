(function initializeUrlUtils(globalScope) {
  "use strict";

  const TRACKING_PARAMETER_NAMES = new Set([
    "dclid",
    "fbclid",
    "gclid",
    "igshid",
    "mc_cid",
    "mc_eid",
    "msclkid",
    "ref_src",
    "s_cid",
    "ttclid",
    "yclid"
  ]);

  const TRACKING_PARAMETER_PREFIXES = [
    "utm_"
  ];

  const COMPOUND_PUBLIC_SUFFIXES = new Set([
    "co.jp",
    "co.kr",
    "co.nz",
    "co.uk",
    "com.au",
    "com.br",
    "com.cn",
    "com.hk",
    "com.sg"
  ]);

  function isSupportedUrl(rawUrl) {
    if (typeof rawUrl !== "string" || rawUrl.length === 0) {
      return false;
    }

    try {
      const url = new URL(rawUrl);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function isTrackingParameter(parameterName) {
    const normalizedName = parameterName.toLowerCase();
    return TRACKING_PARAMETER_NAMES.has(normalizedName)
      || TRACKING_PARAMETER_PREFIXES.some((prefix) => normalizedName.startsWith(prefix));
  }

  function normalizeUrl(rawUrl) {
    if (!isSupportedUrl(rawUrl)) {
      return null;
    }

    const url = new URL(rawUrl);
    url.hash = "";

    for (const parameterName of Array.from(url.searchParams.keys())) {
      if (isTrackingParameter(parameterName)) {
        url.searchParams.delete(parameterName);
      }
    }

    url.searchParams.sort();
    return url.href;
  }

  function getComparisonKey(rawUrl, matchingStrategy = "same_page") {
    if (!isSupportedUrl(rawUrl)) {
      return null;
    }

    if (matchingStrategy === "same_site") {
      return normalizeSiteIdentity(new URL(rawUrl).hostname);
    }

    return normalizeUrl(rawUrl);
  }

  function getTabGroupName(rawUrl) {
    if (!isSupportedUrl(rawUrl)) {
      return "";
    }

    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname.split(".")[0] || hostname;
  }

  function normalizeSiteIdentity(hostname) {
    const normalizedHostname = hostname.toLowerCase().replace(/^www\./, "");
    if (normalizedHostname === "localhost"
      || normalizedHostname.includes(":")
      || /^\d{1,3}(\.\d{1,3}){3}$/.test(normalizedHostname)) {
      return normalizedHostname;
    }

    const labels = normalizedHostname.split(".");
    const finalTwoLabels = labels.slice(-2).join(".");
    const suffixLength = COMPOUND_PUBLIC_SUFFIXES.has(finalTwoLabels) ? 2 : 1;

    if (labels.length <= suffixLength) {
      return normalizedHostname;
    }

    return labels.slice(0, -suffixLength).join(".");
  }

  function normalizeDomainRule(rawRule) {
    if (typeof rawRule !== "string") {
      return "";
    }

    let rule = rawRule.trim().toLowerCase();
    if (rule.startsWith("*.")) {
      rule = rule.slice(2);
    }

    if (!rule) {
      return "";
    }

    try {
      const parsedRule = new URL(rule.includes("://") ? rule : `https://${rule}`);
      return parsedRule.hostname.replace(/^\.+|\.+$/g, "");
    } catch {
      return "";
    }
  }

  function isWhitelisted(rawUrl, domainWhitelist) {
    if (!isSupportedUrl(rawUrl) || !Array.isArray(domainWhitelist)) {
      return false;
    }

    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return domainWhitelist.some((rawRule) => {
      const rule = normalizeDomainRule(rawRule);
      return rule && (hostname === rule || hostname.endsWith(`.${rule}`));
    });
  }

  const urlUtils = {
    getComparisonKey,
    getTabGroupName,
    isSupportedUrl,
    isTrackingParameter,
    isWhitelisted,
    normalizeDomainRule,
    normalizeSiteIdentity,
    normalizeUrl
  };

  globalScope.UrlUtils = urlUtils;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = urlUtils;
  }
}(globalThis));
