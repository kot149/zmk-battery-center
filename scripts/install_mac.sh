#!/bin/bash
set -e

REPO="kot149/zmk-battery-center"
APP_NAME="zmk-battery-center.app"
DEST_PATH="/Applications"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "Starting zmk-battery-center installation..."

# Get the latest release from GitHub API
echo "Fetching the latest version..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
LATEST_VERSION=$(printf '%s\n' "${RELEASE_JSON}" | grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/')

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
    echo "Error: Could not download the app archive for v${LATEST_VERSION} (${ARCH_SUFFIX})." >&2
    exit 1
fi

# Verify archive integrity using the release asset digest
verify_checksum() {
    local file_path="$1"
    local filename="$2"
    local asset_digest
    asset_digest=$(
        printf '%s\n' "${RELEASE_JSON}" |
            awk -v filename="${filename}" '
                { json = json "\n" $0 }
                END {
                    for (i = 1; i <= length(json); i++) {
                        character = substr(json, i, 1)
                        if (in_string) {
                            if (escaped) {
                                token = token character
                                escaped = 0
                            } else if (character == "\\") {
                                escaped = 1
                            } else if (character == "\"") {
                                in_string = 0
                                next_character = i + 1
                                while (substr(json, next_character, 1) ~ /[[:space:]]/) next_character++
                                if (substr(json, next_character, 1) == ":") {
                                    key[depth] = token
                                } else if (key[depth] != "") {
                                    if (key[depth] == "name") name[depth] = token
                                    if (key[depth] == "digest") digest[depth] = token
                                    delete key[depth]
                                }
                            } else {
                                token = token character
                            }
                            continue
                        }
                        if (character == "\"") {
                            in_string = 1
                            token = ""
                        } else if (character == "{") {
                            depth++
                            delete key[depth]
                            delete name[depth]
                            delete digest[depth]
                        } else if (character == "}") {
                            if (name[depth] == filename) {
                                print digest[depth]
                                exit
                            }
                            delete key[depth]
                            delete name[depth]
                            delete digest[depth]
                            depth--
                        } else if (character == ",") {
                            delete key[depth]
                        }
                    }
                }
            '
    )
    if ! printf '%s\n' "${asset_digest}" | grep -Eq '^sha256:[0-9a-fA-F]{64}$'; then
        echo "Error: no valid SHA-256 digest available for ${filename}." >&2
        return 1
    fi

    local expected_hash
    expected_hash=$(printf '%s\n' "${asset_digest#sha256:}" | tr '[:upper:]' '[:lower:]')
    local actual_hash
    actual_hash=$(shasum -a 256 "${file_path}" | awk '{print $1}')
    if [ "${expected_hash}" != "${actual_hash}" ]; then
        echo "Error: checksum mismatch for ${filename}. Aborting." >&2
        exit 1
    fi
    echo "Checksum verified."
}

verify_checksum "${ARCHIVE_TMP_PATH}" "${ARCHIVE_FILENAME}"

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
    INSTALLED_APP_PATH="${DEST_PATH}/${APP_NAME}"
    echo "Installation complete."
    echo "Installed to: ${INSTALLED_APP_PATH}"
else
    echo "Error: Failed to extract ${APP_NAME} from the archive." >&2
    exit 1
fi

echo "✅ Installation completed successfully."
