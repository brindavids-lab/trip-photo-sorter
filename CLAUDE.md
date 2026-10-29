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

Otherwise this downloads and installs the latest version:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/brindavids-lab/trip-photo-sorter/main/install.ps1 | iex"
```

It copies the app to `%LOCALAPPDATA%\TripPhotoSorter` and adds a **Sort My Trip** shortcut to the
Desktop and Start menu. Running it again updates the app and keeps the person's `settings.json`.

## 3. Run it

The sorter is interactive: it asks the person for the trip name, the trip dates and, at the end,
whether to delete the photos from their phone. So **do not run `SortTrip.ps1` in your own
terminal**. Open it in its own window for the person:

```powershell
Start-Process "$env:LOCALAPPDATA\TripPhotoSorter\Sort My Trip.bat"
```

or tell them to double-click **Sort My Trip** on the Desktop. Before that, remind them to plug in the
phone with a cable, **unlock it**, and tap **Trust** (iPhone) or choose **File transfer** (Android).

## Rules

- **Never answer the delete question for the person**, never type `YES` into that window, and
  never delete photos from a phone yourself. That decision is theirs alone.
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
| Phone deletion reports fewer files deleted | On iPhone with iCloud Photos on, Windows can't delete; delete in the Photos app instead. |
| Port 8765 busy | The script tries the next 19 ports automatically. |
| Many photos in *Other* | Lower `minConfidence` in settings.json, or add more descriptions to a category. |

To uninstall: `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\TripPhotoSorter\install.ps1" -Uninstall`
(the person's photos are never touched).
