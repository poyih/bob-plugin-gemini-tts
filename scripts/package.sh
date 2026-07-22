#!/bin/sh

set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
project_dir=$(dirname "$script_dir")
info_file="$project_dir/info.json"

if [ ! -f "$info_file" ]; then
    printf 'Error: info.json not found at %s\n' "$info_file" >&2
    exit 1
fi

version=$(/usr/bin/plutil -extract version raw -o - "$info_file")
case "$version" in
    ''|.*|*.|*..*|*[!0-9a-z.]*)
        printf 'Error: invalid version in info.json: %s\n' "$version" >&2
        exit 1
        ;;
esac

archive_name="gemini-tts-$version.bobplugin"
archive_path="$project_dir/$archive_name"
temp_dir=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/gemini-tts-package.XXXXXX")

cleanup() {
    /bin/rm -rf "$temp_dir"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

(
    cd "$project_dir"
    /usr/bin/zip -q -j "$temp_dir/$archive_name" info.json main.js
)

/bin/mv -f "$temp_dir/$archive_name" "$archive_path"
printf 'Built %s\n' "$archive_path"
