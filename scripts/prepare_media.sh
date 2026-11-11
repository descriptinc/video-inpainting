#!/usr/bin/env bash
# Encode inpaint outputs for the web and grab a poster frame for each.
#
#   scripts/prepare_media.sh <id>=<output.mp4> [<id>=<output.mp4> ...]
#   e.g. scripts/prepare_media.sh vivaldi=../final_ltx_vids/vivaldi_inpaint_full.mp4
#
# Writes media/<id>.mp4 (long side 1280px, H.264, faststart) and
# media/posters/<id>.jpg. Only outputs are encoded: the page's "Input" view
# covers the masked region with the generating overlay, and everything outside
# it passes through the inpainter untouched.
set -euo pipefail

abspath() { (cd "$(dirname "$1")" && echo "$PWD/$(basename "$1")"); }
pairs=()
for pair in "$@"; do pairs+=("${pair%%=*}=$(abspath "${pair#*=}")"); done

cd "$(dirname "$0")/.."
mkdir -p media/posters

for pair in "${pairs[@]}"; do
  name="${pair%%=*}"
  f="${pair#*=}"
  out="media/${name}.mp4"
  poster="media/posters/${name}.jpg"
  scale="scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'"

  if [[ ! -f "$out" ]]; then
    echo "encode  $name"
    ffmpeg -v error -y -i "$f" -vf "$scale" \
      -c:v libx264 -preset medium -crf 24 -profile:v high -pix_fmt yuv420p \
      -c:a aac -b:a 128k -movflags +faststart "$out"
  fi
  if [[ ! -f "$poster" ]]; then
    dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")"
    at="$(awk -v d="$dur" 'BEGIN { printf "%.2f", d / 3 }')"
    ffmpeg -v error -y -ss "$at" -i "$f" -frames:v 1 -vf "$scale" -q:v 4 "$poster"
  fi
done
