<#
Aether engine on a Windows dev box via Task Scheduler.

  powershell -ExecutionPolicy Bypass -File deploy\windows_tasks.ps1            # register (DRY_RUN per engine\.env)
  powershell -ExecutionPolicy Bypass -File deploy\windows_tasks.ps1 -Remove    # unregister all
  powershell -ExecutionPolicy Bypass -File deploy\windows_tasks.ps1 -Status    # show last run / result

Tasks (current user, only while logged on, no stored password):
  Aether\Executor  every 1 min        python -m aether.cli execute   (100 s limit < 110 s lease TTL)
  Aether\Signals   every 15 min from :01  python -m aether.cli signals
  Aether\Monitor   every 5 min        python scripts\monitor_run.py
  Aether\Fees      hourly at :07      python -m aether.cli fees
  Aether\Prune     daily              python scripts\monitor_prune.py (account_snapshots retention)

Secrets: read by the engine from engine\.env (python-dotenv) at run time. Nothing is stored in
the task definition. Keep engine\.env out of git and synced folders.
Logs: engine\logs\<task>.log (appended).
#>
param(
    [switch]$Remove,
    [switch]$Status,
    [switch]$Live,      # omit = every task runs with DRY_RUN=true, HYPERLIQUID_LIVE_CONFIRMED=false
    [string]$Python = ""
)
$ErrorActionPreference = "Stop"
$Root   = Split-Path -Parent $PSScriptRoot
$Engine = Join-Path $Root "engine"
$Logs   = Join-Path $Engine "logs"
$Folder = "\Aether\"

if (-not $Python) {
    $venv = Join-Path $Engine ".venv\Scripts\python.exe"
    if (Test-Path $venv) { $Python = $venv } else { $Python = (Get-Command python).Source }
}

$Tasks = @(
    @{ Name = "Executor"; Args = "-m aether.cli execute";  Every = 1;  Offset = 0; Limit = 100 },
    @{ Name = "Signals";  Args = "-m aether.cli signals";  Every = 15; Offset = 1; Limit = 600 },
    @{ Name = "Monitor";  Args = "scripts\monitor_run.py"; Every = 5;  Offset = 0; Limit = 120 },
    @{ Name = "Fees";     Args = "-m aether.cli fees";     Every = 60; Offset = 7; Limit = 600 },
    @{ Name = "Prune";    Args = "scripts\monitor_prune.py"; Every = 1440; Offset = 17; Limit = 600 }
)

if ($Status) {
    Get-ScheduledTask -TaskPath $Folder -ErrorAction SilentlyContinue | ForEach-Object {
        $i = $_ | Get-ScheduledTaskInfo
        "{0,-10} last={1}  result={2}  next={3}" -f $_.TaskName, $i.LastRunTime, $i.LastTaskResult, $i.NextRunTime
    }
    return
}

foreach ($t in $Tasks) {
    try { Unregister-ScheduledTask -TaskName $t.Name -TaskPath $Folder -Confirm:$false -ErrorAction Stop } catch {}
}
if ($Remove) { "Removed Aether tasks."; return }

New-Item -ItemType Directory -Force $Logs | Out-Null
$now = Get-Date

foreach ($t in $Tasks) {
    $log = Join-Path $Logs ("{0}.log" -f $t.Name.ToLower())
    # cmd /c so stdout+stderr append to the log; working dir = engine\ so `aether` imports and .env loads.
    # Gates forced off in the task's own env (python-dotenv never overrides it) unless -Live.
    $gates = if ($Live) { "" } else { "set DRY_RUN=true&& set HYPERLIQUID_LIVE_CONFIRMED=false&& " }
    $cmd = "/c `"$gates`"$Python`" $($t.Args) >> `"$log`" 2>&1`""
    $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmd -WorkingDirectory $Engine
    $start = $now.Date.AddHours($now.Hour).AddMinutes($t.Offset)
    if ($start -lt $now) { $start = $start.AddMinutes([math]::Ceiling(($now - $start).TotalMinutes / $t.Every) * $t.Every) }
    $trigger = New-ScheduledTaskTrigger -Once -At $start `
        -RepetitionInterval (New-TimeSpan -Minutes $t.Every) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Seconds $t.Limit) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $t.Name -TaskPath $Folder -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Description "Aether Quant engine: $($t.Args)" | Out-Null
    "Registered {0,-9} every {1,2} min from {2:HH:mm}  -> {3}" -f $t.Name, $t.Every, $start, $log
}
"Python: $Python"
"Check: powershell -File deploy\windows_tasks.ps1 -Status   |   Remove: -Remove"
if ($Live) { "LIVE: gates come from engine\.env (both must be flipped there)." } else { "DRY_RUN forced in every task. Re-run with -Live to use engine\.env gates." }
