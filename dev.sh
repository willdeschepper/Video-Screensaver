#!/usr/bin/env bash
# dev.sh – Install the extension and test it in a nested GNOME Shell window,
#          without logging out of the current session.
# Usage: ./dev.sh   (maximize/resize the window to change the monitor size,
#                    e.g. to simulate an ultrawide screen)
#
# Requires GNOME Shell 49+ (gnome-shell --devkit, package mutter-dev-bin).
# Runs the Ubuntu session with only this extension added, using its own settings in
# ~/.cache/video-screensaver-dev. Close the window (or Ctrl+C) to stop.

set -euo pipefail

UUID="video-screensaver@willdeschepper.github.io"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_PATH="/org/gnome/shell/extensions/video-screensaver/"
DEV_CONFIG="${XDG_CACHE_HOME:-$HOME/.cache}/video-screensaver-dev"

if ! gnome-shell --help 2>&1 | grep -q -- '--devkit'; then
    echo "This gnome-shell has no --devkit option (GNOME 49+ required)." >&2
    exit 1
fi

# Copy the current source files into ~/.local/share/gnome-shell/extensions
"${SCRIPT_DIR}/install.sh"

# Take the extension settings (videos folder etc.) from the real session
settings="$(dconf dump "${SETTINGS_PATH}")"

echo ""
echo "Starting nested GNOME Shell. Logs from the extension appear below."
echo ""

# Separate config dir: the nested shell gets its own dconf database, so it
# loads only Ubuntu's built-in extensions (dock...) plus this one, and
# nothing changed in there leaks into the real session.
mkdir -p "${DEV_CONFIG}"
export XDG_CONFIG_HOME="${DEV_CONFIG}"

# A private D-Bus session keeps the nested shell from clashing with the
# real one (both would claim org.gnome.Shell).
exec dbus-run-session -- bash -c '
    printf "%s\n" "$1" | dconf load "$2"
    gsettings set org.gnome.shell enabled-extensions "[\"$3\"]"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
    exec gnome-shell --devkit --wayland --mode=ubuntu
' _ "${settings}" "${SETTINGS_PATH}" "${UUID}"
