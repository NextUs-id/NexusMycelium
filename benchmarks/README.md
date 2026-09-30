# Benchmarks

## Status Task 0.4

`bench:20` adalah command kanonik. Runner mengunci provider `mock`, menjalankan tepat 20 task, memverifikasi output, dan menjadi gagal bila task, verifier, status, jumlah hasil, atau harness tidak memenuhi gate. Smoke tetap hanya sanity check satu task.

## Command

```bash
corepack pnpm bench:20
```

Script kanonik di `package.json` menjalankan build lalu runner secara langsung:

```text
tsc -p tsconfig.build.json && node dist/benchmarks/run.js
```

Tidak ada nested `pnpm` di dalam script. Setelah build berhasil, perintah yang sama dapat dipanggil secara langsung dengan `node dist/benchmarks/run.js`. Smoke yang sudah ada tetap punya command terpisah: `corepack pnpm bench:smoke` atau `node dist/benchmarks/smoke.js`. Acceptance Task 2.6 punya command terpisah juga: `corepack pnpm bench:accept` atau `node dist/benchmarks/accept.js` (lihat "Status Task 2.6").

## Run terbaru

Run final `corepack pnpm bench:20` menghasilkan 20/20 task sukses, exit code 0, `elapsedMs` 845, 40 `steps`, dan 20 `toolCalls`; `successRate` 1. `usage.status` adalah `unavailable` dan `cost.source` adalah `mock-not-billed`. Nilai waktu adalah observasi satu run, bukan SLA. `taskSetHash` adalah `645a15f7f716ea1ef51465dca9e3fdf0f4772af410098afe6bbd049c07d644d2` dan `reproducibilityHash` adalah `8135d0ff1d29794842d3d0fa6bf8ac05c6c22787fa3e63869caa5c11212da1b3`.

## Status Task 4.2d — Harness pengukuran compaction

`bench:20` tidak pernah melewati cap compactor, jadi ia tidak bisa bicara apa pun soal compaction. Harness ini kebalikannya: satu bentuk transcript yang tetap, dijalankan dua kali — sekali dengan cap yang tidak terjangkau mana pun (baseline) dan sekali dengan cap yang menggigit — lalu melaporkan karakter yang benar-benar diserahkan ke provider.

```bash
corepack pnpm bench:compaction
# tsc -p tsconfig.build.json && node dist/benchmarks/compaction.js
```

Bentuk skenarionya tetap: 8 putaran tool yang tiap hasil tool-nya 4.000 karakter, 9 pesan history tersimpan, `maxChars` 4.000, `keepMessages` 4. Run canonical menghasilkan:

- `baseline.promptChars` 218.349 dan `compacted.promptChars` 1.806, jadi `charsSaved` 216.543 atau **99,17%**.
- `retained.allRetained` `true`: kedua instruksi tersimpan dan kedua jawaban lama masih ada di transcript yang dikirim.
- `compacted.orphanToolResults` `0` dan `compacted.compactedTurns` 9.
- `usage.status` `unavailable`, `tokensMeasured` `false`.

**Angka itu batas atas yang condong, bukan klaim umum.** Skenarionya memang dibuat condong: setiap tool mengembalikan 4.000 karakter sementara cap-nya 4.000, jadi hampir seluruh prompt adalah hasil tool yang memang dibuang. Pada run yang isi utamanya prosa atau instruksi, angka ini akan jauh lebih kecil, dan tier dua yang mengorbankan span tertua akan lebih sering dipakai. Angka ini juga **bukan** token: provider di harness ini stub offline yang tidak melapor usage, jadi `tokensMeasured` `false` dan `usage` `unavailable`. Jangan mengutip 99,17% sebagai "compaction hemat token".

Gate harness menolak dengan exit 1 kalau `charsSaved` 0, ada instruksi/jawaban yang hilang, atau ada hasil tool yatim. Uji negatifnya memakai cap yang tidak terjangkau, jadi "nol penghematan" ditolak dan bukan dilaporkan sebagai sukses. Tidak ada mode report-only.

## Kontrak 20 task

Task ID yang harus ada di `benchmarks/tasks.ts` adalah: `ts-constant`, `py-add`, `json-record`, `yaml-settings`, `css-grid`, `html-main`, `sql-filter`, `slug-regex`, `weekday-check`, `markdown-note`, `state-initial`, `csv-header`, `env-mode`, `xml-record`, `ignore-list`, `average`, `badge-component`, `health-handler`, `rust-answer`, dan `jsonl-event`.

- `benchmarks/tasks.ts` mendefinisikan tepat 20 task dengan ID, prompt/instruksi, dan expected files; task set harus fixed, unique, dan aman.
- `runBenchmark()` memakai task set kanonik. `runBenchmark({ tasks })` juga merupakan mode benchmark kanonik dan menolak list kosong, duplikasi, atau jumlah selain 20. Fixture non-20/custom hanya boleh melalui `internal.tasks` untuk test internal dan tidak dapat dipilih oleh CLI kanonik.
- `benchmarks/run.ts` menjalankan seluruh task, bukan mengganti verifier dengan status model. Verifier membandingkan file dan isi file dengan expected map dan menentukan `success` bersama status runner.
- Satu hasil/task memuat `elapsedMs`, `success`, `status`, `steps`, `toolCalls`, tools, dan failure code tanpa prompt atau secret. Ringkasan mempertahankan jumlah task, berhasil, gagal, dan total metrik.
- Task yang gagal, dihentikan, timeout, atau verifier-nya gagal tidak dihitung sukses. Hasil parsial tetap ditulis untuk diagnosa, tetapi gate canonical memerlukan 20 hasil sukses.

## Gate dan schema report

`main()` selalu emit satu report `schemaVersion: "1.0"`. Sukses dan top-level error memakai schema yang sama: `status` membedakan `completed` dari `error`, dan error harness selalu memakai `harnessError` serta exit code 1. Exception validasi pun menghasilkan report lengkap, bukan objek error ad-hoc.

Gate canonical mengembalikan exit code 1 bila kurang dari 20 task sukses, planned/attempted tidak sama, hasil task tidak lengkap, status bukan `completed`, verifier/task gagal, atau harness error. Pemanggil programatis dapat secara eksplisit memakai `main({ reportOnly: true })`; opsi ini hanya mengubah task gate menjadi report-only dan tetap tidak dapat melewati harness error. CLI `bench:20` tidak mengaktifkan opsi tersebut.

## Provenance token dan biaya

Mock provider bersifat deterministic dan tidak melakukan panggilan berbayar. Report aktual sekarang memberi `usage.status: unavailable`, `source: model-mock`, `method: provider-does-not-report`, dan token input/output/total `null`; ia tidak mengarang usage. `cost` adalah `amount: 0`, `currency: USD`, `source: mock-not-billed`, sehingga angka itu bukan tagihan dan bukan bukti biaya provider live. Jika estimator ditambahkan, angka token hanya `estimated`/`mock-estimate` dan harus ditandai `billed: false` atau `not-billed`. **Koreksi untuk versi dokumen sebelumnya:** `ModelResult` di `kernel/src/model.ts` kini punya `usage?: ModelUsage` opsional, jadi kalimat "kontrak `ModelProvider` tidak menyediakan usage" sudah tidak benar — yang benar adalah `usage` itu **opsional**, `plugins/model-mock` tidak melaporkannya, dan tidak ada harga di kontrak provider. Karena benchmark memaksa provider `mock`, `usage.status` tetap `unavailable` (bukan nol) dan tidak ada biaya yang bisa dihitung. `usage` dan `cost` di `benchmarks/run.ts` adalah **literal di source**, bukan turunan jalur pengukuran apa pun. CI tidak boleh memakai live provider atau secret.

## Isolasi dan secret

Setiap task benchmark harus memakai root sementara baru, config benchmark yang eksplisit, dan tools root yang terisolasi; hasil tidak boleh menulis ke checkout dan root harus dibersihkan setelah task. Root confinement tool bukan OS sandbox, jadi ini isolation workspace, bukan klaim keamanan penuh. Benchmark tidak membaca `user/config.yaml`, `user/providers/`, `user/secrets/`, API key, atau credential lain dari user. Config harus memaksa provider mock dan permissions minimum yang diperlukan verifier.

Isolasi ini **milik harness benchmark sendiri, bukan hasil Task 3.1**. `benchmarks/run.ts` masih membangun akar `mkdtemp` dan config `tools.root: workspace`-nya sendiri; ia tidak mengimpor `createSandbox` maupun `runInSandbox` dari `src/sandbox.ts`, jadi tidak ada yang boleh mengutip sandbox 3.1 sebagai bukti isolasi benchmark atau sebaliknya. Process/workspace sandbox 3.1 adalah path terpisah yang dipakai CLI lewat `run --sandbox`; detail dan batasnya di `docs/ARCHITECTURE.md` ("Status Task 3.1").

Snapshot/restore git **3.2** juga tidak dipakai di sini: `benchmarks/` tidak mengimpor `createSnapshot` maupun `restoreSnapshot`, jadi tidak ada baseline commit dan tidak ada `reset --hard`/`clean -fd` di jalur benchmark. Workspace benchmark dihapus dengan `rm(root, { recursive: true, force: true })` pada akhir task di `benchmarks/run.ts`, bukan dipulihkan ke baseline commit. Karena itu 3.2 juga tidak boleh dikutip sebagai bukti isolasi benchmark atau sebaliknya; cakupannya hanya workspace sandbox temp yang dipakai CLI lewat `run --sandbox --snapshot`, dan tiap angka di dokumen ini tetap berasal dari report `benchmarks/run.ts` dengan provider `mock`.

## Failure semantics dan reproducibility

Task-level `stopped`, `error`, exception, atau verifier failure menghasilkan `success: false`; hasil parsial tetap dipertahankan untuk diagnosa. Kegagalan setup/cleanup menghasilkan `harnessError`, `status: "error"`, dan exit code 1. Task yang hilang atau ringkasan yang tidak memenuhi gate juga gagal.

Report mempertahankan `taskSetHash` lama untuk kompatibilitas. `reproducibilityHash` adalah SHA-256 dari provenance yang mencakup hash manifest task, hash expected plus implementasi verifier, hash config benchmark, dan versi runner, config, provider, model, tool, serta agent. Provenance tool menunjuk ke `tools-basic`, provider tool canonical yang dimuat runtime, bukan `tools-core` legacy. Hash input tidak memasukkan timestamp, durasi, output task, atau path sementara, sehingga run dengan input yang sama menghasilkan hash yang sama.

## CI

CI menjalankan `pnpm bench:smoke` lalu `pnpm bench:20`, lalu `pnpm bench:accept` sebagai acceptance gate Task 2.6. Runner 20-task mengunci provider `mock`, membuat config/root sementara, dan tidak membaca user secret; tidak ada live provider, API key, atau 9Router dalam contract test. Gate canonical tidak pernah memakai mode report-only, dan `bench:accept` juga tidak punya mode report-only.

## Status Task 2.6

Task 2.6 adalah "jalankan benchmark" dengan ambang **≥ 5 dari 20 tugas selesai end-to-end**. Statusnya per 2026-09-26: **ditutup** setelah full gate hijau, dengan acceptance harness khusus di `benchmarks/accept.ts` dan 6 test di `benchmarks/acceptance.test.ts`.

### Apa yang ditambahkan, dan apa yang tidak

`benchmarks/accept.ts` adalah entry point acceptance 2.6. Ia **tidak mengubah** `run.ts`: `runBenchmark`, `BenchmarkReport`, `taskSetHash`, dan `reproducibilityHash` tetap milik `benchmarks/run.ts` sebagai satu-satunya sumber kebenaran, dan `accept.ts` hanya menjalankan task set kanonik lalu menilai report-nya. Yang ditambahkan hanya lapisan penilaian di atas report yang sudah ada:

- `MIN_SUCCEEDED = 5` — ambang 2.6, dan `CANONICAL_TASKS = 20` — task set kanonik tidak boleh dipangkas.
- `evaluateAcceptance(report)` mengubah `BenchmarkReport` menjadi satu `AcceptanceReport` dengan `schemaVersion "1.0"`, `scope: "acceptance"`, `status: "accepted" | "rejected"`, `minSucceeded`, `summary`, `phases`, `taskSetHash`, `reproducibilityHash`, dan `violations`.
- `main()` mencetak **tepat satu baris JSON** ke stdout — kontrak satu baris yang sama dengan `run.ts` — dan mengembalikan 0 saat `accepted`, 1 saat ada violation. **Tidak ada mode report-only**: penolakan selalu gagal dan tidak ada opsi yang mengubahnya jadi lulus.
- Violation adalah kode tetap (`harness-error`, `report-error`, `provider-not-mock`, `planned-not-canonical`, `attempt-mismatch`, `summary-mismatch`, `below-minimum-succeeded`, `success-without-work`), jadi baris report tidak membawa prompt, path, secret, atau output task.

`phases` adalah bukti per fase untuk diagnosa, bukan pengganti gate: `config` (provider/model plus `configHash` dari `reproducibility.config.hash`), `discovery` (tool yang termuat dan `tasksWithTools`), `loop` (`steps` dan `tasksWithSteps`), `tool` (`toolCalls` dan `tasksWithToolCalls`), dan `verifier` (`verified` dan `rejected`).

### Command

Script kanonik acceptance 2.6:

```bash
corepack pnpm bench:accept
```

Script di `package.json` melakukan build lalu menjalankan runner secara langsung:

```text
tsc -p tsconfig.build.json && node dist/benchmarks/accept.js
```

Tidak ada nested `pnpm` di dalam script. Setelah build berhasil, perintah yang sama dapat dipanggil langsung dengan `node dist/benchmarks/accept.js`. `bench:20` dan `bench:smoke` tetap punya command masing-masing dan tidak berubah.

Run terverifikasi pada 2026-09-26: `corepack pnpm bench:accept` exit 0 dengan `scope "acceptance"`, `status "accepted"`, `violations []`, `minSucceeded 5`, `summary { planned 20, attempted 20, succeeded 20, failed 0 }`, `phases { config { provider mock, model mock }, discovery { tasksWithTools 20 }, loop { tasksWithSteps 20, steps 40 }, tool { tasksWithToolCalls 20, toolCalls 20 }, verifier { verified 20, rejected 0 } }`, `taskSetHash 645a15f7…`, dan `reproducibilityHash 8135d0ff…`.

### Gate: kenapa status saja tidak pernah cukup

`evaluateAcceptance` menghitung `success`, dan `run.ts` hanya menyetel `success: true` bila runner `completed` **dan** artifact verifier cocok dengan peta `expected`. Akibatnya `status: "completed"` dengan file yang salah tidak pernah dihitung, sehingga gate 2.6 tidak bisa dipenuhi oleh status saja. Selain ambang, gate juga menolak: `harnessError` ada, `report.status` bukan `completed`, provider atau model bukan `mock`, `planned` bukan 20, `attempted`/`planned`/`results.length` tidak konsisten, `summary.succeeded` tidak sama dengan jumlah `success` nyata, dan setiap sukses harus punya `steps > 0` **dan** `toolCalls > 0` (violation `success-without-work`).

### Bukti falsifiable: 6 test di `benchmarks/acceptance.test.ts`

Command: `corepack pnpm vitest run benchmarks/acceptance.test.ts` — 6 test hijau pada 2026-09-26.

Describe "task 2.6 acceptance over the canonical mock tasks":

- "accepts the 20 canonical tasks through config, discovery, loop, tool, artifact, and verifier" — `MIN_SUCCEEDED` benar-benar 5, urutan `results.map(id)` sama dengan `benchmarkTasks.map(id)`, kelima fase terisi (`tasksWithTools 20`, `tasksWithSteps 20`, `tasksWithToolCalls 20`, `verified 20`, `rejected 0`), `violations` kosong, dan `taskSetHash`/`reproducibilityHash` diambil dari report yang sama.
- "emits one report line, exits 0, and touches no user config, key, or network" — stdout tepat satu baris JSON, exit 0, `status "accepted"`; direktori `user/` tidak pernah dibuat di parent root, file canary di parent root tetap utuh (`readdir` = `["secret.txt"]`); baris report tidak memuat secret, temp root, atau prompt task mana pun; dan spy pada `globalThis.fetch` dipalsukan dengan `expect(fetchSpy).not.toHaveBeenCalled()`.

Describe "task 2.6 acceptance gate":

- "rejects a wrong expected artifact even when the runner status is completed" — **test negatif utama**. Satu task dengan `expected` yang salah tetap menghasilkan `status: "completed"` dengan `steps > 0` dan `toolCalls > 0`, tetapi `success: false` dengan `error: "expected-files-mismatch"`, `phases.verifier { verified 0, rejected 1 }`, `status "rejected"`, dan violation `below-minimum-succeeded`.
- "passes at exactly five end-to-end successes and fails below the floor" — laporan kanonik dengan jumlah sukses dipalsukan: 5 → `accepted`, 4 → violation `below-minimum-succeeded`. Ini menguji ambang tepat di batasnya, bukan hanyafar di atasnya.
- "exits 1 and reports a rejection when the harness fails" — root yang tidak dapat dipakai menghasilkan exit 1 dengan `violations ["harness-error", "report-error", "below-minimum-succeeded"]`; root yang tidak valid menghasilkan report `schemaVersion "1.0"` penuh dengan `violations ["harness-error"]` dan `configHash ""`, bukan objek error ad-hoc.
- "rejects harness errors, non-mock providers, incomplete attempts, and work-free successes" — memalsukan `harnessError`, `status: "error"`, `provider: "openai"`, `planned: 19`, 19 hasil, ringkasan tidak konsisten, `steps: 0`, dan `toolCalls: 0`, lalu memalsukan masing-masing violation `harness-error`, `report-error`, `provider-not-mock`, `planned-not-canonical`, `attempt-mismatch`, `summary-mismatch`, dan `success-without-work`.

### Yang dibuktikan dan yang tidak

**Dibuktikan**: plumbing harness/tool/verifier — konfigurasi, discovery plugin official, loop agent, tool call file, artefak tertulis, verifikasi file yang terpisah dari status model, laporan acceptance satu baris, dan gate exit code. Gate juga terbukti tidak bisa dilewati: artefak salah, runner berhenti, harness error, provider non-mock, attempt tidak lengkap, dan sukses tanpa kerja semuanya ditolak.

**Tidak dibuktikan**: kemampuan coding model open-ended. Alasannya ada di source: `createMockModel()` di `plugins/model-mock/src/index.ts` tidak menyusun kode — `complete()` berjalan dengan satu regex `write|create … with content …` atas teks prompt user lalu mengeluarkan tool call `write_text` dengan path dan konten yang sudah tertulis di prompt, dan pola instruksi di `benchmarks/tasks.ts` (`Write <path> with content "<content>"`) cocok dengan grammar itu. Jadi 20 task adalah "tulis satu file dengan konten persis": yang diuji adalah apakah tool, permission, verifikasi, dan gate bekerja — bukan apakah model dapat menyelesaikan masalah, memilih pendekatan, atau memperbaiki kesalahan. Runner juga dibatasi `maxSteps: 4` dan `maxToolCalls: 2`, jadi tidak ada iterasi panjang, pemulihan error, maupun retry yang terukur. `elapsedMs` yang kecil adalah konsekuensi provider offline yang tidak memanggil jaringan, bukan kecepatan model.

**Ditunda, dan alasannya di source**: suite live 9Router dan akuntansi token/biaya nyata — bukan budget guard, yang sudah ditutup sebagai Task 3.3. `accept.ts` memanggil `runBenchmark({ provider: "mock" })`, `run.ts` menolak `provider` selain `mock` di `selectTasks`, dan config benchmark memaksa `network: deny` serta `shell: deny` — jadi tidak ada credential, API key, atau network. Untuk token dan biaya: `ModelResult` di `kernel/src/model.ts` punya `usage?` opsional, tetapi `createMockModel()` tidak pernah mengisinya, dan harga hanya datang dari config milik user — bukan dari kontrak provider — sehingga `usage.status` tetap `unavailable` dengan `method: "provider-does-not-report"` dan token `null`, dan `cost.amount` tetap `0` dengan `source: "mock-not-billed"` — keduanya literal di `run.ts`. Angka nol itu placeholder karena tidak ada yang bisa mengukur, bukan hasil pengukuran; mengarang angka akan lebih buruk daripada reporting `unavailable`.

**Budget guard (Task 3.3) dan batasnya terhadap benchmark.** Kotak 3.3 sudah `- [x]`: enforcement di `plugins/loop-react/src/index.ts` sudah hijau, dan full gate 2026-09-27 keluar bersih di 370 test di 30 file + 2 `node --test`. Untuk benchmark sendiri, 3.3 **tidak mengubah apa pun**: config benchmark yang ditulis `run.ts` tidak punya blok `budget` sama sekali, sehingga guard mati karena default dan `runBenchmark` tidak pernah mengaktifkannya. `timeoutMs: 5000` di config benchmark adalah batas waktu per task milik `loop-react` (alasan stop `agent timeout`), **bukan** budget guard, dan bukan `budget.maxElapsedMs`. `usage` dan `cost` di `run.ts` tetap **literal di source** — `usage.status "unavailable"` dengan `method "provider-does-not-report"` dan token `null`, `cost.amount 0` dengan `source "mock-not-billed"` — bukan turunan pengukuran apa pun. Karena `runBenchmark` memaksa provider `mock` dan `createMockModel()` tidak melaporkan usage, contract `ModelResult.usage?` **tidak mengubah satu pun nilai report**: `taskSetHash 645a15f7…` dan `reproducibilityHash 8135d0ff…` **tidak bergeser** karena 3.3 — keduanya identik dengan yang tercatat di Task 2.6 — dan angka nol itu tetap placeholder, bukan hasil pengukuran. Tidak ada suite live, tidak ada API key, tidak ada network, dan tidak ada tagihan. Yang masih ditunda adalah **akuntansi token/biaya nyata**, bukan enforcement-nya. Rinciannya di `docs/ARCHITECTURE.md` ("Status Task 3.3") dan `TASKS.md` (kotak 3.3).
**Trace log terstruktur (Task 3.4) dan batasnya terhadap benchmark.** Kotak 3.4 **sudah `- [x]`** — ditutup 2026-09-27 setelah full gate bagian 4 hijau pada working tree yang sama, dengan `config.trace.maxBytes` yang sudah sampai ke writer dan ke rotasinya. Untuk benchmark sendiri, 3.4 **tidak mengubah apa pun**: config benchmark yang ditulis `run.ts` **tidak punya blok `trace`**, sehingga blok yang hilang berarti trace mati dan tidak ada file yang ditulis di root workspace benchmark maupun di `${HOME}`. `benchmarks/` juga tidak mengimpor `src/trace.ts` dan tidak punya reader, jadi `taskSetHash 645a15f7…` dan `reproducibilityHash 8135d0ff…` **tidak boleh bergeser karena 3.4** — keduanya identik dengan yang tercatat di 2.6 dan 3.3, dan pada run gate 3.4 keduanya memang tidak bergeser. Perlu dibaca apa adanya: ketiadaan blok `trace` pada config benchmark menunjuk pada **default mati**, dan default mati itulah yang membuat jalur benchmark tidak menulis trace sama sekali — bukan bukti bahwa ada mekanisme yang menahannya. Trace juga **bukan** sumber akuntansi biaya: `usage.status "unavailable"`, token `null`, dan `cost.amount 0` dengan `source "mock-not-billed"` tetap **literal di `run.ts`**, dan `plugins/model-mock` tidak melaporkan usage, sehingga field usage di trace tidak akan muncul pada run mock. Yang ditunda tetap yang sama: suite live 9Router dan akuntansi token/biaya nyata, plus dashboard biaya/token **4.6** dan trace reader/retensi. Rinciannya di `docs/ARCHITECTURE.md` ("Status Task 3.4").
