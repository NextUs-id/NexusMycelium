# AGENTS.md — aturan main untuk agent coding

Baca file ini, `docs/AGENT_WORKFLOW.md`, dan `docs/ARCHITECTURE.md` sebelum menyentuh kode. Bahasa dokumen: Indonesia; kode, komentar, dan nama identifier: Inggris.

## Prinsip
1. **Everything is a plugin.** Fitur baru = plugin di `plugins/`, bukan edit kernel.
2. **`kernel/` terkunci.** Ubah hanya jika task menyebutkannya secara eksplisit. Kernel harus kecil dan membosankan.
3. **Efisiensi adalah fitur.** Hemat token, waktu, dan memori. Ukur, jangan menebak.
4. **Aman dulu.** Aksi berisiko lewat sistem izin; perubahan diri lewat gate (test → canary → swap → rollback).
5. **Milik user tidak disentuh.** `user/` tidak pernah ditimpa oleh update atau agent.

## Perintah
```bash
corepack pnpm install        # pasang dependensi
corepack pnpm test           # vitest run
corepack pnpm typecheck      # tsc --noEmit
corepack pnpm lint           # biome check
corepack pnpm format         # biome check --write
corepack pnpm check          # lint + typecheck + test (wajib hijau sebelum selesai)
```

## Alur kerja per task
- **1 task = 1 branch = 1 PR kecil.** Nama branch: `task/<id>-<slug>` (contoh `task/1.2-registry`).
- **Tes dulu, kode kemudian.** Tulis tes yang gagal, lalu implementasi.
- Ambil task dari `TASKS.md`. Penuhi baris **✓ kriteria selesai**.
- Jangan mengerjakan task lain di PR yang sama.

## Definition of Done
- [ ] `pnpm check` hijau
- [ ] Ada tes untuk perilaku baru
- [ ] Dokumen terkait ikut diperbarui (`docs/`, `TASKS.md`)
- [ ] Tidak ada perubahan di `kernel/` kecuali diminta task
- [ ] Benchmark (`benchmarks/`) tidak memburuk (setelah Task 0.4)

## Gaya kode
- TypeScript strict, ESM. Import lokal memakai akhiran `.js`.
- Validasi data eksternal dengan Zod.
- Jangan `any`. Jangan menelan error diam-diam.
- Fungsi kecil, nama jelas. Komentar menjelaskan *kenapa*, bukan *apa*.
- Dependensi baru: tambahkan hanya bila perlu, dan sebutkan alasannya di PR.

## Struktur singkat
```
kernel/        🔒 loader, registry, event bus, izin, gate
plugins/       ✅ semua fitur official (satu folder = satu plugin)
agent-made/    🤖 plugin buatan agent (staging → active setelah lolos gate)
user/          🧑 milik user, tidak pernah ditimpa
data/          memori, sesi, snapshot, trace (di-gitignore)
benchmarks/    tugas uji dan metrik
docs/          arsitektur dan kontrak plugin
```

## Yang dilarang
- Mengedit `user/` atau `data/` dari kode fitur.
- Menambah privilege langsung di kernel demi kenyamanan satu plugin.
- Menjalankan perintah destruktif di luar sandbox atau worktree.
- Menyimpan rahasia (API key) di repo. Pakai `.env`.
- Mengklaim penghematan tanpa angka dari benchmark.
