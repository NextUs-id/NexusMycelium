---
name: nexus-git
description: Konvensi Git dan SOP kerja untuk repo NexusMycelium.
---

# NexusMycelium: konvensi Git

Satu task = satu branch = satu perubahan kecil. Jangan pernah menimpa perubahan milik orang lain.

## Gate wajib

```bash
corepack pnpm check
```

`check` adalah `biome check .` + `tsc --noEmit` + test. Kalau gagal, task **belum** selesai: kotaknya di
`TASKS.md` tidak dicentang.

## Urutan commit

1. Tulis test lebih dulu, dan pastikan ia gagal karena perilaku belum ada.
2. Implementasikan seminimal mungkin.
3. Jalankan gate bagian 4 di `docs/AGENT_WORKFLOW.md`.
4. Baca `git diff` penuh: tidak boleh ada API key, data runtime, atau file `user/`.
5. Commit kecil dengan pesan yang menyebut nomor task.

## Larangan

- Tidak pernah menjalankan `rm` tanpa konfirmasi eksplisit pengguna.
- Tidak pernah menulis path absolut, URL, atau key milik pengguna ke dokumen yang ter-track.
- Tidak pernah mencantumkan sebuah task selesai hanya karena file-nya ada.
