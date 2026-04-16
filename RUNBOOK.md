# GOODTrackBets — Runbook

Phone-friendly live-odds entry + LightGBM prediction for Keeneland, hosted
on GitHub Pages with a `repository_dispatch` workflow running the model
and committing `predictions.json` back to the repo.

**Race day:** Saturday **2026-04-11**.

---

## 0. Architecture (1-minute read)

```
  Phone (GitHub Pages)                GitHub Actions                 Repo
  ┌──────────────────┐    dispatch    ┌──────────────────┐   commit   ┌──────────┐
  │ docs/index.html  │ ─────────────► │  predict.yml     │ ─────────► │predictions│
  │ docs/app.js      │                │  apply_edits.py  │            │  .json   │
  │ docs/style.css   │ ◄───── poll ── │  predict.py      │ ◄───────── │          │
  └──────────────────┘                │  predict_api.py  │            └──────────┘
                                      └──────────────────┘
```

1. Phone opens `https://greygoodwin.github.io/GOODTrackBets/`
2. Page fetches `HorseRacing/keeneland_2026-04-11.csv` via GitHub Contents API
3. You edit odds / scratches / add AEs
4. Tap **Run Model** → page fires a `repository_dispatch` to the Action
5. Action merges your edits into `test_data.csv`, runs `predict.py`, runs
   `predict_api.py`, commits `predictions.json`
6. Page polls the Contents API for fresh `predictions.json`, renders results

Latency per run: **~30–60 seconds** (Action cold-start is the bottleneck).

---

## 1. One-time setup (do this today, not race morning)

### 1a. Create the GitHub repo

1. On github.com, click **New repository**
2. Name: `GOODTrackBets`
3. Visibility: **Public** (required for free GitHub Pages)
4. Do NOT initialize with README (we have files)
5. Click **Create**

### 1b. Push this local folder to the new repo

From `/Users/greylgoodwin/Desktop/Keeneland`:

```bash
cd /Users/greylgoodwin/Desktop/Keeneland
git init
git branch -M main
git add .
git commit -m "initial import: GOODTrackBets"
git remote add origin https://github.com/greygoodwin/GOODTrackBets.git
git push -u origin main
```

**⚠️ Before committing, double-check the models are going up:**
```bash
ls -lh HorseRacing/models/
```
All three `.pkl` files must exist and be <100 MB each. If any is >100 MB,
you'll need Git LFS — tell me and I'll set it up.

Also verify no secrets are being committed:
```bash
git status
```
There should be no `.env`, no token files.

### 1c. Enable GitHub Pages

1. Go to `https://github.com/greygoodwin/GOODTrackBets/settings/pages`
2. **Source:** "Deploy from a branch"
3. **Branch:** `main` / folder `/docs`
4. Save

Your site will be live at **https://greygoodwin.github.io/GOODTrackBets/** in 1–2 minutes.

### 1d. Generate a fine-grained Personal Access Token

1. Go to https://github.com/settings/personal-access-tokens/new
2. **Token name:** `GOODTrackBets-dispatch`
3. **Expiration:** 30 days (or 7, whatever)
4. **Resource owner:** your account
5. **Repository access:** "Only select repositories" → `GOODTrackBets`
6. **Permissions → Repository permissions:**
    - **Actions:** Read and write
    - **Contents:** Read and write *(needed so the page can read the CSV and poll predictions.json; write is only used server-side by the Action itself)*
    - **Metadata:** Read (auto-selected)
7. Click **Generate token** and copy it (it won't be shown again)

You'll paste it into the page's PAT modal on first load. It's stored in
your phone's `localStorage`.

**If leaked:** worst case is someone triggers your prediction workflow
and reads your public repo. No account-wide access. If you ever want to
kill it, come back to the same settings page and revoke.

---

## 2. Day-before (Friday 2026-04-10) — scrape Saturday's card

The frontend loads `HorseRacing/keeneland_2026-04-11.csv`. You need to
produce that file and commit it.

### 2a. Launch Chrome with a remote-debug port (macOS)

The scraper attaches to a real Chrome to dodge Equibase's bot detection.

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug-goodtrackbets
```

This opens a **separate** Chrome profile (not your main one). Let it sit
on a blank tab — the scraper will drive it.

### 2b. Run the entries scraper

In a new terminal:

```bash
cd /Users/greylgoodwin/Desktop/Keeneland/HorseRacing
pip install playwright
python -m playwright install chromium   # first time only
python scraper_entries.py \
  --track KEE \
  --date 2026-04-11 \
  --output keeneland_2026-04-11.csv
```

Output: `HorseRacing/keeneland_2026-04-11.csv`.

### 2c. Spot-check the CSV

```bash
head -3 HorseRacing/keeneland_2026-04-11.csv
wc -l HorseRacing/keeneland_2026-04-11.csv
```

You should see the expected races (usually 8–10 for Keeneland Saturdays)
with horses, jockeys, trainers, posts, morning-line odds.

### 2d. Commit and push

```bash
cd /Users/greylgoodwin/Desktop/Keeneland
git add HorseRacing/keeneland_2026-04-11.csv
git commit -m "add Saturday 2026-04-11 Keeneland card"
git push
```

**Note:** this filename is NOT in `HorseRacing/.gitignore` — only the
literal `test_data.csv` is ignored. So this commit will work as expected.

---

## 3. Race day (Saturday 2026-04-11)

### 3a. Open the site on your phone
**https://greygoodwin.github.io/GOODTrackBets/**

Bookmark it / add to Home Screen for quick access.

### 3b. First load — paste the PAT

A modal will pop up asking for your GitHub token. Paste the PAT from 1d.
It's saved to `localStorage` — you won't be asked again on this phone
unless you tap "reset token" in the footer.

### 3c. For each race

1. Tap the race tab (R1, R2, ...) at the top
2. Check the entries table — horse names, jockeys, trainers, posts
3. **Scratches:** tap the ✕ checkbox next to any scratched horse
4. **AE/standby:** tap **+ Add horse** and fill in the modal
5. **Live odds:** tap the Odds column for each horse and type the current
   tote board odds (`7.5` for 7-to-1, `0.8` for 4-to-5, etc.)
6. Tap **Run Model**
7. Wait ~30–60 seconds. Status pill will show: `dispatching` → `running` → `done`
8. Results table appears below with:
   - **Rank** (model's predicted finish order)
   - **Model %** (model-implied win probability)
   - **Mkt %** (market-implied win probability from your entered odds)
   - **Edge** — **green = value**, red = overbet

Re-run as many times as you want. Each run is a fresh predictions.json
commit; the page auto-picks up the newest one.

### 3d. Reading the output

- **Model % >> Mkt %** → model thinks the horse is undervalued by the
  board. That's a *potential* value bet. The model's win-pick accuracy
  is ~86% (per the README) but remember RMSE is ~2.16 positions, so
  these are noisy signals, not certainties.
- **Top-3 accuracy is ~68%** — the ranking is more trustworthy than the
  exact finish position.
- **AE horses:** lower confidence. They use default past-performance
  stats because the scraper didn't enrich them.

---

## 4. Troubleshooting

| Symptom | Fix |
|---|---|
| Page shows "no card" | Confirm `HorseRacing/keeneland_2026-04-11.csv` is committed and pushed to `main`. Tap "reload card". |
| PAT rejected | Check the PAT has Actions: write + Contents: read/write scopes for *this specific repo*. Tap "reset token" and re-enter. |
| "Dispatch failed 404" | Repo name mismatch. Verify `OWNER`/`REPO` constants at top of `docs/app.js`. |
| Status stuck on "running" >3 min | Action may have crashed. Check https://github.com/greygoodwin/GOODTrackBets/actions for the failed run's logs. |
| Results table empty | `predict.py` may have errored silently. Check Actions logs. |
| Scraper fails Friday | Equibase may have changed DOM. Fall back: hand-edit `keeneland_2026-04-11.csv` using the model's column format (see `HorseRacing/test_data.csv` as an example), commit, push. |

---

## 5. File map

```
Keeneland/
├── docs/                         # GitHub Pages (phone UI)
│   ├── index.html
│   ├── app.js
│   └── style.css
├── .github/
│   ├── workflows/
│   │   └── predict.yml           # repository_dispatch handler
│   └── scripts/
│       └── apply_edits.py        # merges dispatch edits into test_data.csv
├── HorseRacing/
│   ├── predict.py                # (unchanged) model inference
│   ├── predict_api.py            # NEW — CSV → predictions.json converter
│   ├── models/*.pkl              # LightGBM model + preprocessor + JT lookup
│   ├── scraper_entries.py        # Friday: pulls Saturday's card from Equibase
│   └── keeneland_2026-04-11.csv  # Friday: commit this
├── predictions.json              # written by the Action on each run
└── RUNBOOK.md                    # you are here
```
