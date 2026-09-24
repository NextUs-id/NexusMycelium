# Arsitektur Nexus Agent

> Dokumen ini dibaca manusia **dan** agent. Jaga tetap akurat; agent memakainya untuk memahami dirinya.

## Ide inti
- **Kernel kecil dan terkunci**, semua fitur lain adalah **plugin** (model, tool, memori, loop, UI).
- **Tiga lapisan**: `kernel/` (terkunci) → `plugins/` (official, diupdate) → `user/` (milik user, tidak pernah ditimpa).
- **Plugin buatan agent** masuk karantina (`agent-made/staging`) dan baru aktif setelah lolos **gate**.
- **Efisiensi sebagai fitur**: biaya dan token per tugas adalah metrik utama.

## Tanggung jawab kernel (dan hanya ini)
| Modul | Fungsi | Status |
|---|---|---|
| `manifest` | Skema manifest plugin (Zod) | ada |
| `events` | Event bus bertipe, handler terisolasi | ada (baseline) |
| `plugin` | `definePlugin`, `PluginContext` | ada |
| `registry` | Register, load, unload, cek dependensi | ada (baseline, Task 1.2) |
| `config` | Gabung default official ← `user/` | Task 1.4 |
| `permissions` | allow/ask/deny per tool | Task 1.5 |
| `gate` | test → canary → swap → rollback | Task 7.1 |
| `sandbox` | Runner terisolasi | Task 3.1 |

Semua yang lain (loop agent, model, tool, memori, MCP, skills, UI, scheduler, judge) **bukan** kernel.

## Siklus hidup plugin
1. `definePlugin({ manifest, setup })` memvalidasi manifest.
2. `registry.register(plugin)` mendaftarkan.
3. `registry.load(name)` mengecek `requires`, memanggil `setup(ctx)`, menyimpan disposer.
4. `registry.unload(name)` memanggil disposer; ditolak bila plugin lain bergantung padanya.
5. Hot swap = unload versi lama + load versi baru (Task 1.2/7.4).

## Alur gate (target Task 7.1)
```
patch di worktree → lint/type → unit test → eval → smoke test sandbox
   → canary (sebagian traffic) → hot swap → pantau error → rollback otomatis bila gagal
```
Semua versi tersimpan di git; selalu ada jalan mundur.

## Update yang tidak merusak patch user
- Update hanya menyentuh `kernel/` dan `plugins/`.
- Patch user berupa overlay/hook di `user/`, bukan edit file official.
- `user/patches.lock` mencatat versi dasar tiap patch untuk merge 3 arah.
- Setelah update, semua patch user diuji ulang di background. Yang gagal dinonaktifkan sementara dan agent menawarkan perbaikan.

## Peta folder
```
kernel/        loader, registry, events, izin, gate (🔒)
plugins/       fitur official, satu folder per plugin
agent-made/    staging/ (diuji) dan active/ (lolos gate)
user/          config.yaml, plugins/, overrides/, skills/, patches.lock
data/          memory.db, sessions/, snapshots/, traces/ (gitignored)
benchmarks/    tugas uji + metrik
docs/          dokumen ini dan PLUGIN_API.md
```

## Keputusan yang sudah diambil
- Bahasa core: TypeScript (Node.js). Python hanya untuk eval/skill lewat MCP atau JSON-RPC.
- Memori: vault Markdown (`[[wikilink]]`) sebagai sumber kebenaran, indeks SQLite turunan.
- System 1 (Laya/Jev) di balik satu interface `judge`.
