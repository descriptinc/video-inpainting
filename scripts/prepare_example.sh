#!/usr/bin/env bash
# Pack one inpainting example for the gallery: source | output | mask, side by side.
#
#   scripts/prepare_example.sh <id> <source.mp4> <output.mp4> <mask.mp4>
#
# Each panel is scaled to the output's frame (long side 960px) and retimed to the
# output's frame rate, so the three stay frame-locked in a single video. The mask
# is white where the region is regenerated. Writes media/<id>.mp4 (H.264,
# faststart, the output's audio) and media/posters/<id>.jpg, a packed frame a
# third of the way in. Add the clip to CLIPS and MEDIA.examples in main.js, with
# `out` set to the size of one panel (printed below).
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <id> <source.mp4> <output.mp4> <mask.mp4>" >&2
  exit 1
fi
abspath() { (cd "$(dirname "$1")" && echo "$PWD/$(basename "$1")"); }
id="$1"; src="$(abspath "$2")"; outv="$(abspath "$3")"; mask="$(abspath "$4")"

cd "$(dirname "$0")/.."
mkdir -p media/posters

IFS=x read -r ow oh < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$outv")
fps="$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$outv")"
if (( ow >= oh )); then
  w=960; h=$(( (960 * oh / ow + 1) / 2 * 2 ))
else
  h=960; w=$(( (960 * ow / oh + 1) / 2 * 2 ))
fi

panel="scale=${w}:${h},setsar=1,fps=${fps}"
ffmpeg -v error -y -i "$src" -i "$outv" -i "$mask" -filter_complex \
  "[0:v]${panel}[s];[1:v]${panel}[o];[2:v]${panel},format=gray,format=yuv420p[m];[s][o][m]hstack=inputs=3,format=yuv420p[v]" \
  -map "[v]" -map "1:a?" -shortest \
  -c:v libx264 -preset medium -crf 22 -profile:v high -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart "media/${id}.mp4"

dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "media/${id}.mp4")"
at="$(awk -v d="$dur" 'BEGIN { printf "%.2f", d / 3 }')"
ffmpeg -v error -y -ss "$at" -i "media/${id}.mp4" -frames:v 1 -q:v 4 "media/posters/${id}.jpg"

echo "packed media/${id}.mp4 (panel ${w}x${h})"
