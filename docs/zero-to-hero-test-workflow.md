# Zero-to-Hero: Testes Completos

## Pré-requisitos

```bash
# 1. Tabby local rodando
make kind-reload-all
make k8s-port-forward

# 2. Plataforma rodando (docker compose ou equivalente)
# 3. Port-forward ativo na porta 18080
```

---

## Fase 1 — Unit Tests

```bash
# Tabby
cd ~/work/tabby
pnpm run build
TENANT_ENCRYPTION_KEY=$(printf '0%.0s' {1..64}) pnpm run test
pnpm run lint
helm lint charts/browser-hitl/

# Platform
cd ~/work/adoptwebui/backend
source ~/.virtualenvs/adoptwebgui/bin/activate
python -m pytest tests/test_tabby_resolution.py tests/test_internal_tabby.py -v

# ProjectA3
cd ~/work/ProjectA3
python -m pytest tests/actionbot/test_tabby_utils.py -v
```

**Esperado:** tudo verde, zero falhas.

---

## Fase 2 — NATS Resilience

### Teste 1 — NATS reconnect

```bash
# Mata o NATS
kubectl delete pod browser-hitl-nats-0 -n browser-hitl

# Espera 15s e checa logs do controller
kubectl logs deploy/browser-hitl-controller -n browser-hitl --tail=20 | grep -i nats
```

**Esperado:** `NATS disconnected, reconnecting...` seguido de `NATS reconnected`. Nenhum restart de pod.

---

## Fase 3 — Controller Multi-Replica

### Teste 2 — Escalar para 3 controllers

```bash
kubectl scale deploy browser-hitl-controller -n browser-hitl --replicas=3
```

### Teste 3 — Criar carga

```bash
./scripts/scale-test.sh create 50
```

### Teste 4 — Monitorar distribuição

```bash
# Espera 30s
./scripts/scale-test.sh status
```

**Esperado:** 50 sessions, zero duplicatas, trabalho distribuído entre os 3 controllers.

### Teste 5 — Matar um controller (failover)

```bash
# Deleta um pod qualquer
kubectl delete pod $(kubectl get pods -n browser-hitl -l app.kubernetes.io/component=controller --no-headers -o name | head -1) -n browser-hitl

# Espera 30s e checa status
./scripts/scale-test.sh status
```

**Esperado:** sessions continuam sendo reconciliadas, novo pod sobe, zero órfãos.

### Teste 6 — Scale down (desired=0)

```bash
kubectl exec browser-hitl-postgres-0 -n browser-hitl -- psql -U browser_hitl browser_hitl -c \
  "UPDATE applications SET desired_session_count = 0 WHERE name LIKE 'SCALE-TEST-%';"

# Espera 30s
./scripts/scale-test.sh status
```

**Esperado:** 0 sessions ativas (controller termina tudo).

### Cleanup

```bash
./scripts/scale-test.sh delete
kubectl scale deploy browser-hitl-controller -n browser-hitl --replicas=1
```

---

## Fase 4 — Tabby Offline → Erro Claro

### Teste 7 — Matar port-forward

```bash
pkill -f "port-forward.*18080"
```

### Teste 8 — Executar ação no Copilot

Acesse Experience/Copilot e envie: `create a quote for me`

**Esperado:** o workflow detecta que a ação precisa de Tabby, tenta resolver via callback, health check falha, e o user vê uma mensagem de erro no chat (ex: `"Browser automation service is currently unavailable"`). A ação **não** deve executar silenciosamente sem credenciais.

```bash
# Checar logs do wf-worker (adoptai-workflows)
# Deve mostrar: "Tabby credentials needed for action=..."
# Seguido de: notify_tabby_needed_activity com erro de conexão

# Checar logs do backend (adoptwebui)
# Deve mostrar: "Tabby is unreachable at ..." (no callback endpoint)
```

### Restaurar

```bash
make k8s-port-forward
```

---

## Fase 5 — `pending_input_request` limpo

### Teste 9

```bash
# Pega uma sessão HEALTHY
SESSION=$(kubectl exec browser-hitl-postgres-0 -n browser-hitl -- psql -U browser_hitl browser_hitl -t -c \
  "SELECT id FROM sessions WHERE state = 'HEALTHY' LIMIT 1;" | tr -d ' \n')

# Verifica pending_input_request
kubectl exec browser-hitl-postgres-0 -n browser-hitl -- psql -U browser_hitl browser_hitl -c \
  "SELECT pending_input_request FROM sessions WHERE id = '$SESSION';"
```

**Esperado:** `null` (sem dados stale do último step).

---

## Fase 6 — Stream Token + Revoke

### Teste 10

```bash
# Pega token de admin
TOKEN=$(curl -s http://localhost:18080/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@browser-hitl.local","password":"LocalDev123!@#"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# Pega uma sessão ativa
SESSION=$(kubectl exec browser-hitl-postgres-0 -n browser-hitl -- psql -U browser_hitl browser_hitl -t -c \
  "SELECT id FROM sessions WHERE state != 'TERMINATED' LIMIT 1;" | tr -d ' \n')

# Gera stream token
STREAM=$(curl -s -X POST "http://localhost:18080/sessions/$SESSION/stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')

# Panel-state deve funcionar
curl -s "http://localhost:18080/vnc/$SESSION/panel-state?token=$STREAM" | python3 -m json.tool

# Revoga
curl -s -X DELETE "http://localhost:18080/vnc/$SESSION/stream-access" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Panel-state agora deve retornar 401
curl -s -w "\nHTTP: %{http_code}\n" "http://localhost:18080/vnc/$SESSION/panel-state?token=$STREAM"
```

**Esperado:** `panel-state` funciona antes do revoke, retorna `401` depois.

---

## Fase 7 — Health Probes

### Teste 11

```bash
kubectl get deploy browser-hitl-api -n browser-hitl \
  -o jsonpath='{.spec.template.spec.containers[0].livenessProbe.timeoutSeconds}'
# Esperado: 5

kubectl get deploy browser-hitl-api -n browser-hitl \
  -o jsonpath='{.spec.template.spec.containers[0].livenessProbe.failureThreshold}'
# Esperado: 5
```

---

## Fase 8 — Grafana Labels

### Teste 12

```bash
helm template test charts/browser-hitl/ --set global.grafanaLabels=true | grep 'truefoundry.com' | wc -l
# Esperado: 9

helm template test charts/browser-hitl/ | grep 'truefoundry.com' | wc -l
# Esperado: 0
```

---

## Fase 9 — Platform: Tabby Online (manual no Copilot)

### Teste 13 — Free text com sessão HEALTHY

Envie no Copilot: `create a quote for me`

**Esperado:** workflow seleciona a ação, detecta que precisa de Tabby (via ProjectA3 `tabby_credentials_needed`), faz callback pro backend, backend resolve tokens (rápido — sessão já existe), sinaliza workflow, workflow resume e executa com credenciais reais. No chat do user, a ação executa normalmente.

```bash
# Checar logs do wf-worker — deve mostrar:
# "Tabby credentials needed for action=..."
# "Tabby credentials resolved — re-running action"

# Checar logs do backend — deve mostrar:
# callback recebido + tokens resolvidos + signal enviado
```

### Teste 14 — Free text sem relação com Tabby

Envie: `what can you do?`

**Esperado:** responde normalmente. O workflow seleciona uma ação que **não** precisa de Tabby, ProjectA3 não retorna `tabby_credentials_needed`, zero overhead. Checar logs do wf-worker — não deve aparecer "Tabby credentials needed".

### Teste 15 — Cold start

Sete `desired_session_count=0` no app do Salesforce, espere a session morrer e envie: `create a quote for me`

**Esperado:** workflow detecta Tabby needed → callback → backend provisiona nova sessão → HITL card aparece no chat (login necessário) → user faz login via VNC → backend sinaliza workflow → workflow resume → ação executa. O user **não** precisa remandar o prompt.

### Teste 16 — MCP (verificar que não quebrou)

Execute uma ação via MCP que use Tabby.

**Esperado:** backend resolve tokens normalmente (path `force_tabby=True` inalterado), workflow recebe `tabby_pre_resolved=True` no metadata, workflow **não** tenta resolver mid-flight. Checar logs do wf-worker: deve mostrar `"Tabby pre-resolved by API layer, skipping"`.

---

## Resumo

| Fase | Comando principal                      | Esperado               |
|------|----------------------------------------|------------------------|
| 1    | `pnpm run test` + `pytest`             | Todos verdes           |
| 2    | `kubectl delete pod nats`              | Reconnect nos logs     |
| 3    | `scale-test.sh create 50` + `status`  | 50/50, zero dupes      |
| 4    | `pkill port-forward` + executar ação  | Erro visível           |
| 5    | Query `pending_input_request`          | `null` em HEALTHY      |
| 6    | Stream → revoke → stream              | `200` → `401`          |
| 7    | `jsonpath` probes                      | timeout=5, failure=5   |
| 8    | `helm template grafanaLabels`          | 9 on, 0 off            |
| 9    | Copilot free text                      | Workflow resolve mid-flight |
| 9b   | MCP action                             | Pre-resolved, skip mid-flight |
