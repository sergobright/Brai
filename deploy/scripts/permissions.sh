#!/usr/bin/env bash

normalize_public_tree() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  find "$target" -type d -user "$(id -u)" -exec chmod 2775 {} +
  find "$target" -type f -user "$(id -u)" -exec chmod 0664 {} +
  if find "$target" -type d ! -perm -2775 -print -quit | grep -q . \
    || find "$target" -type f ! -perm -0664 -print -quit | grep -q .; then
    echo "Public artifact tree has files that cannot be normalized: $target" >&2
    return 1
  fi
}

normalize_private_tree() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  find "$target" -type d -exec chmod 2770 {} +
  find "$target" -type f -exec chmod 0660 {} +
}

normalize_public_file() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  chmod 0664 "$target"
}
