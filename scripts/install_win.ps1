# Stop on error
$ErrorActionPreference = "Stop"
$tmpDir = $null

try {
    # Get the URL of the latest MSI file
    Write-Host "Fetching the latest release information..."
    $apiUrl = "https://api.github.com/repos/kot149/zmk-battery-center/releases/latest"
    $latestRelease = Invoke-RestMethod -Uri $apiUrl
    $asset = $latestRelease.assets | Where-Object { $_.name -like 'zmk-battery-center_*_x64_en-US.msi' }

    if (-not $asset) {
        throw "Could not find the target MSI file in the latest release."
    }

    $url = $asset.browser_download_url

    # Download the file to a private temporary directory
    $tmpDir = Join-Path $env:TEMP ("zmk-battery-center-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmpDir | Out-Null
    $outFile = Join-Path $tmpDir "zmk-battery-center.msi"
    Write-Host "Downloading from $url..."
    Invoke-WebRequest -Uri $url -OutFile $outFile

    $sumsAsset = $latestRelease.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }
    if ($sumsAsset) {
        $sumsFile = Join-Path $tmpDir "SHA256SUMS.txt"
        Invoke-WebRequest -Uri $sumsAsset.browser_download_url -OutFile $sumsFile
        $expectedLine = Get-Content $sumsFile | Where-Object { $_ -match [regex]::Escape($asset.name) + '$' }
        if (-not $expectedLine) {
            throw "$($asset.name) not found in SHA256SUMS.txt."
        }
        $expectedHash = ($expectedLine -split '\s+')[0].ToLowerInvariant()
        $actualHash = (Get-FileHash -Algorithm SHA256 -Path $outFile).Hash.ToLowerInvariant()
        if ($expectedHash -ne $actualHash) {
            throw "Checksum mismatch for $($asset.name). Aborting."
        }
        Write-Host "Checksum verified."
    } else {
        Write-Warning "SHA256SUMS.txt not available for this release; skipping integrity check."
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
