**Game:** Dolphin
**Exe:** Dolphin.exe
**Engine / API:** Emulator / dx12
**Route:** OptiScaler + Feeder
**Game Help finding:** nr-model-crash-emulator (step)
**Last run verdict:** nr-model-crash (D3D12Core <- nvngx_dlssnr)
**GPU:** NVIDIA GeForce RTX 5070 Ti
**App:** v1.80.0

<details><summary>Run digest (what the logs say)</summary>

```
api: dx12 -- the emulator is set to Direct3D 12
bitness: 64-bit
route: feeder
verdict: nr-model-crash (D3D12Core <- nvngx_dlssnr)
at: 2026-09-15T18:02:11.000Z
runtime api: dx12 -- what OptiScaler actually saw in the process
neural model: crashed in its evaluate, and the feed stopped
smooth motion: active in this process
```
</details>
