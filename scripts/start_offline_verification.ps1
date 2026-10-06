param([string]$InterfaceAlias = 'WLAN')
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$evidenceRoot = Join-Path $projectRoot 'output/b8'
if (Test-Path -LiteralPath (Join-Path $evidenceRoot 'installed-app')) { throw '请先关闭并卸载本项目的验收安装版' }
if (Test-Path 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/e3f2c2f4-e88d-4f9f-8f9a-b8aeae1a0021') { throw '存在同产品安装，不自动覆盖' }
$info = & netsh wlan show interfaces 2>&1
$profiles = @($info | ForEach-Object { if ($_ -match '^\s*(?:Profile|配置文件)\s*:\s*(.+)\s*$') { $Matches[1].Trim() } })
if ($LASTEXITCODE -ne 0 -or $profiles.Count -ne 1) { throw '无法确定唯一的无线重连配置，不执行断网' }
$profileInfo = & netsh wlan show profile "name=$($profiles[0])" "interface=$InterfaceAlias" 2>&1
$modeLine = ($profileInfo | Where-Object { $_ -match '^\s*(?:Connection mode|连接模式)\s*:' }) -join ''
if ($LASTEXITCODE -ne 0) { throw '无法查询原连接模式，不执行断网' }
if ($modeLine -match 'automatically|自动') { $mode = 'auto' }
elseif ($modeLine -match 'manually|手动') { $mode = 'manual' }
else { throw '无法备份连接模式，不执行断网' }
# 配置名只放临时文件，验收报告不记录 SSID、密码或无线配置名。
$configPath = Join-Path ([IO.Path]::GetTempPath()) ('ai-jizi-b8-wifi-' + [guid]::NewGuid().ToString('N') + '.json')
@{ interface = $InterfaceAlias; profile = $profiles[0]; connection_mode = $mode } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
$workerScript = Join-Path $PSScriptRoot 'verify_system_offline.ps1'
if ($workerScript.Contains('"') -or $configPath.Contains('"') -or $InterfaceAlias -notmatch '^[\p{L}\p{N}_ -]+$') { throw '参数含不支持的字符' }
$workerArgs = '-NoProfile -File "' + $workerScript + '" -InterfaceAlias "' + $InterfaceAlias + '" -StartDelaySeconds 5 -ReconnectConfigPath "' + $configPath + '"'
$worker = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList $workerArgs -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $evidenceRoot 'system_offline.stdout.log') -RedirectStandardError (Join-Path $evidenceRoot 'system_offline.stderr.log')
$worker.Id | Set-Content -LiteralPath (Join-Path $evidenceRoot 'system_offline_worker.pid') -Encoding utf8
Write-Output "5 秒后开始系统断网验证，worker PID $($worker.Id)；原无线状态将在 finally 恢复。"
Write-Output (Join-Path $evidenceRoot 'system_offline_report.json')
