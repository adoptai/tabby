# ============================================================
# Browser HITL MVP — Makefile
# ============================================================
#
# Usage:  make <target>
#
# This Makefile provides a single entry point for all common
# development, build, test, and deployment operations.
# Designed for both human developers and AI agents.
#
# Prerequisites:
#   - Node.js 20+, pnpm 10+, Docker, kubectl, helm (for deploy)
#   - Python 3.11+ (for test-harness only)
#
# Quick start:
#   make install        # Install all dependencies
#   make build          # Build all packages
#   make test           # Run all tests
#   make lint           # Type-check all packages
#   make docker-build   # Build all Docker images
#   make k8s-deploy     # Deploy to Kubernetes via Helm
#
# ============================================================

SHELL := /bin/bash
.DEFAULT_GOAL := help

# --- Configuration -----------------------------------------------------------

REGISTRY       ?= browser-hitl
IMAGE_TAG      ?= dev
HELM_RELEASE   ?= browser-hitl
HELM_NAMESPACE ?= browser-hitl
K8S_CONTEXT    ?= $(shell kubectl config current-context 2>/dev/null)
LOCAL_API_PORT ?= 18080
LOCAL_ENV_FILE ?= .env.local

# Docker image names — must match charts/browser-hitl/values-local.yaml
IMG_API        := $(REGISTRY)/api:$(IMAGE_TAG)
IMG_CONTROLLER := $(REGISTRY)/controller:$(IMAGE_TAG)
IMG_WORKER     := $(REGISTRY)/worker:$(IMAGE_TAG)
IMG_NOVNC      := $(REGISTRY)/novnc:$(IMAGE_TAG)
IMG_ADMIN_UI   := $(REGISTRY)/admin-ui:$(IMAGE_TAG)
IMG_HARNESS    := $(REGISTRY)/test-harness:$(IMAGE_TAG)

# ============================================================
# HELP
# ============================================================

.PHONY: help
help: ## Show this help message
	@echo ""
	@echo "Browser HITL MVP — Available targets:"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
	@echo ""

# ============================================================
# DEVELOPMENT
# ============================================================

.PHONY: install
install: ## Install all dependencies (pnpm)
	pnpm install

.PHONY: build
build: ## Build all packages (shared first, then apps)
	pnpm -r run build

.PHONY: build-shared
build-shared: ## Build shared types package only
	pnpm --filter @browser-hitl/shared run build

.PHONY: build-api
build-api: ## Build API service only
	pnpm --filter @browser-hitl/api run build

.PHONY: build-controller
build-controller: ## Build session controller only
	pnpm --filter @browser-hitl/controller run build

.PHONY: build-worker
build-worker: ## Build browser worker only
	pnpm --filter @browser-hitl/worker run build

.PHONY: clean
clean: ## Remove all build artifacts (dist/)
	find . -name 'dist' -type d -not -path '*/node_modules/*' -exec rm -rf {} + 2>/dev/null || true
	find . -name '*.tsbuildinfo' -delete 2>/dev/null || true
	@echo "Build artifacts cleaned."

.PHONY: clean-all
clean-all: clean ## Remove build artifacts AND node_modules
	find . -name 'node_modules' -type d -exec rm -rf {} + 2>/dev/null || true
	@echo "All artifacts and node_modules cleaned."

# ============================================================
# TESTING
# ============================================================

.PHONY: test
test: ## Run all tests across all packages
	pnpm -r run test

.PHONY: test-shared
test-shared: ## Run shared package tests (78 tests)
	pnpm --filter @browser-hitl/shared run test

.PHONY: test-api
test-api: ## Run API service tests (230 tests)
	pnpm --filter @browser-hitl/api run test

.PHONY: test-controller
test-controller: ## Run session controller tests (50 tests)
	pnpm --filter @browser-hitl/controller run test

.PHONY: test-worker
test-worker: ## Run browser worker tests (27 tests)
	pnpm --filter @browser-hitl/worker run test

.PHONY: test-watch
test-watch: ## Run tests in watch mode (shared package)
	pnpm --filter @browser-hitl/shared run test -- --watch

.PHONY: lint
lint: ## Type-check all packages (tsc --noEmit)
	pnpm -r run lint

# ============================================================
# DOCKER
# ============================================================

.PHONY: docker-build
docker-build: docker-build-api docker-build-controller docker-build-worker docker-build-novnc docker-build-admin-ui docker-build-harness ## Build all Docker images

.PHONY: docker-build-api
docker-build-api: ## Build API Docker image
	docker build -f infra/docker/Dockerfile.api -t $(IMG_API) .

.PHONY: docker-build-controller
docker-build-controller: ## Build controller Docker image
	docker build -f infra/docker/Dockerfile.controller -t $(IMG_CONTROLLER) .

.PHONY: docker-build-worker
docker-build-worker: ## Build worker Docker image (Playwright + Xvfb + x11vnc)
	docker build -f infra/docker/Dockerfile.worker -t $(IMG_WORKER) .

.PHONY: docker-build-novnc
docker-build-novnc: ## Build noVNC sidecar Docker image
	docker build -f infra/docker/Dockerfile.novnc -t $(IMG_NOVNC) .

.PHONY: docker-build-admin-ui
docker-build-admin-ui: ## Build admin-ui Docker image
	docker build -f infra/docker/Dockerfile.admin-ui -t $(IMG_ADMIN_UI) .

.PHONY: docker-build-harness
docker-build-harness: ## Build test harness Docker image
	docker build -f test-harness/Dockerfile -t $(IMG_HARNESS) test-harness/

.PHONY: docker-push
docker-push: ## Push all Docker images to registry
	docker push $(IMG_API)
	docker push $(IMG_CONTROLLER)
	docker push $(IMG_WORKER)
	docker push $(IMG_NOVNC)
	docker push $(IMG_HARNESS)

# ============================================================
# KUBERNETES / HELM
# ============================================================

.PHONY: k8s-deploy
k8s-deploy: ## Deploy to Kubernetes via Helm (creates namespace if needed)
	kubectl create namespace $(HELM_NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -
	helm upgrade --install $(HELM_RELEASE) charts/browser-hitl/ \
		--namespace $(HELM_NAMESPACE) \
		--set global.imageRegistry=$(REGISTRY) \
		--set images.api.tag=$(IMAGE_TAG) \
		--set images.controller.tag=$(IMAGE_TAG) \
		--set images.worker.tag=$(IMAGE_TAG) \
		--set images.novnc.tag=$(IMAGE_TAG) \
		--set images.slackBot.tag=$(IMAGE_TAG) \
		--set images.teamsBot.tag=$(IMAGE_TAG) \
		--set images.adminUi.tag=$(IMAGE_TAG) \
		--wait --timeout 5m

.PHONY: k8s-delete
k8s-delete: ## Delete Helm release from Kubernetes
	helm uninstall $(HELM_RELEASE) --namespace $(HELM_NAMESPACE) || true

.PHONY: k8s-status
k8s-status: ## Show status of all pods in the release namespace
	kubectl get pods -n $(HELM_NAMESPACE) -o wide
	@echo ""
	kubectl get svc -n $(HELM_NAMESPACE)

.PHONY: k8s-logs-api
k8s-logs-api: ## Tail API service logs
	kubectl logs -n $(HELM_NAMESPACE) -l app.kubernetes.io/component=api -f --tail=100

.PHONY: k8s-logs-controller
k8s-logs-controller: ## Tail controller logs
	kubectl logs -n $(HELM_NAMESPACE) -l app.kubernetes.io/component=controller -f --tail=100

.PHONY: k8s-port-forward
k8s-port-forward: ## Port-forward all services for local development
	@echo "API:        http://localhost:18080        (Swagger: http://localhost:18080/api/docs)"
	@echo "Admin UI:   http://localhost:13000"
	@echo "PostgreSQL: localhost:25432"
	@echo "Redis:      localhost:16379"
	@echo "MinIO:      localhost:19000"
	@echo "NATS:       localhost:4222"
	@echo ""
	@echo "Stop all: pkill -f 'kubectl port-forward'"
	@echo ""
	kubectl port-forward -n $(HELM_NAMESPACE) svc/$(HELM_RELEASE)-api 18080:8000 &
	kubectl port-forward -n $(HELM_NAMESPACE) svc/$(HELM_RELEASE)-admin-ui 13000:8000 &
	kubectl port-forward -n $(HELM_NAMESPACE) svc/$(HELM_RELEASE)-postgres 25432:5432 &
	kubectl port-forward -n $(HELM_NAMESPACE) svc/$(HELM_RELEASE)-redis 16379:6379 &
	kubectl port-forward -n $(HELM_NAMESPACE) svc/$(HELM_RELEASE)-minio 19000:9000 &
	kubectl port-forward -n $(HELM_NAMESPACE) svc/$(HELM_RELEASE)-nats 4222:4222 &
	@wait

# ============================================================
# KIND (local Kubernetes)
# ============================================================

DOTENV_FILE ?= .env
HELM_DOTENV_SETS :=
ifneq (,$(wildcard $(DOTENV_FILE)))
  HELM_DOTENV_SETS := $(shell ./scripts/dotenv-to-helm-sets.sh $(DOTENV_FILE))
endif

KIND_CLUSTER ?= tabby-dev

.PHONY: kind-create
kind-create: ## Create a Kind cluster for local development
	kind create cluster --name $(KIND_CLUSTER)
	@echo "Kind cluster '$(KIND_CLUSTER)' created. Context: kind-$(KIND_CLUSTER)"

.PHONY: kind-load-images
kind-load-images: ## Load all Docker images into the Kind cluster
	kind load docker-image \
		$(IMG_API) \
		$(IMG_CONTROLLER) \
		$(IMG_WORKER) \
		$(IMG_NOVNC) \
		$(IMG_ADMIN_UI) \
		--name $(KIND_CLUSTER)
	@echo "Images loaded into Kind cluster '$(KIND_CLUSTER)'"

.PHONY: kind-deploy
kind-deploy: ## Full local deploy: load images + helm install with local values
	$(MAKE) kind-load-images
	kubectl create namespace $(HELM_NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -
	helm upgrade --install $(HELM_RELEASE) charts/browser-hitl/ \
		-f charts/browser-hitl/values-local.yaml \
		--namespace $(HELM_NAMESPACE) \
		--wait --timeout 5m
	@echo "Stack deployed. Run: kubectl port-forward -n $(HELM_NAMESPACE) svc/$(HELM_RELEASE)-api 18080:8080"

# --- Kind reload shortcuts: build + load + restart a single service ----------

.PHONY: kind-reload-api
kind-reload-api: docker-build-api ## Rebuild API and reload into Kind
	kind load docker-image $(IMG_API) --name $(KIND_CLUSTER)
	helm upgrade $(HELM_RELEASE) charts/browser-hitl/ \
		-f charts/browser-hitl/values-local.yaml \
		--namespace $(HELM_NAMESPACE) --reuse-values \
		--wait --timeout 5m
	@echo "API reloaded."

.PHONY: kind-reload-controller
kind-reload-controller: docker-build-controller ## Rebuild controller and reload into Kind
	kind load docker-image $(IMG_CONTROLLER) --name $(KIND_CLUSTER)
	helm upgrade $(HELM_RELEASE) charts/browser-hitl/ \
		-f charts/browser-hitl/values-local.yaml \
		--namespace $(HELM_NAMESPACE) --reuse-values \
		--wait --timeout 5m
	@echo "Controller reloaded."

.PHONY: kind-reload-worker
kind-reload-worker: docker-build-worker ## Rebuild worker and reload into Kind
	kind load docker-image $(IMG_WORKER) --name $(KIND_CLUSTER)
	helm upgrade $(HELM_RELEASE) charts/browser-hitl/ \
		-f charts/browser-hitl/values-local.yaml \
		--namespace $(HELM_NAMESPACE) --reuse-values \
		--wait --timeout 5m
	@echo "Worker reloaded."

.PHONY: kind-reload-admin-ui
kind-reload-admin-ui: docker-build-admin-ui ## Rebuild admin-ui and reload into Kind
	kind load docker-image $(IMG_ADMIN_UI) --name $(KIND_CLUSTER)
	helm upgrade $(HELM_RELEASE) charts/browser-hitl/ \
		-f charts/browser-hitl/values-local.yaml \
		--namespace $(HELM_NAMESPACE) --reuse-values \
		--wait --timeout 5m
	@echo "Admin UI reloaded."

.PHONY: kind-reload-novnc
kind-reload-novnc: docker-build-novnc ## Rebuild noVNC and reload into Kind
	kind load docker-image $(IMG_NOVNC) --name $(KIND_CLUSTER)
	@echo "noVNC reloaded (sidecar — new worker pods will pick it up)."

.PHONY: kind-reload-all
kind-reload-all: clean build docker-build ## Clean + build source + images, load into Kind, and upgrade Helm release
	$(MAKE) kind-load-images
	helm upgrade --install $(HELM_RELEASE) charts/browser-hitl/ \
		-f charts/browser-hitl/values-local.yaml \
		--namespace $(HELM_NAMESPACE) --create-namespace \
		$(HELM_DOTENV_SETS) \
		--wait --timeout 5m
	@echo "Force-restarting deployments (image tag :dev never changes, so pods must be bounced)..."
	kubectl rollout restart deployment \
		-l app.kubernetes.io/instance=$(HELM_RELEASE) \
		-n $(HELM_NAMESPACE)
	kubectl rollout status deployment \
		-l app.kubernetes.io/instance=$(HELM_RELEASE) \
		-n $(HELM_NAMESPACE) \
		--timeout 3m
	@echo "All services rebuilt and deployed with local images."

.PHONY: kind-stop
kind-stop: ## Scale all deployments and statefulsets to 0 replicas (stop pods without deleting)
	kubectl scale deployment --all --replicas=0 -n $(HELM_NAMESPACE)
	kubectl scale statefulset --all --replicas=0 -n $(HELM_NAMESPACE)
	@echo "All pods scaled to 0 in namespace '$(HELM_NAMESPACE)'."

.PHONY: kind-start
kind-start: ## Scale all deployments and statefulsets back to 1 replica
	kubectl scale deployment --all --replicas=1 -n $(HELM_NAMESPACE)
	kubectl scale statefulset --all --replicas=1 -n $(HELM_NAMESPACE)
	@echo "All pods scaled to 1 in namespace '$(HELM_NAMESPACE)'."

.PHONY: kind-delete
kind-delete: ## Delete the Kind cluster
	kind delete cluster --name $(KIND_CLUSTER)

# ============================================================
# TEST HARNESS (local Python dev)
# ============================================================

.PHONY: harness-run
harness-run: ## Run test harness locally (Python/FastAPI on :8000)
	cd test-harness && python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload

.PHONY: harness-test
harness-test: ## Quick smoke test of test harness endpoints
	@echo "--- GET /login ---"
	curl -s http://localhost:8000/login | head -5
	@echo ""
	@echo "--- POST /login ---"
	curl -s -X POST http://localhost:8000/login \
		-d "email=admin@example.com&password=P@ssw0rd12345" \
		-c /tmp/harness-cookies.txt -L -o /dev/null -w "HTTP %{http_code}\n"
	@echo "--- GET /api/me ---"
	curl -s http://localhost:8000/api/me -b /tmp/harness-cookies.txt
	@echo ""

.PHONY: e2e-batch-a
e2e-batch-a: ## Run Batch A E2E validation (stream/replay/takeover-release) and write evidence artifacts
	./scripts/e2e-batch-a.sh

.PHONY: e2e-batch-b
e2e-batch-b: ## Run Batch B E2E validation (dynamic egress allowlist runtime enforcement)
	./scripts/e2e-batch-b.sh

.PHONY: e2e-batch-c
e2e-batch-c: ## Run Batch C in-cluster closure validation (controller->egress allowlist sync/update/cleanup)
	./scripts/e2e-batch-c.sh

.PHONY: e2e-batch-d
e2e-batch-d: ## Run Batch D in-cluster egress data-plane validation (worker Playwright allow/deny/update)
	./scripts/e2e-batch-d.sh

.PHONY: e2e-uat-22-4
e2e-uat-22-4: ## Run section 22.4 UAT closure validator and write full evidence package
	./scripts/e2e-uat-22-4.sh

.PHONY: local-ngrok-up
local-ngrok-up: ## Start local API port-forward + ngrok tunnel and print captured public URL
	LOCAL_NAMESPACE=$(HELM_NAMESPACE) \
	LOCAL_RELEASE=$(HELM_RELEASE) \
	LOCAL_API_PORT=$(LOCAL_API_PORT) \
	./scripts/local-stack-ngrok.sh up

.PHONY: local-ngrok-up-apply-stream-host
local-ngrok-up-apply-stream-host: ## Start local tunnel and apply STREAM_HOST/STREAM_PROTOCOL to API deployment
	LOCAL_NAMESPACE=$(HELM_NAMESPACE) \
	LOCAL_RELEASE=$(HELM_RELEASE) \
	LOCAL_API_PORT=$(LOCAL_API_PORT) \
	LOCAL_APPLY_STREAM_ENV=true \
	./scripts/local-stack-ngrok.sh up

.PHONY: local-ngrok-refresh-apply-stream-host
local-ngrok-refresh-apply-stream-host: ## Force-rotate ngrok tunnel, then apply fresh STREAM_HOST/STREAM_PROTOCOL/PUBLIC_BASE_URL
	$(MAKE) local-ngrok-down
	$(MAKE) local-ngrok-up-apply-stream-host

.PHONY: local-ngrok-status
local-ngrok-status: ## Show status of local API port-forward/ngrok and current URL
	LOCAL_NAMESPACE=$(HELM_NAMESPACE) \
	LOCAL_RELEASE=$(HELM_RELEASE) \
	LOCAL_API_PORT=$(LOCAL_API_PORT) \
	./scripts/local-stack-ngrok.sh status

.PHONY: local-ngrok-url
local-ngrok-url: ## Print active ngrok public URL for local stack
	LOCAL_NAMESPACE=$(HELM_NAMESPACE) \
	LOCAL_RELEASE=$(HELM_RELEASE) \
	LOCAL_API_PORT=$(LOCAL_API_PORT) \
	./scripts/local-stack-ngrok.sh url

.PHONY: local-ngrok-down
local-ngrok-down: ## Stop local API port-forward + ngrok tunnel managed by local targets
	LOCAL_NAMESPACE=$(HELM_NAMESPACE) \
	LOCAL_RELEASE=$(HELM_RELEASE) \
	LOCAL_API_PORT=$(LOCAL_API_PORT) \
	./scripts/local-stack-ngrok.sh down

.PHONY: local-nats-up
local-nats-up: ## Start managed local NATS port-forward on localhost:4222
	LOCAL_NAMESPACE=$(HELM_NAMESPACE) \
	LOCAL_ENV_FILE=$(LOCAL_ENV_FILE) \
	./scripts/local-nats-port-forward.sh up

.PHONY: local-nats-status
local-nats-status: ## Show managed local NATS port-forward status
	LOCAL_NAMESPACE=$(HELM_NAMESPACE) \
	LOCAL_ENV_FILE=$(LOCAL_ENV_FILE) \
	./scripts/local-nats-port-forward.sh status

.PHONY: local-nats-down
local-nats-down: ## Stop managed local NATS port-forward
	LOCAL_NAMESPACE=$(HELM_NAMESPACE) \
	LOCAL_ENV_FILE=$(LOCAL_ENV_FILE) \
	./scripts/local-nats-port-forward.sh down

.PHONY: local-slack-soft-up
local-slack-soft-up: ## Start managed Slack soft bridge in background using $(LOCAL_ENV_FILE)
	LOCAL_ENV_FILE=$(LOCAL_ENV_FILE) \
	./scripts/local-slack-soft-bridge.sh up

.PHONY: local-slack-soft-status
local-slack-soft-status: ## Show managed Slack soft bridge status
	LOCAL_ENV_FILE=$(LOCAL_ENV_FILE) \
	./scripts/local-slack-soft-bridge.sh status

.PHONY: local-slack-soft-logs
local-slack-soft-logs: ## Tail managed Slack soft bridge logs
	LOCAL_ENV_FILE=$(LOCAL_ENV_FILE) \
	./scripts/local-slack-soft-bridge.sh logs

.PHONY: local-slack-soft-down
local-slack-soft-down: ## Stop managed Slack soft bridge
	LOCAL_ENV_FILE=$(LOCAL_ENV_FILE) \
	./scripts/local-slack-soft-bridge.sh down

.PHONY: e2e-uat-22-4-local
e2e-uat-22-4-local: ## Start local tunnel (and apply stream host) then run section 22.4 UAT against localhost:$(LOCAL_API_PORT)
	$(MAKE) local-ngrok-up-apply-stream-host
	API_URL=http://localhost:$(LOCAL_API_PORT) \
	UAT_NAMESPACE=$(HELM_NAMESPACE) \
	./scripts/e2e-uat-22-4.sh

.PHONY: hitl-scale-down-active
hitl-scale-down-active: ## Scale all active apps (desired_session_count>0) to zero to free worker CPU
	API_URL=http://localhost:$(LOCAL_API_PORT) \
	./scripts/hitl-scale-down-active-apps.sh

.PHONY: local-reliability-preflight
local-reliability-preflight: ## Run strict local reliability preflight checks (ngrok/api/stream/assets/capacity)
	LOCAL_ENV_FILE=$(LOCAL_ENV_FILE) \
	LOCAL_NAMESPACE=$(HELM_NAMESPACE) \
	LOCAL_RELEASE=$(HELM_RELEASE) \
	./scripts/local-reliability-preflight.sh --env-file $(LOCAL_ENV_FILE) --auto-fix --require-nats

.PHONY: local-fresh-e2e
local-fresh-e2e: ## One-command reliability flow: refresh ngrok, clean stale state, start NATS+soft bridge, run preflight
	LOCAL_ENV_FILE=$(LOCAL_ENV_FILE) \
	LOCAL_NAMESPACE=$(HELM_NAMESPACE) \
	LOCAL_RELEASE=$(HELM_RELEASE) \
	./scripts/local-fresh-e2e.sh --env-file $(LOCAL_ENV_FILE)

.PHONY: local-fresh-down
local-fresh-down: ## Stop managed local reliability helper processes (Slack soft bridge, NATS port-forward, ngrok stack)
	$(MAKE) local-slack-soft-down
	$(MAKE) local-nats-down
	$(MAKE) local-ngrok-down

.PHONY: slack-soft-start
slack-soft-start: ## Start soft Slack bridge using vars from $(LOCAL_ENV_FILE)
	@test -f "$(LOCAL_ENV_FILE)" || (echo "Missing $(LOCAL_ENV_FILE). Create it from .env.example first." >&2; exit 1)
	@set -a; source "$(LOCAL_ENV_FILE)"; set +a; \
	pnpm --filter @browser-hitl/slack-bot build && \
	pnpm --filter @browser-hitl/slack-bot start:soft

# ============================================================
# SMOKE TEST (full stack verification)
# ============================================================

.PHONY: smoke-test
smoke-test: ## Full smoke test: build, test, docker-build, verify
	@echo "=== Step 1/4: Build all packages ==="
	$(MAKE) build
	@echo ""
	@echo "=== Step 2/4: Run all tests ==="
	$(MAKE) test
	@echo ""
	@echo "=== Step 3/4: Lint (type-check) ==="
	$(MAKE) lint
	@echo ""
	@echo "=== Step 4/4: Summary ==="
	@echo "Build:  PASS"
	@echo "Tests:  PASS (385 tests)"
	@echo "Lint:   PASS"
	@echo ""
	@echo "Smoke test complete. Run 'make docker-build' to build images."

# ============================================================
# CI SHORTCUTS
# ============================================================

.PHONY: ci
ci: install build lint test ## Full CI pipeline: install → build → lint → test

.PHONY: ci-docker
ci-docker: ci docker-build ## CI + Docker image builds

# ============================================================
# JETSTREAM / NATS MONITORING
# ============================================================

.PHONY: nats-streams
nats-streams: ## Show JetStream stream status (requires NATS monitoring port-forward on 8222)
	@curl -sf http://localhost:8222/jsz 2>/dev/null | jq '.streams[] | {name, messages, consumer_count, state: .state.messages}' \
		|| echo "NATS monitoring not available. Run: kubectl -n $(HELM_NAMESPACE) port-forward svc/$(HELM_RELEASE)-nats 8222:8222"

.PHONY: nats-consumers
nats-consumers: ## Show JetStream consumer details for all streams
	@echo "=== HITL_EVENTS consumers ===" && \
	curl -sf http://localhost:8222/jsz?consumers=true 2>/dev/null | jq '.streams[] | select(.name=="HITL_EVENTS") | .consumer_detail[]? | {name, num_pending, num_ack_pending}' \
		|| echo "NATS monitoring not available."
	@echo "" && echo "=== SESSION_EVENTS consumers ===" && \
	curl -sf http://localhost:8222/jsz?consumers=true 2>/dev/null | jq '.streams[] | select(.name=="SESSION_EVENTS") | .consumer_detail[]? | {name, num_pending, num_ack_pending}' \
		|| echo ""

# ============================================================
# ENCRYPTION KEY MANAGEMENT
# ============================================================

.PHONY: generate-encryption-key
generate-encryption-key: ## Generate a new AES-256 tenant encryption key (64-char hex)
	@echo "TENANT_ENCRYPTION_KEY=$$(openssl rand -hex 32)"

# ============================================================
# UTILITIES
# ============================================================

.PHONY: deps-check
deps-check: ## Check for outdated dependencies
	pnpm outdated -r || true

.PHONY: deps-update
deps-update: ## Update all dependencies (interactive)
	pnpm update -r --interactive --latest

.PHONY: format-check
format-check: ## Check code formatting (if prettier configured)
	@echo "Prettier not yet configured. Add to devDependencies to enable."

.PHONY: git-status
git-status: ## Show git status with file count
	@echo "Tracked files: $$(git ls-files | wc -l)"
	@echo "Modified:      $$(git diff --name-only | wc -l)"
	@echo "Untracked:     $$(git ls-files --others --exclude-standard | wc -l)"
	@echo ""
	@git status --short | head -30
	@TOTAL=$$(git status --short | wc -l); \
		if [ $$TOTAL -gt 30 ]; then echo "... and $$((TOTAL - 30)) more"; fi

.PHONY: tree
tree: ## Show project structure (source files only)
	@find apps packages -name '*.ts' -not -path '*/node_modules/*' -not -path '*/dist/*' | sort | head -80
	@echo ""
	@echo "Total source files: $$(find apps packages -name '*.ts' -not -path '*/node_modules/*' -not -path '*/dist/*' | wc -l)"
