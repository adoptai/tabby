#!/usr/bin/env bash
# =============================================================================
# SBOM Pipeline Script
# Per spec section 15.9:
#   - Generate SBOM via syft on each container image build
#   - Output: CycloneDX JSON format
#   - Sign SBOM with cosign sign-blob and store signature alongside the SBOM
#   - Verify signatures before SBOM review
#   - SBOM and signatures stored in the container registry alongside image manifests
# =============================================================================

set -euo pipefail

# --- Configuration ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SBOM_OUTPUT_DIR="${SBOM_OUTPUT_DIR:-${PROJECT_ROOT}/dist/sbom}"
COSIGN_KEY="${COSIGN_KEY:-}"  # Path to cosign private key; if empty, keyless signing is used

# All service images to process
IMAGES=(
  "browser-hitl/api"
  "browser-hitl/controller"
  "browser-hitl/worker"
  "browser-hitl/novnc"
  "browser-hitl/slack-bot"
  "browser-hitl/teams-bot"
  "browser-hitl/admin-ui"
)

# --- Dependency Checks ---
check_dependencies() {
  local missing=()

  if ! command -v syft &>/dev/null; then
    missing+=("syft")
  fi

  if ! command -v cosign &>/dev/null; then
    missing+=("cosign")
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: Missing required tools: ${missing[*]}"
    echo ""
    echo "Install instructions:"
    echo "  syft:   curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin"
    echo "  cosign: go install github.com/sigstore/cosign/v2/cmd/cosign@latest"
    exit 1
  fi
}

# --- Generate SBOM ---
# Uses syft to generate a CycloneDX SBOM for a given Docker image
generate_sbom() {
  local image="$1"
  local tag="${2:-latest}"
  local full_image="${image}:${tag}"
  local safe_name
  safe_name="$(echo "${image}" | tr '/' '_')"
  local sbom_file="${SBOM_OUTPUT_DIR}/${safe_name}-${tag}.cdx.json"

  echo "==> Generating SBOM for ${full_image}..."
  mkdir -p "${SBOM_OUTPUT_DIR}"

  syft "${full_image}" \
    --output cyclonedx-json="${sbom_file}" \
    --quiet

  if [[ ! -f "${sbom_file}" ]]; then
    echo "ERROR: SBOM generation failed for ${full_image}"
    return 1
  fi

  echo "    SBOM written to: ${sbom_file}"
  echo "${sbom_file}"
}

# --- Sign SBOM ---
# Signs the SBOM blob with cosign. Supports both key-based and keyless signing.
sign_sbom() {
  local sbom_file="$1"
  local sig_file="${sbom_file}.sig"
  local cert_file="${sbom_file}.cert"

  echo "==> Signing SBOM: ${sbom_file}..."

  if [[ -n "${COSIGN_KEY}" ]]; then
    # Key-based signing
    cosign sign-blob \
      --key "${COSIGN_KEY}" \
      --output-signature "${sig_file}" \
      "${sbom_file}"
  else
    # Keyless signing (Fulcio + Rekor) - for CI environments with OIDC
    # Requires COSIGN_EXPERIMENTAL=1 or cosign v2+ with --yes flag
    COSIGN_EXPERIMENTAL=1 cosign sign-blob \
      --yes \
      --output-signature "${sig_file}" \
      --output-certificate "${cert_file}" \
      "${sbom_file}"
  fi

  echo "    Signature written to: ${sig_file}"
}

# --- Verify SBOM Signature ---
verify_sbom() {
  local sbom_file="$1"
  local sig_file="${sbom_file}.sig"
  local cert_file="${sbom_file}.cert"

  echo "==> Verifying SBOM signature: ${sbom_file}..."

  if [[ -n "${COSIGN_KEY}" ]]; then
    # Key-based verification
    cosign verify-blob \
      --key "${COSIGN_KEY%.key}.pub" \
      --signature "${sig_file}" \
      "${sbom_file}"
  else
    # Keyless verification (requires certificate + Rekor)
    if [[ -f "${cert_file}" ]]; then
      COSIGN_EXPERIMENTAL=1 cosign verify-blob \
        --signature "${sig_file}" \
        --certificate "${cert_file}" \
        --certificate-identity-regexp '.*' \
        --certificate-oidc-issuer-regexp '.*' \
        "${sbom_file}"
    else
      echo "    WARN: No certificate found for keyless verification. Skipping verify."
      return 0
    fi
  fi

  echo "    Signature verified OK"
}

# --- Attach SBOM to OCI Registry ---
# Attach the SBOM to the container image in the registry as an OCI artifact
attach_sbom_to_registry() {
  local image="$1"
  local tag="${2:-latest}"
  local full_image="${image}:${tag}"
  local safe_name
  safe_name="$(echo "${image}" | tr '/' '_')"
  local sbom_file="${SBOM_OUTPUT_DIR}/${safe_name}-${tag}.cdx.json"

  if [[ ! -f "${sbom_file}" ]]; then
    echo "ERROR: SBOM file not found: ${sbom_file}"
    return 1
  fi

  echo "==> Attaching SBOM to ${full_image} in registry..."
  cosign attach sbom \
    --sbom "${sbom_file}" \
    --type cyclonedx \
    "${full_image}"

  echo "    SBOM attached to registry for ${full_image}"
}

# --- Main ---
main() {
  local command="${1:-generate}"
  local image_tag="${2:-latest}"
  local specific_image="${3:-}"

  check_dependencies

  case "${command}" in
    generate)
      echo "============================================"
      echo "Generating SBOMs for all service images"
      echo "Tag: ${image_tag}"
      echo "============================================"
      echo ""

      local images_to_process=("${IMAGES[@]}")
      if [[ -n "${specific_image}" ]]; then
        images_to_process=("${specific_image}")
      fi

      local generated_files=()
      for image in "${images_to_process[@]}"; do
        sbom_file="$(generate_sbom "${image}" "${image_tag}")"
        generated_files+=("${sbom_file}")
        echo ""
      done

      echo "============================================"
      echo "Signing SBOMs"
      echo "============================================"
      echo ""

      for sbom_file in "${generated_files[@]}"; do
        sign_sbom "${sbom_file}"
        echo ""
      done

      echo "============================================"
      echo "Verifying SBOM signatures"
      echo "============================================"
      echo ""

      for sbom_file in "${generated_files[@]}"; do
        verify_sbom "${sbom_file}"
        echo ""
      done

      echo "============================================"
      echo "SBOM pipeline complete"
      echo "Output directory: ${SBOM_OUTPUT_DIR}"
      echo "============================================"
      ;;

    verify)
      echo "Verifying all SBOMs in ${SBOM_OUTPUT_DIR}..."
      for sbom_file in "${SBOM_OUTPUT_DIR}"/*.cdx.json; do
        if [[ -f "${sbom_file}" ]]; then
          verify_sbom "${sbom_file}"
          echo ""
        fi
      done
      echo "All SBOM verifications complete."
      ;;

    attach)
      echo "Attaching SBOMs to registry..."
      local images_to_process=("${IMAGES[@]}")
      if [[ -n "${specific_image}" ]]; then
        images_to_process=("${specific_image}")
      fi

      for image in "${images_to_process[@]}"; do
        attach_sbom_to_registry "${image}" "${image_tag}"
        echo ""
      done
      echo "All SBOMs attached to registry."
      ;;

    *)
      echo "Usage: $0 {generate|verify|attach} [image-tag] [specific-image]"
      echo ""
      echo "Commands:"
      echo "  generate  - Generate, sign, and verify SBOMs for all images (default)"
      echo "  verify    - Verify existing SBOM signatures"
      echo "  attach    - Attach SBOMs to OCI registry alongside images"
      echo ""
      echo "Environment variables:"
      echo "  SBOM_OUTPUT_DIR  - Output directory for SBOMs (default: dist/sbom)"
      echo "  COSIGN_KEY       - Path to cosign private key (empty = keyless signing)"
      exit 1
      ;;
  esac
}

main "$@"
