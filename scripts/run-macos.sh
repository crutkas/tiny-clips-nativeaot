#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

require_stopped_app() {
    if pgrep -u "$(id -u)" -x TinyClips >/dev/null; then
        echo "TinyClips is already running. Finish any recording, save your work, and quit TinyClips before using Run macOS again (including any installed copy)." >&2
        exit 1
    else
        status=$?
        if [ "$status" -ne 1 ]; then
            echo "Could not check whether TinyClips is running (pgrep exited with $status)." >&2
            exit "$status"
        fi
    fi
}

require_stopped_app
xcodebuild build -project mac/TinyClips.xcodeproj -scheme TinyClips \
    -configuration Debug -derivedDataPath .build/copilot-macos \
    CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual
require_stopped_app
open .build/copilot-macos/Build/Products/Debug/TinyClips.app
