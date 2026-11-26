{
  description = "AsPulse/t3code development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        # nix-direnv は flake.nix と flake.lock の変更だけを監視するので、ピン留めはここに置く。
        pins = {
          pnpm = {
            version = "12.14.0";
            targets = {
              x86_64-linux = {
                pkg = "linux-x64";
                hash = "sha256-HemO0uliEROwiHsGMitGHvud9z2RP8HRUQObELcRekE=";
              };
              aarch64-darwin = {
                pkg = "darwin-arm64";
                hash = "sha256-BhNpIMnMytT2FbsIDgVNmsCG/t/DJJe9h6iSt6RYb28=";
              };
            };
          };
        };

        # pnpm 12 はネイティブバイナリ配布で、corepack や pnpm 自身の自動ダウンロード版は
        # NixOS で動的リンクに失敗する。nixpkgs 側の追従も遅れるため、公式バイナリを patchelf して使う。
        pnpm =
          let
            target = pins.pnpm.targets.${system} or null;
          in
          if target == null then
            pkgs.pnpm
          else
            pkgs.stdenv.mkDerivation {
              pname = "pnpm";
              inherit (pins.pnpm) version;
              src = pkgs.fetchurl {
                url = "https://registry.npmjs.org/@pnpm/exe.${target.pkg}/-/exe.${target.pkg}-${pins.pnpm.version}.tgz";
                inherit (target) hash;
              };
              nativeBuildInputs = [
                pkgs.makeWrapper
              ]
              ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
                pkgs.autoPatchelfHook
              ];
              buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
                pkgs.stdenv.cc.cc.lib
              ];
              dontStrip = true;
              installPhase = ''
                runHook preInstall
                install -Dm755 pnpm "$out/bin/pnpm"
                makeWrapper "$out/bin/pnpm" "$out/bin/pnpx" --add-flag "dlx"
                ln -s "$out/bin/pnpm" "$out/bin/pn"
                ln -s "$out/bin/pnpx" "$out/bin/pnx"
                runHook postInstall
              '';
            };

        # ワークツリーごとに node_modules/.bin/vp を解決するシム。
        # 未インストールのワークツリーで最初に `vp i` を叩いたときだけ pnpm install にフォールバックする。
        vp = pkgs.writeShellApplication {
          name = "vp";
          runtimeInputs = [
            pkgs.coreutils
            pkgs.nodejs_26
            pnpm
          ];
          text = ''
            search_dir="$PWD"
            if [ "''${1:-}" = "-C" ] && [ -n "''${2:-}" ] && [ -d "$2" ]; then
              search_dir="$(cd "$2" && pwd -P)"
            fi

            cur="$search_dir"
            while :; do
              if [ -x "$cur/node_modules/.bin/vp" ]; then
                exec "$cur/node_modules/.bin/vp" "$@"
              fi
              parent="$(dirname "$cur")"
              if [ "$parent" = "$cur" ]; then
                break
              fi
              cur="$parent"
            done

            case "''${1:-}" in
              i|install)
                shift
                args=()
                for arg in "$@"; do
                  if [ "$arg" != "--" ]; then
                    args+=("$arg")
                  fi
                done
                exec pnpm install "''${args[@]}"
                ;;
              *)
                echo "vp: node_modules/.bin/vp が見つかりません。先に 'vp i' (または 'pnpm install') を実行してください。" >&2
                exit 1
                ;;
            esac
          '';
        };

        playwrightBrowsers = pkgs.playwright-driver.browsers.override {
          withFirefox = false;
          withWebkit = false;
          withFfmpeg = false;
        };
      in
      {
        devShells.default = pkgs.mkShell {
          name = "t3code";

          packages = [
            pkgs.nodejs_26
            pnpm
            vp
            pkgs.cargo
            pkgs.rustc
            pkgs.python3
            pkgs.pkg-config
          ]
          ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
            pkgs.libsecret
          ];

          env = {
            # packageManager との差異で未 patch の pnpm ネイティブバイナリを自動ダウンロードするのを防ぐ。
            npm_config_manage_package_manager_versions = "false";
          }
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            # Vitest Browser Mode (Playwright) は NixOS で素のダウンロードバイナリが動かないため、
            # nixpkgs 側で patchelf 済みの Chromium を使う。
            PLAYWRIGHT_BROWSERS_PATH = "${playwrightBrowsers}";
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
          };
        };
      }
    );
}
