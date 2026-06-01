# Bundled UAssetGUI

`UAssetGUI.exe` (self-contained, single-file, win-x64) is placed in this
folder so Riff can derive Unreal `.uasset` / `.umap` property diffs without the
end user installing anything.

- **Release CI** (`.github/workflows/release.yml`) builds a self-contained
  UAssetGUI from source and drops `UAssetGUI.exe` here before `tauri build`.
- **Local release builds**: place a self-contained `UAssetGUI.exe` here
  manually, or build one:
  `dotnet publish UAssetGUI/UAssetGUI.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true`
- **`tauri dev`**: this binary is usually absent; set the UAssetGUI path via
  the in-app "UE" settings (the path override wins over the bundle).

The binary and its license file are git-ignored (large, fetched at build
time). UAssetGUI is MIT-licensed (atenfyr/UAssetGUI); its `LICENSE` is shipped
next to the exe as `UAssetGUI-LICENSE.txt`.
