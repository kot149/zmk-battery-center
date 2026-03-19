{
  description = "zmk-battery-center - System tray app to monitor battery level of ZMK-based keyboards";

  inputs = {
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    utils,
    fenix,
  }:
    utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs {
        inherit system;
        overlays = [fenix.overlays.default];
      };
      toolchain = pkgs.fenix.complete;
      appName = "zmk-battery-center";
      buildInputs = with pkgs; [
        # js
        bun

        # rust
        (with toolchain; [
          cargo
          rustc
          rust-src
          clippy
          rustfmt
        ])
        pkg-config
        openssl

        webkitgtk_4_1
        libsoup_3
        dbus
        gtk3
        glib
        cairo
        pango
        gdk-pixbuf
        atk
        libayatana-appindicator
        libappindicator-gtk3
      ]
      ++ pkgs.lib.optionals pkgs.stdenv.isLinux (with pkgs; [
        libcanberra-gtk3
        mesa
        libepoxy
        libglvnd
      ]);

      # Unwrapped binaries (e.g. cargo run) need this so the dynamic linker finds
      # libdbus (bluest/BlueZ) and GTK/WebKit stacks from the Nix store.
      runtimeLibraryPath = pkgs.lib.makeLibraryPath (
        (with pkgs; [
          dbus
          webkitgtk_4_1
          libsoup_3
          gtk3
          glib
          cairo
          pango
          gdk-pixbuf
          atk
          libayatana-appindicator
          libappindicator-gtk3
        ])
        ++ pkgs.lib.optionals pkgs.stdenv.isLinux (with pkgs; [
          libcanberra-gtk3
          mesa
          libepoxy
          libglvnd
        ])
      );
    in rec {
      packages.default = pkgs.stdenv.mkDerivation rec {
        inherit buildInputs;
        name = appName;
        src = ./.;

        buildPhase = ''
          export HOME=$(mktemp -d)
          bun install --frozen-lockfile
          bun scripts/generate_licenses.ts --skip-verify
          bun tauri build
        '';

        installPhase = ''
          mkdir -p $out/bin
          cp src-tauri/target/release/${appName} $out/bin/${appName}
        '';
      };

      # Executed by `nix run`
      apps.default = utils.lib.mkApp {
        drv = packages.default;
      };

      # Used by `nix develop`
      devShell = pkgs.mkShell {
        inherit buildInputs;

        RUST_SRC_PATH = "${toolchain.rust-src}/lib/rustlib/src/rust/library";
        shellHook =
          ''
            export LD_LIBRARY_PATH="${runtimeLibraryPath}''${LD_LIBRARY_PATH:+:}$LD_LIBRARY_PATH"
          ''
          + pkgs.lib.optionalString pkgs.stdenv.isLinux ''
            export GTK_PATH="${pkgs.libcanberra-gtk3}/lib/gtk-3.0''${GTK_PATH:+:$GTK_PATH}"
            export WEBKIT_DISABLE_DMABUF_RENDERER=1
          '';
      };
    });
}
