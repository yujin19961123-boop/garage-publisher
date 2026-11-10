# Adapt only the user's local test fixture. Production uploads are not rewritten.
$ErrorActionPreference='Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$source=[IO.Compression.ZipFile]::OpenRead((Join-Path (Get-Location) 'dist.zip'))
$destination=Join-Path (Get-Location) '.local/dist-path.zip'
if(Test-Path $destination){$source.Dispose();throw 'Test fixture already exists.'}
$target=[IO.Compression.ZipFile]::Open($destination,[IO.Compression.ZipArchiveMode]::Create)
try {
 foreach($entry in $source.Entries){
  if(!$entry.FullName.StartsWith('dist/') -or $entry.FullName.EndsWith('/')){continue}
  $name=$entry.FullName.Substring(5)
  $out=$target.CreateEntry($name)
  $inputStream=$entry.Open();$outputStream=$out.Open()
  try {
   if($name -match '\.(html|js|css)$'){
    $reader=[IO.StreamReader]::new($inputStream)
    $text=$reader.ReadToEnd()
    $text=[regex]::Replace($text,'(["''`])/(assets|mail|mobile|icons|avatars)/','$1./$2/')
    $text=[regex]::Replace($text,'(["''`])/(#|\?)','$1./$2')
    $bytes=[Text.Encoding]::UTF8.GetBytes($text);$outputStream.Write($bytes,0,$bytes.Length)
   }else{$inputStream.CopyTo($outputStream)}
  }finally{$inputStream.Dispose();$outputStream.Dispose()}
 }
}finally{$source.Dispose();$target.Dispose()}
Write-Output 'Prepared .local/dist-path.zip; original archive unchanged.'
