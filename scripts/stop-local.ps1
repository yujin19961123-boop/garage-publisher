$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $workspace '.local'
foreach ($name in @('web','app')) {
    $pidFile = Join-Path $runtime "$name.pid"
    if (Test-Path $pidFile) {
        $process = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
        if ($process) {
            $expected = if ($name -eq 'web') { 'node' } else { 'server' }
            if ($process.ProcessName -ne $expected) { throw "PID for $name belongs to a different process; refusing to stop it." }
            $details = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
            $expectedPath = if ($name -eq 'web') { Join-Path $workspace 'scripts\dev-server.mjs' } else { Join-Path $runtime 'server.exe' }
            if (!$details.CommandLine -or !$details.CommandLine.Contains($expectedPath)) { throw "PID for $name is not this project's process; refusing to stop it." }
            Stop-Process -Id $process.Id
        }
        Remove-Item -LiteralPath $pidFile
    }
}
$pgctl = Join-Path $workspace '.tools\pg-runtime\pgsql\bin\pg_ctl.exe'
if (!(Test-Path $pgctl)) { $pgctl = Join-Path $workspace '.tools\pgsql\bin\pg_ctl.exe' }
$pgdata = Join-Path $runtime 'pgdata'
if ((Test-Path $pgctl) -and (Test-Path "$pgdata\postmaster.pid")) {
    $stop = Start-Process $pgctl -ArgumentList @('-D', "`"$pgdata`"", '-m', 'fast', '-w', 'stop') -WindowStyle Hidden -PassThru
    $stop.WaitForExit()
    if ($stop.ExitCode -ne 0) { throw 'PostgreSQL stop failed.' }
}
Write-Host 'Stopped local services. Database and published files are preserved.'
