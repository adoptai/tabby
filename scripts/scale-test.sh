#!/usr/bin/env bash
# Scale test: create N apps with desired_session_count=1 to stress-test
# the controller's SKIP LOCKED reconciliation across multiple replicas.
#
# Usage:
#   ./scripts/scale-test.sh create 150    # Create 150 test apps
#   ./scripts/scale-test.sh status        # Check progress
#   ./scripts/scale-test.sh delete        # Clean up everything
set -euo pipefail

NAMESPACE="${NAMESPACE:-browser-hitl}"
PG_POD="browser-hitl-postgres-0"
PG_USER="browser_hitl"
PG_DB="browser_hitl"
TENANT_ID="${TENANT_ID:-5e8b20be-2576-4a20-a88b-c8ed06e450b6}"
PREFIX="SCALE-TEST"

psql_exec() {
  kubectl exec "$PG_POD" -n "$NAMESPACE" -- psql -U "$PG_USER" "$PG_DB" -c "$1"
}

psql_val() {
  kubectl exec "$PG_POD" -n "$NAMESPACE" -- psql -U "$PG_USER" "$PG_DB" -t -c "$1" | tr -d ' \n'
}

case "${1:-help}" in
  create)
    COUNT="${2:-150}"
    echo "Creating $COUNT test apps (${PREFIX}-001 to ${PREFIX}-$(printf '%03d' "$COUNT"))..."
    psql_exec "
      INSERT INTO applications (id, tenant_id, name, target_urls, login_config, keepalive_config, export_policy, notification_config, browser_policy, desired_session_count, owner_user_id)
      SELECT
        gen_random_uuid(),
        '${TENANT_ID}',
        '${PREFIX}-' || lpad(g::text, 3, '0'),
        '[\"https://test.example.com\"]'::jsonb,
        '{\"steps\": [], \"login_url\": \"https://test.example.com\", \"credential_ref\": \"manual:\"}'::jsonb,
        '{\"interval_seconds\": 120, \"actions\": [], \"health_checks\": []}'::jsonb,
        '{\"ttl_seconds\": 3600}'::jsonb,
        '{}'::jsonb,
        '{\"clipboard\": false, \"downloads\": false, \"file_chooser\": false, \"streaming_mode\": \"vnc\"}'::jsonb,
        1,
        NULL
      FROM generate_series(1, ${COUNT}) g;
    "
    echo "Done. Controller will start creating sessions on next reconcile tick (~15s)."
    ;;

  status)
    TOTAL=$(psql_val "SELECT count(*) FROM applications WHERE name LIKE '${PREFIX}-%';")
    SESSIONS=$(psql_val "SELECT count(*) FROM sessions s JOIN applications a ON s.app_id = a.id WHERE a.name LIKE '${PREFIX}-%' AND s.state != 'TERMINATED';")
    DUPES=$(psql_val "SELECT count(*) FROM (SELECT a.name FROM sessions s JOIN applications a ON s.app_id = a.id WHERE a.name LIKE '${PREFIX}-%' AND s.state != 'TERMINATED' GROUP BY a.name HAVING count(*) > 1) x;")
    echo "Apps: $TOTAL | Sessions: $SESSIONS/$TOTAL | Duplicates: $DUPES"
    echo ""
    echo "Sessions by state:"
    psql_exec "SELECT state, count(*) FROM sessions s JOIN applications a ON s.app_id = a.id WHERE a.name LIKE '${PREFIX}-%' AND s.state != 'TERMINATED' GROUP BY state ORDER BY count DESC;"
    echo ""
    echo "Controller distribution:"
    for pod in $(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=controller --no-headers -o custom-columns=':.metadata.name'); do
      creates=$(kubectl logs "$pod" -n "$NAMESPACE" 2>&1 | grep -c 'Created session' || true)
      echo "  $pod: $creates creates"
    done
    ;;

  delete)
    echo "Cleaning up ${PREFIX} apps and all related data..."
    psql_exec "
      DELETE FROM session_batons WHERE session_id IN (SELECT s.id FROM sessions s JOIN applications a ON s.app_id = a.id WHERE a.name LIKE '${PREFIX}-%');
      DELETE FROM interventions WHERE session_id IN (SELECT s.id FROM sessions s JOIN applications a ON s.app_id = a.id WHERE a.name LIKE '${PREFIX}-%');
      DELETE FROM artifact_bundles WHERE session_id IN (SELECT s.id FROM sessions s JOIN applications a ON s.app_id = a.id WHERE a.name LIKE '${PREFIX}-%');
      DELETE FROM sessions WHERE app_id IN (SELECT id FROM applications WHERE name LIKE '${PREFIX}-%');
      DELETE FROM applications WHERE name LIKE '${PREFIX}-%';
    "
    echo "Done."
    ;;

  *)
    echo "Usage: $0 {create N|status|delete}"
    echo ""
    echo "  create N  — Create N test apps with desired_session_count=1"
    echo "  status    — Check session creation progress + distribution"
    echo "  delete    — Remove all test apps and related data"
    ;;
esac
