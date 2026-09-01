# Installe l'agent Ledger sans avoir besoin de Python : telecharge le binaire
# de la derniere Release GitHub, puis lance 'configure' et 'install'.
#
# Usage (PowerShell) :
#   irm https://raw.githubusercontent.com/FabrichJean/c-sha/main/agent/install.ps1 | iex

$ErrorActionPreference = "Stop"

$repo = "FabrichJean/c-sha"
$destDir = Join-Path $env:USERPROFILE ".ledger\bin"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null

Write-Host "Recuperation de la derniere release (ledger-agent-windows-*)..."
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest"
# le nom de l'asset porte le tag de version (ex: ledger-agent-windows-v0.3.1.exe) —
# on filtre par motif plutot que par egalite exacte.
$asset = $release.assets | Where-Object { $_.name -like "ledger-agent-windows-*" }
if (-not $asset) {
    Write-Error "Aucune release trouvee avec un asset ledger-agent-windows-*. Cree d'abord un tag (ex: v0.1.0) pour declencher le build."
    exit 1
}

$dest = Join-Path $destDir "ledger-agent.exe"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest
Write-Host "Binaire installe : $dest"
Write-Host ""

& $dest configure
& $dest install

Write-Host ""
Write-Host "Termine. Pour desinstaller : $dest uninstall"
