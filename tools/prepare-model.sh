#!/usr/bin/env bash
# Builds the Streamed SOG model in public/model/ from source/scene.ply.
# Run from anywhere; paths are resolved relative to the repo root.
#
#   tools/prepare-model.sh                 # default settings
#   DECIMATE=uniform tools/prepare-model.sh
#   LEVELS="50% 25% 10%" tools/prepare-model.sh
#
# Requires: npm install -g @playcanvas/splat-transform
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/source/scene.ply"
WORK="$ROOT/source"
OUT="$ROOT/public/model"

DECIMATE="${DECIMATE:-adaptive}"   # adaptive | uniform
LEVELS="${LEVELS:-50% 25% 10%}"     # lower LOD levels, as a fraction of the source
HARMONICS="${HARMONICS:-0}"         # source has no higher-order SH, so 0 is lossless

[[ -f "$SRC" ]] || { echo "missing $SRC" >&2; exit 1; }

if [[ "$DECIMATE" == "adaptive" ]]; then DFLAG=--decimate-adaptive; else DFLAG=-d; fi

echo "== source stats"
splat-transform --no-tty "$SRC" --info null

# Build lower detail levels (in parallel; each is independent)
args=("$SRC" -l 0)
i=1
pids=()
for pct in $LEVELS; do
  lod="$WORK/lod$i-$DECIMATE-${pct%\%}.ply"
  if [[ ! -f "$lod" ]]; then
    echo "== building $lod ($DFLAG $pct)"
    splat-transform --no-tty -w "$SRC" "$DFLAG" "$pct" "$lod" &
    pids+=($!)
  else
    echo "== reusing $lod"
  fi
  args+=("$lod" -l "$i")
  i=$((i + 1))
done
for p in "${pids[@]}"; do wait "$p"; done

echo "== writing Streamed SOG to $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
splat-transform --no-tty -w "${args[@]}" "$OUT/lod-meta.json" \
  --filter-nan --filter-harmonics "$HARMONICS"

echo "== size report"
du -sh "$OUT"
echo "files: $(find "$OUT" -type f | wc -l | tr -d ' ')"
echo "largest:"
find "$OUT" -type f -exec stat -f '%z %N' {} + | sort -n -r | head -3 \
  | while read -r size path; do printf "  %6.1f MB  %s\n" "$(echo "$size/1048576" | bc -l)" "${path#"$ROOT"/}"; done
for lvl in $(seq 0 $((i - 1))); do
  printf "  LOD %s: %s\n" "$lvl" "$(du -ch "$OUT"/"$lvl"_* | tail -1 | cut -f1)"
done
over=$(find "$OUT" -type f -size +100M | wc -l | tr -d ' ')
echo "files over 100 MB: $over"
