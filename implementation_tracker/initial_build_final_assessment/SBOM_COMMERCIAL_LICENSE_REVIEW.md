# SBOM Commercial and License Review

**Date:** 2026-02-19  
**SBOM bundle:** `implementation_tracker/phase_4/sbom/sbom_20260219T201118Z`

## 1. Scope and Method

SBOM sources reviewed:
1. Project source SBOM (`source.spdx.json`, `source.cyclonedx.json`).
2. Runtime image SBOMs (10 images, SPDX + CycloneDX each).
3. Runtime image metadata/verification for key components.

Bundle manifest:
- `manifest.json`: `image_count=10`, SPDX/CycloneDX image outputs complete.
- `SHA256SUMS.txt`: integrity checks present.

## 2. Important Data Quality Note

License resolution quality is uneven:
1. `source.spdx.json` is largely `NOASSERTION` for package license fields.
2. Image SBOMs contain many OS-level packages with mixed/compound expressions.

Implication:
- This is a strong inventory baseline, but **not yet sufficient alone for legal sign-off**.

## 3. Commercial Risk Findings

## 3.1 High attention: MinIO licensing

Observed evidence:
1. Runtime uses `minio/minio:latest`.
2. Running binary reports:
   - `License: GNU AGPLv3`
   - verified via container command (`minio --version`).

Commercial implication:
- AGPLv3 can be a blocker or require explicit legal/commercial licensing strategy depending on deployment and distribution model.

Mitigation options:
1. Obtain a commercial MinIO license/support agreement aligned to intended business model.
2. Replace MinIO with an alternative S3-compatible backend with acceptable licensing posture.
3. Use managed external object storage (where policy allows) to reduce embedded AGPL exposure.

## 3.2 Medium attention: VNC stack copyleft footprint

Observed in runtime SBOM:
1. `x11vnc` appears as `GPL-2.0-only` in worker image.
2. noVNC stack includes MPL/LGPL/copyleft components (`@novnc/novnc`, `websockify` packages).

Commercial implication:
- These are commonly usable in commercial environments with compliance obligations, but they require formal notice/source-offer handling where applicable.

Mitigation options:
1. Keep VNC stack for PoC only and accelerate CDP migration path to reduce copyleft surface.
2. If retained, implement explicit third-party notice and source-availability compliance pipeline.

## 3.3 Medium attention: mutable tags and drift risk

Observed:
1. Stateful/runtime images include mutable tags (for example `minio/minio:latest`).

Implication:
- Reproducibility and legal/security attestability are weakened.

Mitigation:
1. Pin images by digest (`@sha256:...`) in Helm values.
2. Regenerate SBOM per digest and attach signatures/attestations per release.

## 3.4 Medium attention: unresolved license assertions

Observed:
1. Large fraction of components are `NOASSERTION`/missing license fields in generated outputs.

Implication:
- Unknown-license components must be triaged before production commercialization.

Mitigation:
1. Add a secondary license scanner specialized for npm/python/go attribution.
2. Establish a legal review queue for unknown/ambiguous components.
3. Fail CI on denied licenses and unresolved critical unknowns.

## 4. Practical Commercial Readiness Rating

Current rating: **Conditionally usable for PoC, not yet cleared for broad commercial deployment**.

Reasons:
1. AGPL-bearing MinIO runtime currently in active stack.
2. Copyleft footprint in VNC path not yet paired with formal compliance process.
3. Incomplete source-license assertions.

## 5. Recommended License Closure Plan

1. Make an immediate product/legal decision on MinIO path:
- commercial MinIO agreement, or
- storage backend replacement.
2. Decide whether VNC remains beyond PoC:
- if no, prioritize CDP migration;
- if yes, formalize notice/source obligations.
3. Add `license-policy` CI gate:
- allowlist/denylist by SPDX ID,
- fail on unresolved critical unknowns.
4. Produce release artifacts:
- pinned image digests,
- signed SBOM + provenance attestations,
- third-party notices bundle.

## 6. Not Legal Advice

This is a technical risk assessment and prioritization artifact. Final commercial licensing decisions require counsel review.

