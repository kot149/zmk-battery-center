#!/bin/bashsh -c "$(curl -fsSL https://raw.githubusercontent.com/kot149/zmk-battery-center/main/scripts/install_mac.sh)"
set -e

REPO="kot149/zmk-battery-center"
APP_NAME="zmk-battery-center.app"
DEST_PATH="/Applications"
TMP_DIR="/tmp"

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

# Download the archive file
ARCHIVE_FILENAME="zmk-battery-center_${ARCH_SUFFIX}.app.tar.gz"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${LATEST_VERSION}/${ARCHIVE_FILENAME}"
ARCHIVE_TMP_PATH="${TMP_DIR}/${ARCHIVE_FILENAME}"

echo "Downloading: ${DOWNLOAD_URL}"
curl -L -o "${ARCHIVE_TMP_PATH}" "${DOWNLOAD_URL}"

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
    echo "Error: Failed to extract ${APP_NAME} from the archive."
fi

# Clean up
echo "Cleaning up..."
rm -f "${ARCHIVE_TMP_PATH}"

echo "✅ Installation completed successfully."
