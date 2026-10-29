<#
.SYNOPSIS
  Trip Photo Sorter. Starts a small local server and opens the sorter page in your browser.
  Everything else happens on that page: finding the phone, choosing the trip dates, copying,
  AI sorting, and (only if you confirm) deleting the copied photos from the phone.

.EXAMPLE
  .\SortTrip.ps1                 # normally started minimized by "Sort My Trip.bat"
  .\SortTrip.ps1 -NoBrowser      # start the server without opening the browser
#>
param(
    [string]$TripsFolder,   # where trip folders are created (default: settings.json, then %USERPROFILE%\Trip Photos)
    [switch]$NoBrowser,     # don't open the browser or Explorer automatically
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$AppDir = $PSScriptRoot
Add-Type -AssemblyName System.Windows.Forms
$Settings = Get-Content -LiteralPath (Join-Path $AppDir 'settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not ('TripSorter.ShellOps' -as [type])) {
    Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $AppDir 'lib\ShellOps.cs') -Raw)
}

$PhotoExt = '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.dng'
$VideoExt = '.mov', '.mp4', '.m4v', '.3gp'
$MediaExt = $PhotoExt + $VideoExt
$Utf8 = New-Object System.Text.UTF8Encoding $false
$IdleMinutes = 30   # quit when the page has been closed this long

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
        [pscustomobject]@{ Name = $name; Folder = $Rel; Rel = (Join-Rel $Rel $name); Size = $size; Date = $date; Item = $item; Path = $null }
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
        for ($n = 0; $n -lt $Items.Count; $n++) {
            $m = $Items[$n]
            $target = Join-Path $Incoming $m.Rel
            if (Test-Path -LiteralPath $target) { continue }
            $shell.Namespace($dests[$n]).CopyHere($m.Item, 4 + 16)
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

# Long jobs (reading the phone, copying, deleting) answer with one JSON line per progress step.
function Start-Stream($Ctx) {
    $res = $Ctx.Response
    $res.SendChunked = $true
    $res.ContentType = 'application/x-ndjson; charset=utf-8'
    $res
}

function Send-Line($Res, $Object) {
    $bytes = $Utf8.GetBytes((ConvertTo-Json -InputObject $Object -Depth 5 -Compress) + "`n")
    $Res.OutputStream.Write($bytes, 0, $bytes.Length)
    $Res.OutputStream.Flush()
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

function ConvertTo-Day($Text) { if ($Text) { [datetime]::ParseExact($Text, 'yyyy-MM-dd', $null) } }

# ---------------------------------------------------------------- the steps the page asks for

function Get-PhoneStatus {
    $devices = @(Find-Phones)
    $ready = @($devices | Where-Object { $_.Photos })
    if ($ready) { $State.Phone = $ready[0]; return @{ name = $ready[0].Name; ready = $true } }
    $State.Phone = $null
    if ($devices) { return @{ name = $devices[0].Name; ready = $false } }
    $null
}

function Invoke-PickFolder($Ctx) {
    # An invisible always-on-top window, brought to the front, owns the picker so it opens on top
    # of the browser instead of hiding behind it.
    $owner = New-Object System.Windows.Forms.Form -Property @{
        TopMost = $true; ShowInTaskbar = $false; FormBorderStyle = 'None'; Opacity = 0
        StartPosition = 'CenterScreen'; Size = (New-Object System.Drawing.Size 1, 1)
    }
    try {
        $owner.Show()
        [TripSorter.FolderPicker]::BringToFront($owner.Handle)
        $path = [TripSorter.FolderPicker]::Pick($owner.Handle, 'Choose the folder with your trip photos')
    } finally { $owner.Dispose() }
    Send-Json $Ctx @{ path = $path }
}

# Lists what would be copied: phone photos in the trip dates, or every photo in a folder.
function Invoke-Scan($Ctx) {
    $req = Read-Body $Ctx | ConvertFrom-Json
    $State.Mode = $req.mode
    $State.From = ConvertTo-Day $req.from
    $State.Until = ConvertTo-Day $req.until
    $State.Items.Clear()
    $res = Start-Stream $Ctx
    $seen = 0; $skipped = 0

    if ($req.mode -eq 'folder') {
        $root = (Resolve-Path -LiteralPath $req.path).ProviderPath.TrimEnd('\')
        $State.Source = $root
        Send-Line $res @{ type = 'progress'; found = 0; where = $root }
        foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File) {
            if ($MediaExt -notcontains $f.Extension.ToLower()) { continue }
            $rel = $f.FullName.Substring($root.Length + 1)
            [void]$State.Items.Add([pscustomobject]@{ Name = $f.Name; Folder = (Split-Path $rel); Rel = $rel; Size = $f.Length; Date = $f.LastWriteTime; Item = $null; Path = $f.FullName })
            if ($State.Items.Count % 50 -eq 0) { Send-Line $res @{ type = 'progress'; found = $State.Items.Count } }
        }
    } else {
        if (-not $State.Phone) { [void](Get-PhoneStatus) }
        if (-not $State.Phone) { Send-Line $res @{ type = 'error'; message = 'Your phone is not connected or is locked.' }; return }
        $ledger = @{}
        if ($req.skipImported -and (Test-Path -LiteralPath $LedgerPath)) { foreach ($line in [IO.File]::ReadAllLines($LedgerPath)) { $ledger[$line] = $true } }
        Send-Line $res @{ type = 'progress'; found = 0; where = $State.Phone.Name }
        foreach ($m in Get-PhoneMedia $State.Phone.Photos '' $State.From $State.Until) {
            $seen++
            if ($seen % 25 -eq 0) { Send-Line $res @{ type = 'progress'; found = $State.Items.Count; where = $m.Folder } }
            # Files without a date are kept rather than silently left behind.
            if ($m.Date -and (($State.From -and $m.Date.Date -lt $State.From) -or ($State.Until -and $m.Date.Date -gt $State.Until))) { continue }
            if ($ledger[(Get-LedgerKey $m)]) { $skipped++; continue }
            [void]$State.Items.Add($m)
        }
    }

    $videos = @($State.Items | Where-Object { $VideoExt -contains [IO.Path]::GetExtension($_.Name).ToLower() }).Count
    $days = @($State.Items | Where-Object { $_.Date } | Group-Object { $_.Date.ToString('yyyy-MM-dd') } | Sort-Object Name |
        ForEach-Object { @{ date = $_.Name; count = $_.Count } })
    $bytes = ($State.Items | Measure-Object -Property Size -Sum).Sum
    Send-Line $res @{
        type = 'done'; total = $State.Items.Count; photos = $State.Items.Count - $videos; videos = $videos
        where = $(if ($req.mode -eq 'folder') { $State.Source } else { $State.Phone.Name })
        bytes = [int64]$bytes; skipped = $skipped; days = $days
    }
}

function Get-LedgerKey($M) { "$($State.Phone.Name)|$($M.Rel)|$(if ($M.Date) { $M.Date.ToString('s') })" }

# Copies the scanned files into <Trip Photos>\<trip>\_incoming, then prepares the sorting session.
function Invoke-Copy($Ctx) {
    $req = Read-Body $Ctx | ConvertFrom-Json
    $name = Get-SafeName $req.trip
    if (-not $name) { $name = "Trip $(Get-Date -Format 'yyyy-MM-dd')" }
    $State.TripName = $name
    $State.TripDir = Get-UniquePath (Join-Path $TripsRoot $name)
    $State.Incoming = Join-Path $State.TripDir '_incoming'
    [void][IO.Directory]::CreateDirectory($State.Incoming)
    $res = Start-Stream $Ctx

    $items = @($State.Items)
    for ($i = 0; $i -lt $items.Count; $i += 20) {
        $batch = @($items[$i..([Math]::Min($i + 19, $items.Count - 1))])
        if ($State.Mode -eq 'phone') {
            Copy-FromPhone $batch $State.Incoming
        } else {
            foreach ($f in $batch) {
                $dest = Join-Path $State.Incoming $f.Rel
                [void][IO.Directory]::CreateDirectory((Split-Path $dest))
                [IO.File]::Copy($f.Path, $dest, $true)
            }
        }
        Send-Line $res @{ type = 'progress'; done = $i + $batch.Count; total = $items.Count }
    }

    $copied = @($items | Where-Object { Test-Path -LiteralPath (Join-Path $State.Incoming $_.Rel) })
    if ($State.Mode -eq 'phone' -and $copied) {
        [IO.File]::AppendAllLines($LedgerPath, [string[]]@($copied | ForEach-Object { Get-LedgerKey $_ }), $Utf8)
    }
    $State.Copied = $copied

    $State.Files = @(Get-ChildItem -LiteralPath $State.Incoming -Recurse -File | Where-Object { $MediaExt -contains $_.Extension.ToLower() } | Sort-Object FullName)
    $State.Session = @{
        trip = $State.TripName; tripDir = $State.TripDir; fromPhone = ($State.Mode -eq 'phone')
        phoneName = $(if ($State.Phone) { $State.Phone.Name })
        files = @(for ($i = 0; $i -lt $State.Files.Count; $i++) {
            $f = $State.Files[$i]
            @{
                id = $i; name = $f.Name; ext = $f.Extension.ToLower(); size = $f.Length; date = $f.LastWriteTime.ToString('s')
                kind = $(if ($VideoExt -contains $f.Extension.ToLower()) { 'video' } else { 'photo' })
            }
        })
    }
    Send-Line $res @{ type = 'done'; copied = $copied.Count; failed = $items.Count - $copied.Count; tripDir = $State.TripDir }
}

function Invoke-Apply($Ctx) {
    if ($State.Applied) { Send-Text $Ctx 409 'Already sorted.'; return }
    $data = Read-Body $Ctx | ConvertFrom-Json
    $manifest = New-Object System.Collections.ArrayList
    $folders = @{}
    foreach ($a in $data.assignments) {
        $file = $State.Files[[int]$a.id]
        $segments = @(($a.folder -split '/') | ForEach-Object { Get-SafeName $_ } | Where-Object { $_ -and $_ -ne '..' })
        if (-not $segments) { $segments = @($Settings.otherFolder) }
        $destDir = $State.TripDir
        foreach ($s in $segments) { $destDir = Join-Path $destDir $s }
        [void][IO.Directory]::CreateDirectory($destDir)
        $dest = Get-UniquePath (Join-Path $destDir $file.Name)
        [IO.File]::Move($file.FullName, $dest)
        $folders[$destDir] = $true
        [void]$manifest.Add([ordered]@{
            original = $file.FullName.Substring($State.Incoming.Length + 1)
            sorted   = $dest.Substring($State.TripDir.Length + 1)
            category = $segments -join '/'
            bytes    = $file.Length
        })
    }
    $leftover = @(Get-ChildItem -LiteralPath $State.Incoming -Recurse -File).Count
    if ($leftover -eq 0) { Remove-Item -LiteralPath $State.Incoming -Recurse -Force }
    [IO.File]::WriteAllText((Join-Path $State.TripDir 'sorting-log.json'), (ConvertTo-Json -InputObject $manifest -Depth 4), $Utf8)
    $State.Applied = $true
    $State.Manifest = $manifest
    Send-Json $Ctx @{ ok = $true; tripDir = $State.TripDir; moved = $manifest.Count; folders = $folders.Count; leftover = $leftover; deletable = @(Get-SafeToDelete).Count }
}

# Phone files whose laptop copy exists in the trip folder with exactly the same size.
function Get-SafeToDelete {
    if ($State.Mode -ne 'phone' -or -not $State.Applied) { return }
    $sortedByOriginal = @{}
    foreach ($entry in $State.Manifest) { $sortedByOriginal[$entry.original] = $entry }
    foreach ($m in $State.Copied) {
        $entry = $sortedByOriginal[$m.Rel]
        if (-not $entry -or $entry.bytes -le 0) { continue }
        $onLaptop = Join-Path $State.TripDir $entry.sorted
        if ((Test-Path -LiteralPath $onLaptop) -and (Get-Item -LiteralPath $onLaptop).Length -eq $entry.bytes) { $m }
    }
}

# Runs only when the person presses the confirmed delete button on the page.
function Invoke-Delete($Ctx) {
    if ($State.Deleted) { Send-Text $Ctx 409 'Already done.'; return }
    $safe = @(Get-SafeToDelete)
    $res = Start-Stream $Ctx
    if (-not $safe) { Send-Line $res @{ type = 'done'; deleted = 0; total = 0; message = 'Nothing was verified on the laptop, so nothing was deleted.' }; return }
    $State.Deleted = $true
    $problem = $null
    for ($i = 0; $i -lt $safe.Count; $i += 25) {
        $batch = @($safe[$i..([Math]::Min($i + 24, $safe.Count - 1))])
        try { [void][TripSorter.ShellOps]::Delete([object[]]@($batch | ForEach-Object { $_.Item.psobject.BaseObject })) }
        catch { $problem = $_.Exception.Message }
        Send-Line $res @{ type = 'progress'; done = $i + $batch.Count; total = $safe.Count }
    }
    Send-Line $res @{ type = 'checking' }
    $stillThere = @{}
    foreach ($m in Get-PhoneMedia $State.Phone.Photos '' $State.From $State.Until) { $stillThere[$m.Rel] = $true }
    $deleted = @($safe | Where-Object { -not $stillThere[$_.Rel] }).Count
    Send-Line $res @{ type = 'done'; deleted = $deleted; total = $safe.Count; message = $problem }
}

function Invoke-Request($Ctx) {
    $path = $Ctx.Request.Url.AbsolutePath
    $post = $Ctx.Request.HttpMethod -eq 'POST'
    switch -Regex ($path) {
        '^/$' { Send-File $Ctx (Join-Path $AppDir 'app\index.html'); return }
        '^/(app\.js|style\.css)$' { Send-File $Ctx (Join-Path $AppDir "app\$($Matches[1])"); return }
        '^/settings\.json$' { Send-File $Ctx (Join-Path $AppDir 'settings.json'); return }
        '^/api/ping$' { Send-Text $Ctx 200 'trip-photo-sorter'; return }
        '^/api/status$' {
            Send-Json $Ctx @{ tripsRoot = $TripsRoot; phone = (Get-PhoneStatus); hasSession = [bool]$State.Session; applied = $State.Applied }
            return
        }
        '^/api/session$' { if ($State.Session) { Send-Json $Ctx $State.Session } else { Send-Text $Ctx 404 'No trip yet' }; return }
        '^/media/(\d+)$' {
            $i = [int]$Matches[1]
            if ($i -lt $State.Files.Count -and -not $State.Applied) { Send-File $Ctx $State.Files[$i].FullName } else { Send-Text $Ctx 404 'Not found' }
            return
        }
        '^/api/pick-folder$' { if ($post) { Invoke-PickFolder $Ctx; return } }
        '^/api/scan$' { if ($post) { Invoke-Scan $Ctx; return } }
        '^/api/copy$' { if ($post) { Invoke-Copy $Ctx; return } }
        '^/api/apply$' { if ($post) { Invoke-Apply $Ctx; return } }
        '^/api/report$' {
            if ($post) {
                [IO.File]::WriteAllText((Join-Path $State.TripDir 'Sorting report.html'), (Read-Body $Ctx), $Utf8)
                Send-Json $Ctx @{ ok = $true }; return
            }
        }
        '^/api/delete$' { if ($post) { Invoke-Delete $Ctx; return } }
        '^/api/open-folder$' {
            if ($post) {
                if ($State.TripDir -and -not $NoBrowser) { Start-Process explorer.exe -ArgumentList "`"$($State.TripDir)`"" }
                Send-Json $Ctx @{ ok = $true }; return
            }
        }
        '^/api/finish$' { if ($post) { $State.Finished = $true; Send-Json $Ctx @{ ok = $true }; return } }
    }
    Send-Text $Ctx 404 'Not found'
}

# ---------------------------------------------------------------- start

try {
    $Url = "http://localhost:$Port/"
    # Already running (double-clicked twice)? Just show the page again.
    try {
        if ((Invoke-WebRequest -UseBasicParsing "$($Url)api/ping" -TimeoutSec 2).Content -eq 'trip-photo-sorter') {
            if (-not $NoBrowser) { Start-Process $Url }
            return
        }
    } catch {}

    $TripsRoot = $TripsFolder
    if (-not $TripsRoot -and $Settings.tripsFolder) { $TripsRoot = [Environment]::ExpandEnvironmentVariables($Settings.tripsFolder) }
    if (-not $TripsRoot) { $TripsRoot = Join-Path $env:USERPROFILE 'Trip Photos' }
    [void][IO.Directory]::CreateDirectory($TripsRoot)
    $LedgerPath = Join-Path $TripsRoot '.imported-from-phone.txt'

    $State = @{
        Phone = $null; Mode = $null; Source = $null; From = $null; Until = $null
        Items = (New-Object System.Collections.ArrayList); Copied = @()
        TripName = $null; TripDir = $null; Incoming = $null; Files = @(); Session = $null
        Applied = $false; Manifest = $null; Deleted = $false; Finished = $false; LastSeen = Get-Date
    }

    $Listener = $null
    for ($p = $Port; $p -lt $Port + 20 -and -not $Listener; $p++) {
        $candidate = New-Object System.Net.HttpListener
        $candidate.Prefixes.Add("http://localhost:$p/")
        try { $candidate.Start(); $Listener = $candidate; $Url = "http://localhost:$p/" } catch { $candidate.Close() }
    }
    if (-not $Listener) { throw "Could not start the sorter page on ports $Port-$($Port + 19)." }

    Say ""
    Say "  Trip Photo Sorter is open in your browser: $Url" Magenta
    Say "  This window closes by itself when you press Done (or 30 minutes after you close the page)."
    if (-not $NoBrowser) { Start-Process $Url }

    try {
        while (-not $State.Finished) {
            $pending = $Listener.BeginGetContext($null, $null)
            while (-not $pending.AsyncWaitHandle.WaitOne(300)) {   # short waits keep Ctrl+C working
                if (((Get-Date) - $State.LastSeen).TotalMinutes -gt $IdleMinutes) { $State.Finished = $true; break }
            }
            if ($State.Finished) { break }
            $ctx = $Listener.EndGetContext($pending)
            $State.LastSeen = Get-Date
            try { Invoke-Request $ctx }
            catch {
                Say "Error: $($_.Exception.Message)" Yellow
                try { Send-Text $ctx 500 $_.Exception.Message } catch {}
            }
            finally { try { $ctx.Response.Close() } catch {} }
            $State.LastSeen = Get-Date
        }
    } finally { $Listener.Close() }
} catch {
    [void][System.Windows.Forms.MessageBox]::Show("Trip Photo Sorter could not start:`n`n$($_.Exception.Message)", 'Trip Photo Sorter', 'OK', 'Error')
    throw
}
