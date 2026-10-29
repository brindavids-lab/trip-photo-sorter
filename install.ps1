<#
.SYNOPSIS
  Installs Trip Photo Sorter for the current Windows user and adds a "Sort My Trip"
  shortcut to the Desktop and the Start menu. No admin rights, Python or Node needed.

.EXAMPLE
  # From anywhere (downloads the latest version from GitHub):
  irm https://raw.githubusercontent.com/brindavids-lab/trip-photo-sorter/main/install.ps1 | iex

.EXAMPLE
  .\install.ps1              # from a downloaded or cloned copy
  .\install.ps1 -Uninstall   # removes the app and shortcuts, never your photos
#>
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'TripPhotoSorter'),
    [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
    [string]$StartMenuDir = [Environment]::GetFolderPath('Programs'),
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Repo = 'brindavids-lab/trip-photo-sorter'
$ShortcutName = 'Sort My Trip.lnk'
$AppFiles = 'Sort My Trip.bat', 'SortTrip.ps1', 'settings.json', 'app', 'lib', 'install.ps1', 'README.md', 'LICENSE'
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Remove-Shortcuts {
    foreach ($dir in $DesktopDir, $StartMenuDir) {
        $path = Join-Path $dir $ShortcutName
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
}

function Assert-OurFolder {
    # Never wipe a folder that isn't a Trip Photo Sorter install.
    if ((Test-Path -LiteralPath $InstallDir) -and @(Get-ChildItem -LiteralPath $InstallDir -Force).Count -gt 0 -and
        -not (Test-Path -LiteralPath (Join-Path $InstallDir 'SortTrip.ps1'))) {
        throw "$InstallDir already exists and is not a Trip Photo Sorter folder. Choose another -InstallDir."
    }
}

if ($Uninstall) {
    Assert-OurFolder
    Remove-Shortcuts
    if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
    Write-Host "Trip Photo Sorter is uninstalled. Your photos in '$env:USERPROFILE\Trip Photos' were not touched." -ForegroundColor Green
    return
}

if ($env:OS -ne 'Windows_NT') { throw 'Trip Photo Sorter only works on Windows.' }
Assert-OurFolder

# 1. Find the app files: next to this script, or download them from GitHub.
$source = $PSScriptRoot
$temp = $null
if (-not $source -or -not (Test-Path -LiteralPath (Join-Path $source 'SortTrip.ps1'))) {
    $temp = Join-Path $env:TEMP "trip-photo-sorter-$(Get-Random)"
    [void][IO.Directory]::CreateDirectory($temp)
    $zip = Join-Path $temp 'download.zip'
    Write-Host "Downloading Trip Photo Sorter from github.com/$Repo ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing "https://github.com/$Repo/archive/refs/heads/main.zip" -OutFile $zip
    Expand-Archive -LiteralPath $zip -DestinationPath $temp
    $source = (Get-ChildItem -LiteralPath $temp -Directory | Select-Object -First 1).FullName
}

try {
    # 2. Copy them, keeping the user's own settings.json when updating.
    $settingsPath = Join-Path $InstallDir 'settings.json'
    $oldSettings = if (Test-Path -LiteralPath $settingsPath) { [IO.File]::ReadAllText($settingsPath) }
    if (Test-Path -LiteralPath $InstallDir) { Get-ChildItem -LiteralPath $InstallDir -Force | Remove-Item -Recurse -Force }
    [void][IO.Directory]::CreateDirectory($InstallDir)
    foreach ($name in $AppFiles) {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination $InstallDir -Recurse -Force
    }
    if ($oldSettings) {
        Copy-Item -LiteralPath $settingsPath -Destination (Join-Path $InstallDir 'settings.default.json') -Force
        [IO.File]::WriteAllText($settingsPath, $oldSettings, $Utf8)
        Write-Host "Kept your existing settings.json (the new defaults are in settings.default.json)."
    }
    Get-ChildItem -LiteralPath $InstallDir -Recurse -File | Unblock-File

    # 3. Shortcuts with a camera icon.
    $shell = New-Object -ComObject WScript.Shell
    foreach ($dir in $DesktopDir, $StartMenuDir) {
        [void][IO.Directory]::CreateDirectory($dir)
        $link = $shell.CreateShortcut((Join-Path $dir $ShortcutName))
        $link.TargetPath = Join-Path $InstallDir 'Sort My Trip.bat'
        $link.WorkingDirectory = $InstallDir
        $link.IconLocation = "$env:SystemRoot\System32\imageres.dll,52"
        $link.Description = 'Copy the photos off your phone and sort them into folders'
        $link.Save()
    }
} finally {
    if ($temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "Trip Photo Sorter is installed." -ForegroundColor Green
Write-Host "  App:      $InstallDir"
Write-Host "  Shortcut: 'Sort My Trip' on your Desktop and in the Start menu"
Write-Host "After a trip: plug in and unlock your phone, then double-click 'Sort My Trip'."
