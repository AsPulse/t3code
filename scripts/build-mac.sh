#!/usr/bin/env bash
set -euo pipefail

upload_release() (
  local tag="$1" dmg="$2" commit="$3"
  local repo=AsPulse/t3code checksums_dir
  if gh release view "$tag" --repo "$repo" > /dev/null; then
    gh release upload "$tag" --repo "$repo" --clobber "$dmg"
  else
    gh release create "$tag" --repo "$repo" --verify-tag \
      --title "AsPulse T3 Code ${tag#aspulse-}" --notes "Built from $commit." "$dmg"
  fi

  checksums_dir="$(mktemp -d)"
  trap 'rm -rf -- "$checksums_dir"' EXIT
  gh release download "$tag" --repo "$repo" --dir "$checksums_dir" \
    --pattern '*.tar.gz' --pattern '*.dmg'
  (
    cd "$checksums_dir"
    shopt -s nullglob
    shasum -a 256 -- *.tar.gz *.dmg > SHA256SUMS
  )
  gh release upload "$tag" --repo "$repo" --clobber "$checksums_dir/SHA256SUMS"
)

install_app() (
  local dmg="$1" cache_dir="$2"
  local install_dir="${T3_INSTALL_DIR:-/Applications}" app_name='T3 Code (Beta).app'
  local installed="$install_dir/$app_name" stage_dir mount_dir

  osascript <<'APPLESCRIPT'
if application id "com.t3tools.t3code" is running then
  with timeout of 30 seconds
    tell application id "com.t3tools.t3code" to quit
  end timeout
  repeat 30 times
    if not (application id "com.t3tools.t3code" is running) then return
    delay 1
  end repeat
  error "T3 Code did not quit."
end if
APPLESCRIPT

  if [[ -d "$installed" ]]; then
    local backup
    backup="$cache_dir/backups/T3-Code-$(date +%Y%m%d-%H%M%S).zip"
    mkdir -p "$cache_dir/backups"
    ditto -c -k --keepParent "$installed" "$backup"
    printf 'Backup: %s\n' "$backup"
  fi

  mount_dir="$(mktemp -d)"
  stage_dir="$(mktemp -d "$install_dir/.t3code-install.XXXXXXXX")"
  trap 'hdiutil detach "$mount_dir" > /dev/null; rmdir "$mount_dir"; rm -rf -- "$stage_dir"' EXIT
  hdiutil attach -nobrowse -readonly -mountpoint "$mount_dir" "$dmg" > /dev/null
  ditto "$mount_dir/$app_name" "$stage_dir/$app_name"
  rm -rf -- "$installed"
  mv "$stage_dir/$app_name" "$installed"
  xattr -dr com.apple.quarantine "$installed" 2>/dev/null || true
)

verify_signature() (
  local dmg="$1" mount_dir
  mount_dir="$(mktemp -d)"
  trap 'hdiutil detach "$mount_dir" > /dev/null; rmdir "$mount_dir"' EXIT
  hdiutil attach -nobrowse -readonly -mountpoint "$mount_dir" "$dmg" > /dev/null
  codesign --verify --deep --strict "$mount_dir/T3 Code (Beta).app"
)

prepare_node() (
  local version="$1" node_dir="$2"
  local archive="node-v$version-darwin-arm64.tar.gz"
  local url="https://nodejs.org/dist/v$version" download_dir
  if [[ -x "$node_dir/bin/node" ]]; then
    return
  fi
  download_dir="$(mktemp -d)"
  trap 'rm -rf -- "$download_dir"' EXIT
  cd "$download_dir"
  curl -fsSLO "$url/$archive"
  curl -fsSL "$url/SHASUMS256.txt" | grep -F "  $archive" | shasum -a 256 -c -
  mkdir -p "$node_dir"
  tar -xzf "$archive" -C "$node_dir" --strip-components=1
)

main() {
  local tag="${1:-}" version upload=false install=false
  if [[ ! "$tag" =~ ^aspulse-v([0-9]+\.[0-9]+\.[0-9]+)(-[0-9]+)?$ ]]; then
    printf 'Usage: build-mac.sh <aspulse-vX.Y.Z[-N]> [--upload] [--install]\n' >&2
    return 2
  fi
  version="${BASH_REMATCH[1]}"
  shift
  while (($#)); do
    case "$1" in
      --upload) upload=true ;;
      --install) install=true ;;
      *) printf 'Unknown option: %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  if [[ "$(uname -s)-$(uname -m)" != Darwin-arm64 ]]; then
    printf 'An Apple Silicon Mac is required.\n' >&2
    return 1
  fi
  if ! command -v nix > /dev/null; then
    export PATH="/nix/var/nix/profiles/default/bin:$PATH"
  fi

  local cache_dir="$HOME/Library/Caches/t3code-fork-build"
  local checkout="$cache_dir/t3code"
  mkdir -p "$cache_dir"
  if [[ ! -d "$checkout/.git" ]]; then
    git clone --filter=blob:none --no-checkout https://github.com/AsPulse/t3code.git "$checkout"
  fi
  cd "$checkout"
  git fetch --tags origin
  git sparse-checkout set --no-cone '/*' '!/.repos/'
  git checkout --detach --force "refs/tags/$tag"
  git clean -fd

  local name value
  for name in CLERK_PUBLISHABLE_KEY CLERK_JWT_TEMPLATE CLERK_CLI_OAUTH_CLIENT_ID RELAY_URL; do
    value="$(sed -n "s|^T3CODE_${name}=||p" .env.example)"
    export "T3CODE_${name}=$value"
  done
  unset T3CODE_DESKTOP_UPDATE_REPOSITORY GITHUB_REPOSITORY T3CODE_DESKTOP_MOCK_UPDATES

  export CARGO_HOME="$cache_dir/cargo"
  export ELECTRON_BUILDER_CACHE="$cache_dir/electron-builder"
  export NPM_CONFIG_CACHE="$cache_dir/npm"
  export pnpm_config_store_dir="$cache_dir/pnpm/store" pnpm_config_cache_dir="$cache_dir/pnpm/cache"
  export VP_HOME="$cache_dir/vite-plus" XDG_CACHE_HOME="$cache_dir/xdg"

  local build_path node_version pnpm_version node_dir pnpm_dir
  build_path="$(nix shell nixpkgs#nodejs_26 nixpkgs#cargo nixpkgs#rustc -c printenv PATH)"
  export PATH="$build_path"
  node_version="$(node -p 'require("./package.json").engines.node')"
  pnpm_version="$(node -p 'require("./package.json").packageManager.split("@")[1]')"
  node_dir="$cache_dir/node/$node_version"
  pnpm_dir="$cache_dir/pnpm/$pnpm_version"

  prepare_node "$node_version" "$node_dir"
  if [[ ! -x "$pnpm_dir/node_modules/.bin/pnpm" ]]; then
    npm install --prefix "$pnpm_dir" --ignore-scripts --no-audit --no-fund "pnpm@$pnpm_version"
  fi
  export PATH="$node_dir/bin:$pnpm_dir/node_modules/.bin:$PATH"

  time pnpm install --frozen-lockfile \
    --filter=t3... --filter=@t3tools/web... --filter=@t3tools/desktop... --filter=@t3tools/scripts...
  export PATH="$checkout/node_modules/.bin:$PATH"

  node scripts/update-release-package-versions.ts "$version"
  time vp run build:desktop:bundle
  # A Nix cc wrapper on PATH cannot find the SDK's libiconv; Apple's clang can.
  time CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/usr/bin/clang cargo build --locked --release \
    --manifest-path native/resource-monitor/Cargo.toml --target aarch64-apple-darwin
  rm -rf -- release
  (
    trap 'git restore -- scripts/prepare-server-compile-cache.cjs' EXIT
    unset CSC_NAME
    # Unsigned packaging leaves Electron's stale signature, and build-desktop-artifact.ts
    # offers no way to ask electron-builder for an ad-hoc identity.
    cat >> scripts/prepare-server-compile-cache.cjs <<'CJS'

const prepareCompileCache = module.exports;
module.exports = async (context) => {
  await prepareCompileCache(context);
  const app = require("node:path").join(
    context.appOutDir, context.packager.appInfo.productFilename + ".app",
  );
  require("node:child_process").execFileSync(
    "/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" },
  );
};
CJS
    time T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true vp run dist:desktop:artifact \
      --platform mac --target dmg --arch arm64 --build-version "$version" --skip-build --verbose
  )

  local dmg="$checkout/release/T3-Code-$version-arm64.dmg"
  verify_signature "$dmg"
  if $upload; then
    upload_release "$tag" "$dmg" "$(git rev-parse HEAD)"
  fi
  if $install; then
    install_app "$dmg" "$cache_dir"
  fi
  printf '%s\n' "$dmg"
}

main "$@"
