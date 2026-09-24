# Nexus Agent (nama sementara)

Agent yang **makin murah dan makin cepat seiring dipakai**: kernel kecil terkunci, semua fitur berupa plugin, perubahan diri lewat gate uji, patch user tahan update.

## Mulai
```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check      # lint + typecheck + test
```
Butuh Node.js ≥ 20 dan pnpm `12.6.0` sesuai `packageManager`.

## Dokumen
- `AGENTS.md` — aturan untuk agent coding
- `TASKS.md` — daftar task per fase
- `docs/ARCHITECTURE.md` — arsitektur
- `docs/PLUGIN_API.md` — kontrak plugin
- `docs/AGENT_WORKFLOW.md` — SOP kerja agent, validasi, gate, dan serah terima
- `task-dashboard.html` — dashboard status task; buka lewat server lokal
- `docs/NAME_RESEARCH.md` — collision screen Task 0.1 dan rekomendasi nama

## Status
Fase 0 selesai (scaffold). Baseline kernel (manifest, event bus, registry) sudah ada dengan tes. Lanjut ke `TASKS.md` → 0.1, 0.4, 1.x.

## Ganti nama
Scope `@nexus/*` bersifat sementara. Setelah nama final (Task 0.1), ganti dengan pencarian global.
