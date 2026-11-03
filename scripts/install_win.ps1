# Stop on error
$ErrorActionPreference = "Stop"
$tmpDir = $null

# Older Windows PowerShell versions may have TLS 1.2 disabled by default,
# which would make the GitHub API calls below fail
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

try {
    # Detect the system architecture to select the matching installer
    # PROCESSOR_ARCHITEW6432 is set when the script runs as x86 under WoW64
    $procArch = $env:PROCESSOR_ARCHITEW6432
    if (-not $procArch) {
        $procArch = $env:PROCESSOR_ARCHITECTURE
    }
    $msiArch = switch ($procArch) {
        "AMD64" { "x64" }
        "ARM64" { "arm64" }
        default { throw "Unsupported system architecture: $procArch. Please install manually from the Releases page." }
    }

    # Get the URL of the latest MSI file for this architecture
    Write-Host "Fetching the latest release information..."
    $apiUrl = "https://api.github.com/repos/kot149/zmk-battery-center/releases/latest"
    $latestRelease = Invoke-RestMethod -Uri $apiUrl
    $asset = $latestRelease.assets | Where-Object { $_.name -like "zmk-battery-center_*_${msiArch}_en-US.msi" }

    if (-not $asset) {
        throw "Could not find the ${msiArch} MSI file in the latest release."
    }

    $url = $asset.browser_download_url

    # Download the file to a private temporary directory
    $tmpDir = Join-Path $env:TEMP ("zmk-battery-center-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmpDir | Out-Null
    $outFile = Join-Path $tmpDir "zmk-battery-center.msi"
    Write-Host "Downloading from $url..."
    Invoke-WebRequest -Uri $url -OutFile $outFile

    $digest = [string]$asset.digest
    if ($digest) {
        if ($digest -notmatch '^sha256:[0-9a-fA-F]{64}$') {
            throw "Unsupported digest for $($asset.name)."
        }
        $expectedHash = $digest.Substring(7).ToLowerInvariant()
        $actualHash = (Get-FileHash -Algorithm SHA256 -Path $outFile).Hash.ToLowerInvariant()
        if ($expectedHash -ne $actualHash) {
            throw "Checksum mismatch for $($asset.name). Aborting."
        }
        Write-Host "Checksum verified."
    } else {
        throw "No SHA-256 digest available for $($asset.name)."
    }

    # Execute the silent installation as admin
    Write-Host "Installing $outFile..."
    $installProcess = Start-Process msiexec.exe -ArgumentList "/i `"$outFile`" /quiet" -Wait -PassThru -Verb RunAs
    if ($installProcess.ExitCode -notin @(0, 3010)) {
        throw "MSI installation failed with exit code $($installProcess.ExitCode)."
    }

    $installedLocation = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
    ) |
        ForEach-Object { Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue } |
        Where-Object { $_.DisplayName -like "zmk-battery-center*" -and $_.InstallLocation } |
        Select-Object -First 1 -ExpandProperty InstallLocation

    Write-Host "✅ Installation completed successfully."
    if ($installedLocation) {
        Write-Host "Installed to: $installedLocation"
    } else {
        Write-Host "The app is available from the Start menu."
    }

} catch {
    Write-Error "❌ An error occurred during installation: $($_.Exception.Message)"
    exit 1
} finally {
    if ($tmpDir -and (Test-Path -LiteralPath $tmpDir)) {
        Write-Host "Cleaning up..."
        Remove-Item -LiteralPath $tmpDir -Recurse -Force
    }
    Write-Host "Done."
}
