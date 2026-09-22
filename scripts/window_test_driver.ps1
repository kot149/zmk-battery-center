param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [ValidateSet('click', 'quick-reopen', 'close', 'metrics')][string]$Action = 'metrics'
)
$ErrorActionPreference = 'Stop'

if ($Action -eq 'metrics') {
    $all = @(Get-CimInstance Win32_Process)
    $ids = @($ProcessId)
    do {
        $children = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object { [int]$_.ProcessId })
        $ids += $children
    } while ($children.Count -gt 0)
    $processes = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
    [pscustomobject]@{
        processes = $processes.Count
        webviews = @($processes | Where-Object { $_.ProcessName -eq 'msedgewebview2' }).Count
        workingSetBytes = ($processes | Measure-Object WorkingSet64 -Sum).Sum
        privateBytes = ($processes | Measure-Object PrivateMemorySize64 -Sum).Sum
    } | ConvertTo-Json -Compress
    exit
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TrayTestDriver {
    private delegate bool Callback(IntPtr window, IntPtr param);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr param);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    public static bool Close(uint processId) {
        IntPtr main = IntPtr.Zero;
        EnumWindows((window, param) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            var title = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            if (owner == processId && title.ToString() == "zmk-battery-center") main = window;
            return true;
        }, IntPtr.Zero);
        return main != IntPtr.Zero && PostMessage(main, 0x0010, UIntPtr.Zero, IntPtr.Zero);
    }
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam);
    public static bool Click(uint processId) {
        IntPtr tray = IntPtr.Zero;
        EnumWindows((window, param) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            var name = new StringBuilder(256);
            GetClassName(window, name, name.Capacity);
            if (owner == processId && name.ToString() == "tray_icon_app") tray = window;
            return true;
        }, IntPtr.Zero);
        // tray-icon 0.24 uses message 6002 for shell mouse events.
        return tray != IntPtr.Zero && PostMessage(tray, 6002, UIntPtr.Zero, new IntPtr(0x0202));
    }
}
'@
$clickedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
if ($Action -eq 'close') {
    if (-not [TrayTestDriver]::Close([uint32]$ProcessId)) {
        throw "No main window found for process $ProcessId"
    }
} else {
    if (-not [TrayTestDriver]::Click([uint32]$ProcessId)) {
        throw "No tray window found for process $ProcessId"
    }
    if ($Action -eq 'quick-reopen') {
        Start-Sleep -Milliseconds 300
        if (-not [TrayTestDriver]::Click([uint32]$ProcessId)) {
            throw "Failed to reopen main window for process $ProcessId"
        }
    }
}
Write-Output $clickedAt
