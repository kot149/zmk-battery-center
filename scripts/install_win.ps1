# Stop on error
$ErrorActionPreference = "Stop"

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

    # Download the file to a temporary file
    $outFile = Join-Path $env:TEMP "zmk-battery-center.msi"
    Write-Host "Downloading from $url..."
    Invoke-WebRequest -Uri $url -OutFile $outFile

    # Execute the silent installation
    Write-Host "Installing $outFile..."
    Start-Process msiexec.exe -ArgumentList "/i `"$outFile`" /quiet" -Wait

    # Delete the temporary file
    Write-Host "Cleaning up..."
    Remove-Item $outFile

    Write-Host "✅ Installation completed successfully."

} catch {
    Write-Error "❌ An error occurred during installation: $($_.Exception.Message)"
    exit 1
}
