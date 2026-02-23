# SBOM Generation Record (2026-02-19)

## Output Bundle

- Path: `implementation_tracker/phase_4/sbom/sbom_20260219T201118Z`
- Formats generated:
  - SPDX JSON (`*.spdx.json`)
  - CycloneDX JSON (`*.cyclonedx.json`)

## Scope

1. Full project source tree SBOM:
   - `source.spdx.json`
   - `source.cyclonedx.json`
2. Runtime image SBOMs for all unique images currently used by the `browser-hitl` namespace deployment snapshot:
   - `browser-hitl/api:phase4c`
   - `browser-hitl/controller:phase3d2`
   - `browser-hitl/worker:phase3g`
   - `browser-hitl/novnc:phase3`
   - `browser-hitl/test-harness:phase4u1`
   - `node:20-alpine`
   - `minio/minio:latest`
   - `nats:2.10-alpine`
   - `postgres:16-alpine`
   - `redis:7-alpine`

## Integrity + Inventory

- `manifest.json` includes source path, image count, and artifact counts.
- `images.txt` captures the exact image list used for image SBOM generation.
- `SHA256SUMS.txt` contains checksums for generated artifacts.

## Repro Command Pattern

```bash
syft scan dir:/home/juancho/projects/adoptbrowserstack \
  --output spdx-json=source.spdx.json \
  --output cyclonedx-json=source.cyclonedx.json

syft scan <image-ref> \
  --output spdx-json=<image>.spdx.json \
  --output cyclonedx-json=<image>.cyclonedx.json
```

