# Instructions for Claude (and other AI assistants)

People will paste this repository's link into Claude and ask you to "install it", "set it up" or
"run it". The person is usually not technical. Do this:

## 1. Check the computer

- It only works on **Windows 10 or 11**. On a Mac or Linux, say so and stop.
- No admin rights, Python, Node or Git are needed. It uses Windows PowerShell 5.1 and Edge or Chrome.

## 2. Install

Read `install.ps1` first, then run it. If you already cloned or downloaded the repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Otherwise download the installer to a file, read it, then run it with `-File`. It notices it has no
app files next to it and downloads the latest version from GitHub:

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/brindavids-lab/trip-photo-sorter/main/install.ps1 -OutFile "$env:TEMP\trip-photo-sorter-install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\trip-photo-sorter-install.ps1"
```

(From Git Bash: `curl -fsSL <same URL> -o "$TEMP/trip-photo-sorter-install.ps1"` then the same
`powershell ... -File` line.) Don't wrap `irm ... | iex` inside `powershell -Command "..."`: nested
quoting breaks it. That one-liner is only for people pasting it straight into a PowerShell window.

It copies the app to `%LOCALAPPDATA%\TripPhotoSorter` and adds a **Sort My Trip** shortcut to the
Desktop and Start menu. Running it again updates the app and keeps the person's `settings.json`.

## 3. Run it

Start it for the person:

```powershell
Start-Process "$env:LOCALAPPDATA\TripPhotoSorter\Sort My Trip.bat"
```

or tell them to double-click **Sort My Trip** on the Desktop. A small helper starts minimized and
opens `http://localhost:8765` in their browser; everything else happens on that page (phone
status, trip name, date pickers, sorting, review). Before that, remind them to plug in the phone
with a cable, **unlock it**, and tap **Trust** (iPhone) or choose **File transfer** (Android) — or to
put the camera's memory card in the card reader / plug in the USB stick. All of these are detected.
The helper closes itself when they press **Done**, or 30 minutes after the page is closed.

## Rules

- **Never press "Delete them from my phone/card" or "Yes, delete from phone/card" for the person**, never
  call `/api/delete` yourself, and never delete photos from a phone in any other way. That
  decision is theirs alone, even if browser tools would let you click it.
- Don't move, rename or delete anything in `%USERPROFILE%\Trip Photos` unless asked.
- The photos stay on the computer. The only downloads are the app, the AI model (from
  huggingface.co, cached by the browser) and two JavaScript libraries from cdn.jsdelivr.net.

## Changing the folders

Folders are defined in `%LOCALAPPDATA%\TripPhotoSorter\settings.json` (`categories`: a folder name
plus short English descriptions the AI compares each photo with). Keep it valid JSON. The README
explains every setting.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "I can see 'Apple iPhone' but not its photos" | Unlock the phone, tap **Trust**, unplug and plug in again. |
| "No phone found" (Android) | USB notification → **File transfer / Android Auto**, not "Charging only". |
| Browser page stuck on "Downloading the AI model" | Needs internet once (about 230 MB). Corporate proxies may block huggingface.co. |
| Card or USB stick not shown | Only removable drives are listed; external hard disks aren't. Use **or sort a folder** for those. |
| Phone deletion reports fewer files deleted | On iPhone with iCloud Photos on, Windows can't delete; delete in the Photos app instead. |
| Port 8765 busy | The script tries the next 19 ports automatically. |
| Many photos in *Other* | Lower `minConfidence` in settings.json, or add more descriptions to a category. |

To uninstall: `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\TripPhotoSorter\install.ps1" -Uninstall`
(the person's photos are never touched).
