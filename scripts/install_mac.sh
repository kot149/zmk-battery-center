#!/bin/bash
set -e

REPO="kot149/zmk-battery-center"
APP_NAME="zmk-battery-center.app"
DEST_PATH="/Applications"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "Starting zmk-battery-center installation..."

# Get the latest version tag from GitHub API
echo "Fetching the latest version..."
LATEST_VERSION=$(curl -sL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/')

if [ -z "$LATEST_VERSION" ]; then
    echo "Error: Could not fetch the latest version."
    exit 1
fi
echo "Latest version: ${LATEST_VERSION}"

# Determine system architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    echo "Detected architecture: Apple Silicon (aarch64)"
    ARCH_SUFFIX="aarch64"
elif [ "$ARCH" = "x86_64" ]; then
    echo "Detected architecture: Intel (x64)"
    ARCH_SUFFIX="x64"
else
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
fi

# Download the archive file.
# Releases built with tauri-action v1+ include the version in the filename;
# older releases do not, so fall back to the unversioned name.
ARCHIVE_FILENAME=""
ARCHIVE_TMP_PATH=""
for candidate in \
    "zmk-battery-center_${LATEST_VERSION}_${ARCH_SUFFIX}.app.tar.gz" \
    "zmk-battery-center_${ARCH_SUFFIX}.app.tar.gz"; do
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${LATEST_VERSION}/${candidate}"
    echo "Downloading: ${DOWNLOAD_URL}"
    if curl -fL -o "${TMP_DIR}/${candidate}" "${DOWNLOAD_URL}"; then
        ARCHIVE_FILENAME="${candidate}"
        ARCHIVE_TMP_PATH="${TMP_DIR}/${candidate}"
        break
    fi
    echo "Not found, trying next filename..."
done

if [ -z "${ARCHIVE_FILENAME}" ]; then
    echo "Error: Could not download the app archive for v${LATEST_VERSION} (${ARCH_SUFFIX})." >&2nt
    exit 1
fi

# Verify archive integrity when the release publishes checksums
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/v${LATEST_VERSION}/SHA256SUMS.txt"
CHECKSUMS_PATH="${TMP_DIR}/SHA256SUMS.txt"
if curl -fsSL -o "${CHECKSUMS_PATH}" "${CHECKSUMS_URL}"; then
    EXPECTED_HASH=$(grep " ${ARCHIVE_FILENAME}\$" "${CHECKSUMS_PATH}" | awk '{print $1}')
    if [ -z "${EXPECTED_HASH}" ]; then
        echo "Error: ${ARCHIVE_FILENAME} not found in SHA256SUMS.txt." >&2
        exit 1
    fi
    ACTUAL_HASH=$(shasum -a 256 "${ARCHIVE_TMP_PATH}" | awk '{print $1}')
    if [ "${EXPECTED_HASH}" != "${ACTUAL_HASH}" ]; then
        echo "Error: checksum mismatch for ${ARCHIVE_FILENAME}. Aborting." >&2
        exit 1
    fi
    echo "Checksum verified."
else
    echo "Warning: SHA256SUMS.txt not available for this release; skipping integrity check."
fi

# Extract the archive and install the application
echo "Extracting archive..."
tar -xzf "${ARCHIVE_TMP_PATH}" -C "${TMP_DIR}"

# Check if the .app was extracted correctly
EXTRACTED_APP_PATH="${TMP_DIR}/${APP_NAME}"
if [ -d "${EXTRACTED_APP_PATH}" ]; then
    echo "Installing ${APP_NAME} to ${DEST_PATH}..."
    # Remove the old version if it exists
    if [ -d "${DEST_PATH}/${APP_NAME}" ]; then
        echo "Removing existing version..."
        sudo rm -rf "${DEST_PATH}/${APP_NAME}"
    fi
    # Move the new version into the Applications folder
    sudo mv "${EXTRACTED_APP_PATH}" "${DEST_PATH}/"
    echo "Installation complete."
else
    echo "Error: Failed to extract ${APP_NAME} from the archive." >&2
    exit 1
fi

echo "✅ Installation completed successfully."
