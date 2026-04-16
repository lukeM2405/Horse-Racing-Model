"""
Delete superseded prediction files for the same (track_code, card_date, race_number).

A file is deleted when ALL of the following are true:
  - It lives in predictions/run_*.json
  - Its embedded track_code matches TRACK_CODE env
  - Its embedded card_date matches CARD_DATE env
  - It contains race_number RACE_NUM (in the races dict keys)
  - Its filename does NOT match the current run (KEEP_RUN_ID)
  - Its mtime is older than MIN_AGE_SECONDS (default 120s)

The MIN_AGE_SECONDS guard prevents deleting files that another user's UI
is still polling for in the brief window between dispatch and rendering.

Scoping by track_code ensures that two tracks running races on the same
date (e.g. KEE R5 and CD R5 both on 2026-05-04) do not clobber each other.
"""
import json
import os
import sys
import time
from pathlib import Path

PRED_DIR = Path("predictions")


def main():
    keep = os.environ.get("KEEP_RUN_ID", "")
    track_code = os.environ.get("TRACK_CODE", "").upper()
    card_date = os.environ.get("CARD_DATE", "")
    race_num = os.environ.get("RACE_NUM", "")
    min_age = int(os.environ.get("MIN_AGE_SECONDS", "120"))

    if not track_code or not card_date or not race_num:
        print("Skipping cleanup: TRACK_CODE / CARD_DATE / RACE_NUM not all set")
        return

    race_key = str(int(race_num))
    keep_name = f"run_{keep}.json"
    cutoff_mtime = time.time() - min_age

    deleted = []
    skipped_recent = []
    for path in sorted(PRED_DIR.glob("run_*.json")):
        if path.name == keep_name:
            continue
        try:
            data = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError) as e:
            print(f"  skip {path.name}: unreadable ({e})")
            continue

        if (data.get("track_code") or "").upper() != track_code:
            continue
        if data.get("card_date") != card_date:
            continue
        if race_key not in (data.get("races") or {}):
            continue

        if path.stat().st_mtime > cutoff_mtime:
            skipped_recent.append(path.name)
            continue

        path.unlink()
        deleted.append(path.name)

    print(f"Cleanup for track={track_code} card={card_date} race={race_key}: "
          f"deleted {len(deleted)}, kept-recent {len(skipped_recent)}")
    for n in deleted:
        print(f"  - deleted {n}")
    for n in skipped_recent:
        print(f"  - kept (within {min_age}s window) {n}")


if __name__ == "__main__":
    main()
