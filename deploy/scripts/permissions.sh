#!/usr/bin/env bash

normalize_public_tree() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  find "$target" -user "$(id -u)" -type d -exec chmod 2775 {} +
  find "$target" -user "$(id -u)" -type f -exec chmod 0664 {} +
}

normalize_private_tree() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  find "$target" -user "$(id -u)" -type d -exec chmod 2770 {} +
  find "$target" -user "$(id -u)" -type f -exec chmod 0660 {} +
}

normalize_public_file() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  chmod 0664 "$target"
}
