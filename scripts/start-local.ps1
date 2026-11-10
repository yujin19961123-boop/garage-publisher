$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
Set-Location $workspace
$runtime = Join-Path $workspace '.local'
New-Item -ItemType Directory -Force $runtime | Out-Null
if (!(Test-Path '.env')) { throw 'Missing .env. Copy .env.example and set strong passwords first.' }
foreach ($line in Get-Content '.env') {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
        $value = $Matches[2].Trim().Trim('"').Trim("'")
        [Environment]::SetEnvironmentVariable($Matches[1], $value, 'Process')
    }
}
if (!$env:POSTGRES_PASSWORD -or !$env:INIT_ADMIN_PASSWORD) { throw 'Set POSTGRES_PASSWORD and INIT_ADMIN_PASSWORD in .env.' }
$pgbin = Join-Path $workspace '.tools\pg-runtime\pgsql\bin'
if (!(Test-Path "$pgbin\initdb.exe")) { $pgbin = Join-Path $workspace '.tools\pgsql\bin' }
$goexe = Join-Path $workspace '.tools\go\bin\go.exe'
$env:GOCACHE = Join-Path $workspace '.tools\gocache'
$env:GOMODCACHE = Join-Path $workspace '.tools\gomodcache'
$env:GOPATH = Join-Path $workspace '.tools\gopath'
if (!(Test-Path $goexe) -or !(Test-Path "$pgbin\initdb.exe")) { throw 'Project-local Go/PostgreSQL tools missing in .tools. See README.' }
$pgdata = Join-Path $runtime 'pgdata'
if (!(Test-Path "$pgdata\PG_VERSION")) {
    $passwordFile = Join-Path $runtime 'init-password.tmp'
    try {
        [IO.File]::WriteAllText($passwordFile, $env:POSTGRES_PASSWORD)
        & "$pgbin\initdb.exe" -D $pgdata -U prototype --encoding=UTF8 --auth=scram-sha-256 "--pwfile=$passwordFile"
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL initialization failed.' }
    } finally { if (Test-Path $passwordFile) { Remove-Item -LiteralPath $passwordFile } }
}
& "$pgbin\pg_ctl.exe" status -D $pgdata *> $null
if ($LASTEXITCODE -ne 0) {
    $arguments = @('-D', "`"$pgdata`"", '-l', "`"$runtime\postgres.log`"", '-o', '"-h 127.0.0.1 -p 5432"', '-w', 'start')
    # Start-Process -Wait follows the whole child tree, including long-lived postgres.
    # WaitForExit waits only for pg_ctl, which exits after readiness verification.
    $pgStart = Start-Process "$pgbin\pg_ctl.exe" -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $pgStart.WaitForExit()
    if ($pgStart.ExitCode -ne 0) { throw 'PostgreSQL start failed. See .local/postgres.log.' }
}
$env:PGPASSWORD = $env:POSTGRES_PASSWORD
try {
    $exists = & "$pgbin\psql.exe" -h 127.0.0.1 -p 5432 -U prototype -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='prototype'"
    if ($LASTEXITCODE -ne 0) { throw 'Database authentication failed.' }
    if ($exists -ne '1') {
        & "$pgbin\createdb.exe" -h 127.0.0.1 -p 5432 -U prototype prototype
        if ($LASTEXITCODE -ne 0) { throw 'Creating database failed.' }
    }
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
$passwordEncoded = [Uri]::EscapeDataString($env:POSTGRES_PASSWORD)
$env:DATABASE_URL = "postgres://prototype:${passwordEncoded}@127.0.0.1:5432/prototype?sslmode=disable"
$env:LISTEN_ADDR = '127.0.0.1:8081'
$env:DATA_DIR = Join-Path $runtime 'data'
$env:PUBLIC_DOMAIN = 'localhost'
$env:PUBLIC_PORT = '8080'
$env:PUBLIC_SCHEME = 'http'
$env:PUBLIC_URL_MODE = 'path'
$env:ADMIN_HOSTS = 'console.localhost,127.0.0.1'
$env:CONSOLE_URL = 'http://console.localhost:8080'
foreach ($name in @('app','web')) {
    $pidFile = Join-Path $runtime "$name.pid"
    if (Test-Path $pidFile) {
        $running = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
        if ($running) {
            $details = Get-CimInstance Win32_Process -Filter "ProcessId=$($running.Id)"
            $expectedPath = if ($name -eq 'web') { Join-Path $workspace 'scripts\dev-server.mjs' } else { Join-Path $runtime 'server.exe' }
            if ($details.CommandLine -and $details.CommandLine.Contains($expectedPath)) {
                throw "$name already running. Run scripts/stop-local.ps1 first."
            }
        }
        # Windows can reuse a PID after an app update or reboot. Discard only
        # the stale record; never stop the unrelated process now using it.
        Remove-Item -LiteralPath $pidFile
    }
}
foreach ($listenPort in @(8080,8081)) {
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$listenPort)
    try { $probe.Start() } catch { throw "Local port $listenPort is already in use; stop its owner before starting." } finally { $probe.Stop() }
}
Push-Location frontend
try {
    if (!(Test-Path node_modules)) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' } }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
} finally { Pop-Location }
Push-Location backend
try {
    & $goexe build -o "$runtime\server.exe" .
    if ($LASTEXITCODE -ne 0) { throw 'Backend build failed.' }
} finally { Pop-Location }
$appProcess = Start-Process "$runtime\server.exe" -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput "$runtime\app.log" -RedirectStandardError "$runtime\app-error.log" -PassThru
$appProcess.Id | Set-Content "$runtime\app.pid"
$healthy = $false
for ($attempt=0; $attempt -lt 30; $attempt++) {
    try { $response = Invoke-WebRequest 'http://127.0.0.1:8081/healthz' -UseBasicParsing; if ($response.StatusCode -eq 200) { $healthy=$true; break } } catch {}
    Start-Sleep -Milliseconds 500
}
if (!$healthy) { throw 'Backend health check failed. See .local/app-error.log.' }
$webProcess = Start-Process (Get-Command node.exe).Source -ArgumentList "`"$workspace\scripts\dev-server.mjs`"" -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput "$runtime\web.log" -RedirectStandardError "$runtime\web-error.log" -PassThru
$webProcess.Id | Set-Content "$runtime\web.pid"
$webHealthy = $false
for ($attempt=0; $attempt -lt 20; $attempt++) {
    if ($webProcess.HasExited) { break }
    try { $response = Invoke-WebRequest 'http://127.0.0.1:8080/healthz' -Headers @{Host='console.localhost:8080'} -UseBasicParsing; if ($response.StatusCode -eq 200) { $webHealthy=$true; break } } catch {}
    Start-Sleep -Milliseconds 250
}
if (!$webHealthy -or $webProcess.HasExited) { throw 'Local proxy health check failed. See .local/web-error.log.' }
Write-Host 'Started: http://console.localhost:8080. Credentials are in .env; logs/data are in .local.'
