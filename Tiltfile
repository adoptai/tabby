# ============================================================
# Browser HITL — Tiltfile
# Replaces `make kind-reload-all` with live rebuild + deploy.
#
# Prerequisites:
#   kind create cluster --name tabby-dev
#   tilt up
# ============================================================

allow_k8s_contexts(['kind-tabby-dev'])

# ============================================================
# Docker images
# ============================================================

docker_build(
    'browser-hitl/api',
    context='.',
    dockerfile='infra/docker/Dockerfile.api',
)

docker_build(
    'browser-hitl/controller',
    context='.',
    dockerfile='infra/docker/Dockerfile.controller',
)

docker_build(
    'browser-hitl/worker',
    context='.',
    dockerfile='infra/docker/Dockerfile.worker',
)

docker_build(
    'browser-hitl/admin-ui',
    context='.',
    dockerfile='infra/docker/Dockerfile.admin-ui',
)

docker_build(
    'browser-hitl/novnc',
    context='.',
    dockerfile='infra/docker/Dockerfile.novnc',
)

docker_build(
    'browser-hitl/slack-bot',
    context='.',
    dockerfile='infra/docker/Dockerfile.slack-bot',
)

# ============================================================
# Helm deploy
# ============================================================

k8s_yaml(helm(
    'charts/browser-hitl',
    name='browser-hitl',
    namespace='browser-hitl',
    values=['charts/browser-hitl/values-local.yaml'],
))

# ============================================================
# Port-forwards
# ============================================================

k8s_resource(
    'browser-hitl-api',
    port_forwards=[
        port_forward(18080, 8000, name='api'),
    ],
    labels=['app'],
)

k8s_resource(
    'browser-hitl-admin-ui',
    port_forwards=[
        port_forward(13000, 8000, name='admin-ui'),
    ],
    labels=['app'],
)

k8s_resource(
    'browser-hitl-controller',
    labels=['app'],
)

k8s_resource(
    'browser-hitl-postgres',
    port_forwards=[
        port_forward(25432, 5432, name='postgres'),
    ],
    labels=['infra'],
)

k8s_resource(
    'browser-hitl-redis',
    port_forwards=[
        port_forward(16379, 6379, name='redis'),
    ],
    labels=['infra'],
)

k8s_resource(
    'browser-hitl-minio',
    port_forwards=[
        port_forward(19000, 9000, name='minio'),
    ],
    labels=['infra'],
)

k8s_resource(
    'browser-hitl-nats',
    port_forwards=[
        port_forward(14222, 4222, name='nats'),
    ],
    labels=['infra'],
)
