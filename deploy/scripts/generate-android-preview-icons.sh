#!/usr/bin/env bash
set -euo pipefail

ROOT="${BRAI_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
APP_SRC="$ROOT/apps/brai_app/android/app/src"
FONT="${BRAI_ICON_FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf}"

render_full_bleed() {
  local output="$1"
  local size="$2"
  local label="$3"
  local font_size=$((size * 22 / 100))
  local shadow=$((size / 72 + 1))
  local bottom=$((size * 6 / 100))
  local logo_size=$((size * 112 / 100))
  local logo_y=$((size * -4 / 100))
  local source="$APP_SRC/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png"

  ffmpeg -v error -y \
    -f lavfi -i "color=c=black:s=${size}x${size},format=rgba" \
    -i "$source" \
    -filter_complex "[1]scale=${logo_size}:${logo_size}:force_original_aspect_ratio=decrease[logo];[0][logo]overlay=(W-w)/2:${logo_y},drawtext=fontfile='${FONT}':text='${label}':fontcolor=white:fontsize=${font_size}:borderw=${shadow}:bordercolor=black@0.9:x=(w-text_w)/2:y=h-text_h-${bottom}" \
    -frames:v 1 \
    "$output"
}

render_scaled() {
  local output="$1"
  local size="$2"
  local label="$3"
  local scale_pct="$4"
  local scaled_size=$((size * scale_pct / 100))
  local tmp_logo

  tmp_logo="$(mktemp -t brai-icon-logo.XXXXXX.png)"
  render_full_bleed "$tmp_logo" "$size" "$label"
  ffmpeg -v error -y \
    -f lavfi -i "color=c=black:s=${size}x${size},format=rgba" \
    -i "$tmp_logo" \
    -filter_complex "[1]scale=${scaled_size}:${scaled_size}[icon];[0][icon]overlay=(W-w)/2:(H-h)/2" \
    -frames:v 1 \
    "$output"
  rm -f "$tmp_logo"
  chmod u=rw,go=r "$output"
}

generate_icons() {
  local flavor="$1"
  local label="$2"
  local density="$3"
  local icon_size="$4"
  local foreground_size="$5"
  local dir="$APP_SRC/$flavor/res/mipmap-$density"
  mkdir -p "$dir"

  render_scaled "$dir/ic_launcher.png" "$icon_size" "$label" 84
  cp "$dir/ic_launcher.png" "$dir/ic_launcher_round.png"
  render_scaled "$dir/ic_launcher_foreground.png" "$foreground_size" "$label" 72
}

generate_density() {
  local density="$1"
  local icon_size="$2"
  local foreground_size="$3"
  generate_icons previewA A "$density" "$icon_size" "$foreground_size"
  generate_icons previewB B "$density" "$icon_size" "$foreground_size"
  generate_icons previewC C "$density" "$icon_size" "$foreground_size"
  generate_icons previewD D "$density" "$icon_size" "$foreground_size"
  generate_icons previewE E "$density" "$icon_size" "$foreground_size"
}

generate_density mdpi 48 108
generate_density hdpi 72 162
generate_density xhdpi 96 216
generate_density xxhdpi 144 324
generate_density xxxhdpi 192 432

echo "Generated production-style launcher icons with safe-scale preview labels"
