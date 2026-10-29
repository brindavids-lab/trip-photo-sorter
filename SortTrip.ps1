<#
.SYNOPSIS
  Copies a trip's photos off your phone, sorts them into category folders with AI
  (in your browser, on your own laptop), then asks whether to delete them from the phone.

.EXAMPLE
  .\SortTrip.ps1                         # plug in the phone and follow the prompts
  .\SortTrip.ps1 -Source "D:\Camera"     # sort a folder instead of a phone
#>
param(
    [string]$Source,        # sort this folder instead of a phone (it is copied, never changed)
    [string]$TripName,
    [string]$TripsFolder,   # where trip folders are created (default: settings.json, then %USERPROFILE%\Trip Photos)
    [switch]$NoBrowser,     # don't open the browser or Explorer automatically
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$AppDir = $PSScriptRoot
$Settings = Get-Content -LiteralPath (Join-Path $AppDir 'settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not ('TripSorter.ShellOps' -as [type])) {
    Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $AppDir 'lib\ShellOps.cs') -Raw)
}

$PhotoExt = '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.dng'
$VideoExt = '.mov', '.mp4', '.m4v', '.3gp'
$MediaExt = $PhotoExt + $VideoExt
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

function Get-SafeName([string]$Name) {
    ($Name -replace '[<>:"/\\|?*\x00-\x1f]', '').Trim().TrimEnd('.')
}

function Get-UniquePath([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $Path }
    $dir = Split-Path $Path
    $base = [IO.Path]::GetFileNameWithoutExtension($Path)
    $ext = [IO.Path]::GetExtension($Path)
    $i = 2
    do { $candidate = Join-Path $dir "$base ($i)$ext"; $i++ } while (Test-Path -LiteralPath $candidate)
    $candidate
}

function Join-Rel([string]$Rel, [string]$Name) { if ($Rel) { "$Rel\$Name" } else { $Name } }

# ---------------------------------------------------------------- phone access

function Get-ShellFileName($Item) {
    # FolderItem.Name hides extensions when Explorer does, so ask for the real file name.
    $name = $null
    try { $name = $Item.ExtendedProperty('System.FileName') } catch {}
    if ($name) { $name } else { $Item.Name }
}

$MonthFolder = '^(\d{4})(0[1-9]|1[0-2])_'   # recent iPhones: Internal Storage\202509_a\IMG_4685.JPG

# Returns the folder holding the camera roll: DCIM (Android, older iPhones), or the
# storage folder itself when it contains iPhone month folders.
function Find-PhotoFolder($Folder, [int]$Depth) {
    foreach ($item in $Folder.Items()) {
        if (-not $item.IsFolder) { continue }
        if ($item.Name -eq 'DCIM') { return $item.GetFolder }
        if ($item.Name -match $MonthFolder -or $item.Name -match '^\d{3}APPLE$') { return $Folder }
        if ($Depth -lt 1) {
            $found = Find-PhotoFolder $item.GetFolder ($Depth + 1)
            if ($found) { return $found }
        }
    }
    $null
}

function Find-Phones {
    $shell = New-Object -ComObject Shell.Application
    foreach ($device in $shell.Namespace(17).Items()) {   # 17 = "This PC"
        if ($device.IsFileSystem -or -not $device.IsFolder) { continue }   # skip C:, D:, ...
        $photos = $null
        try { $photos = Find-PhotoFolder $device.GetFolder 0 } catch {}
        # A locked or not-yet-trusted phone shows up with empty storage, so Photos stays $null.
        [pscustomobject]@{ Name = $device.Name; Photos = $photos }
    }
}

# Lists photos and videos. With trip dates, iPhone month folders outside them are skipped,
# which saves minutes on a phone holding years of photos.
function Get-PhoneMedia($Folder, [string]$Rel, $From = $null, $Until = $null) {
    foreach ($item in $Folder.Items()) {
        if ($item.IsFolder) {
            if ($item.Name -match $MonthFolder) {
                $monthStart = New-Object DateTime ([int]$Matches[1]), ([int]$Matches[2]), 1
                if (($From -and $monthStart.AddMonths(1) -le $From.Date) -or ($Until -and $monthStart -gt $Until.Date)) { continue }
            }
            Get-PhoneMedia $item.GetFolder (Join-Rel $Rel $item.Name) $From $Until
            continue
        }
        $name = Get-ShellFileName $item
        if ($MediaExt -notcontains [IO.Path]::GetExtension($name).ToLower()) { continue }
        $size = 0L
        try { $size = [int64]$item.ExtendedProperty('System.Size') } catch {}
        # iPhones leave FolderItem.ModifyDate empty; System.DateModified (UTC) holds the capture time.
        $date = $null
        try { $date = $item.ExtendedProperty('System.DateModified') } catch {}
        if ($date -is [datetime]) { $date = [datetime]::SpecifyKind($date, 'Utc').ToLocalTime() } else { $date = $item.ModifyDate }
        if ($date -and $date.Year -lt 1980) { $date = $null }
        $script:Listed++
        if ($script:Listed % 25 -eq 0) { Write-Progress -Activity 'Reading the photo list from the phone' -Status "$($script:Listed) files so far ($Rel)" }
        [pscustomobject]@{ Name = $name; Folder = $Rel; Rel = (Join-Rel $Rel $name); Size = $size; Date = $date; Item = $item }
    }
}

function Read-Date([string]$Prompt) {
    while ($true) {
        $text = Read-Host $Prompt
        if (-not $text) { return $null }
        $date = [datetime]::MinValue
        if ([datetime]::TryParse($text, [ref]$date)) { return $date }
        Say "  Please type a date like 2026-10-14, or just press Enter." Yellow
    }
}

function Select-Phone {
    while ($true) {
        Say "Looking for your phone..."
        $devices = @(Find-Phones)
        $phones = @($devices | Where-Object { $_.Photos })
        if ($phones.Count -eq 1) { return $phones[0] }
        if ($phones.Count -gt 1) {
            for ($i = 0; $i -lt $phones.Count; $i++) { Say "  [$($i + 1)] $($phones[$i].Name)" White }
            $pick = Read-Host "Which one? (number)"
            if ($pick -as [int] -and [int]$pick -ge 1 -and [int]$pick -le $phones.Count) { return $phones[[int]$pick - 1] }
            continue
        }
        Say ""
        if ($devices) {
            Say "I can see '$($devices[0].Name)' but not its photos yet. Check that:" Yellow
        } else {
            Say "No phone found. Check that:" Yellow
        }
        Say "  - the phone is plugged in with a cable and UNLOCKED"
        Say "  - iPhone: you tapped 'Trust' on the phone.  Android: you chose 'File transfer' in the USB notification"
        $answer = Read-Host "Press Enter to look again, or type F to pick a folder on this laptop instead"
        if ($answer -match '^f') { return $null }
    }
}

function Copy-FromPhone($Items, [string]$Incoming) {
    $sources = New-Object System.Collections.Generic.List[object]
    $dests = New-Object System.Collections.Generic.List[string]
    foreach ($m in $Items) {
        $dest = if ($m.Folder) { Join-Path $Incoming $m.Folder } else { $Incoming }
        [void][IO.Directory]::CreateDirectory($dest)
        $sources.Add($m.Item.psobject.BaseObject); $dests.Add($dest)
    }
    try {
        [void][TripSorter.ShellOps]::Copy($sources.ToArray(), $dests.ToArray())
    } catch {
        Say "Fast copy failed ($($_.Exception.Message)). Copying one by one instead..." Yellow
        $shell = New-Object -ComObject Shell.Application
        $n = 0
        foreach ($m in $Items) {
            $n++
            Write-Progress -Activity 'Copying from phone' -Status $m.Rel -PercentComplete (100 * $n / $Items.Count)
            $target = Join-Path $Incoming $m.Rel
            if (Test-Path -LiteralPath $target) { continue }
            $shell.Namespace($dests[$n - 1]).CopyHere($m.Item, 4 + 16)
            # CopyHere returns before the copy finishes: wait until the file stops growing.
            $last = -1; $deadline = (Get-Date).AddMinutes(5)
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Milliseconds 200
                if (Test-Path -LiteralPath $target) {
                    $len = (Get-Item -LiteralPath $target).Length
                    if ($len -gt 0 -and $len -eq $last) { break }
                    $last = $len
                }
            }
        }
        Write-Progress -Activity 'Copying from phone' -Completed
    }
}

# ---------------------------------------------------------------- tiny local web server

function Send-Bytes($Ctx, [byte[]]$Bytes, [string]$Type, [int]$Status = 200) {
    $res = $Ctx.Response
    $res.StatusCode = $Status
    $res.ContentType = $Type
    $res.ContentLength64 = $Bytes.Length
    $res.OutputStream.Write($Bytes, 0, $Bytes.Length)
}

function Send-Json($Ctx, $Object) {
    Send-Bytes $Ctx $Utf8.GetBytes((ConvertTo-Json -InputObject $Object -Depth 6 -Compress)) 'application/json; charset=utf-8'
}

function Send-Text($Ctx, [int]$Status, [string]$Text) {
    Send-Bytes $Ctx $Utf8.GetBytes($Text) 'text/plain; charset=utf-8' $Status
}

$MimeTypes = @{
    '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.png' = 'image/png'
    '.gif' = 'image/gif'; '.webp' = 'image/webp'; '.heic' = 'image/heic'; '.heif' = 'image/heif'
    # Chrome/Edge only play .mov when it is labelled mp4; iPhone .mov files usually are.
    '.mp4' = 'video/mp4'; '.m4v' = 'video/mp4'; '.mov' = 'video/mp4'; '.3gp' = 'video/3gpp'
}

function Send-File($Ctx, [string]$Path) {
    $res = $Ctx.Response
    $type = $MimeTypes[[IO.Path]::GetExtension($Path).ToLower()]
    if (-not $type) { $type = 'application/octet-stream' }
    $stream = [IO.File]::OpenRead($Path)
    try {
        $length = $stream.Length; $start = 0L; $end = $length - 1; $status = 200
        # Videos are fetched in byte ranges; answer open-ended ranges in 8 MB pieces.
        if ($Ctx.Request.Headers['Range'] -match '^bytes=(\d*)-(\d*)$') {
            if ($Matches[1]) {
                $start = [int64]$Matches[1]
                $end = if ($Matches[2]) { [Math]::Min([int64]$Matches[2], $length - 1) } else { [Math]::Min($start + 8MB - 1, $length - 1) }
            } elseif ($Matches[2]) {
                $start = [Math]::Max(0, $length - [int64]$Matches[2])
            }
            if ($start -ge $length) { Send-Text $Ctx 416 'Range not satisfiable'; return }
            $status = 206
            $res.AddHeader('Content-Range', "bytes $start-$end/$length")
        }
        $res.AddHeader('Accept-Ranges', 'bytes')
        $res.StatusCode = $status
        $res.ContentType = $type
        $res.ContentLength64 = $end - $start + 1
        $stream.Position = $start
        $buffer = New-Object byte[] 65536
        $left = $end - $start + 1
        while ($left -gt 0) {
            $read = $stream.Read($buffer, 0, [int][Math]::Min($buffer.Length, $left))
            if ($read -le 0) { break }
            $res.OutputStream.Write($buffer, 0, $read)
            $left -= $read
        }
    } finally { $stream.Dispose() }
}

function Read-Body($Ctx) {
    $reader = New-Object IO.StreamReader($Ctx.Request.InputStream, [Text.Encoding]::UTF8)
    try { $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Invoke-Apply($Ctx) {
    if ($State.Applied) { Send-Text $Ctx 409 'Already sorted.'; return }
    $data = Read-Body $Ctx | ConvertFrom-Json
    $manifest = New-Object System.Collections.ArrayList
    $folders = @{}
    foreach ($a in $data.assignments) {
        $file = $Files[[int]$a.id]
        $segments = @(($a.folder -split '/') | ForEach-Object { Get-SafeName $_ } | Where-Object { $_ -and $_ -ne '..' })
        if (-not $segments) { $segments = @($Settings.otherFolder) }
        $destDir = $TripDir
        foreach ($s in $segments) { $destDir = Join-Path $destDir $s }
        [void][IO.Directory]::CreateDirectory($destDir)
        $dest = Get-UniquePath (Join-Path $destDir $file.Name)
        [IO.File]::Move($file.FullName, $dest)
        $folders[$destDir] = $true
        [void]$manifest.Add([ordered]@{
            original = $file.FullName.Substring($Incoming.Length + 1)
            sorted   = $dest.Substring($TripDir.Length + 1)
            category = $segments -join '/'
            bytes    = $file.Length
        })
    }
    $leftover = @(Get-ChildItem -LiteralPath $Incoming -Recurse -File).Count
    if ($leftover -eq 0) { Remove-Item -LiteralPath $Incoming -Recurse -Force }
    [IO.File]::WriteAllText((Join-Path $TripDir 'sorting-log.json'), (ConvertTo-Json -InputObject $manifest -Depth 4), $Utf8)
    $State.Applied = $true
    $State.Manifest = $manifest
    Send-Json $Ctx @{ ok = $true; tripDir = $TripDir; moved = $manifest.Count; folders = $folders.Count; leftover = $leftover }
}

function Invoke-Request($Ctx) {
    $path = $Ctx.Request.Url.AbsolutePath
    $post = $Ctx.Request.HttpMethod -eq 'POST'
    switch -Regex ($path) {
        '^/$' { Send-File $Ctx (Join-Path $AppDir 'app\index.html'); return }
        '^/(app\.js|style\.css)$' { Send-File $Ctx (Join-Path $AppDir "app\$($Matches[1])"); return }
        '^/settings\.json$' { Send-File $Ctx (Join-Path $AppDir 'settings.json'); return }
        '^/api/session$' { Send-Json $Ctx $Session; return }
        '^/media/(\d+)$' {
            $i = [int]$Matches[1]
            if ($i -lt $Files.Count -and -not $State.Applied) { Send-File $Ctx $Files[$i].FullName } else { Send-Text $Ctx 404 'Not found' }
            return
        }
        '^/api/apply$' { if ($post) { Invoke-Apply $Ctx; return } }
        '^/api/report$' {
            if ($post) {
                [IO.File]::WriteAllText((Join-Path $TripDir 'Sorting report.html'), (Read-Body $Ctx), $Utf8)
                Send-Json $Ctx @{ ok = $true }; return
            }
        }
        '^/api/finish$' { if ($post) { $State.Finished = $true; Send-Json $Ctx @{ ok = $true }; return } }
    }
    Send-Text $Ctx 404 'Not found'
}

# ---------------------------------------------------------------- 1. where and what

Say ""
Say "  Trip Photo Sorter" Magenta
Say "  ------------------" Magenta

$TripsRoot = $TripsFolder
if (-not $TripsRoot -and $Settings.tripsFolder) { $TripsRoot = [Environment]::ExpandEnvironmentVariables($Settings.tripsFolder) }
if (-not $TripsRoot) { $TripsRoot = Join-Path $env:USERPROFILE 'Trip Photos' }
[void][IO.Directory]::CreateDirectory($TripsRoot)

if (-not $TripName) { $TripName = Read-Host "Name this trip (for example: Bali 2026)" }
$TripName = Get-SafeName $TripName
if (-not $TripName) { $TripName = "Trip $(Get-Date -Format 'yyyy-MM-dd')" }
$TripDir = Get-UniquePath (Join-Path $TripsRoot $TripName)
$Incoming = Join-Path $TripDir '_incoming'
[void][IO.Directory]::CreateDirectory($Incoming)

# ---------------------------------------------------------------- 2. copy the photos to the laptop

$Phone = $null
$PhoneItems = @()
if (-not $Source) {
    $Phone = Select-Phone
    if (-not $Phone) {
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = 'Choose the folder with your trip photos'
        if ($dialog.ShowDialog() -ne 'OK') { Remove-Item -LiteralPath $TripDir -Recurse -Force; return }
        $Source = $dialog.SelectedPath
    }
}

if ($Phone) {
    Say "Found: $($Phone.Name)." Green
    Say "Which dates was the trip? Press Enter on both to take everything not imported before."
    $from = Read-Date "  First day of the trip (e.g. 2026-10-14)"
    $until = Read-Date "  Last day of the trip  (e.g. 2026-10-21)"
    Say "Reading the photo list from the phone (this can take a minute)..."
    $all = @(Get-PhoneMedia $Phone.Photos '' $from $until)
    Write-Progress -Activity 'Reading the photo list from the phone' -Completed
    $ledgerPath = Join-Path $TripsRoot '.imported-from-phone.txt'
    $ledger = @{}
    if (Test-Path -LiteralPath $ledgerPath) { foreach ($line in [IO.File]::ReadAllLines($ledgerPath)) { $ledger[$line] = $true } }
    $keyOf = { param($m) "$($Phone.Name)|$($m.Rel)|$(if ($m.Date) { $m.Date.ToString('s') })" }

    $PhoneItems = @($all | Where-Object {
        if ($from -or $until) {
            # Files without a date are kept rather than silently left behind.
            -not $_.Date -or ((-not $from -or $_.Date.Date -ge $from.Date) -and (-not $until -or $_.Date.Date -le $until.Date))
        } else {
            -not $ledger[(& $keyOf $_)]
        }
    })
    if (-not $PhoneItems) { Say "Nothing to import for those dates." Yellow; Remove-Item -LiteralPath $TripDir -Recurse -Force; return }

    Say "Copying $($PhoneItems.Count) files to $TripDir ..." Green
    Copy-FromPhone $PhoneItems $Incoming
    $copied = @($PhoneItems | Where-Object { Test-Path -LiteralPath (Join-Path $Incoming $_.Rel) })
    if ($copied.Count -lt $PhoneItems.Count) { Say "$($PhoneItems.Count - $copied.Count) files could not be copied; they stay on the phone." Yellow }
    [IO.File]::AppendAllLines($ledgerPath, [string[]]@($copied | ForEach-Object { & $keyOf $_ }), $Utf8)
    $PhoneItems = $copied
} else {
    $srcRoot = (Resolve-Path -LiteralPath $Source).ProviderPath.TrimEnd('\')
    $srcFiles = @(Get-ChildItem -LiteralPath $srcRoot -Recurse -File | Where-Object { $MediaExt -contains $_.Extension.ToLower() })
    Say "Copying $($srcFiles.Count) files from $srcRoot (the originals are not touched)..." Green
    $n = 0
    foreach ($f in $srcFiles) {
        $n++
        Write-Progress -Activity 'Copying photos' -Status $f.Name -PercentComplete (100 * $n / [Math]::Max(1, $srcFiles.Count))
        $dest = Join-Path $Incoming $f.FullName.Substring($srcRoot.Length + 1)
        [void][IO.Directory]::CreateDirectory((Split-Path $dest))
        [IO.File]::Copy($f.FullName, $dest, $true)
    }
    Write-Progress -Activity 'Copying photos' -Completed
}

$Files = @(Get-ChildItem -LiteralPath $Incoming -Recurse -File | Where-Object { $MediaExt -contains $_.Extension.ToLower() } | Sort-Object FullName)
if (-not $Files) { Say "No photos or videos to sort." Yellow; Remove-Item -LiteralPath $TripDir -Recurse -Force; return }

$Session = @{
    trip    = $TripName
    tripDir = $TripDir
    fromPhone = [bool]$Phone
    files   = @(for ($i = 0; $i -lt $Files.Count; $i++) {
        $f = $Files[$i]
        @{
            id   = $i
            name = $f.Name
            ext  = $f.Extension.ToLower()
            kind = $(if ($VideoExt -contains $f.Extension.ToLower()) { 'video' } else { 'photo' })
            size = $f.Length
            date = $f.LastWriteTime.ToString('s')
        }
    })
}

# ---------------------------------------------------------------- 3. sort in the browser

$State = @{ Applied = $false; Finished = $false; Manifest = $null }
$Listener = $null
for ($p = $Port; $p -lt $Port + 20 -and -not $Listener; $p++) {
    $candidate = New-Object System.Net.HttpListener
    $candidate.Prefixes.Add("http://localhost:$p/")
    try { $candidate.Start(); $Listener = $candidate; $Url = "http://localhost:$p/" } catch { $candidate.Close() }
}
if (-not $Listener) { throw "Could not start the local sorter page on ports $Port-$($Port + 19)." }

Say ""
Say "Sorting $($Files.Count) files. The sorter is open in your browser: $Url" Green
Say "(Keep this window open. Press Ctrl+C to stop without moving anything.)"
if (-not $NoBrowser) { Start-Process $Url }

try {
    while (-not $State.Finished) {
        $pending = $Listener.BeginGetContext($null, $null)
        while (-not $pending.AsyncWaitHandle.WaitOne(300)) { }   # short waits keep Ctrl+C working
        $ctx = $Listener.EndGetContext($pending)
        try { Invoke-Request $ctx }
        catch { try { Send-Text $ctx 500 $_.Exception.Message } catch {} }
        finally { try { $ctx.Response.Close() } catch {} }
    }
} finally { $Listener.Close() }

if (-not $State.Applied) { Say "Nothing was moved. Your copied files are in $Incoming" Yellow; return }
Say ""
Say "Done! $($State.Manifest.Count) files are sorted into folders in:" Green
Say "  $TripDir" White
if (-not $NoBrowser) { Start-Process explorer.exe -ArgumentList "`"$TripDir`"" }

# ---------------------------------------------------------------- 4. offer to free up the phone

if (-not $Phone) { return }

$sortedByOriginal = @{}
foreach ($entry in $State.Manifest) { $sortedByOriginal[$entry.original] = $entry }
$safe = New-Object System.Collections.ArrayList
foreach ($m in $PhoneItems) {
    $entry = $sortedByOriginal[$m.Rel]
    if (-not $entry -or $entry.bytes -le 0) { continue }
    $onLaptop = Join-Path $TripDir $entry.sorted
    if ((Test-Path -LiteralPath $onLaptop) -and (Get-Item -LiteralPath $onLaptop).Length -eq $entry.bytes) { [void]$safe.Add($m) }
}
$notSafe = $PhoneItems.Count - $safe.Count
if ($safe.Count -eq 0) { Say "Nothing was verified on the laptop, so nothing will be deleted from the phone." Yellow; return }

Say ""
Say "Checked: $($safe.Count) photos and videos from this trip are safely on your laptop." Green
if ($notSafe -gt 0) { Say "($notSafe others could not be verified and will stay on the phone no matter what.)" Yellow }
Say "Do you want to DELETE these $($safe.Count) files from your phone ($($Phone.Name)) to free up space?" White
Say "Deleting over the cable is permanent on the phone (it skips 'Recently Deleted'). Your laptop copies stay." Yellow
$answer = Read-Host "Type YES to delete them from the phone, or press Enter to keep them"
if ($answer -ne 'YES' -and $answer -ne 'yes') { Say "OK - nothing was deleted from the phone."; return }

try {
    [void][TripSorter.ShellOps]::Delete([object[]]@($safe | ForEach-Object { $_.Item.psobject.BaseObject }))
} catch {
    Say "The phone refused some deletions: $($_.Exception.Message)" Yellow
}
Say "Checking the phone..."
$stillThere = @{}
foreach ($m in @(Get-PhoneMedia $Phone.Photos '' $from $until)) { $stillThere[$m.Rel] = $true }
Write-Progress -Activity 'Reading the photo list from the phone' -Completed
$deleted = @($safe | Where-Object { -not $stillThere[$_.Rel] }).Count
Say "Deleted $deleted of $($safe.Count) files from the phone." Green
if ($deleted -lt $safe.Count) {
    Say "Some files could not be removed over the cable. On iPhone this happens when iCloud Photos is on:" Yellow
    Say "delete them in the Photos app instead (Library > select the trip days > Delete)." Yellow
}
