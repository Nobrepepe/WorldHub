#!/usr/bin/env bash
# Installs (or refreshes) the World Hub desktop entry and icon for the
# current user, so the app can be launched from the application menu and
# pinned to the taskbar. Re-run it after moving the project directory.
#
#   ./packaging/install-desktop-entry.sh             install
#   ./packaging/install-desktop-entry.sh --uninstall remove

set -euo pipefail

here="$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd)"
project_root="$(dirname -- "$here")"

app_id="world-hub"
wm_class="world-hub"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
apps_dir="$data_home/applications"
icons_dir="$data_home/icons/hicolor"
desktop_file="$apps_dir/$app_id.desktop"
sizes=(16 24 32 48 64 128 256 512)

refresh_caches() {
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
    command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$icons_dir" >/dev/null 2>&1 || true
    command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
    rm -f "$desktop_file"
    rm -f "$icons_dir/scalable/apps/$app_id.svg"
    for size in "${sizes[@]}"; do
        rm -f "$icons_dir/${size}x${size}/apps/$app_id.png"
    done
    refresh_caches
    echo "Removed the World Hub desktop entry and icon."
    exit 0
fi

mkdir -p "$apps_dir" "$icons_dir/scalable/apps"
install -m 644 "$here/$app_id.svg" "$icons_dir/scalable/apps/$app_id.svg"

# Raster copies for panels and menus that will not scale an SVG themselves.
# rsvg-convert first; sharp is already a project dependency, so it covers a
# machine without librsvg.
raster_with_rsvg() {
    command -v rsvg-convert >/dev/null 2>&1 || return 1
    for size in "${sizes[@]}"; do
        mkdir -p "$icons_dir/${size}x${size}/apps"
        rsvg-convert -w "$size" -h "$size" "$here/$app_id.svg" \
            -o "$icons_dir/${size}x${size}/apps/$app_id.png"
    done
}

raster_with_sharp() {
    [[ -d "$project_root/node_modules/sharp" ]] || return 1
    for size in "${sizes[@]}"; do
        mkdir -p "$icons_dir/${size}x${size}/apps"
    done
    ICON_SVG="$here/$app_id.svg" ICON_DIR="$icons_dir" APP_ID="$app_id" \
    SIZES="${sizes[*]}" node --input-type=module -e '
        import sharp from "sharp";
        const svg = process.env.ICON_SVG;
        for (const size of process.env.SIZES.split(" ")) {
          const n = Number(size);
          await sharp(svg, { density: Math.ceil((72 * n) / 512) * 4 })
            .resize(n, n)
            .png()
            .toFile(`${process.env.ICON_DIR}/${n}x${n}/apps/${process.env.APP_ID}.png`);
        }
    ' 2>/dev/null || return 1
}

if ! raster_with_rsvg && ! raster_with_sharp; then
    echo "Note: no rasteriser found (rsvg-convert or sharp); installed the SVG icon only." >&2
fi

chmod +x "$here/$app_id"
sed -e "s|@EXEC@|$here/$app_id|g" \
    -e "s|@PROJECT_ROOT@|$project_root|g" \
    -e "s|@WMCLASS@|$wm_class|g" \
    "$here/$app_id.desktop.in" > "$desktop_file"
chmod 644 "$desktop_file"

command -v desktop-file-validate >/dev/null 2>&1 && desktop-file-validate "$desktop_file"
refresh_caches

echo "Installed:"
echo "  $desktop_file"
echo "  $icons_dir/scalable/apps/$app_id.svg"
echo
echo "Search for \"World Hub\" in the application launcher, then right-click"
echo "the running window's task manager entry and choose \"Pin to Task Manager\"."
