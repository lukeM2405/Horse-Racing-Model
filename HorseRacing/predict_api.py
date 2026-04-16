"""
Thin JSON converter for the prediction pipeline.

Reads race_predictions/all_race_predictions.csv (produced by predict.py) and
writes a single predictions.json file with, per race:
    - ranked horses (1..N by model prediction)
    - raw predicted finish position
    - model-implied win probability (softmax over -pred within the race)
    - market-implied win probability (from dollar_odds, treated as X-to-1)
    - edge (model_prob - market_prob); positive = value

Usage:
    python predict_api.py \
        --input race_predictions/all_race_predictions.csv \
        --output predictions.json
"""
import argparse
import json
import math
import sys
from datetime import datetime, timezone

import pandas as pd


SOFTMAX_TEMPERATURE = 1.5


def softmax_neg(values, tau=SOFTMAX_TEMPERATURE):
    """Softmax over -values/tau. Lower input -> higher output weight."""
    scaled = [-v / tau for v in values]
    m = max(scaled)
    exps = [math.exp(s - m) for s in scaled]
    total = sum(exps)
    return [e / total for e in exps]


def market_prob(odds):
    """X-to-1 fractional odds -> implied win probability. None if invalid."""
    try:
        o = float(odds)
    except (TypeError, ValueError):
        return None
    if o <= 0 or math.isnan(o):
        return None
    return 1.0 / (o + 1.0)


def build_payload(df, card_date=None, track_code=None):
    races = {}
    df = df.copy()
    df["predicted_finish"] = pd.to_numeric(df["predicted_finish"], errors="coerce")
    df = df.dropna(subset=["predicted_finish"])

    for race_num, race_df in df.groupby("race_number"):
        race_df = race_df.sort_values("predicted_finish").reset_index(drop=True)
        preds = race_df["predicted_finish"].tolist()
        model_probs = softmax_neg(preds)

        horses = []
        for i, row in race_df.iterrows():
            odds_val = row.get("odds")
            mkt = market_prob(odds_val)
            mdl = model_probs[i]
            edge = None if mkt is None else round(mdl - mkt, 4)
            horses.append({
                "rank": i + 1,
                "horse_name": str(row.get("original_horse_name", "")),
                "jockey": str(row.get("jockey", "")),
                "trainer": str(row.get("trainer", "")),
                "odds": None if pd.isna(odds_val) else float(odds_val),
                "predicted_finish": round(float(row["predicted_finish"]), 3),
                "model_prob": round(mdl, 4),
                "market_prob": None if mkt is None else round(mkt, 4),
                "edge": edge,
            })

        races[str(int(race_num))] = horses

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "track_code": track_code,
        "card_date": card_date,
        "races": races,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="race_predictions/all_race_predictions.csv")
    parser.add_argument("--output", default="predictions.json")
    parser.add_argument("--card-date", default=None,
                        help="YYYY-MM-DD card date, embedded in JSON for client-side filtering")
    parser.add_argument("--track-code", default=None,
                        help="Track code (e.g. KEE, CD), embedded in JSON for client-side filtering")
    args = parser.parse_args()

    try:
        df = pd.read_csv(args.input)
    except FileNotFoundError:
        print(f"Error: input CSV not found at {args.input}", file=sys.stderr)
        sys.exit(1)

    required = {"race_number", "original_horse_name", "predicted_finish"}
    missing = required - set(df.columns)
    if missing:
        print(f"Error: input CSV missing columns: {missing}", file=sys.stderr)
        sys.exit(1)

    payload = build_payload(df, card_date=args.card_date, track_code=args.track_code)
    with open(args.output, "w") as f:
        json.dump(payload, f, indent=2)

    print(f"Wrote {args.output} with {len(payload['races'])} races "
          f"(track={args.track_code} card_date={args.card_date})")


if __name__ == "__main__":
    main()
