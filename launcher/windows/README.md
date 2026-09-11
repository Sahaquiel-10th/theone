# ONE Key for Windows

`ONE.exe` is a native Windows x64 GUI launcher. On first launch it copies a credential-free presence helper into the current user's local cache. The helper reads the same `.one/credential.json` used by the macOS launcher, authenticates the device with Ed25519, opens the one-time browser login, disconnects when the USB drive is removed, and automatically reconnects when the same Key returns.

The checked-in `rsrc_windows_amd64.syso` embeds `ONE.ico` and `ONE.exe.manifest`. Regenerate it after changing either resource:

```bash
go run github.com/akavel/rsrc@v0.10.2 \
  -manifest ONE.exe.manifest \
  -ico ONE.ico \
  -o rsrc_windows_amd64.syso
```
