#!/usr/bin/env bash
# Build the Flex images for a MikroTik router and save them as .tar files.
# Run this on any PC with Docker (Docker Desktop on Windows/macOS, or Docker on Linux).
#
#   ./mikrotik/build-images.sh arm64     RB5009, hAP ax2/ax3, CCR2004, CCR2116, CCR2216 ...
#   ./mikrotik/build-images.sh amd64     CHR or RouterOS on an x86 PC
#   ./mikrotik/build-images.sh arm       older 32-bit ARM routers (app + sync only, no media engine)
#
# Output: mikrotik/out/flex-portal-<arch>.tar and mikrotik/out/flex-sync-<arch>.tar
# Upload both to the router's disk (Winbox > Files, or scp), then import flex.rsc.
set -euo pipefail

ARCH="${1:-arm64}"
case "$ARCH" in
  arm64) PLATFORM=linux/arm64 ;;
  amd64|x86|x86_64) ARCH=amd64; PLATFORM=linux/amd64 ;;
  arm|arm32|armv7) ARCH=arm; PLATFORM=linux/arm/v7 ;;
  *) echo "Unknown architecture '$ARCH'. Use arm64, amd64 or arm."; exit 1 ;;
esac

cd "$(dirname "$0")/.."
OUT=mikrotik/out
mkdir -p "$OUT"

# Cross-building on Linux needs CPU emulation (Docker Desktop already has it).
if [ "$(uname -s)" = "Linux" ] && [ "$ARCH" != "amd64" ]; then
  if [ ! -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ] && [ ! -e /proc/sys/fs/binfmt_misc/qemu-arm ]; then
    echo "Enabling ARM emulation (one time)..."
    docker run --privileged --rm tonistiigi/binfmt --install arm64,arm
  fi
fi

# A builder that can export image files
docker buildx inspect flex-builder >/dev/null 2>&1 || docker buildx create --name flex-builder --driver docker-container >/dev/null

build() {   # build <folder> <image name>
  echo "Building $2 for $PLATFORM ..."
  docker buildx build --builder flex-builder \
    --platform "$PLATFORM" \
    --build-arg RUN_AS=root \
    --tag "$2:latest" \
    --output "type=docker,dest=$OUT/$2-$ARCH.tar" \
    "./$1"
}

build portal flex-portal
build splynx-sync flex-sync

echo
echo "Done:"
ls -lh "$OUT"/*-"$ARCH".tar
echo
echo "Next: copy these two files to the router disk (e.g. usb1/flex/images/), then follow mikrotik/README.md"
