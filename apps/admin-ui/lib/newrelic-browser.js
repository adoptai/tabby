/**
 * New Relic Browser SDK bootstrap.
 *
 * This module is loaded **client-side only** via a dynamic import that is
 * gated on `NEXT_PUBLIC_NEWRELIC_ENABLED === 'true'`. When the toggle is
 * off (or this module never gets imported) no New Relic Browser code is
 * loaded into the page — zero overhead, zero network traffic.
 *
 * Reads configuration from the standard NR Browser env vars (mirrored at
 * build time into the page via `NEXT_PUBLIC_NEW_RELIC_BROWSER_*`). The
 * actual SDK class is loaded as a dynamic import so the heavy code path
 * is only fetched when the agent is enabled.
 *
 * No keys are hardcoded — everything comes from env.
 */

/* eslint-disable no-undef */

(async () => {
  if (typeof window === 'undefined') return;

  // Read env vars injected at build time (Next.js convention: NEXT_PUBLIC_*).
  // When admin-ui is served as a plain HTML page, these are inlined by the
  // server at render time into `window.__NEWRELIC_BROWSER_CONFIG__`.
  const winCfg =
    (typeof window !== 'undefined' && window.__NEWRELIC_BROWSER_CONFIG__) || {};
  const env =
    (typeof process !== 'undefined' && process.env) ? process.env : {};

  const licenseKey =
    winCfg.licenseKey ||
    env.NEXT_PUBLIC_NEW_RELIC_BROWSER_LICENSE_KEY ||
    '';
  const applicationID =
    winCfg.applicationID ||
    env.NEXT_PUBLIC_NEW_RELIC_BROWSER_APP_ID ||
    '';
  const accountID =
    winCfg.accountID ||
    env.NEXT_PUBLIC_NEW_RELIC_BROWSER_ACCOUNT_ID ||
    '';
  const trustKey = winCfg.trustKey || accountID;
  const agentID = winCfg.agentID || applicationID;

  if (!licenseKey || !applicationID || !accountID) {
    // Misconfigured — bail silently so we never break the page.
    return;
  }

  try {
    // Dynamic import: SDK code is only fetched when the agent is enabled.
    const { BrowserAgent } = await import('@newrelic/browser-agent/loaders/browser-agent');

    // eslint-disable-next-line no-new
    new BrowserAgent({
      init: {
        distributed_tracing: { enabled: true },
        privacy: { cookies_enabled: true },
        ajax: { deny_list: ['bam.nr-data.net'] },
      },
      info: {
        beacon: 'bam.nr-data.net',
        errorBeacon: 'bam.nr-data.net',
        licenseKey,
        applicationID,
        sa: 1,
      },
      loader_config: {
        accountID,
        trustKey,
        agentID,
        licenseKey,
        applicationID,
      },
    });
  } catch (e) {
    // Never break the page if the agent fails to load.
    // eslint-disable-next-line no-console
    console.warn('[newrelic-browser] failed to initialise:', e);
  }
})();
