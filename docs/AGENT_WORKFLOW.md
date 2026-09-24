# Agent Workflow — Nexus Agent

Dokumen ini adalah SOP kerja agent untuk Nexus Agent. Baca bersama `AGENTS.md` dan `docs/ARCHITECTURE.md` sebelum mengubah kode.

## 0. Scope dan safety

- Repo aktif: `/media/andrew/DATA1/02_Development/Agents/NexusMycelium/nexus-scaffold/nexus/`.
- Satu task = satu branch = satu perubahan kecil.
- Jangan menyentuh `user/` atau `data/` dari implementasi fitur.
- Jangan mengubah `kernel/` kecuali task menyebutkannya secara eksplisit.
- Jangan mengklaim fitur selesai hanya karena file dibuat. Jalankan check yang relevan.
- Jangan menambah dependency, framework, atau service sebelum ada task yang membutuhkannya.

## 1. Mulai task

1. Buka repo dan baca `AGENTS.md`, `docs/ARCHITECTURE.md`, serta `docs/PLUGIN_API.md` bila menyangkut plugin.
2. Baca `TASKS.md`; pilih **satu** task yang belum selesai.
3. Tulis ulang task dalam 1 kalimat: tujuan, scope, dan kriteria selesai.
4. Periksa `git status --short` dan diff yang sudah ada. Jangan menimpa perubahan milik user.
5. Buat branch dari base yang bersih:

   ```bash
   git switch -c task/<id>-<slug>
   ```

6. Catat acceptance criteria dan batasan kernel sebelum coding.

## 2. Test 먼저

1. Tambahkan atau ubah test paling kecil yang membuktikan perilaku baru.
2. Jalankan test relevan dan pastikan gagal karena perilaku belum ada, bukan karena setup rusak.
3. Jika task hanya dokumentasi, tambahkan validasi link/format atau cek status yang reproducible; jangan membuat test kosong.

## 3. Implementasi minimum

1. Kerjakan hanya task terpilih.
2. Untuk fitur official, buat atau ubah satu plugin di `plugins/`.
3. Untuk plugin agent, mulai di `agent-made/staging/`; jangan langsung masuk `active/`.
4. Gunakan TypeScript strict, ESM, dan import lokal berakhiran `.js`.
5. Validasi input eksternal dengan Zod bila kontrak plugin atau konfigurasi membutuhkannya.
6. Jangan memakai `any`; jangan menelan error.
7. Perbarui `docs/` atau `TASKS.md` bila perilaku, kontrak, atau status berubah.
8. Hentikan scope ketika acceptance criteria terpenuhi. Jangan mengimplementasikan roadmap berikutnya.

## 4. Validasi lokal

Dari root repo `nexus/`, jalankan berurutan:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm check
```

`corepack pnpm check` adalah gate wajib sebelum serah terima. Jika shell memakai pnpm versi lain, gunakan Corepack sesuai `packageManager` project dan catat blocker; jangan mengganti versi tanpa alasan.

## 5. Review sebelum commit

Periksa:

```bash
git diff --check
git diff --stat
git status --short
```

Lalu baca diff penuh. Pastikan:

- tidak ada API key, `.env`, data runtime, atau file user;
- tidak ada perubahan di luar scope;
- test ada untuk perilaku baru;
- dokumentasi sinkron;
- tidak ada dependency baru yang tidak diperlukan;
- kernel hanya berubah bila diizinkan task.

## 6. Commit dan serah terima

1. Commit kecil dengan pesan yang menyebut task, misalnya `task/1.4: add config resolution`.
2. Pastikan diff dan status bersih setelah commit.
3. Isi `TASKS.md` hanya setelah kriteria selesai terverifikasi.
4. Buka PR kecil jika remote tersedia.
5. Tunggu CI. Jangan menyatakan selesai sebelum CI hijau.

Format laporan serah terima:

```text
Task:
Branch:
Commit:
Scope:
Tests:
Check:
Docs:
Risiko/keterbatasan:
```

## 7. Lifecycle plugin agent

Flow target:

```text
staging → test → gate → canary → active
```

Folder `staging/` dan `active/` sudah tersedia, tetapi gate executable belum ada. Jangan mengklaim tahap ini sudah berjalan. Untuk Task 7.1, gate wajib meliputi:

```text
worktree → lint/type → unit → eval → smoke sandbox → canary → hot swap → monitor → rollback
```

Plugin yang gagal gate tetap di `staging/` atau dinonaktifkan. Jangan memindahkan ke `active/` hanya karena compile/test dasar hijau.

## 8. Stop conditions

Berhenti dan laporkan blocker bila:

- task tidak punya acceptance criteria;
- perubahan membutuhkan kernel tetapi task tidak mengizinkan;
- test baseline gagal sebelum perubahan;
- dependency/toolchain tidak bisa dipasang atau tidak kompatibel;
- perubahan memerlukan keputusan produk/arsitektur yang belum diputuskan;
- adanya file `user/` atau `data/` yang akan tertimpa.

Laporan blocker wajib menyebut bukti, file/command yang dipakai, dan langkah keputusan yang dibutuhkan.

## 9. Urutan MVP

Ikuti urutan yang sudah ditetapkan di `TASKS.md`:

```text
0.1 → 0.4 → 1.1 → 1.2 → 1.4 → 2.1 → 2.2 → 2.3 → 2.6
```

Jangan menambah provider, MCP, memory, scheduler, UI, atau Laya sebelum task yang membutuhkannya aktif.
