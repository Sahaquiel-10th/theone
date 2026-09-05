# ONE Key for Windows

`ONE.exe` is a native Windows x64 GUI launcher. It reads the same `.one/credential.json` used by the macOS launcher, authenticates the device with Ed25519, opens the one-time browser login, and remains connected to answer fresh presence challenges until the USB drive is removed.

The checked-in `rsrc_windows_amd64.syso` embeds `ONE.ico` and `ONE.exe.manifest`. Regenerate it after changing either resource:

```bash
go run github.com/akavel/rsrc@v0.10.2 \
  -manifest ONE.exe.manifest \
  -ico ONE.ico \
  -o rsrc_windows_amd64.syso
```
