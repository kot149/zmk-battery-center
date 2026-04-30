#!/usr/bin/env bash
set -euo pipefail

REPO="kot149/zmk-battery-center"
APP_NAME="zmk-battery-center"

echo "Starting zmk-battery-center installation..."

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

echo "Fetching the latest version..."
LATEST_TAG=$(curl -sL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"tag_name": "([^"]+)".*/\1/')

if [ -z "${LATEST_TAG}" ]; then
  echo "Error: Could not fetch the latest version."
  exit 1
fi

VERSION="${LATEST_TAG#v}"
echo "Latest version: ${VERSION}"

ARCH=$(uname -m)
case "${ARCH}" in
  x86_64)
    DEB_ARCH="amd64"
    RPM_ARCH="x86_64"
    APPIMAGE_ARCH="amd64"
    ;;
  aarch64|arm64)
    DEB_ARCH="arm64"
    RPM_ARCH="aarch64"
    APPIMAGE_ARCH="aarch64"
    ;;
  *)
    echo "Error: Unsupported architecture: ${ARCH}"
    exit 1
    ;;
esac

download() {
  local url="$1"
  local out="$2"
  echo "Downloading: ${url}"
  curl -fL -o "${out}" "${url}"
}

install_appimage() {
  local filename="${APP_NAME}_${VERSION}_${APPIMAGE_ARCH}.AppImage"
  local url="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${filename}"
  local out="${TMP_DIR}/${filename}"
  download "${url}" "${out}"
  local bin_dir="${HOME}/.local/bin"
  local dest="${bin_dir}/${APP_NAME}.AppImage"
  mkdir -p "${bin_dir}"
  mv "${out}" "${dest}"
  chmod +x "${dest}"
  echo "Installed AppImage to ${dest}"
  echo "You can run it with: ${dest}"
}

install_appimage

echo "✅ Installation completed successfully."
