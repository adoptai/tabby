'use strict';

// New Relic Node agent configuration. Reads everything from env.
// All values are env-driven; no license keys, app names, or secrets are
// hardcoded. Set NEWRELIC_ENABLED=true and NEW_RELIC_LICENSE_KEY=<key> in
// the pod environment to activate the agent.
exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'Adopt Tabby Teams Bot'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  distributed_tracing: { enabled: true },
  agent_enabled:
    process.env.NEWRELIC_ENABLED === 'true' &&
    !!process.env.NEW_RELIC_LICENSE_KEY,
  application_logging: {
    enabled: true,
    forwarding: { enabled: false }, // OFF per Decision Point in implementation plan
    local_decorating: { enabled: true },
    metrics: { enabled: true },
  },
  logging: { level: 'info' },
};
