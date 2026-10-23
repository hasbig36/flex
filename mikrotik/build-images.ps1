# Build the Flex images for a MikroTik router on Windows (Docker Desktop).
#   powershell -ExecutionPolicy Bypass -File mikrotik\build-images.ps1 arm64
# arm64 = RB5009, hAP ax, CCR2004/2116/2216    amd64 = CHR or x86    arm = 32-bit ARM (app + sync only)
param([string]$Arch = "arm64")
$ErrorActionPreference = "Stop"

switch ($Arch) {
  "arm64" { $Platform = "linux/arm64" }
  { $_ -in "amd64", "x86", "x86_64" } { $Arch = "amd64"; $Platform = "linux/amd64" }
  { $_ -in "arm", "arm32", "armv7" } { $Arch = "arm"; $Platform = "linux/arm/v7" }
  default { Write-Error "Unknown architecture '$Arch'. Use arm64, amd64 or arm." }
}

Set-Location (Join-Path $PSScriptRoot "..")
$Out = "mikrotik\out"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

docker buildx inspect flex-builder *> $null
if ($LASTEXITCODE -ne 0) { docker buildx create --name flex-builder --driver docker-container | Out-Null }

function Build($Folder, $Name) {
  Write-Host "Building $Name for $Platform ..."
  docker buildx build --builder flex-builder --platform $Platform --build-arg RUN_AS=root `
    --tag "${Name}:latest" --output "type=docker,dest=$Out\$Name-$Arch.tar" ".\$Folder"
  if ($LASTEXITCODE -ne 0) { throw "Build of $Name failed" }
}

Build "portal" "flex-portal"
Build "splynx-sync" "flex-sync"

Write-Host "`nDone:"
Get-ChildItem "$Out\*-$Arch.tar" | Format-Table Name, @{n="MB";e={[math]::Round($_.Length/1MB)}}
Write-Host "Next: copy these two files to the router disk (e.g. usb1/flex/images/), then follow mikrotik\README.md"
