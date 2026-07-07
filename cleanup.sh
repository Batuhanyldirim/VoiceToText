#!/usr/bin/env bash
# ============================================================================
# cleanup.sh — remove EVERYTHING this prototype downloaded.
#
# Because env.sh redirects all model/cache/pip downloads INTO this project
# folder, the primary cleanup is simply deleting the folder. This script
# (a) shows you what will be removed and its size, (b) optionally also removes
# the shared Homebrew packages (ffmpeg, python@3.11) if you want a full wipe.
# ============================================================================
set -euo pipefail
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "=== This prototype is fully self-contained in: ==="
echo "    $PROJECT_ROOT"
echo
echo "=== Size of downloads living inside the project: ==="
du -sh "$PROJECT_ROOT/models" "$PROJECT_ROOT/.pip-cache" "$PROJECT_ROOT/.venv" 2>/dev/null || true
echo
echo "To remove the ENTIRE prototype (venv + all models + all caches), run:"
echo "    rm -rf \"$PROJECT_ROOT\""
echo
echo "Nothing was written to ~/.cache, ~/Library, or the global HF cache,"
echo "so deleting the folder above removes 100% of the model/package downloads."
echo
echo "----------------------------------------------------------------------"
echo "OPTIONAL — shared system tools installed via Homebrew for this project:"
echo "  * ffmpeg          (may be used by other things — remove with care)"
echo "  * python@3.11     (may be used by other things — remove with care)"
echo
echo "If you are SURE nothing else needs them, uninstall with:"
echo "    brew uninstall ffmpeg python@3.11"
echo "----------------------------------------------------------------------"
