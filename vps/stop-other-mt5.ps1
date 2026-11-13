# Closes every MetaTrader that is NOT one of Kanairy's private copies, then shows each account's last compile log.
$procs = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'"
foreach ($p in $procs) {
  if ($p.ExecutablePath -like '*ProgramData\Kanairy*') { Write-Host ('Keeping   ' + $p.ExecutablePath) }
  else { Write-Host ('Closing   ' + $p.ExecutablePath); Stop-Process -Id $p.ProcessId -Force }
}
Write-Host ''
$root = Join-Path $env:ProgramData 'Kanairy\users'
if (Test-Path $root) {
  Get-ChildItem $root -Directory | ForEach-Object {
    $log = Join-Path $_.FullName 'data\compile.log'
    Write-Host ('--- ' + $_.Name + ' compile log ---')
    if (Test-Path $log) { Get-Content $log -Tail 12 } else { Write-Host '(none)' }
  }
}
