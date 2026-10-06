param([string]$InterfaceAlias = 'WLAN', [int]$StartDelaySeconds = 0, [string]$ReconnectConfigPath = '')
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$evidenceRoot = Join-Path $projectRoot 'output/b8'
$reportFile = Join-Path $evidenceRoot 'system_offline_report.json'
$netsh = Join-Path $env:SystemRoot 'System32/netsh.exe'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$shellExe = (Get-Command pwsh -ErrorAction Stop).Source
$physical = @(Get-NetAdapter -Physical)
$active = @($physical | Where-Object Status -eq 'Up')
if ($active.Count -ne 1 -or $active[0].Name -ne $InterfaceAlias) { throw '只支持唯一活动 Wi-Fi 接口，避免影响其他网络连接' }
Add-Type -Path (Join-Path $PSScriptRoot 'WlanRadio.cs')
$wifiGuid = [Guid]$active[0].InterfaceGuid
$originalRadio = [B8WlanRadio]::Read($wifiGuid)
if (Test-Path -LiteralPath (Join-Path $evidenceRoot 'installed-app')) { throw '请先完成原生保存复验并卸载测试应用' }
if ($ReconnectConfigPath) {
    $reconnectConfig = Get-Content -LiteralPath $ReconnectConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($reconnectConfig.interface -ne $InterfaceAlias) { throw '重连配置的接口不匹配' }
    $wifiProfile = $reconnectConfig.profile
    $originalMode = $reconnectConfig.connection_mode
    if ($originalMode -notin @('auto', 'manual')) { throw '缺少原无线连接模式，不能保证还原' }
} else {
$wifiInfo = & $netsh wlan show interfaces 2>&1
$profileNames = @($wifiInfo | ForEach-Object { if ($_ -match '^\s*(?:Profile|配置文件)\s*:\s*(.+)\s*$') { $Matches[1].Trim() } })
if ($LASTEXITCODE -eq 0 -and $profileNames.Count -eq 1) { $wifiProfile = $profileNames[0] }
else {
    # 无窗口子进程的 netsh 本地化输出可能使用 OEM 编码；用 Unicode API 补充。
    $connections = @(Get-NetConnectionProfile -InterfaceAlias $InterfaceAlias)
    if ($connections.Count -ne 1) { throw '当前无线配置无法确定，不断开网络' }
    $wifiProfile = $connections[0].Name
}
}
$profileCheck = & $netsh wlan show profile "name=$wifiProfile" "interface=$InterfaceAlias" 2>&1
if ($LASTEXITCODE -ne 0) { throw '重连配置不可用，不断开网络' }
if (-not $originalMode) {
    $modeLine = ($profileCheck | Where-Object { $_ -match '^\s*Connection mode\s*:' }) -join ''
    if ($modeLine -match 'automatically') { $originalMode = 'auto' }
    elseif ($modeLine -match 'manually') { $originalMode = 'manual' }
    else { throw '无法备份原无线连接模式，不断开网络' }
}
$report = [ordered]@{ passed = $false; method = 'WlanSetInterface software radio off + netsh reconnect; all physical NICs checked'
    interface = $InterfaceAlias; started_at = (Get-Date -Format o); restored = $false
    system_network_disconnected = $false; phases = @(); error = $null }
$monitorStop = Join-Path $evidenceRoot 'network_monitor_done.flag'
if (Test-Path -LiteralPath $monitorStop) { Remove-Item -LiteralPath $monitorStop }
function Assert-Disconnected([string]$Phase) {
    $adapters = @(Get-NetAdapter -Physical | Select-Object Name, Status)
    if (-not $adapters.Count -or @($adapters | Where-Object Status -eq 'Up').Count) { throw "物理网络未断开：$Phase" }
    $report.phases += @{ phase = $Phase; timestamp = (Get-Date -Format o); physical_adapters = $adapters }
}
function Run-CheckedChild([string]$Exe, [string]$Arguments, [string]$Label, [int]$Timeout = 45000) {
    $stdoutFile = Join-Path $evidenceRoot "$Label.stdout.log"
    $stderrFile = Join-Path $evidenceRoot "$Label.stderr.log"
    $child = Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
    if (-not $child.WaitForExit($Timeout)) { $child.Kill($true); throw "$Label 超时" }
    if ($child.ExitCode -ne 0) { throw "$Label 退出码 $($child.ExitCode)，见验收日志" }
}
if ($StartDelaySeconds -gt 0) { Start-Sleep -Seconds $StartDelaySeconds }
$monitor = $null
$changedMode = $false
$radioAttempted = $false
try {
    # Windows 会自动重连当前配置；临时改为手动连接，finally 恢复原值。
    $modeOutput = & $netsh wlan set profileparameter "name=$wifiProfile" "interface=$InterfaceAlias" 'connectionmode=manual' 2>&1
    if ($LASTEXITCODE -ne 0) { throw '无法暂停 Wi-Fi 自动重连，未执行断网验证' }
    $changedMode = $true
    $radioAttempted = $true
    for ($phy = 0; $phy -lt $originalRadio.Length; $phy += 3) {
        $errorCode = [B8WlanRadio]::Set($wifiGuid, $originalRadio[$phy], 2)
        if ($errorCode -ne 0) { throw "Wi-Fi 软件射频关闭被拒绝，Windows 错误 $errorCode" }
    }
    $disconnectOutput = & $netsh wlan disconnect "interface=$InterfaceAlias" 2>&1
    if ($LASTEXITCODE -ne 0) { throw '无线断开命令被系统拒绝；未取得系统断网证据' }
    Start-Sleep -Seconds 2
    Assert-Disconnected 'before_install'
    $report.system_network_disconnected = $true
    $monitor = Start-Job -ArgumentList $monitorStop -ScriptBlock {
        param($StopFile)
        while (-not (Test-Path -LiteralPath $StopFile)) {
            $adapters = @(Get-NetAdapter -Physical | Select-Object Name, Status)
            @{ timestamp = (Get-Date -Format o); all_physical_disconnected = ($adapters.Count -gt 0 -and @($adapters | Where-Object Status -eq 'Up').Count -eq 0); adapters = $adapters }
            Start-Sleep -Milliseconds 500
        }
    }
    $env:B8_SYSTEM_OFFLINE = '1'
    Run-CheckedChild $shellExe '-NoProfile -File scripts/verify_install.ps1 -Action install' 'offline_install'
    Assert-Disconnected 'after_install'
    Run-CheckedChild $nodeExe 'scripts/verify_installed.js' 'offline_gui' 60000
    Assert-Disconnected 'after_gui_export'
    Run-CheckedChild $shellExe '-NoProfile -File scripts/verify_install.ps1 -Action uninstall' 'offline_uninstall'
    Assert-Disconnected 'after_uninstall'
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
} finally {
    Set-Content -LiteralPath $monitorStop -Value 'done' -Encoding utf8
    if ($monitor) {
        $null = Wait-Job $monitor -Timeout 15
        $samples = @(Receive-Job $monitor)
        $report.monitor_samples = $samples
        $report.continuous_physical_disconnect = ($samples.Count -gt 0 -and @($samples | Where-Object { -not $_.all_physical_disconnected }).Count -eq 0)
        if (-not $report.continuous_physical_disconnect) { $report.passed = $false; $report.error = ($report.error + '；网络监测未能证明全流程持续断开').TrimStart('；') }
        Remove-Job $monitor -Force
    }
    Remove-Item Env:/B8_SYSTEM_OFFLINE -ErrorAction SilentlyContinue
    # 不改变无线配置/连接模式；无论验收结果如何，都回到原有配置。
    if ($radioAttempted) {
        $report.radio_restored = $true
        for ($phy = 0; $phy -lt $originalRadio.Length; $phy += 3) {
            if ([B8WlanRadio]::Set($wifiGuid, $originalRadio[$phy], $originalRadio[$phy + 1]) -ne 0) { $report.radio_restored = $false }
        }
        if (-not $report.radio_restored) { $report.passed = $false; $report.error += '；原软件射频状态未恢复' }
    }
    if ($changedMode) {
        $restoreModeOutput = & $netsh wlan set profileparameter "name=$wifiProfile" "interface=$InterfaceAlias" "connectionmode=$originalMode" 2>&1
        $report.connection_mode_restored = ($LASTEXITCODE -eq 0)
        $report.original_connection_mode = $originalMode
        if (-not $report.connection_mode_restored) { $report.passed = $false; $report.error += '；原连接模式未恢复' }
    }
    for ($retry = 0; $retry -lt 5; $retry++) {
        $connectOutput = & $netsh wlan connect "name=$wifiProfile" "interface=$InterfaceAlias" 2>&1
        Start-Sleep -Seconds 3
        if ((Get-NetAdapter -Name $InterfaceAlias).Status -eq 'Up') { $report.restored = $true; break }
    }
    $report.finished_at = (Get-Date -Format o)
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportFile -Encoding utf8
    if ($ReconnectConfigPath -and [IO.Path]::GetFullPath($ReconnectConfigPath).StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $ReconnectConfigPath -ErrorAction SilentlyContinue
    }
}
if (-not $report.restored) { throw 'Wi-Fi 未自动恢复，请按原有无线配置手动连接' }
if (-not $report.passed) { throw $report.error }
Write-Output '系统断网验收通过：安装 → 启动 → 十段集字 → 候选切换 → PNG 导出 → 卸载；Wi-Fi 已恢复。'
