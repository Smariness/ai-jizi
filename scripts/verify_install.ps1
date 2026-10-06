param([ValidateSet('install', 'inspect', 'uninstall')][string]$Action = 'install')
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$evidenceRoot = Join-Path $projectRoot 'output/b8'
$installRoot = [IO.Path]::GetFullPath((Join-Path $evidenceRoot 'installed-app'))
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$installer = Join-Path $projectRoot "dist/AI-Jizi-Placeholder-Setup-$($package.version)-x64.exe"
$application = Join-Path $installRoot 'AI-Jizi.exe'
$asarFile = Join-Path $installRoot 'resources/app.asar'
$reportPath = Join-Path $evidenceRoot 'install_report.json'
$productName = '集字工作台（占位版）'
$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) "$productName.lnk"),
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) "Programs/$productName.lnk")
)
function Find-Registration {
    @(Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/*' -ErrorAction SilentlyContinue |
        Where-Object { $_.PSChildName -eq 'e3f2c2f4-e88d-4f9f-8f9a-b8aeae1a0021' })
}
function Assert-OwnedDirectory {
    if (-not $installRoot.StartsWith($evidenceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw '测试安装目录越界'
    }
    if (Test-Path -LiteralPath $installRoot) {
        $item = Get-Item -LiteralPath $installRoot
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '测试安装目录不能为链接或 junction' }
        if ((Resolve-Path -LiteralPath $installRoot).Path -ne $installRoot) { throw '安装目录解析异常' }
    }
}
Assert-OwnedDirectory
$systemOffline = $env:B8_SYSTEM_OFFLINE -eq '1'
if ($systemOffline) {
    $physical = @(Get-NetAdapter -Physical)
    if (-not $physical.Count -or @($physical | Where-Object Status -eq 'Up').Count) { throw '系统断网验收要求所有物理网络接口断开' }
}
if ($Action -ne 'uninstall') {
    $installerExitCode = $null
    if ($Action -eq 'install') {
    if ((Find-Registration).Count -or (Test-Path -LiteralPath $installRoot) -or
        @($shortcutPaths | Where-Object { Test-Path -LiteralPath $_ }).Count) {
        throw '存在已有安装或同名快捷方式；不覆盖用户安装'
    }
    # 完整 NSIS 包，不使用 nsis-web。代理仅作用于本次安装进程，不改变系统设置。
    $oldProxy = @{}
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) {
        $oldProxy[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, 'http://127.0.0.1:9', 'Process')
    }
    try {
        $process = Start-Process -FilePath $installer -ArgumentList "/S /currentuser /D=$installRoot" -WindowStyle Hidden -PassThru -Wait
        if ($process.ExitCode -ne 0) { throw "安装退出码：$($process.ExitCode)" }
        $installerExitCode = $process.ExitCode
    } finally {
        foreach ($name in $oldProxy.Keys) { [Environment]::SetEnvironmentVariable($name, $oldProxy[$name], 'Process') }
    }
    }
    Assert-OwnedDirectory
    if (-not (Test-Path -LiteralPath $application)) { throw '安装后找不到应用' }
    $expectedAsar = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $projectRoot 'dist/win-unpacked/resources/app.asar')).Hash
    $installedAsar = (Get-FileHash -Algorithm SHA256 -LiteralPath $asarFile).Hash
    if ($installedAsar -ne $expectedAsar) { throw '安装后的 asar 与构建产物不一致' }
    $registration = Find-Registration
    if ($registration.Count -ne 1) { throw '应有唯一的当前用户卸载注册项' }
    $uninstallerPath = Join-Path $installRoot 'Uninstall AI-Jizi.exe'
    if (-not $registration[0].UninstallString.StartsWith('"' + $uninstallerPath + '"')) { throw '注册项卸载路径不匹配' }
    $shell = New-Object -ComObject WScript.Shell
    $shortcuts = @($shortcutPaths | ForEach-Object {
        if (-not (Test-Path -LiteralPath $_)) { throw "缺快捷方式：$_" }
        $shortcut = $shell.CreateShortcut($_)
        if ($shortcut.TargetPath -ne $application) { throw "快捷方式指向错误：$_" }
        @{ path = $_; target = $shortcut.TargetPath }
    })
    $report = [ordered]@{
        passed = $true; action = $Action; timestamp = (Get-Date -Format o)
        installer = $installer; installer_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant()
        install_root = $installRoot; application = $application; exit_code = $installerExitCode
        current_user_only = $true; installed_asar_sha256 = $installedAsar.ToLowerInvariant()
        asar_matches_build = $true; registration_key = $registration[0].PSPath
        uninstall_command = $registration[0].UninstallString; shortcuts = $shortcuts
        installer_type = 'full NSIS, not nsis-web'; process_proxy = '127.0.0.1:9'
        system_network_disconnected = $systemOffline
    }
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
    Write-Output "安装通过：$application；asar 相同，注册项与两处快捷方式正确。"
} else {
    $installed = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    if ($installed.install_root -ne $installRoot -or -not $installed.passed) { throw '缺少本次安装所有权记录' }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $asarFile).Hash.ToLowerInvariant() -ne $installed.installed_asar_sha256) { throw '安装内容已变化，停止自动卸载' }
    $running = @(Get-Process -Name AI-Jizi -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $application })
    if ($running.Count) { throw '请先正常关闭测试应用，再卸载' }
    $uninstallers = @(Get-ChildItem -LiteralPath $installRoot -Filter 'Uninstall*.exe' -File)
    if ($uninstallers.Count -ne 1) { throw '应有唯一卸载程序' }
    $process = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList '/S /currentuser' -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "卸载退出码：$($process.ExitCode)" }
    # NSIS 卸载器会复制到临时目录后退出；等待子进程完成清理。
    for ($attempt = 0; $attempt -lt 60 -and (Test-Path -LiteralPath $application); $attempt++) { Start-Sleep -Milliseconds 500 }
    if ((Test-Path -LiteralPath $application) -or (Test-Path -LiteralPath $asarFile)) { throw '卸载未移除应用文件' }
    if ((Find-Registration).Count) { throw '卸载注册项仍在' }
    if (@($shortcutPaths | Where-Object { Test-Path -LiteralPath $_ }).Count) { throw '卸载快捷方式仍在' }
    $exportFile = Join-Path $evidenceRoot 'installed_export.png'
    if (-not (Test-Path -LiteralPath $exportFile)) { throw '用户导出图未保留' }
    [ordered]@{
        passed = $true; action = 'uninstall'; timestamp = (Get-Date -Format o)
        install_root = $installRoot; exit_code = $process.ExitCode
        application_removed = $true; asar_removed = $true; registration_removed = $true
        shortcuts_removed = $true; export_preserved = $true
        export_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $exportFile).Hash.ToLowerInvariant()
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'uninstall_report.json') -Encoding utf8
    Write-Output '卸载通过：应用文件、注册项与快捷方式清除，导出作品保留。'
}
