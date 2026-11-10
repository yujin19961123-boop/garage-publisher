# Test fixture preparation only. The publication API never rewrites archives.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force .local | Out-Null
$source = [IO.Compression.ZipFile]::OpenRead((Join-Path (Get-Location) 'dist.zip'))
$targetPath = Join-Path (Get-Location) '.local/dist-normalized.zip'
if (Test-Path $targetPath) { $source.Dispose(); throw 'Test copy already exists; original dist.zip was not changed.' }
$target = [IO.Compression.ZipFile]::Open($targetPath, [IO.Compression.ZipArchiveMode]::Create)
try {
    if (!$source.GetEntry('dist/index.html')) { throw 'Expected dist/index.html in the sample archive.' }
    foreach ($entry in $source.Entries) {
        if (!$entry.FullName.StartsWith('dist/') -or $entry.FullName.EndsWith('/')) { continue }
        $output = $target.CreateEntry($entry.FullName.Substring(5))
        $inputStream = $entry.Open()
        $outputStream = $output.Open()
        try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose(); $outputStream.Dispose() }
    }
} finally { $source.Dispose(); $target.Dispose() }
Write-Host 'Created .local/dist-normalized.zip; original dist.zip unchanged.'
