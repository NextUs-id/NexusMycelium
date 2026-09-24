# TASKS — Nexus Agent (fokus core dulu)

Ukuran: **S** jam · **M** 1–2 hari · **L** 3+ hari. Tiap task punya ✓ kriteria selesai.
Status awal scaffold: 0.2 dan 0.3 selesai, dasar 1.1–1.3 sudah ada (perlu diperluas).

## Cara kerja agent

Sebelum mengerjakan task, ikuti `docs/AGENT_WORKFLOW.md`. Satu task memakai satu branch dan satu perubahan kecil. Test ditulis lebih dulu, `corepack pnpm check` wajib hijau, lalu update dokumentasi dan checklist task.

## Fase 0 — Fondasi
- [ ] **0.1 (S)** Putuskan nama final; cek GitHub/npm/domain. Ganti scope `@nexus/*` bila perlu
- [x] **0.2 (S)** Monorepo pnpm, TS strict, lint, vitest, CI. ✓ `pnpm check` hijau
- [x] **0.3 (S)** `AGENTS.md` + `docs/ARCHITECTURE.md` skeleton
- [ ] **0.4 (M)** Benchmark awal: 20 tugas coding kecil + metrik (biaya, token, waktu, sukses). ✓ satu perintah menjalankan semuanya

## Fase 1 — Kernel (🔒)
- [ ] **1.1 (M)** Kontrak Plugin API final. ✓ `docs/PLUGIN_API.md` + tipe (draf sudah ada)
- [ ] **1.2 (M)** Loader/registry: urutan dependensi, hot swap, isolasi kegagalan. ✓ plugin dimuat/dibuang tanpa restart (baseline sudah ada)
- [ ] **1.3 (S)** Event bus dengan tipe event terdaftar (baseline sudah ada)
- [ ] **1.4 (M)** Config YAML + resolusi `plugins/` → `user/`. ✓ config user menimpa default tanpa mengubah file official
- [ ] **1.5 (M)** Sistem izin allow/ask/deny per tool. ✓ tool berbahaya meminta approval

🏁 **M1:** kernel jalan, plugin bisa hot-load.

## Fase 2 — Agent inti
- [ ] **2.1 (M)** Plugin `model-*` (satu provider dulu, interface generik)
- [ ] **2.2 (M)** Plugin `loop-react`. ✓ agent memanggil tool dalam loop
- [ ] **2.3 (M)** Tool `fs` dan `shell` (dengan izin). ✓ agent mengedit file di proyek uji
- [ ] **2.4 (M)** Sesi tersimpan (SQLite/JSONL), resume dan fork
- [ ] **2.5 (S)** UI CLI minimal
- [ ] **2.6 (M)** Jalankan benchmark. ✓ ≥ 5 dari 20 tugas selesai end-to-end

🏁 **M2:** agent pertama yang benar-benar bekerja.

## Fase 3 — Aman
- [ ] **3.1 (L)** Sandbox runner (container atau git worktree terisolasi)
- [ ] **3.2 (M)** Snapshot dan rollback berbasis git. ✓ satu perintah mengembalikan keadaan sebelum tugas
- [ ] **3.3 (M)** Budget guard (token, uang, waktu). ✓ agent berhenti saat batas tercapai
- [ ] **3.4 (S)** Trace log terstruktur

## Fase 4 — Efisiensi (pembeda utama)
- [ ] **4.1 (M)** Prompt caching
- [ ] **4.2 (M)** Context compactor otomatis
- [ ] **4.3 (M)** Tool call paralel
- [ ] **4.4 (M)** Tool edit berbasis diff. ✓ token turun dibanding tulis ulang file
- [ ] **4.5 (M)** Router model murah/mahal
- [ ] **4.6 (S)** Dashboard CLI biaya dan token per tugas. ✓ ada baseline sebelum/sesudah

🏁 **M3:** bukti angka penghematan di benchmark.

## Fase 5 — Ekstensi standar
- [ ] **5.1 (M)** MCP client
- [ ] **5.2 (S)** Skills loader (SKILL.md)
- [ ] **5.3 (S)** Pembaca `AGENTS.md`
- [ ] **5.4 (L)** Memori v1: vault Markdown + `[[wikilink]]` + indeks SQLite

## Fase 6 — System 1 (Laya/Jev)
- [ ] **6.1 (M)** Interface plugin `judge`. ✓ bisa ganti Laya, Jev, atau fallback LLM
- [ ] **6.2 (M)** Integrasi Laya lokal (ONNX). ✓ berjalan di mesin dev
- [ ] **6.3 (M)** Uji akurasi di data sendiri (termasuk bahasa Indonesia) dan kalibrasi
- [ ] **6.4 (M)** Pakai untuk gate tool call dan pemilihan tool. ✓ LLM lebih jarang dipanggil, sukses tidak turun

## Fase 7 — Self-evolve (jantung Nexus)
- [ ] **7.1 (L)** Pipeline gate: worktree → lint/type → unit → eval → smoke sandbox → canary → swap → rollback
- [ ] **7.2 (M)** Tool `plugin.create`, `plugin.test`, `plugin.install`
- [ ] **7.3 (M)** `agent-made/staging` dan `active`
- [ ] **7.4 (L)** Hot reload plugin buatan agent. ✓ patch buruk otomatis ditolak
- [ ] **7.5 (L)** `patches.lock` + merge 3 arah + uji ulang patch user setelah update
- [ ] **7.6 (L)** Kristalisasi skill: pola berulang → script tanpa LLM. ✓ biaya tugas berulang turun

🏁 **M4:** agent memperbaiki dirinya dengan aman.

## Fase 8 — Kesadaran diri
- [ ] **8.1 (M)** `self.inspect()` + `SELF.md` otomatis
- [ ] **8.2 (M)** Scheduler: goals, heartbeat, cron
- [ ] **8.3 (M)** Refleksi setelah tugas + catat tingkat sukses per jenis tugas
- [ ] **8.4 (M)** Skor keyakinan (dari judge) → bertanya atau eskalasi
- [ ] **8.5 (L)** Graph view live

## Template prompt per task
```
Task: <ID + judul>
Konteks: baca AGENTS.md dan docs/ARCHITECTURE.md
Tujuan: <1 kalimat>
Kriteria selesai: <dari daftar ✓>
Batasan: jangan ubah kernel/ kecuali disebut; tambahkan tes
Output: ringkasan perubahan + hasil tes
```

## Urutan awal yang disarankan
0.1 → 0.4 → 1.1 → 1.2 → 1.4 → 2.1 → 2.2 → 2.3 → 2.6
