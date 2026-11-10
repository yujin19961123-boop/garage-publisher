param(
    [string]$GoVersion = '1.27.3',
    [string]$PostgresArchiveUrl = 'https://get.enterprisedb.com/postgresql/postgresql-17.11-3-windows-x64-binaries.zip'
)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $workspace '.tools'
New-Item -ItemType Directory -Force $toolsDir | Out-Null
if (![Environment]::Is64BitOperatingSystem) { throw 'These tools require 64-bit Windows.' }
if ($GoVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Go release version.' }
$pgUrl = [Uri]$PostgresArchiveUrl
if ($pgUrl.Scheme -ne 'https' -or $pgUrl.Host -ne 'get.enterprisedb.com') { throw 'PostgreSQL download must use the official EDB HTTPS host.' }
$goFilename = "go$GoVersion.windows-amd64.zip"
$metadata = Invoke-RestMethod 'https://go.dev/dl/?mode=json&include=all'
$release = $metadata | Where-Object version -eq "go$GoVersion" | Select-Object -First 1
$archive = $release.files | Where-Object filename -eq $goFilename | Select-Object -First 1
if (!$archive.sha256) { throw 'No official SHA256 metadata for requested Go archive.' }
$goZip = Join-Path $toolsDir 'go.zip'
if (!(Test-Path $goZip) -or (Get-FileHash $goZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archive.sha256) {
    Invoke-WebRequest "https://go.dev/dl/$goFilename" -OutFile $goZip -UseBasicParsing
}
if ((Get-FileHash $goZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archive.sha256) { throw 'Go SHA256 verification failed; refusing to extract.' }
if (!(Test-Path "$toolsDir\go\bin\go.exe")) { Expand-Archive -LiteralPath $goZip -DestinationPath $toolsDir }
$pgZip = Join-Path $toolsDir 'postgres.zip'
if (!(Test-Path $pgZip)) { Invoke-WebRequest $PostgresArchiveUrl -OutFile $pgZip -UseBasicParsing }
# EDB archive is fetched over HTTPS; no upstream checksum is assumed here.
# Extract only runtime bin/lib/share, avoiding the large bundled pgAdmin tree.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$destination = Join-Path $toolsDir 'pg-runtime'
New-Item -ItemType Directory -Force $destination | Out-Null
$destinationFull = [IO.Path]::GetFullPath($destination) + [IO.Path]::DirectorySeparatorChar
$zip = [IO.Compression.ZipFile]::OpenRead($pgZip)
try {
    foreach ($entry in $zip.Entries) {
        $entryName = $entry.FullName.Replace('\','/')
        if ($entryName -notmatch '^pgsql/(bin|lib|share)/') { continue }
        $target = [IO.Path]::GetFullPath((Join-Path $destination $entryName))
        if (!$target.StartsWith($destinationFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe PostgreSQL archive path.' }
        if ($entryName.EndsWith('/')) { New-Item -ItemType Directory -Force $target | Out-Null; continue }
        New-Item -ItemType Directory -Force ([IO.Path]::GetDirectoryName($target)) | Out-Null
        if (!(Test-Path $target)) { [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$false) }
    }
} finally { $zip.Dispose() }
if (!(Test-Path "$destination\pgsql\bin\initdb.exe")) { throw 'PostgreSQL archive did not contain expected runtime.' }
Write-Host 'Project-local Go and PostgreSQL tools are ready. Run scripts/start-local.ps1.'
