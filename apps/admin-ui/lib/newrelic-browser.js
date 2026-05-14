/**
 * New Relic Browser SDK bootstrap (CDN loader pattern).
 *
 * This module is served directly to the browser by the custom Next.js server
 * via the `/_nr/newrelic-browser.js` endpoint. Because it is served as raw JS
 * (NOT bundled by webpack/Next.js), it must be self-contained — bare npm
 * specifiers like `@newrelic/browser-agent/...` are NOT resolvable in the
 * browser. The correct pattern is the NR Browser "agent loader": configure
 * window.NREUM globals, then load NR's pre-built agent bundle from their CDN.
 *
 * Activation gate: window.__NEWRELIC_BROWSER_CONFIG__ (injected by server.js
 * only when NEXT_PUBLIC_NEWRELIC_ENABLED === 'true' and a license key is set).
 * When the gate is off, this file is never fetched at all (the import() call
 * in the HTML is wrapped in the same conditional).
 *
 * No keys are hardcoded — everything comes from the server-injected config.
 */

/* eslint-disable no-undef */

(function () {
  if (typeof window === 'undefined') return;

  var winCfg =
    (typeof window !== 'undefined' && window.__NEWRELIC_BROWSER_CONFIG__) || {};

  var licenseKey = winCfg.licenseKey || '';
  var applicationID = winCfg.applicationID || '';
  var accountID = winCfg.accountID || '';
  var trustKey = winCfg.trustKey || accountID;
  var agentID = winCfg.agentID || applicationID;

  // Comma-separated list of backend origins that should receive `traceparent`
  // on outbound fetch/XHR. Without this list the SDK collects browser-side
  // data but never stitches to the backend trace. Configured server-side via
  // NEXT_PUBLIC_NEW_RELIC_BROWSER_ALLOWED_ORIGINS.
  var allowedOriginsRaw = winCfg.allowedOrigins || '';
  var allowedOrigins = (typeof allowedOriginsRaw === 'string'
    ? allowedOriginsRaw.split(',')
    : Array.isArray(allowedOriginsRaw)
    ? allowedOriginsRaw
    : []
  )
    .map(function (o) {
      return ('' + o).trim();
    })
    .filter(Boolean);

  if (!licenseKey || !applicationID || !accountID) {
    // Misconfigured — bail silently so we never break the page.
    return;
  }

  // ---- NR Browser globals: configure BEFORE loading the agent bundle ----
  window.NREUM = window.NREUM || {};
  window.NREUM.init = {
    distributed_tracing: {
      enabled: true,
      allowed_origins: allowedOrigins,
    },
    privacy: { cookies_enabled: true },
    ajax: { deny_list: ['bam.nr-data.net'] },
  };
  window.NREUM.loader_config = {
    accountID: accountID,
    trustKey: trustKey,
    agentID: agentID,
    licenseKey: licenseKey,
    applicationID: applicationID,
  };
  window.NREUM.info = {
    beacon: 'bam.nr-data.net',
    errorBeacon: 'bam.nr-data.net',
    licenseKey: licenseKey,
    applicationID: applicationID,
    sa: 1,
  };

  // ---- Load the pre-built NR agent from their CDN ----
  // Using `nr-loader-spa-current.min.js` which is the standard SPA loader and
  // includes distributed tracing + AJAX instrumentation. NR maintains this URL
  // forever; the `-current` suffix means "latest stable in this loader family."
  try {
    var script = document.createElement('script');
    script.src = 'https://js-agent.newrelic.com/nr-loader-spa-current.min.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = function () {
      // Network blocked / CSP restriction. Never break the page.
      // Intentionally silent in production.
    };
    document.head.appendChild(script);
  } catch (e) {
    // Defensive: never break the page if the agent fails to load.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[newrelic-browser] failed to inject loader:', e);
    }
  }
})();
