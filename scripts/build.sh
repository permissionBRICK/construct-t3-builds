#!/usr/bin/env bash
set -Eeuo pipefail
publisher="$(cd "$(dirname "$0")/.." && pwd)"
work="$(realpath "$1")"
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$work/plan.json" "$1"; }
REPO_DIR="$(field sourceDirectory)"
T3CODE_SOURCE_VERSION="$(field version)" T3CODE_INVENTORY="$(field inventory)"
CONSTRUCT_VERSION="$(field buildRepositoryCommit)"
T3CODE_CHANNEL="$(field channel)"
export T3CODE_BUILD_REPOSITORY_COMMIT="${CONSTRUCT_VERSION}"
export REPO_DIR T3CODE_SOURCE_VERSION T3CODE_INVENTORY CONSTRUCT_VERSION T3CODE_CHANNEL
# NSIS 3's native include handling crashes on long pnpm paths. Keep compilation
# under a short temporary root even when Actions checks out under a long path.
export T3CODE_CACHE_ROOT="$(mktemp -d /tmp/t3-src.XXXXXX)"
trap 'rm -r -- "$T3CODE_CACHE_ROOT"' EXIT
export T3CODE_ARTIFACT_ROOT="$work/artifacts"
export T3CODE_COMPILER_CACHE="${T3CODE_COMPILER_CACHE:-$work/compiler}"
export T3CODE_STATUS_PATH="$work/status" T3CODE_LAUNCHER="$work/t3"
expected_node="$(field nodeVersion)"
[[ "$(node -p process.versions.node)" == "$expected_node" ]] || { echo 'Build Node version differs from runtime pin' >&2; exit 1; }
T3CODE_BUILD_MODE=server bash "$REPO_DIR/bin/build-t3code.sh"
source_dir="$(dirname "$(dirname "$(dirname "$(dirname "$(readlink -f "$work/t3")")")")")"
node "$publisher/scripts/package-linux.mjs" "$source_dir" "$work/linux-runtime" "$(command -v node)"
# The distributed runtime uses the exact Node executable that built its native modules.
curl -fsSL "https://raw.githubusercontent.com/nodejs/node/v${expected_node}/LICENSE" -o "$work/linux-runtime/NODE-LICENSE"
tar -czf "$work/artifacts/t3code-server-linux-x64.tar.gz" -C "$work/linux-runtime" .
python3 "$publisher/scripts/smoke.py" "$work/artifacts/t3code-server-linux-x64.tar.gz"
T3CODE_BUILD_MODE=desktop bash "$REPO_DIR/bin/build-t3code.sh"
# PE signature, plus a real extraction of the NSIS payload (no Windows UI on Linux).
python3 - "$work/artifacts/T3Code-Construct-Setup.exe" <<'PY'
import struct,sys
with open(sys.argv[1], 'rb') as f:
    assert f.read(2) == b'MZ', 'Missing DOS header'
    f.seek(60); offset = struct.unpack('<I', f.read(4))[0]
    f.seek(offset); assert f.read(4) == b'PE\0\0', 'Missing PE header'
PY
7z t "$work/artifacts/T3Code-Construct-Setup.exe" > "$work/windows-archive-check.log"
python3 "$publisher/scripts/publisher.py" finalize --work "$work"
