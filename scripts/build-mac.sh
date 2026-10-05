#!/usr/bin/env bash
# 把 desktop/ 打包成 macOS 应用 ds_pet.app。
#
#   bash scripts/build-mac.sh                  打包本机架构 → dist/mac-<arch>/ds_pet.app
#   bash scripts/build-mac.sh --dmg            另外生成安装镜像 dist/ds_pet-<版本>-<arch>.dmg
#   bash scripts/build-mac.sh --arch x64       打 Intel 版（arm64 = Apple 芯片，x64 = Intel）
#   bash scripts/build-mac.sh --install        打包后装进「应用程序」并打开（会先退出正在运行的旧版本）
#
# 只依赖 macOS 自带工具（curl / ditto / plutil / codesign / hdiutil），不需要 Node。
# Electron 运行时优先用 node_modules 里已下载的那份，否则自动下载到 .cache/。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

NAME="ds_pet"
EXE="ds_pet"
BUNDLE_ID="io.github.cjian1.ds-pet"
VERSION="$(plutil -extract version raw -o - desktop/package.json)"
ELECTRON_VERSION="$(plutil -extract devDependencies.electron raw -o - package.json | tr -d '^~')"
HOST_ARCH="$(uname -m)"; [ "$HOST_ARCH" = "x86_64" ] && HOST_ARCH="x64"
ARCH="$HOST_ARCH"
INSTALL=0
DMG=0

while [ $# -gt 0 ]; do
  case "$1" in
    --install) INSTALL=1 ;;
    --dmg) DMG=1 ;;
    --arch) ARCH="${2:-}"; shift ;;
    --arch=*) ARCH="${1#--arch=}" ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
  shift
done
case "$ARCH" in arm64|x64) ;; *) echo "--arch 只能是 arm64 或 x64" >&2; exit 2 ;; esac

step() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------- Electron 运行时
RUNTIME=""
NM="$ROOT/node_modules/electron/dist"
if [ "$ARCH" = "$HOST_ARCH" ] && [ -x "$NM/Electron.app/Contents/MacOS/Electron" ] \
   && [ "$(cat "$NM/version" 2>/dev/null)" = "$ELECTRON_VERSION" ]; then
  RUNTIME="$NM/Electron.app"
else
  CACHE="$ROOT/.cache/electron/v$ELECTRON_VERSION-darwin-$ARCH"
  if [ ! -x "$CACHE/Electron.app/Contents/MacOS/Electron" ]; then
    step "下载 Electron $ELECTRON_VERSION（$ARCH）"
    TMP="$(mktemp -d)"
    curl -fL --progress-bar -o "$TMP/electron.zip" \
      "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-darwin-$ARCH.zip"
    rm -rf "$CACHE" && mkdir -p "$CACHE"
    ditto -x -k "$TMP/electron.zip" "$CACHE"
    rm -rf "$TMP"
  fi
  RUNTIME="$CACHE/Electron.app"
fi

# ---------------------------------------------------------------- 组装 .app
OUT="$ROOT/dist/mac-$ARCH"
APP="$OUT/$NAME.app"
step "组装 $NAME.app（版本 $VERSION，$ARCH，Electron $ELECTRON_VERSION）"
mkdir -p "$OUT"
rm -rf "$APP"
ditto "$RUNTIME" "$APP"
C="$APP/Contents"

rm -f "$C/Resources/default_app.asar" "$C/Resources/electron.icns"
mkdir -p "$C/Resources/app"
rsync -a --delete --exclude '.DS_Store' "$ROOT/desktop/" "$C/Resources/app/"
cp "$ROOT/desktop/resources/icon.icns" "$C/Resources/app.icns"
mv "$C/MacOS/Electron" "$C/MacOS/$EXE"

P="$C/Info.plist"
plutil -replace CFBundleExecutable -string "$EXE" "$P"
plutil -replace CFBundleName -string "$NAME" "$P"
plutil -replace CFBundleDisplayName -string "$NAME" "$P"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$P"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$P"
plutil -replace CFBundleVersion -string "$VERSION" "$P"
plutil -replace CFBundleIconFile -string "app.icns" "$P"
plutil -replace CFBundleDevelopmentRegion -string "en" "$P"
plutil -replace LSApplicationCategoryType -string "public.app-category.entertainment" "$P"
plutil -replace NSHumanReadableCopyright -string "A remix of PC2005-cloud/dsh-pet (MIT) · 基于 dsh-pet 二次创作" "$P"
# 菜单栏应用：启动时不在程序坞里闪一下（打开设置窗口时应用自己会显示程序坞图标）
plutil -replace LSUIElement -bool YES "$P"
plutil -remove ElectronAsarIntegrity "$P" 2>/dev/null || true

# ---------------------------------------------------------------- 签名（ad-hoc，本地签名，不需要开发者账号）
step "签名"
xattr -cr "$APP"
codesign --force --deep --sign - "$APP" 2>&1 | grep -v "replacing existing signature" || true
codesign --verify --deep --strict "$APP"
du -sh "$APP" | awk '{print "    大小 " $1}'

# ---------------------------------------------------------------- DMG
if [ "$DMG" = 1 ]; then
  DMG_FILE="$ROOT/dist/$NAME-$VERSION-$ARCH.dmg"
  step "生成安装镜像 $(basename "$DMG_FILE")"
  STAGE="$(mktemp -d)"
  ditto "$APP" "$STAGE/$NAME.app"
  ln -s /Applications "$STAGE/Applications"
  cp "$ROOT/scripts/dmg-readme.txt" "$STAGE/打不开看这里 · Read Me.txt"
  rm -f "$DMG_FILE"
  hdiutil create -quiet -volname "$NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG_FILE"
  rm -rf "$STAGE"
  du -h "$DMG_FILE" | awk '{print "    大小 " $1}'
fi

# ---------------------------------------------------------------- 安装到本机
if [ "$INSTALL" = 1 ]; then
  if [ "$ARCH" != "$HOST_ARCH" ]; then
    echo "这是 $ARCH 版，本机是 $HOST_ARCH，跳过安装。" >&2
  else
    TARGET_DIR="/Applications"
    [ -w "$TARGET_DIR" ] || TARGET_DIR="$HOME/Applications"
    mkdir -p "$TARGET_DIR"
    step "安装到 $TARGET_DIR"
    if pgrep -x "$EXE" >/dev/null; then
      osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
      for _ in $(seq 1 30); do pgrep -x "$EXE" >/dev/null || break; sleep 0.2; done
      pkill -x "$EXE" 2>/dev/null || true
    fi
    rm -rf "$TARGET_DIR/$NAME.app"
    ditto "$APP" "$TARGET_DIR/$NAME.app"
    open "$TARGET_DIR/$NAME.app"
    echo "    已安装：$TARGET_DIR/$NAME.app"
  fi
fi

step "完成：$APP"
