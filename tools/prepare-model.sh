#!/usr/bin/env bash
# Builds the Streamed SOG model in public/model/ from the PortalCam / LCC Studio PLY export.
# Run from anywhere; paths are resolved relative to the repo root.
#
#   tools/prepare-model.sh
#   SRC=/path/to/point_cloud/iteration_100 tools/prepare-model.sh
#
# The export already contains the scan at six detail levels (point_cloud.ply, then _1 … _5,
# each about half the previous) plus environment.ply (a distant sky shell). They map straight onto
# Streamed SOG LOD levels 0–5, with the environment tagged as LOD -1 (always shown).
#
# The scan is Z-up; PlayCanvas is Y-up, so every input is rotated +90° about X (raw z → world y).
# The viewer applies no further rotation, so stop poses in stops.json are plain world coordinates.
#
# Requires: npm install -g @playcanvas/splat-transform
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${SRC:-$ROOT/source/tucson/ply/point_cloud/iteration_100}"
OUT="$ROOT/public/model"
ROTATE="90,0,0"

[[ -f "$SRC/point_cloud.ply" ]] || { echo "missing $SRC/point_cloud.ply" >&2; exit 1; }

args=("$SRC/point_cloud.ply" -r "$ROTATE" -l 0)
for i in 1 2 3 4 5; do
  f="$SRC/point_cloud_$i.ply"
  [[ -f "$f" ]] && args+=("$f" -r "$ROTATE" -l "$i")
done
[[ -f "$SRC/environment.ply" ]] && args+=("$SRC/environment.ply" -r "$ROTATE" -l -1)

echo "== inputs"
splat-transform --no-tty "$SRC/point_cloud.ply" --info null | grep -E "gaussians|sh bands"

echo "== writing Streamed SOG to $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
# Basic colour only (SH degree 0), so --filter-harmonics 0 is lossless.
splat-transform --no-tty -w "${args[@]}" "$OUT/lod-meta.json" --filter-nan --filter-harmonics 0

echo "== size report"
du -sh "$OUT"
echo "files: $(find "$OUT" -type f | wc -l | tr -d ' ')"
echo "largest:"
find "$OUT" -type f -exec stat -f '%z %N' {} + | sort -n -r | head -3 \
  | while read -r size path; do printf "  %6.1f MB  %s\n" "$(echo "$size/1048576" | bc -l)" "${path#"$ROOT"/}"; done
for lvl in 0 1 2 3 4 5; do
  ls -d "$OUT"/"$lvl"_* >/dev/null 2>&1 || continue
  printf "  LOD %s: %s\n" "$lvl" "$(du -ch "$OUT"/"$lvl"_* | tail -1 | cut -f1)"
done
[[ -d "$OUT/env" ]] && printf "  environment: %s\n" "$(du -sh "$OUT/env" | cut -f1)"
over=$(find "$OUT" -type f -size +100M | wc -l | tr -d ' ')
echo "files over 100 MB: $over"
