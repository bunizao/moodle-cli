#!/bin/sh
set -eu
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) asset=moodle-darwin-arm64 ;;
  Linux-x86_64) asset=moodle-linux-x64 ;;
  *) echo 'Use npm install -g moodle-cli on this platform.' >&2; exit 1 ;;
esac
root=${MOODLE_INSTALL_DIR:-"$HOME/.local/bin"}
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
version=${MOODLE_VERSION:-latest}
if [ "$version" = latest ]; then
  base=https://github.com/bunizao/moodle-cli/releases/latest/download
else
  case "$version" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo 'MOODLE_VERSION must be a release tag such as v0.8.0.' >&2; exit 1 ;; esac
  base="https://github.com/bunizao/moodle-cli/releases/download/$version"
fi
curl -fL --retry 2 "$base/$asset" -o "$temporary/moodle"
chmod 755 "$temporary/moodle"
"$temporary/moodle" --version
mkdir -p "$root"
install -m 755 "$temporary/moodle" "$root/moodle"
printf 'Installed %s/moodle. Add %s to PATH if needed.\n' "$root" "$root"
