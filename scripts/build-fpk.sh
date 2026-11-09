#!/usr/bin/env bash
# 打飞牛 .fpk。镜像不打进包，compose 在运行时拉取。
# 用法: scripts/build-fpk.sh <version> <image-without-tag-or-with-repo> [output.fpk]
# 例: scripts/build-fpk.sh 1.2.3 ghcr.io/octocat/fnos-agent-checkin dist/fnos-agent-checkin-1.2.3.fpk
set -euo pipefail

VERSION="${1:-0.0.0}"
IMAGE_REPO="${2:-ghcr.io/OWNER/fnos-agent-checkin}"
OUT="${3:-dist/fnos-agent-checkin-${VERSION}.fpk}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# 去掉用户可能带上的 :tag
IMAGE_REPO="${IMAGE_REPO%%:*}"
IMAGE_REPO="$(printf '%s' "$IMAGE_REPO" | tr '[:upper:]' '[:lower:]')"

mkdir -p "$STAGE"
cp -a "$ROOT/fpk/." "$STAGE/"
rm -f "$STAGE/app.tgz"
find "$STAGE" -name '.DS_Store' -delete

python3 - "$STAGE/app/docker/docker-compose.yaml" "$IMAGE_REPO" << 'PY'
import pathlib, sys
path, repo = sys.argv[1:]
file = pathlib.Path(path)
file.write_text(file.read_text().replace("ghcr.io/OWNER/fnos-agent-checkin", repo))
PY

python3 - "$STAGE/manifest" "$VERSION" << 'PY'
import pathlib, sys
path, version = sys.argv[1:]
file = pathlib.Path(path)
lines = []
for line in file.read_text().splitlines():
    if line.startswith("version "):
        lines.append(f"version = {version}")
    elif line.startswith("checksum "):
        continue
    else:
        lines.append(line)
file.write_text("\n".join(lines) + "\n")
PY

tar -C "$STAGE/app" -czf "$STAGE/app.tgz" .
MD5="$(md5sum "$STAGE/app.tgz" | awk '{print $1}')"
printf 'checksum = %s\n' "$MD5" >> "$STAGE/manifest"

mkdir -p "$(dirname "$ROOT/$OUT")"
OUT_ABS="$ROOT/$OUT"
rm -f "$OUT_ABS"

FNPACK_VERSION="1.2.3"
FNPACK_SHA256="54b97fa7b70968c4d05c79840f5daeff508957d0bb2062fdb0376d00d9615c93"
FNPACK_URL="https://static2.fnnas.com/fnpack/fnpack-${FNPACK_VERSION}-linux-amd64"
FNPACK_BIN="${TMPDIR:-/tmp}/fnpack-${FNPACK_VERSION}-linux-amd64"

pack_with_tar() {
  echo "使用 tar.gz 作为 .fpk（飞牛安装包本质是 tar.gz，不是 zip）" >&2
  tar -C "$STAGE" -czf "$OUT_ABS" .
}

if curl --fail --location --silent --show-error --retry 3 --output "$FNPACK_BIN" "$FNPACK_URL"; then
  if printf '%s  %s\n' "$FNPACK_SHA256" "$FNPACK_BIN" | sha256sum --check --status; then
    chmod 755 "$FNPACK_BIN"
    # fnpack 把 .fpk 写到当前工作目录，文件名随 appname 变化。
    PACK_DIR="$(mktemp -d)"
    if (cd "$PACK_DIR" && "$FNPACK_BIN" build --directory "$STAGE"); then
      found="$(find "$PACK_DIR" -maxdepth 2 -name '*.fpk' -print -quit)"
      if [ -n "$found" ]; then
        mv "$found" "$OUT_ABS"
      else
        echo "fnpack 没有产出 .fpk，改用 tar.gz" >&2
        pack_with_tar
      fi
    else
      echo "fnpack build 失败，改用 tar.gz" >&2
      pack_with_tar
    fi
    rm -rf "$PACK_DIR"
  else
    echo "fnpack 校验和不匹配，拒绝执行该二进制，改用 tar.gz" >&2
    pack_with_tar
  fi
else
  pack_with_tar
fi

sha256sum "$OUT_ABS" | awk '{print $1}' > "${OUT_ABS}.sha256"
echo "wrote $OUT_ABS"
