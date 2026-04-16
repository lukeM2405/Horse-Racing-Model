"""
Apply dispatch-payload edits (scratches, odds overrides, added horses)
to the base race card CSV, writing the result as HorseRacing/test_data.csv
so that predict.py picks it up via its default hardcoded path.

Reads:
    .dispatch/payload.json  (the repository_dispatch client_payload)

Payload shape:
    {
      "overrides":  { "<race>::<horse>": <float odds>, ... },
      "scratches":  [ "<race>::<horse>", ... ],
      "added":      [ { race_number, horse_name, jockey, trainer,
                        post_position, dollar_odds }, ... ],
      "card_path":  "HorseRacing/KEE_2026-04-11.csv",
      "requested_at": "..."
    }
"""
import json
import os
import sys

import pandas as pd

DISPATCH = ".dispatch/payload.json"
DEFAULT_CARD = "HorseRacing/KEE_2026-04-11.csv"
OUT = "HorseRacing/test_data.csv"


def horse_key(race, name):
    return f"{int(race)}::{name}"


def main():
    with open(DISPATCH) as f:
        payload = json.load(f)

    card_path = payload.get("card_path") or DEFAULT_CARD
    if not os.path.exists(card_path):
        print(f"ERROR: card file not found: {card_path}", file=sys.stderr)
        sys.exit(1)

    df = pd.read_csv(card_path, low_memory=False)
    print(f"Loaded {len(df)} rows from {card_path}")

    if "race_number" not in df.columns or "horse_name" not in df.columns:
        print("ERROR: card CSV must have race_number and horse_name", file=sys.stderr)
        sys.exit(1)

    df["race_number"] = pd.to_numeric(df["race_number"], errors="coerce").astype("Int64")

    # 1) scratches — drop rows
    scratches = set(payload.get("scratches", []))
    if scratches:
        before = len(df)
        df["_key"] = df.apply(lambda r: horse_key(r["race_number"], r["horse_name"]), axis=1)
        df = df[~df["_key"].isin(scratches)].drop(columns=["_key"])
        print(f"Scratched {before - len(df)} horses: {sorted(scratches)}")

    # 2) odds overrides — set dollar_odds on matching rows
    overrides = payload.get("overrides", {}) or {}
    if overrides:
        if "dollar_odds" not in df.columns:
            df["dollar_odds"] = pd.NA
        df["_key"] = df.apply(lambda r: horse_key(r["race_number"], r["horse_name"]), axis=1)
        n_applied = 0
        for key, odds in overrides.items():
            mask = df["_key"] == key
            if mask.any():
                df.loc[mask, "dollar_odds"] = float(odds)
                n_applied += int(mask.sum())
        df = df.drop(columns=["_key"])
        print(f"Applied {n_applied} odds overrides from {len(overrides)} entries")

    # 3) added horses — append rows
    added = payload.get("added", []) or []
    if added:
        new_rows = []
        for h in added:
            row = {c: None for c in df.columns}
            row["race_number"] = int(h["race_number"])
            row["horse_name"] = h.get("horse_name", "")
            row["jockey"] = h.get("jockey", "") or "Unknown"
            row["trainer"] = h.get("trainer", "") or "Unknown"
            if h.get("post_position") not in (None, ""):
                row["post_position"] = int(h["post_position"])
            if h.get("dollar_odds") not in (None, ""):
                row["dollar_odds"] = float(h["dollar_odds"])
            # Borrow race context (race_type, purse, surface, distance, etc.)
            # from an existing horse in the same race so the model has sane
            # race-level features for this AE.
            sibs = df[df["race_number"] == row["race_number"]]
            if len(sibs):
                context_cols = [
                    "race_type", "purse", "surface", "distance", "distance_unit",
                    "track_condition", "breed", "course",
                ]
                for c in context_cols:
                    if c in sibs.columns:
                        row[c] = sibs.iloc[0][c]
            new_rows.append(row)
        df = pd.concat([df, pd.DataFrame(new_rows)], ignore_index=True)
        print(f"Added {len(new_rows)} AE/standby horses")

    # 4) optional: filter to a single race when payload specifies race_number
    requested_race = payload.get("race_number")
    if requested_race not in (None, ""):
        try:
            rn = int(requested_race)
        except (TypeError, ValueError):
            print(f"ERROR: invalid race_number in payload: {requested_race!r}", file=sys.stderr)
            sys.exit(1)
        before = len(df)
        df = df[df["race_number"] == rn]
        print(f"Filtered to race {rn}: {len(df)}/{before} rows")
        if df.empty:
            print(f"ERROR: no rows for race {rn} after filtering", file=sys.stderr)
            sys.exit(1)

    df = df.sort_values("race_number").reset_index(drop=True)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    df.to_csv(OUT, index=False)
    print(f"Wrote {OUT} with {len(df)} rows")


if __name__ == "__main__":
    main()
