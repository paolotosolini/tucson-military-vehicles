#!/usr/bin/env bash
# Builds the Streamed SOG model in public/model/ from the PortalCam / LCC Studio PLY export.
# Run from anywhere; paths are resolved relative to the repo root.
#
#   tools/prepare-model.sh
#   SRC=/path/to/point_cloud/iteration_100 tools/prepare-model.sh
#
# The export already contains the scan at six detail levels (point_cloud.ply, then _1 … _5,
# each about half the previous). They map straight onto Streamed SOG LOD levels 0–5.
#
# First, tools/crop-scan.mjs crops every level to the inside of the hangar: it removes the roof
# (everything above y = 2.9) and all splats outside the walls. environment.ply (a distant sky
# shell) is left out for the same reason: the scan is entirely indoors.
#
# The scan is Z-up; PlayCanvas is Y-up, so every input is rotated +90° about X (raw z → world y).
# The viewer applies no further rotation, so stop poses in stops.json are plain world coordinates.
#
# Requires: npm install -g @playcanvas/splat-transform
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${SRC:-$ROOT/source/tucson/ply/point_cloud/iteration_100}"
CROP="$ROOT/source/tucson/cropped"
OUT="$ROOT/public/model"
ROTATE="90,0,0"

[[ -f "$SRC/point_cloud.ply" ]] || { echo "missing $SRC/point_cloud.ply" >&2; exit 1; }

echo "== cropping to the hangar interior (roof and outside removed)"
mkdir -p "$CROP"
names=(point_cloud.ply)
for i in 1 2 3 4 5; do [[ -f "$SRC/point_cloud_$i.ply" ]] && names+=("point_cloud_$i.ply"); done
for n in "${names[@]}"; do node "$ROOT/tools/crop-scan.mjs" "$SRC/$n" "$CROP/$n"; done

args=()
for lvl in "${!names[@]}"; do args+=("$CROP/${names[$lvl]}" -r "$ROTATE" -l "$lvl"); done

echo "== writing Streamed SOG to $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
# Basic colour only (SH degree 0), so --filter-harmonics 0 is lossless.
# Small streaming chunks (~128K splats, ~8 m, ~1.7 MB each instead of 512K / 16 m / ~10 MB): a
# view then fetches full detail only near the camera. Measured at stop 6: 57 MB to fully sharp
# instead of 120 MB, with the same close-up look. (Encoding takes ~12 minutes.)
splat-transform --no-tty -w "${args[@]}" "$OUT/lod-meta.json" --filter-nan --filter-harmonics 0 \
  --lod-chunk-count 128 --lod-chunk-extent 8

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
over=$(find "$OUT" -type f -size +100M | wc -l | tr -d ' ')
echo "files over 100 MB: $over"

# Collision voxels for walk mode (10 cm grid, ~1 MB), from a mid detail level, in the same
# rotated world space. src/walk.ts reads them with PlayCanvas's VoxelOccupancy.
echo "== collision voxels for walk mode"
COL="$ROOT/public/collision"
rm -rf "$COL"
mkdir -p "$COL"
splat-transform --no-tty -w "$CROP/point_cloud_2.ply" -r "$ROTATE" "$COL/hangar.voxel.json" --voxel-size 0.1 >/dev/null
du -ch "$COL"/* | tail -1
