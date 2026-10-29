# Trip Photo Sorter

Back from a trip? Plug your phone into your Windows laptop, double-click one file, and your
photos and videos get copied off the phone, sorted by AI into folders like **Me & selfies**,
**Group photos**, **Nature**, **Food & cafés** and **Travel & vibe**, and then you're asked
whether to delete them from the phone.

- **Nothing to install.** It uses PowerShell (built into Windows) and your web browser (Edge or Chrome).
- **Private.** The AI runs inside your browser on your own laptop. Your photos are never uploaded.
  The only download is the AI model itself (about 150–250 MB, the first time only).
- **Safe.** Nothing is deleted from the phone unless every file has been checked on the laptop
  *and* you confirm it. Duplicates go into a folder for you to check, not the bin.

## Install

Free for anyone. Pick one way:

**A. Let Claude do it.** Open the Claude desktop app, go to the **Code** tab (or use Claude Code),
and paste:

> Install and set up this for me: https://github.com/brindavids-lab/trip-photo-sorter

Claude reads [CLAUDE.md](CLAUDE.md), installs it and puts a **Sort My Trip** shortcut on your
Desktop. (A normal Claude chat on the website can't install things on your computer, so use the
Code tab.)

**B. One line in PowerShell.** Press Start, type *PowerShell*, open it and paste:

```powershell
irm https://raw.githubusercontent.com/brindavids-lab/trip-photo-sorter/main/install.ps1 | iex
```

**C. By hand.** Green **Code** button → **Download ZIP**, unzip it, then double-click
`Sort My Trip.bat` inside the folder (no shortcut is created this way).

To uninstall, run `install.ps1 -Uninstall`. Your photos are never touched.

## How to use it

1. Plug in your phone with a cable and **unlock it**.
   - **iPhone:** tap **Trust** when asked. Tip: in *Settings → Apps → Photos → Transfer to Mac or PC*
     choose **Automatic**, so photos arrive as normal JPGs that every browser can read.
   - **Android:** pull down the notification bar, tap the USB notification and pick **File transfer**.
2. Double-click **Sort My Trip** on your Desktop (or ask Claude to start it). The sorter opens in
   your browser and shows a green dot when it sees your phone.
3. Give the trip a name and pick the **first and last day** with the date pickers (or tap
   *Last week*, *Last 2 weeks*, ...). Press **Find my trip photos**.
4. Check what it found — photos and videos per day — and press **Copy to my laptop & sort**.
5. Watch the photos fly out of the pile into folders. When it says **All sorted**, click any
   folder to check it; if the AI got one wrong, pick the right folder under that photo.
6. Press **Create the folders on my laptop**.
7. Optional: press **Delete them from my phone** to free up space. It only offers this after
   checking every file on the laptop, and asks you to confirm first. Then press **Done**.

There is no black window to type into: the small helper runs minimized in the taskbar and closes
itself when you press **Done**.

You end up with:

```
Trip Photos\
  Bali 2026\
    Photos\
      Me & selfies\
      Group photos\
      Nature\
      Food & cafés\
      ...
    Videos\
      ...
    Duplicates - to trash\     <- look through these, then delete the folder
    Sorting report.html        <- a page with every folder and preview pictures
    sorting-log.json           <- which original file went where
```

### Sort a folder instead of a phone

If your photos are already on the laptop (an SD card, a Google Photos export, ...), click
**or sort a folder that's already on this laptop** on the start screen and pick the folder.
The original folder is copied, never changed.

## The folders

| Folder | What goes in it |
| --- | --- |
| Me & selfies | Selfies and photos of one person |
| Group photos | Two or more people posing together |
| Outfits | Mirror selfies and outfit shots |
| Food & cafés | Meals, coffee, drinks, desserts |
| Nature | Beaches, mountains, forests, sunsets |
| Travel & vibe | Landmarks, streets, cities, airports |
| Aesthetic spaces | Hotel rooms, nice interiors, pools |
| Sport & wellness | Hiking, skiing, surfing, gym, spa |
| Music & hobby | Concerts, festivals, museums |
| Animals | Pets and wildlife |
| Text & documents | Tickets, receipts, signs, menus |
| Screenshots | Phone screenshots (every `.png` from the camera roll) |
| Other | Anything the AI isn't sure about, or can't open |
| Duplicates - to trash | Exact copies and near-identical burst shots |

Videos are sorted the same way, using a frame from about one second into each clip.

### Change the folders

Open `settings.json` in Notepad. Each category has a folder name and a few short
descriptions ("prompts") the AI compares each photo against. Add, rename or remove categories
freely — for example a `"Work from home"` folder, or `"Weddings"` with prompts like
`"a bride and groom"`. Other settings:

| Setting | Meaning |
| --- | --- |
| `tripsFolder` | Where trip folders go. Empty = `C:\Users\<you>\Trip Photos`. You can use `%USERPROFILE%\Desktop\Trips`. |
| `minConfidence` | 0–1. Higher = more photos go to *Other* instead of a possibly wrong folder. |
| `duplicateSimilarity` | 0–1. Lower = more burst shots count as duplicates. |
| `pngIsScreenshot` | Put every PNG into *Screenshots* (phones save screenshots as PNG; cameras never do). |
| `aiModel` | The [CLIP](https://openai.com/research/clip) model. `Xenova/clip-vit-base-patch16` is a bit more accurate but slower. |

## Good to know

- **How accurate is it?** On a test set of 27 everyday photos it put 22 in the right folder,
  including all group photos. The check-and-fix step is there for the rest.
- **Speed:** fast on laptops whose browser can use the graphics chip (WebGPU); otherwise it runs on
  the processor and takes longer. The page shows a time estimate while it works.
- **HEIC photos** (iPhone "High Efficiency") are converted in the browser, which is slow. Setting the
  iPhone to *Transfer → Automatic* (see above) avoids that.
- **Videos** that the browser can't play (some iPhone HEVC videos on older PCs) go to *Videos/Other*.
- **Deleting from an iPhone** over the cable fails when *iCloud Photos* is switched on — the script
  tells you, and you can delete them in the Photos app instead. Deleting over the cable is
  permanent on the phone (no *Recently Deleted*), which is why the laptop copies are verified first.
- **Already imported?** Every file copied from the phone is remembered in
  `Trip Photos\.imported-from-phone.txt`, so the next trip only picks up new photos.
- **Work laptop?** If your Pictures folder syncs to a company OneDrive, that's why the default
  location is `C:\Users\<you>\Trip Photos` and not Pictures.

## How it works

`SortTrip.ps1` finds the phone through the Windows Shell (phones are "portable devices", not
drives), copies the files with the same engine File Explorer uses, then starts a tiny web server
on `http://localhost:8765` that only your browser can reach. The page (`app/`) runs the CLIP
model with [transformers.js](https://github.com/huggingface/transformers.js), compares each
picture with every category description, and sends back one folder per file. The script moves
the files, writes the report, checks each copy against the phone's list, and only then offers
to delete.

## License

MIT
