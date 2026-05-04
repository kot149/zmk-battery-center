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
RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")"
LATEST_TAG="$(printf '%s\n' "${RELEASE_JSON}" | grep '"tag_name":' | head -1 | sed -E 's/.*"tag_name": "([^"]+)".*/\1/')"

if [[ -z "${LATEST_TAG}" ]]; then
  echo "Error: Could not fetch the latest release tag." >&2
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
aarch64 | arm64)
  DEB_ARCH="arm64"
  RPM_ARCH="aarch64"
  APPIMAGE_ARCH="aarch64"
  ;;
*)
  echo "Error: Unsupported architecture: ${ARCH}" >&2
  exit 1
  ;;
esac

RPM_FILENAME="${APP_NAME}-${VERSION}-1.${RPM_ARCH}.rpm"
DEB_FILENAME="${APP_NAME}_${VERSION}_${DEB_ARCH}.deb"
APPIMAGE_FILENAME="${APP_NAME}_${VERSION}_${APPIMAGE_ARCH}.AppImage"

if [[ ! -c /dev/tty ]] || [[ ! -r /dev/tty ]]; then
  echo "Error: This installer needs an interactive terminal (e.g. run it in a terminal window)." >&2
  exit 1
fi

echo ""
echo "Select package format:"
echo "  1) AppImage  — no sudo; installs to ~/.local/bin/${APP_NAME}.AppImage"
echo "  2) Debian     — sudo; .deb for Debian, Ubuntu, and derivatives"
echo "  3) RPM         — sudo; .rpm for Fedora, RHEL, openSUSE, etc."
echo ""
choice=""
read -r -p "Enter 1–3 [1]: " choice < /dev/tty || true
choice="${choice:-1}"
case "${choice}" in
1) FORMAT="appimage" ;;
2) FORMAT="deb" ;;
3) FORMAT="rpm" ;;
*)
  echo "Error: Invalid choice: ${choice}" >&2
  exit 1
  ;;
esac

download() {
  local url="$1"
  local out="$2"
  echo "Downloading: ${url}"
  curl -fsSL -o "${out}" "${url}"
}

release_url() {
  local filename="$1"
  echo "https://github.com/${REPO}/releases/download/${LATEST_TAG}/${filename}"
}

install_appimage() {
  local out="${TMP_DIR}/${APPIMAGE_FILENAME}"
  download "$(release_url "${APPIMAGE_FILENAME}")" "${out}"
  local bin_dir="${HOME}/.local/bin"
  local dest="${bin_dir}/${APP_NAME}.AppImage"
  mkdir -p "${bin_dir}"
  mv "${out}" "${dest}"
  chmod +x "${dest}"
  echo "Installed AppImage to ${dest}"
  echo "Run: ${dest}"
}

install_deb() {
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Error: apt-get not found. Install on Debian/Ubuntu, or choose AppImage/RPM for other systems." >&2
    exit 1
  fi
  local out="${TMP_DIR}/${DEB_FILENAME}"
  download "$(release_url "${DEB_FILENAME}")" "${out}"
  echo "Installing .deb (requires sudo)..."
  sudo apt-get install -y "${out}"
  echo "Installed Debian package. Look for ${APP_NAME} in your app menu, or run: ${APP_NAME}"
}

install_rpm() {
  local out="${TMP_DIR}/${RPM_FILENAME}"
  download "$(release_url "${RPM_FILENAME}")" "${out}"
  echo "Installing .rpm (requires sudo)..."
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y "${out}"
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y "${out}"
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper --non-interactive install -y "${out}"
  elif command -v rpm >/dev/null 2>&1; then
    sudo rpm -Uvh "${out}"
  else
    echo "Error: No supported RPM installer found (dnf, yum, zypper, or rpm)." >&2
    exit 1
  fi
  echo "Installed RPM package. Look for ${APP_NAME} in your app menu, or run: ${APP_NAME}"
}

case "${FORMAT}" in
appimage) install_appimage ;;
deb) install_deb ;;
rpm) install_rpm ;;
esac

echo "✅ Installation completed successfully."
