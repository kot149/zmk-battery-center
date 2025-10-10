# install-latest.ps1

# エラーが発生したら処理を中断する
$ErrorActionPreference = "Stop"

try {
    # 1. 最新リリースのMSIファイルのURLを取得
    Write-Host "Fetching the latest release information..."
    $apiUrl = "https://api.github.com/repos/kot149/zmk-battery-center/releases/latest"
    $latestRelease = Invoke-RestMethod -Uri $apiUrl
    $asset = $latestRelease.assets | Where-Object { $_.name -like 'zmk-battery-center_*_x64_en-US.msi' }

    if (-not $asset) {
        throw "Could not find the target MSI file in the latest release."
    }

    $url = $asset.browser_download_url

    # 2. 一時ファイルとして保存するパスを定義
    $outFile = Join-Path $env:TEMP "zmk-battery-center.msi"

    # 3. ファイルをダウンロード
    Write-Host "Downloading from $url..."
    Invoke-WebRequest -Uri $url -OutFile $outFile

    # 4. サイレントインストールを実行
    Write-Host "Installing $outFile..."
    Start-Process msiexec.exe -ArgumentList "/i `"$outFile`" /quiet" -Wait

    # 5. 一時ファイルを削除
    Write-Host "Cleaning up..."
    Remove-Item $outFile

    Write-Host "✅ Installation completed successfully."

} catch {
    Write-Error "❌ An error occurred during installation: $($_.Exception.Message)"
    exit 1
}
