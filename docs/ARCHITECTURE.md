# Arsitektur NexusMycelium

> Dokumen ini dibaca manusia dan agent. Task 2.6 sudah dicentang di `TASKS.md` pada 2026-09-26 setelah full gate hijau dengan acceptance harness khusus; bagian "Status Task 2.6" menyatakan apa yang ditunjukkan source, apa yang dibuktikan dan tidak dibuktikan acceptance run itu, dan batas yang tetap ditunda. Kontrak normative Plugin API v1 berada di `docs/PLUGIN_API.md`; Task 1.1 sudah closed final untuk v1 setelah acceptance run hijau, dan setiap perubahan kontrak berikutnya memerlukan task serta migration guide baru. Task 2.4 sudah dicentang di `TASKS.md` setelah full gate hijau; bagian "Status Task 2.4" menyatakan apa yang ditunjukkan source, termasuk perilaku yang terbukti di CLI dan batas yang sengaja dikosongkan. Task 1.2 dan 1.3 sudah closed pada 2026-09-26 setelah full gate hijau: bagian "Status Task 1.2" dan "Status Task 1.3" memisahkan perilaku yang sudah terverifikasi dari batas yang memang belum ada.

## Batas runtime

- Runtime adalah Node.js `^22.12.0 || ^24.0.0 || >=26.0.0` dengan pnpm `12.6.0`.
- Kernel kecil menangani manifest, config, event, registry, permission, dan lifecycle plugin.
- `plugins/` adalah source workspace berisi kode official yang dipercaya dan berjalan pada proses Node yang sama. `user/config.yaml` hanya data overlay dan tidak dapat memuat kode.
- Semua package root, kernel, dan plugin adalah `private: true`; source-workspace-only adalah batas v1. Tidak ada promise publish registry, dependency eksternal, atau hot swap berpipeline.
- Official plugin bukan sandbox. Plugin untrusted dan `agent-made/` tidak memiliki trust boundary, loader runtime, gate, canary, atau rollback yang boleh diasumsikan aman.

## Package dan manifest

Nama runtime dan nama package dipisahkan secara tegas:

| Manifest name | Package canonical | Peran |
|---|---|---|
| `model-mock` | `@nexusmycelium/plugin-model-mock` | provider offline |
| `model-openai` | `@nexusmycelium/plugin-model-openai` | provider HTTP opsional |
| `loop-react` | `@nexusmycelium/plugin-loop-react` | runner bounded |
| `tools-basic` | `@nexusmycelium/plugin-tools-basic` | provider tool canonical |
| `tools-core` | `@nexusmycelium/plugin-tools-core` | status legacy, bukan dependency baru |
| `example-hello` | `@nexusmycelium/plugin-example-hello` | sample official |

Root package `nexusmycelium`, kernel `@nexusmycelium/kernel`, dan seluruh plugin memakai versi workspace `0.1.0`. Manifest `version` adalah `x.y.z` plugin; `apiVersion` adalah number literal `1`, bukan `"1"`. Loader v1 menolak API version lain. Perubahan API di masa depan memerlukan migration guide, adapter/compatibility period, dan test migrasi; tidak ada coercion atau fallback diam-diam.

Manifest v1 normative adalah strict dan immutable: field unknown ditolak, default diterapkan sekali, dan manifest tidak dimutasi setelah validasi. Kernel menegakkannya lewat schema `strict()` plus `deepFreeze` rekursif setelah parse, dan keduanya punya test hijau.

## Discovery fail-closed

`discoverPlugins` hanya menerima canonical official `plugins/` root. Ia membandingkan real path, menolak URL non-`file:`, dan menolak path di luar root termasuk symlink escape. Package JSON, root export, default export, manifest, dan `setup` yang malformed menghentikan discovery; tidak ada fallback ke network, arbitrary module, `user/`, atau `agent-made/`.

Discovery boleh melewati directory yang tidak memiliki package/export, tetapi directory tersebut tidak pernah menjadi kandidat runtime. Kegagalan plugin official harus terlihat sebagai error; plugin tidak boleh diam-diam dinonaktifkan karena pathcheck.

## Runtime flow

1. Resolve `config/default.yaml`, lalu overlay tervalidasi dari `user/config.yaml` bila ada.
2. Pilih provider `model-mock` atau `model-openai` dari config.
3. Discover dan register plugin official dengan canonical names.
4. Load provider, lalu `loop-react` dengan `loadAll(required, { strict: true })`; dependency `tools-basic` dimuat lebih dahulu oleh registry, dan plugin optional dari config dimuat satu per satu dengan warn saat gagal.
5. Runtime mengambil model, canonical `tool:core`, dan agent runner factory dari service registry.
6. `close()` menutup plugin dalam reverse order dan membersihkan owner service.

`tools-core` tetap dipertahankan hanya untuk kompatibilitas legacy. Runtime canonical tidak memuatnya sebagai dependency dan `tools-basic` serta `tools-core` tidak boleh diaktifkan bersamaan karena keduanya memenuhi service `tool:core`.

## Manifest semantics

`requires` berisi canonical manifest names, bukan package names atau capability strings. Registry yang memiliki delegation memuat dependency rekursif sebelum setup, menolak missing/cycle, mencegah unload selama dependent aktif, dan memberi plugin access hanya ke service owner sendiri atau dependency transitif. Plugin tidak mengimpor atau me-load plugin lain secara langsung.

`provides` adalah capability contract yang harus ditegakkan registry: capability yang ditawarkan harus memiliki owner/service yang sesuai, dan service atau owner yang tidak dideklarasikan harus ditolak. `provides` bukan OS permission. Registry menegakkan `requires` delegation, owner-scoped service access, dan `provides` sekaligus: registration service ditolak jika service tidak ada di `provides` owner atau owner tidak cocok, dan service hanya terlihat oleh owner sendiri atau dependency transitif. Ketiganya punya test hijau.

## Lifecycle, event, dan service

`definePlugin` melakukan validasi manifest sebelum registration. `setup(context)` boleh async, dapat mengembalikan satu `Disposer`, dan menerima `events`, `log`, `config`, `services`, `capabilities`, serta scoped `permissions`.

- Load dependency selalu selesai sebelum setup plugin.
- Setup failure membersihkan service parsial, tidak menandai plugin loaded, dan meneruskan error.
- Unload menolak dependent, memanggil disposer, menghapus seluruh service owner, lalu mengirim event `plugin:unloaded`; disposer error tetap dikembalikan.
- Bulk load memakai `loadAll(names, { strict })`: urutan dependency-first, pre-check graph tanpa menjalankan setup, isolasi kegagalan per nama, dan `strict` untuk caller fail-closed.
- Reload memakai `reload(name, replacement)`: swap objek plugin official beserta dependent closure-nya, dengan rollback ke objek sebelumnya bila swap gagal.
- Close terminal dan idempotent: menunggu in-flight operation, memakai reverse load order, menggabungkan shutdown errors, lalu menolak `load`/`loadAll`/`reload` berikutnya.
- Event handler failure diisolasi dan dilaporkan tanpa membatalkan handler lain.

Public lifecycle event map v1 (`PluginEventMap`):

```ts
type PluginEventMap = {
  "plugin:loaded": { name: string };
  "plugin:unloaded": { name: string };
};
```

`on` harus typed dan dapat dik unsubscribe. Service selalu owner-aware; owner eksplisit harus sama dengan nama plugin. Registry tidak memberikan ambient access ke plugin yang tidak memiliki dependency atau service sendiri.

## Status Task 1.2 — Loader dan registry

Task 1.2 sudah dicentang di `TASKS.md` setelah full gate hijau. Bagian ini hanya menyatakan perilaku yang ditunjukkan `kernel/src/registry.ts`, `kernel/src/plugin.ts`, `kernel/src/registry.test.ts`, `kernel/src/plugin.reload.test.ts`, dan `src/plugin-lifecycle.contract.test.ts`, lalu batas yang memang belum ada.

Sudah ada dan terverifikasi:

- Urutan dependensi: seluruh `requires` dimuat rekursif sebelum `setup` plugin dijalankan. Dependency yang tidak terdaftar ditolak (`requires X, which is not registered`), cycle ditolak (`plugin dependency cycle: …`) baik untuk load berurutan maupun untuk dua `load` konkuren, dan `close()` menutup plugin dalam reverse load order.
- Konkurensi per plugin: satu entri `inFlight` per nama. `load`/`unload` konkuren untuk plugin yang sama berbagi satu promise dan memanggil `setup`/disposer tepat sekali; operasi berlawanan dirangkai pada state operasi sebelumnya sehingga tidak ada deadlock.
- Guard unload: unload ditolak bila plugin yang sudah loaded bergantung padanya, dan ditolak bila dependent-nya masih di tengah load. Error disposer tetap dikembalikan ke caller setelah status loaded dilepas dan seluruh service owner dihapus.
- Isolasi kegagalan per plugin: setup yang melempar error menghapus service parsial, tidak menandai plugin loaded, dan meneruskan error. Plugin lain yang sudah loaded tidak ikut terpengaruh.
- State lifecycle di-*settle* sebelum listener event dijalankan, sehingga listener boleh memuat atau membuang plugin yang sama tanpa deadlock.
- Bulk load dengan isolasi kegagalan: `loadAll(names, { strict })` menyusun urutan dependency-first lebih dulu lewat pre-check `planLoad` yang tidak menjalankan kode plugin apa pun, jadi nama dengan dependency hilang, nama unknown, atau cycle langsung dilaporkan bersama semua yang bergantung padanya dan tidak pernah mencapai fase load. Setelah itu setiap nama dimuat satu per satu; kegagalan setup memblokir hanya nama yang bergantung pada nama itu, sibling independen tetap dimuat, dan hasil dikembalikan per nama sebagai `loaded` + `failures` dengan pesan saja (tanpa stack atau objek). `strict: true` mengubah laporan itu menjadi satu `AggregateError` untuk caller fail-closed; `src/runtime.ts` memakainya untuk plugin required.
- Reload object-level plugin official: `reload(name, replacement)` adalah swap objek, bukan file watcher dan bukan reload `agent-made/`. Registry menunggu operasi in-flight milik closure, unload closure dalam reverse load order, memasang objek baru hanya saat plugin target tidak loaded dan tidak in-flight, lalu memuat ulang closure dalam urutan dependensi sehingga dependent juga melihat generasi baru. Swap yang ditolak (setup versi baru gagal) mengembalikan objek sebelumnya, unload lalu load ulang target, dan service hidup kembali ke nilai sebelum swap sebelum error `AggregateError` dilempar, jadi swap gagal tidak meninggalkan service yatim atau ganda. Replacement dengan nama manifest berbeda ditolak, dan facade `services` yang disimpan sejak sebelum reload tidak boleh mendaftarkan service lagi karena epoch-nya sudah mati.
- Cache-bust sisi loader: `loadPlugin(specifier, { cacheKey })` dan `discoverPlugins(dir, { cacheKey })` menempelkan query `nexusCache` tervalidasi ke import sehingga satu key memakai ulang modul yang sama dan key berikutnya mengevaluasi ulang entry yang sama. Tanpa `cacheKey` perilaku tetap cache ESM biasa, dan token query yang tidak aman ditolak sebelum ada import. Ini pasangan dari `reload()`: caller memperoleh objek baru lewat key yang berputar, lalu menyerahkan objek itu ke `reload()`.
- `close()` terminal dan idempotent: `close()` menandai registry closed secara permanen, sehingga `load`, `loadAll`, dan `reload` setelahnya menolak dengan `plugin registry is closed`, sementara `unload` setelah close adalah no-op. Drain menunggu seluruh operasi in-flight, menutup plugin dalam reverse load order, menggabungkan error shutdown (satu error dilempar apa adanya, lebih dari satu jadi `AggregateError`), dan `close()` konkuren berbagi satu promise yang sama. `runtime.close()` di `src/runtime.ts` tetap idempotent lewat flag `closed` miliknya sendiri.

Batas yang tetap tidak ada, dan tidak boleh diasumsikan plugin maupun integrator:

- Tidak ada file watcher untuk `plugins/`. Perubahan di disk tidak memicu load/unload; pemuatan ulang selalu berupa operasi in-process pada objek plugin yang sudah diimpor, dan satu-satunya watcher di repo adalah `src/dashboard.ts` yang memonitor file tasks dashboard.
- Tidak ada loader `agent-made/`. `agent-made/staging/` dan `agent-made/active/` bukan runtime boundary dan tidak pernah menjadi kandidat discovery.
- Tidak ada canary dan tidak ada gate sebelum swap. `reload()` menukar objek plugin official atas nama caller; tidak ada worktree, lint/type/unit/eval, smoke sandbox, canary, atau monitor yang memutuskan swap, dan tidak ada rollback keputusan sebelum swap terjadi. Seluruh pipeline itu adalah ruang lingkup Task 7.1 dan 7.4, bukan 1.2.
- Tidak ada bulk load lintas trust boundary. `loadAll` hanya untuk plugin yang sudah teregister di registry, yaitu plugin official yang lolos discovery fail-closed.
- Tidak ada sandbox **OS**. Object-level reload bukan isolation: plugin official tetap berjalan di proses Node yang sama. Yang ada sejak 3.1 adalah process/workspace sandbox runner — akar sementara, tools root terkurung, deny network/shell, dan hardening child proses — dan itu hygiene, bukan boundary terhadap plugin in-process; lihat "Status Task 3.1".

## Status Task 1.3 — Event bus

Task 1.3 sudah dicentang di `TASKS.md` setelah full gate hijau. Implementasi ada di `kernel/src/events.ts` dan ditunjukkan `kernel/src/events.test.ts` plus `src/plugin-lifecycle.contract.test.ts`:

- Catalog nama event: `PLUGIN_EVENT_NAMES` berisi tepat `plugin:loaded` dan `plugin:unloaded`, dan `PLUGIN_EVENT_SCHEMAS` `satisfies` `EventCatalog<PluginEventMap>`. Katalog runtime ada, bukan hanya key tipe: nama di luar katalog gagal closed di `on` maupun di `emit` — `on` tidak mendaftarkan handler dan mengembalikan unsubscribe no-op, `emit` melaporkan `unknown event: <name>` dan tidak dispatch apa pun. Test membandingkan isi `PLUGIN_EVENT_NAMES`, key `PLUGIN_EVENT_SCHEMAS`, dan `PluginEventMap` agar ketiganya tidak bisa melenceng. `EventBus<PluginEventMap>` memakai katalog plugin sebagai default; bus untuk map lain wajib mengoper catalog-nya sendiri, jika tidak semua nama-nya unknown dan gagal closed.
- Validasi payload ketat: setiap event punya satu schema, dan `emit` menjalankan `safeParse` sebelum dispatch. Payload `{ name: 1 }`, `{ name: "" }`, `{ name: "x", extra: true }`, dan `undefined` semuanya ditolak karena schema `z.strictObject({ name: z.string().min(1) })`: key unknown dan string kosong tidak lolos. Payload yang gagal validasi hanya dilaporkan lewat `onError`; handler tidak pernah dipanggil.
- Isolasi `onError`: setiap handler dibungkus try/catch di dalam `emit`, sehingga handler yang melempar dilaporkan tanpa membatalkan handler lain, dan `emit` tetap menunggu seluruh handler. `onError` yang sendiri melempar ditelan, jadi `emit` tidak pernah reject karena reporting. Registry mengaitkan `onError` ke `log.error("event handler failed: <event>", error)`, dan jalur yang sama menerima error validasi, `unknown event`, serta depth overflow.
- Ceiling reentrancy: `MAX_EMIT_DEPTH = 16`. Emit di dalam handler menaikkan kedalaman; saat batas terlampaui emit gagal closed dengan `emit depth limit 16 exceeded` dan tidak dispatch. Penghitung diturunkan di `finally`, jadi emit berikutnya tetap dispatch. Handler yang memancarkan event-nya sendiri sampai batas berhenti pada dispatch ke-16 dengan tepat satu error. Ini ceiling kedalaman tetap, bukan detektor cycle per event.
- Urutan dan snapshot dispatch: `emit` menyalin set handler sebelum memanggilnya, jadi handler yang di-unsubscribe atau ditambahkan di tengah dispatch hanya memengaruhi emit berikutnya. `load()`/`unload()` baru resolve setelah seluruh handler selesai.
- Urutan lifecycle: `plugin:loaded` dikirim setelah setup, registrasi service, dan penandaan loaded; `plugin:unloaded` dikirim setelah disposer dan penghapusan seluruh service owner. Untuk rantai `a → b → c` urutan emit load adalah `a`, `b`, `c` dan urutan unload adalah `c`, `b`, `a`. Error disposer tidak diubah menjadi sukses oleh event. State sudah settle sebelum listener jalan, jadi listener boleh memuat atau membuang plugin yang sama tanpa deadlock.

Yang tetap tidak ada:

- Tidak ada wildcard. Tidak ada `on("*")`, tidak ada pola listener, dan tidak ada listener global; setiap `on` spesifik pada satu nama event dari katalog.
- Tidak ada timeout. `emit` tidak memasang timeout per handler maupun per event; handler yang tidak pernah resolve membuat `emit` menggantung, dan karena `emit` ikut ditunggu, `load`/`unload`/`close` juga menggantung. Batas yang ada hanya kedalaman emit, bukan durasi.

## Status Task 2.4 — Sesi, resume, dan fork

Task 2.4 sudah dicentang di `TASKS.md` setelah full gate hijau. Implementasi ada di `src/session.ts` dengan `src/runtime.ts` dan `src/cli.ts` sebagai pemanggilnya, plus test di `src/session.test.ts`, `src/session-security.contract.test.ts`, `src/session.fixtures.ts`, `src/runtime.test.ts`, dan `src/cli.test.ts`. Bagian ini mem-separasikan apa yang ditunjukkan source dari apa yang belum ada; kalau ada butir di bawah yang berbeda dari source, source yang menang dan dokumen ini yang salah.

### Bentuk store

- **Lokasi**: default store root adalah `join(homedir(), ".config", "nexus", "user", "sessions")`, yaitu `${HOME}/.config/nexus/user/sessions/`. Root diturunkan dari home direktori proses. `createSessionStore({ root })` hanya mengoverride root untuk test dan caller embed; tidak ada config key atau env var produksi yang memilih path.
- **Bukan `data/`**: `data/` di root runtime berada di volume fuseblk yang sama dengan repo, di-gitignore sebagai scratch, dan bukan state milik user. Alasan yang sama tertulis di source: secure home scope by default, karena repo `data/` mount adalah shared fuseblk volume, bukan user state.
- **Format**: JSONL — satu objek JSON per baris. Baris pertama `run-start`, lalu satu `run-step` per langkah, lalu `run-end` terminal. Record adalah discriminated union pada `type` (`run-start` | `run-step` | `run-end`), semuanya `.strict()`, dan semuanya membawa `schemaVersion: 1` (`SESSION_SCHEMA_VERSION`) serta `sessionId`.
- **Append-only**: file dibuka dengan `O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW` mode `0600`, dan store tidak pernah menulis ulang atau menghapus file sesi yang sudah ada. Root directory dibuat `0700` dan di-`chmod` ulang pada setiap write, karena `mkdir` tidak mengubah mode directory yang sudah ada.

Bentuk record menurut `src/session.ts`:

```jsonl
{"type":"run-start","schemaVersion":1,"sessionId":"…","provider":"mock","model":"mock","task":"…"}
{"type":"run-step","schemaVersion":1,"sessionId":"…","step":1,"messages":[…]}
{"type":"run-end","schemaVersion":1,"sessionId":"…","status":"completed","text":"…","limits":{…}}
```

`run-start` adalah header: `provider`, `model`, `task`, dan `parent` opsional yang menandai fork (`{ sessionId, step }`). `run-end` membawa `status`, `text`, `error`, dan `limits` opsional. Tidak ada field waktu di dalam record; `list()` mengambil `updatedAt` dari mtime file dan `bytes` dari ukuran file.

### Redaction, ukuran, dan path

- **Kenapa config dan secret tidak bisa bocor**: bentuk record-nya strict. `config`, `apiKeyFile`, `headers`, `path`, dan `HOME` bukan field yang dikenal, jadi `safeParse` menolaknya lebih dulu. Test yang memalsukannya: "never persists provider config, secret paths, or headers" (`src/session.test.ts`), "never persists provider config, secret paths, or headers in the record envelope" dan "keeps secret paths and absolute locations out of stored tool-call arguments" (`src/session-security.contract.test.ts`).
- **Redaction pada tool-call arguments: nilai, nama key, dan lokasi.** `redactText` mengganti pola `sk-…` dan `Bearer …` dengan `[redacted]`, dan dipasang sebagai Zod `.transform` pada setiap field teks, sehingga scrubbing terjadi saat validasi. `redactValue` berjalan rekursif pada `tool_calls[].arguments`: ia membuang key `__proto__`, `prototype`, dan `constructor`; membuang key yang namanya cocok `sensitiveKey` (`apikey`, `secret`, `token`, `password`, `passwd`, `passphrase`, `credential`, `authorization`, `privatekey`, `accesskey`, `cookie`) atau `locationKey` (`home`, `root`, `cwd`, `env`, `dir`, `path`, `pwd`, `userprofile`, `homedir`, `tmpdir`); mengganti nilai string yang diawali `/`, `~/`, `../`, atau drive letter dengan `[redacted]`; memotong array dan object di 64 entry; dan berhenti di kedalaman 6 dengan nilai `[redacted]`. Test yang memalsukannya: "redacts obvious secrets from the task, transcript, tool arguments, and result" (`src/session.test.ts`) dan "caps tool calls, argument entries, and redaction depth in stored tool calls" (`src/session-security.contract.test.ts`).
- **Batasnya harus dibaca apa adanya**: pencocoran nama key dan lokasi absolut hanya berlaku di tool-call arguments. Teks bebas milik user — `task`, `content`, `text`, `error` — hanya disaring `redactText`, jadi transcript tetap bisa memuat path absolut. Itu konsekuensi yang disepakati, bukan bug: test "never persists provider config, secret paths, or headers in the record envelope" justru memalsukkannya dengan menyimpan `keyFile` apa adanya di `task`.
- **Batas ukuran**: 64 KiB per field teks, 200 message per step, 32 tool call, 64 argument entry, kedalaman redaction 6, 4 MiB per record, dan 64 MiB per file. Record atau file yang melewati batas ditolak dengan error, tidak dipotong diam-diam. Test: "caps field and record sizes" dan "accepts a record just under the byte cap and refuses one past it".
- **Path**: `sessionId` harus cocok `[A-Za-z0-9_-]{1,64}`, sehingga `..`, `/`, dan `\` mustahil. Session root di-`realpath` lalu dibandingkan dengan `inside()`; kandidat file juga di-`realpath` dan diperiksa lagi, sehingga symlink yang keluar root ditolak; `O_NOFOLLOW` menutup jalur symlink saat append; `lstat` menolak target yang bukan regular file. Directory `0700`, file `0600`. Test: "rejects traversal, absolute, and control-character session ids", "refuses a session path that leaves the root through a symlink", "confines a symlinked sessions root to its own real target", "refuses a directory and a dangling symlink where a session file belongs".
- **Id baru** adalah 16 hex char dari `randomBytes(8)`; id fork adalah `<source[0:40]>-fork-<12 hex>`. Keduanya cocok pola di atas, jadi keduanya aman dipakai sebagai nama file.

### Resume

- **Sumber kebenaran adalah record.** `runSession` di `src/runtime.ts` memanggil `resumeSession`, yang `load()` file, mewajibkan record `run-start`, lalu mengembalikan `sessionMessages(records)` sebagai `history` untuk `runner.run`: seluruh message dari setiap `run-step`, digabung berurutan. Task asli tidak dikirim ulang sebagai turn baru; transcript lama diputar ulang apa adanya.
- **Mismatch provider/model gagal closed**, di dua tempat yang independen. `resumeSession` di `src/runtime.ts` menolak dengan `cannot resume session <id>: stored <provider>:<model> differs from current <provider>:<model>`, dan `startSession` di `src/cli.ts` menolak dengan `session <id> used <provider>/<model>, runtime is <provider>/<model>`. Store sendiri tidak melakukan cek ini; store hanya menyimpan dan memvalidasi bentuk record. `Runtime` kini mengekspos `modelIdentity: ModelIdentity`, diambil setelah plugin config override diterapkan, sehingga identity yang dibandingkan adalah model yang benar-benar dipakai.
- **Limit saat resume**: limit dari caller menang; kalau caller tidak menyebut `limits`, run dilanjutkan dengan limit dari `run-end` terakhir. Sesi panjang jadi tidak diam-diam melompat ke default yang lebih longgar.
- **`onStep` di-await inline** oleh runner, sehingga append urut sesuai urutan step dan append yang gagal menghentikan run, bukan meninggalkan record setengah jadi. Hook caller dipanggil setelah append store, jadi observer tidak pernah melihat langkah yang belum tersimpan.
- **Torn tail diperbaiki, bukan dianggap error.** Baris terakhir yang tidak terminated adalah marker crash: `appendStep` memangkas file kembali ke newline terakhir sebelum append, dan `load` membuang line malformed terakhir sambil mengembalikan seluruh record utuh yang sudah terkumpul. Line malformed di tengah file tetap error, karena itu berarti file bukan hasil crash. Test: "recovers from a torn tail but rejects corruption in the middle" dan "repairs a torn tail on appendStep and keeps the session listed".

### Fork

- **Fork = prefix dari record, bukan copy file.** `store.fork(source, atStep, newId)` me-load source, mewajibkan `run-start` dan step `atStep` benar-benar ada, lalu menulis ke file baru: `run-start` dengan `sessionId` baru plus `parent: { sessionId: source, step: atStep }`, diikuti setiap `run-step` dengan `step <= atStep` yang ditulis ulang dengan `sessionId` baru. `run-end` tidak ikut disalin, jadi fork selalu dimulai dari transcript yang belum selesai.
- **Source immutable.** Fork hanya membaca source, dan file source tidak pernah dibuka untuk menulis. Test: "forks at a step, leaves the source byte-immutable, and keeps appends independent", "forks only the steps up to atStep and never rewrites the source file", "keeps two forks of one source independent".
- **Provider/model terbawa** oleh `run-start` hasil fork, sehingga mismatch check tetap berlaku saat fork itu di-resume.

### Permission dan batas kernel

- Store adalah modul runtime host di `src/`, bukan plugin dan bukan capability baru. Tidak ada service `session:*`, tidak ada event baru, dan `CoreServiceMap` tidak berubah. Plugin tidak membaca atau menulis file sesi, dan tidak ada yang mengekspos bentuk file JSONL ke plugin.
- **Store tidak lewat `PermissionGate`.** Ia punya konfinement sendiri — root `0700`, file `0600`, `O_NOFOLLOW`, serta `realpath` + `inside()` — persis seperti aturan yang dipakai `apiKeyFile`, sehingga `fs.write: deny` yang default tidak memblokirnya. Konsekuensinya harus dibaca apa adanya: session store punya jalur sendiri di luar permission gate, dan jalur itu hanya bisa aktif kalau caller memintanya secara eksplisit lewat `--session` atau `session resume`.
- **Kernel berubah, dan itu disengaja untuk task ini.** `kernel/src/agent.ts` menambah tipe `AgentStepRecord` (`{ step, messages }`) dan dua field optional pada `AgentRunOptions`: `history` (transcript run sebelumnya, diputar verbatim sebelum task baru) dan `onStep` (dipanggil setelah setiap step selesai, dengan snapshot transcript sejauh ini). Keduanya additive dan optional, jadi runner yang tidak memakainya tetap valid. `apiVersion` tetap `1`; tidak ada migration guide karena tidak ada field yang dihapus atau berubah tipe.
- **Nol dependency baru.** Store memakai `node:crypto`, `node:fs`, `node:os`, `node:path`, dan Zod yang sudah ada. Tidak ada SQLite dan tidak ada package baru: `dependencies` root tetap `yaml` dan `zod`, dan tidak ada baris session- atau sqlite-related di diff `package.json` maupun `pnpm-lock.yaml`.

### CLI

Help text yang sebenarnya ada di `src/cli.ts`:

```text
NexusMycelium CLI (command: nexus)

Usage:
  node dist/src/cli.js run [task] [--root PATH] [--model mock|openai] [--session ID]
  node dist/src/cli.js session list
  node dist/src/cli.js session resume <id> <task> [--root PATH] [--model mock|openai]
  node dist/src/cli.js session fork <id> <newId> [atStep]
  node dist/src/cli.js serve [--root PATH]
  node dist/src/cli.js --help

Commands:
  run      Run one bounded agent task and print a JSON result.
  session  list, resume, or fork the stored sessions. Omitting atStep forks the whole session.
  serve    Serve the realtime task dashboard on 127.0.0.1:18765.
```

`run --session <id>` membuat sesi dengan id itu dan merekam setiap step; tanpa `--session`, `run` tidak menyentuh store sama sekali. `session list` mencetak `{ sessions }` dari `readdir` tanpa index file, dengan tiap entri `{ id, bytes, updatedAt }`. `session resume <id> <task>` memuat transcript, menolak mismatch provider/model, lalu melanjutkan. `session fork <id> <newId> [atStep]` menyalin prefix dan mencetak `{ session: { id, atStep } }`; tanpa `atStep`, fork memakai step terakhir.

Perilaku yang terverifikasi lewat CLI nyata pada 2026-09-26, dijalankan dengan `HOME` dan `--root` temporer supaya store user asli tidak tersentuh:

- `run --session <id>` lalu `run --session <id>` lagi pada id yang sama **menambah** record, bukan menimpa: file yang sama berisi dua tripel `run-start` / `run-step` / `run-end`. Tidak ada dedup dan tidak ada error; inilah konsekuensi append-only, dan `run-start` yang kedua tidak membuat sesi baru.
- Pada `run --session` pertama, `run-end` yang tercatat **tidak punya key `limits`**, karena `src/cli.ts` hanya menulis `limits` saat `session.limits` terisi — dan itu hanya terjadi pada jalur `session resume` yang membaca `run-end` terakhir. Jadi kontinuitas limit saat resume baru berlaku setelah sekurang-kurangnya satu `session resume`; sebelum itu resume berikutnya jatuh ke default config plugin.
- `session fork` menyalin record berdasarkan `step <= atStep` **tanpa men-dedup nomor step**. Sumber dengan dua run yang sama-sama punya `step: 1` menghasilkan fork dengan dua record `run-step` `step: 1`. Nomor step-unique per file, bukan per run.
- `session list` pada store kosong mencetak `{"sessions":[]}` dan exit 0; `session resume <id>` untuk id yang tidak ada, `session fork` dengan id target invalid, dan subcommand yang tidak dikenal semuanya menolak dengan pesan dan exit 1.
- Directory store `0700`, file `0600`, dan setiap file berakhir dengan newline.
- `run` tanpa `--session` terbukti tidak menyentuh store: jumlah file dan total byte store identik sebelum dan sesudah.

Isolasi percobaan itu demanding dan perlu dicatat: **`HOME` saja tidak cukup.** `user/config.yaml` lokal mesin ini menunjuk `apiKeyFile` di bawah `${HOME}/.config/nexus/user/secrets/`, jadi begitu `HOME` di-override ke direktori sementara, `resolveConfig` gagal dengan `model.apiKeyFile must be under the approved user scope`. CLI juga butuh `--root` ke runtime root sementara yang hanya berisi `config/default.yaml` tanpa `user/`. Ini bukan bug store: store memang mengikuti `homedir()` seperti yang ada di `src/session.ts`, dan exception `apiKeyFile` punya aturan scope sendiri yang tidak saling memengaruhi.

### Yang belum ada

Semua ini di luar 2.4 dan tidak boleh diklaim sebagai kemampuan store:

- Tidak ada compaction, summary, atau pruning history. Transcript dibaca dan diputar apa adanya; pengurangan context adalah milik Task 4.2.
- Tidak ada TTL, expiry, garbage collection, atau perintah hapus sesi. `O_APPEND` memberi atomicity antar-proses untuk append, dan test "neither interleaves nor loses records under concurrent appends" menutupnya, tapi tidak ada lock di level aplikasi dan tidak ada koordinasi antar-proses di luar append itu.
- Tidak ada index atau catalog file. `list()` adalah `readdir` plus `lstat`, diurutkan `updatedAt` lalu `id`; tidak ada file katalog yang dipersistensi.
- Tidak ada integrasi dashboard. `task-dashboard.html` dan `scripts/dashboard-server.mjs` tidak disentuh 2.4: tidak ada panel sesi, tidak ada endpoint sesi, tidak ada SSE event sesi. Bukti yang bisa dijalankan ulang: `grep -rin session task-dashboard.html scripts/` tidak menghasilkan apa pun.
- Tidak ada persistence config atau secret, dan tidak ada session store untuk `agent-made/` atau plugin untrusted.
- Tidak ada `session show`, tidak ada handoff antar provider, dan tidak ada resume lintas model. Mismatch ditolak, bukan dinegosiasi.
- Tidak ada `session delete`, `session rename`, atau `session prune`.

## Status Task 2.6 — Benchmark yang dijalankan dan apa batasnya

Task 2.6 adalah "jalankan benchmark" dengan ambang **≥ 5 dari 20 tugas selesai end-to-end**. Statusnya per 2026-09-26: **ditutup** setelah full gate hijau, dengan acceptance harness khusus — bukan dengan 20/20 milik 0.4. Bagian ini hanya menyatakan apa yang ditunjukkan source dan apa batasnya; kalau ada butir di bawah yang berbeda dari source, source yang menang dan dokumen ini yang salah.

### Apa yang ditambahkan, dan apa yang tidak

Harness acceptance 2.6 ada di `benchmarks/accept.ts`, dengan test di `benchmarks/acceptance.test.ts` dan script `bench:accept` di `package.json`. Yang ditambahkan hanya **lapisan penilaian di atas report yang sudah ada**:

- **Tidak ada perubahan pada `run.ts`.** `runBenchmark`, `BenchmarkReport`, `taskSetHash`, dan `reproducibilityHash` tetap milik `benchmarks/run.ts` sebagai satu-satunya sumber kebenaran. `accept.ts` tidak punya task sendiri, tidak punya provider sendiri, dan tidak mengubah gate 0.4; ia memanggil `runBenchmark({ provider: "mock" })` lalu menilai report yang dikembalikan.
- **Konstanta ambang.** `MIN_SUCCEEDED = 5` — ambang 2.6. `CANONICAL_TASKS = 20` — task set kanonik tidak boleh dipangkas, jadi run yang lebih pendek bukan acceptance run.
- **`evaluateAcceptance(report)`** mengubah `BenchmarkReport` menjadi satu `AcceptanceReport` dengan `schemaVersion "1.0"`, `scope: "acceptance"`, `status: "accepted" | "rejected"`, `minSucceeded`, `summary`, `phases`, `taskSetHash`, `reproducibilityHash`, dan `violations`. Fungsinya murni: report masuk, report keluar, tanpa I/O.
- **`main()`** mencetak **tepat satu baris JSON** ke stdout — kontrak satu baris yang sama dengan `run.ts` — dan mengembalikan 0 saat `accepted`, 1 saat ada violation. **Tidak ada mode report-only**: penolakan selalu gagal dan tidak ada opsi yang mengubahnya menjadi lulus. Kegagalan harness juga dilaporkan sebagai report `rejected` dengan `harness-error`, tidak pernah sebagai lulus.
- **Violation adalah kode tetap**: `harness-error`, `report-error`, `provider-not-mock`, `planned-not-canonical`, `attempt-mismatch`, `summary-mismatch`, `below-minimum-succeeded`, `success-without-work`. Karena isinya kode, baris report tidak membawa prompt, path, secret, atau output task.
- **`phases` adalah bukti per fase untuk diagnosa, bukan pengganti gate**: `config` (provider, model, dan `configHash` dari `reproducibility.config.hash`), `discovery` (tool yang termuat plus `tasksWithTools`), `loop` (`steps` plus `tasksWithSteps`), `tool` (`toolCalls` plus `tasksWithToolCalls`), dan `verifier` (`verified` plus `rejected`).

### Gate: kenapa status saja tidak pernah cukup

`evaluateAcceptance` menghitung `success`, bukan `status`. `run.ts` hanya menyetel `success: true` bila runner `completed` **dan** artifact verifier cocok dengan peta `expected`, jadi `status: "completed"` dengan file yang salah tidak pernah terhitung. Selain ambang, gate juga menolak: `harnessError` ada, `report.status` bukan `completed`, provider atau model bukan `mock`, `planned` bukan 20, `attempted`/`planned`/`results.length` tidak konsisten, `summary.succeeded` tidak sama dengan jumlah `success` nyata, dan setiap sukses harus punya `steps > 0` **dan** `toolCalls > 0` (violation `success-without-work`).

### Command dan hasil run

Script kanonik acceptance 2.6:

```bash
corepack pnpm bench:accept
```

Script di `package.json` melakukan build lalu menjalankan runner secara langsung, tanpa nested `pnpm`:

```text
tsc -p tsconfig.build.json && node dist/benchmarks/accept.js
```

Run terverifikasi pada 2026-09-26: exit 0, `scope "acceptance"`, `status "accepted"`, `violations []`, `minSucceeded 5`, `summary { planned 20, attempted 20, succeeded 20, failed 0 }`, `phases { config { provider mock, model mock }, discovery { tasksWithTools 20, tools read_text/shell/write_text }, loop { tasksWithSteps 20, steps 40 }, tool { tasksWithToolCalls 20, toolCalls 20 }, verifier { verified 20, rejected 0 } }`, `taskSetHash 645a15f7…`, dan `reproducibilityHash 8135d0ff…`. `bench:20` pada run yang sama tetap 20/20 dengan `successRate 1`, dan `bench:smoke` menghasilkan `"ok": true`.

CI menjalankan `pnpm bench:smoke`, lalu `pnpm bench:20`, lalu `pnpm bench:accept` sebagai acceptance gate 2.6.

### Bukti falsifiable: 6 test di `benchmarks/acceptance.test.ts`

Command: `corepack pnpm vitest run benchmarks/acceptance.test.ts` — 6 test hijau pada 2026-09-26.

Describe "task 2.6 acceptance over the canonical mock tasks":

- "accepts the 20 canonical tasks through config, discovery, loop, tool, artifact, and verifier" — `MIN_SUCCEEDED` benar-benar 5, urutan `results.map(id)` sama dengan `benchmarkTasks.map(id)`, kelima fase terisi (`tasksWithTools 20`, `tasksWithSteps 20`, `tasksWithToolCalls 20`, `verified 20`, `rejected 0`), `violations` kosong, dan `taskSetHash`/`reproducibilityHash` diambil dari report yang sama.
- "emits one report line, exits 0, and touches no user config, key, or network" — stdout tepat satu baris JSON, exit 0, `status "accepted"`; direktori `user/` tidak pernah dibuat di parent root; file canary di parent root tetap utuh (`readdir` = satu file); baris report tidak memuat secret, temp root, atau prompt task mana pun; dan spy pada `globalThis.fetch` dipalsukan dengan `expect(fetchSpy).not.toHaveBeenCalled()`.

Describe "task 2.6 acceptance gate":

- "rejects a wrong expected artifact even when the runner status is completed" — **test negatif utama**. Satu task dengan `expected` yang salah tetap menghasilkan `status: "completed"` dengan `steps > 0` dan `toolCalls > 0`, tetapi `success: false` dengan `error: "expected-files-mismatch"`, `phases.verifier { verified 0, rejected 1 }`, `status "rejected"`, dan violation `below-minimum-succeeded`.
- "passes at exactly five end-to-end successes and fails below the floor" — laporan kanonik dengan jumlah sukses dipalsukan: 5 → `accepted`, 4 → violation `below-minimum-succeeded`. Ambang diuji tepat di batasnya, bukan hanyafar di atasnya.
- "exits 1 and reports a rejection when the harness fails" — root yang tidak dapat dipakai menghasilkan exit 1 dengan `violations ["harness-error", "report-error", "below-minimum-succeeded"]`; root yang tidak valid menghasilkan report `schemaVersion "1.0"` penuh dengan `violations ["harness-error"]` dan `configHash ""`, bukan objek error ad-hoc.
- "rejects harness errors, non-mock providers, incomplete attempts, and work-free successes" — memalsukan `harnessError`, `status: "error"`, `provider: "openai"`, `planned: 19`, 19 hasil, ringkasan tidak konsisten, `steps: 0`, dan `toolCalls: 0`, lalu memalsukan masing-masing violation `harness-error`, `report-error`, `provider-not-mock`, `planned-not-canonical`, `attempt-mismatch`, `summary-mismatch`, dan `success-without-work`.

### Yang dibuktikan: plumbing, bukan kemampuan model

Yang terukur adalah **plumbing harness/tool/verifier** — konfigurasi, discovery plugin official (`model-mock`, `loop-react`, `tools-basic`), loop agent bounded, tool call file, artefak tertulis, verifikasi file yang terpisah dari status model, laporan acceptance satu baris, dan gate exit code. Gate juga terbukti tidak bisa dilewati: artefak salah, runner berhenti, harness error, provider non-mock, attempt tidak lengkap, dan sukses tanpa kerja semuanya ditolak.

Yang **tidak** terukur adalah kemampuan coding model open-ended, dan alasannya ada di source, bukan di interpretasi dokumen:

- `createMockModel()` di `plugins/model-mock/src/index.ts` tidak menyusun kode. `complete()` berjalan dengan satu regex `write|create … with content …` atas teks prompt user, lalu mengeluarkan tool call `write_text` dengan path dan konten yang sudah tertulis di prompt. Pola instruksi di `benchmarks/tasks.ts` (`Write <path> with content "<content>"`) cocok dengan grammar regex itu.
- Konsekuensinya: 20 task adalah "tulis satu file dengan konten persis". Verifier membandingkan konten yang sudah diberikan ke prompt, sehingga yang diuji adalah apakah tool, permission, verifikasi, dan gate bekerja — bukan apakah model dapat menyelesaikan masalah, memilih pendekatan, atau memperbaiki kesalahan.
- Runner dibatasi `maxSteps: 4` dan `maxToolCalls: 2` oleh config benchmark. Tidak ada iterasi panjang, tanpa recovery, dan tanpa retry yang terukur.
- Konsekuensi lain yang harus dibaca apa adanya: `elapsedMs` yang kecil adalah konsekuensi provider mock yang tidak memanggil jaringan, bukan kecepatan model.

### Yang ditunda, dan alasan penundaan

Suite live 9Router dan akuntansi token/biaya nyata tetap ditunda, dan keduanya punya sebab yang bisa diperiksa di source. **Budget guard 3.3 sudah ditutup** dan tidak lagi masuk daftar ini — yang ditunda sekarang adalah akuntansi nyatanya, bukan enforcement-nya:

- **Live 9Router**: butuh credential dan permission `network`. Acceptance v1 secara eksplisit secret-free dan offline. `run.ts` menolak `provider` selain `mock` di `selectTasks`, `accept.ts` selalu memanggil `runBenchmark({ provider: "mock" })`, dan config benchmark memaksa `network: deny` serta `shell: deny`. `model-openai` ada sebagai provider HTTP opsional, tetapi tidak pernah dipakai benchmark, dan violation `provider-not-mock` menutup jalan itu secara eksplisit.
- **Token dan biaya nyata**: di working tree ini `ModelResult` di `kernel/src/model.ts` sudah punya `usage?: ModelUsage` opsional pada kedua variannya, jadi "tidak ada tempat di tipe hasil" sudah **tidak benar lagi** dan harus dibaca ulang. Yang tetap benar: tidak ada pricing di kontrak provider, tidak ada akuntansi yang berjalan sampai level run, dan tidak ada yang memakai usage itu. `plugins/model-mock` tidak melaporkan usage, sehingga `usage.status` tetap `unavailable` dengan `method: "provider-does-not-report"` dan token `null`, dan `cost.amount` tetap `0` dengan `source: "mock-not-billed"`. Angka nol itu bukan hasil pengukuran; itu placeholder, dan mengarang angka akan lebih buruk daripada reporting `unavailable`. Lihat "Status Task 3.3" di bawah.
- **Budget guard**: **sudah ada dan sudah ditutup sebagai Task 3.3** — `plugins/loop-react/src/index.ts` menghentikan run pada cap token, biaya, atau waktu dan memalsukannya dengan test; rinciannya di "Status Task 3.3" di bawah. Yang tetap benar untuk benchmark: `timeoutMs: 5000` di config benchmark adalah batas waktu per task milik `loop-react` (`agent timeout`), **bukan** `budget.maxElapsedMs`; config benchmark tidak punya blok `budget` sehingga guard mati karena default; dan `accept.ts` tetap tidak mengarang angka usage.
- **Akuntansi nyata, yang masih ditunda**: enforcement bisa stop pada cap biaya, tetapi tidak ada satu pun sumber harga besides config milik user, tidak ada suite live, dan tidak ada akuntansi yang bertahan lintas run. `usage.status` tetap `unavailable` dengan `method: "provider-does-not-report"` dan token `null`, dan `cost.amount` tetap `0` dengan `source: "mock-not-billed"` — placeholder, bukan hasil pengukuran.

### Provenance angka

`taskSetHash 645a15f7…` dan `reproducibilityHash 8135d0ff…` di laporan acceptance adalah angka yang sama dengan laporan `bench:20`, karena keduanya membaca report yang sama dari `run.ts`. Angka itu bukan tagihan, bukan bukti biaya provider live, dan `elapsedMs` adalah observasi satu run, bukan SLA. Angka 20/20 tetap milik Task 0.4: 2.6 memakai pipeline yang sama dan tidak menghasilkan rekor baru.

## Status Task 3.1 — Sandbox process/workspace

Task 3.1 di `TASKS.md` menyebut "container atau git worktree terisolasi". **Keduanya tidak diambil.** Yang diimplementasikan adalah opsi ketiga yang lebih lemah: **process/workspace sandbox di host**, dan itu harus dibaca apa adanya. Kotak 3.1 di `TASKS.md` sudah `- [x]`: full gate hijau 2026-09-27 pada working tree yang sama, rinciannya di `TASKS.md`. Yang dicentang hanya process/workspace sandbox — snapshot/rollback git sudah ditutup di kotak sendiri **3.2** dan hanya memulihkan isi workspace sandbox temp, budget guard **3.3** sudah ditutup di kotak sendiri, trace log **3.4** juga sudah ditutup di kotak sendiri, sementara 7.1–7.4 (pipeline gate, tool `plugin.create`/`plugin.test`/`plugin.install`, `agent-made`, hot reload) tetap `- [ ]`.

### Bentuk yang diimplementasikan

`src/sandbox.ts` mengekspor `createSandbox()`, `runInSandbox()`, dan `assertSandboxEnforced()`. Satu run sandbox:

1. **Akar sementara.** `mkdtemp` di OS temp dengan prefix `nexus-sandbox-`, bukan `data/` di repo dan bukan `user/`. Di dalamnya dibuat `config/`, `user/` kosong, dan `workspace/`. `workspace` di-`realpath` supaya perbandingan containment dilakukan lewat symlink apa pun yang mungkin ada di path temp itu sendiri.
2. **Tools root dipaksa relatif.** Config sandbox menulis `tools.root: workspace` — relatif, dengan sengaja. `tools.root` absolut akan melewati pemeriksaan containment kernel, jadi kernel-lah yang me-resolve-nya di bawah akar sementara. `assertSandboxEnforced` kemudian **memverifikasi, bukan memercayai**: menolak workspace yang bukan absolute, `network` yang bukan `deny`, provider yang bukan `mock`, `tools.root` di luar workspace, dan root `plugins.tools-basic`/`plugins.tools-core` yang bukan absolute atau keluar workspace. Kegagalan di sini menutup runtime dan menghapus pohon.
3. **Tidak ada user overlay.** Config sandbox dibuat dari nol, tanpa membaca `config/user.yaml` milik host, sehingga base URL, key, atau grant network dari host tidak bisa masuk. `user/` sengaja dibiarkan kosong supaya scope `user/` di repo dan scope secret di home sama-sama tak terjangkau.
4. **`root` dari request tidak pernah dibaca.** `SandboxRequest.root` divalidasi lalu dibuang; mengadopsi runtime root milik caller adalah satu-satunya rute dari sandbox ke `user/config.yaml` dan ke provider key. Field lain divalidasi dan ditolak kalau melebar (`provider` non-`mock`, `permissions` non-`deny`), tetapi tidak ada yang bisa memberi akses karena sandbox membangun config offline-nya sendiri.
5. **Network dan shell deny.** `network: deny` permanen, dan `shell` deny ganda: `permissions.shell: deny` **plus** `deny: ["*"]` di daftar tolak tools. Satu-satunya jalan membuka shell adalah `SandboxOptions.shell.allow` yang eksplisit, dan satu executable yang di-allowlist tidak mengizinkan yang lain — termasuk interpreter.
6. **Envelope hasil tertutup.** Hasil hanya `status`, `steps`, `toolCalls`, `error?`, dan `workspaceCleaned`. Tidak ada teks, path, atau config yang ikut. `workspaceCleaned` hanya `true` setelah pohon temp diverifikasi hilang lewat `stat`, dan `dispose()` single-flight serta idempoten, dipanggil pada sukses, error, run yang terhenti, penolakan, dan kegagalan konstruksi.

Hardening child proses ada di tool shell `plugins/tools-basic/src/index.ts`, karena di situlah satu-satunya `spawn` yang bisa menjangkau proses luar:

- **Env child dibersihkan.** Hanya `PATH`, `LANG`, `LC_ALL`, `TMPDIR` yang menyeberang batas. Child tidak melihat `HOME`, API key, atau credential host apa pun. `buildEnv()` meneruskan allowlist itu dan tidak ada jalur lain.
- **Process group terpisah.** Child di-`spawn` dengan `detached: true`, `shell: false`, dan `stdio` pipe; sinyal dikirim per process group lewat `process.kill(-pid, …)`, sehingga descendant ikut mati dan tidak ada orphan yang lolos. Timeout memberi `SIGTERM`, lalu `SIGKILL` setelah grace `terminationGraceMs`, dan sebuah hard timer menutup promise sendiri kalau pipe tidak pernah ditutup — jadi child yang menahan stdout tidak bisa menggantung tool.
- **Hard deadline dan output cap.** `timeoutMs` dibatasi maksimum 30.000 ms, dan output child dipotong pada `maxOutput` 64.000 byte dengan marker truncation, sehingga child yang membanjiri output tidak bisa mendorong hasil tak terbatas.

### Yang tidak ada, dan tidak boleh diklaim

Tidak ada container, Docker, `git worktree`, mount namespace, seccomp, cgroup, `uid`/`gid` drop, chroot, Landlock, atau AppArmor. `grep -rniE "docker|container|namespace|unshare|seccomp|cgroup|setuid|setresuid|apparmor|landlock|chroot" --include="*.ts" src kernel/src plugins/*/src` di luar `*.test.ts` **0 hit**; satu-satunya sebutan `worktree` di source non-test adalah komentar di `kernel/src/config.ts:495`.

**Yang paling penting: ini bukan pertahanan terhadap plugin in-process yang berbahaya.** Agent sandbox berjalan di proses Node yang sama lewat `createRuntime`, sehingga plugin official yang sudah dimuat tetap berjalan dengan akses proses yang sama seperti sebelumnya. Semua yang di atas adalah hygiene path, workspace, dan proses — bukan boundary keamanan terhadap kode yang sudah jalan di dalam host. Permission gate tetap cooperative, dan tidak ada mekanisme yang mengubahnya.

Tidak ada gate sebelum swap, tidak ada canary, tidak ada monitor, dan tidak ada rollback keputusan. Snapshot/rollback berbasis git sudah ditutup di Task 3.2, dan itu **tidak** menambah keputusan apa pun: ia hanya memulihkan isi workspace sandbox temp, sementara pipeline `worktree → … → smoke sandbox → canary → swap → rollback` tetap Task 7.1. `run --sandbox` adalah satu run hermetik yang mencetak satu baris JSON, bukan gate: ia tidak memutuskan apakah plugin boleh di-swap.

### Bukti falsifiable

23 test di dua file, semuanya benar-benar memanggil host — bukan mock. `src/sandbox.test.ts` (12 test) mencakup confinement root, envelope hasil, penolakan request yang melebar, `root` yang tidak pernah dibaca, escape traversal/absolute/symlink, shell deny, tanpa network, pohon host byte-identical, fail-closed config, cleanup, dan **CLI seam nyata tanpa host yang di-inject** ("runs the real CLI sandbox path end to end, with no injected host" plus "exits nonzero through the real seam when the run cannot complete"). `src/sandbox-security.contract.test.ts` (11 test) menambahkan temp workspace terpisah, byte-identical host trees, root yang bukan absolute/keluar/symlink, baca-tulis lewat symlink keluar, shell deny tanpa executable yang sempat jalan, env child tanpa key dan tanpa home, **"kills a child that ignores the deadline, grandchild included"**, output cap, cleanup setelah run/penolakan/kegagalan konstruksi, laporan tanpa fetch/user config/secret, dan symlink workspace yang dijaga tetap di dalamnya.

Dua catatan jujur soal bukti ini. Test process-group itu `it.skipIf(!posix)`, jadi ia **dilewati di platform non-POSIX** dan tidak boleh dibaca sebagai jaminan lintas platform. Dan command `node dist/src/cli.js run --sandbox "write a note"` yang dipakai sebagai bukti harus dijalankan ulang oleh coordinator pada build-nya sendiri; yang tercatat di sini adalah hasil run di working tree yang sama, bukan jaminan build berikutnya.

### Yang tetap kosong

`benchmarks/` **tidak** memakai sandbox ini — `benchmarks/run.ts` masih membangun akar sementara dan config-nya sendiri secara paralel, jadi isolated workspace benchmark dan isolated workspace sandbox adalah dua mekanisme terpisah yang tidak boleh dicampur dalam satu klaim. Snapshot/restore 3.2 tidak mengubah itu: `benchmarks/` tidak mengimpor `createSnapshot` maupun `runInSandbox`, jadi snapshot 3.2 juga tidak boleh dikutip sebagai bukti isolasi benchmark atau sebaliknya. Trace log 3.4 ditutup terpisah dan tidak menambah gate/canary/rollback keputusan apa pun; yang tetap kosong di sini adalah 7.1. Budget guard 3.3 ditutup terpisah dan tidak menambah gate apa pun.

## Status Task 3.2 — Snapshot/restore git workspace sandbox

Task 3.2 di `TASKS.md` adalah "snapshot dan rollback berbasis git". **Kotaknya sudah `- [x]`**: full gate hijau 2026-09-27 pada working tree yang sama, rinciannya di `TASKS.md`. `src/snapshot.ts` mengekspor `createSnapshot(root)`, `createSnapshot(options)` (session `{ take, restore }`), dan `restoreSnapshot(root, commit)`, sudah di-import `src/sandbox.ts`, dan sudah di-wire ke flag `--snapshot` di `src/cli.ts`. Yang dipulihkan 3.2 adalah **isi workspace sandbox temp** — bukan keputusan, bukan checkout plugin official, dan bukan repo developer.

### Scope: hanya workspace sandbox, tidak pernah repo developer

- **Targetnya milik sandbox sendiri.** `run()` mengambil target dari `workspace` yang dibuat `mkdtemp` pada `createSandbox()`, bukan dari `SandboxRequest.root` — dan `root` itu tetap divalidasi lalu dibuang seperti pada 3.1. Jadi `git init` dan baseline commit terjadi di `<tmp>/nexus-sandbox-*/workspace`, sementara mengadopsi root caller tetap satu-satunya rute ke `user/config.yaml` dan ke provider key.
- **Tiga aturan containment di `canonicalRoot()`**. (1) Root harus string non-kosong tanpa NUL, harus absolut, dan harus direktori yang ada; root di-`realpath` lebih dulu sehingga symlink apa pun ikut terbandingkan. (2) Root harus **di dalam** OS temp, dan **temp dir itu sendiri ditolak** — `relative(tmpdir, canonical) === ""` secara eksplisit ditolak, begitu juga `..` dan path absolut. Aturan inilah yang menutup `..` traversal, `/`, `$HOME`, dan repo developer sebagai target, dan penolakannya datang dari gerbang containment dengan pesan `snapshot root …`, bukan dari kegagalan git yang tidak terduga. (3) Kalau git melaporkan ada repository di root itu, git **harus menempatkan `.git` miliknya sendiri sebagai git dir repository itu**: jawaban `rev-parse --absolute-git-dir` di-`realpath` dan dibandingkan dengan `realpath(<root>/.git)`, dan kalau berbeda root ditolak dengan `snapshot refuses a git checkout`.
- **Tidak ada marker file.** Implementasi ini **tidak menulis dan tidak membaca** marker `.git/nexus-snapshot`; versi dokumen sebelumnya salah menyebutnya, dan `grep -rn "nexus-snapshot" src/ kernel/src/ plugins/*/src` kini hanya mengenai prefix direktori scratch di test dan `snapshotPrefix` di `src/snapshot.fixtures.ts`. Yang sebenarnya ditolak aturan 3 adalah **git-dir milik orang lain**: root yang memang repository-nya sendiri **diizinkan** — itu workspace milik caller — dan `git init` di `open()` hanya berjalan bila `.git` belum ada. Checkout orang lain, termasuk worktree yang di-plant, tidak pernah di-`init`, di-`commit`, atau di-`reset`. Aturan 2 dan 3 membandingkan `realpath` dan jawaban git, bukan pencocokan string, sehingga path temp berupa symlink tetap bekerja.
- **Tidak ada `worktree`, `stash`, `branch`, `remote`, `tag`, `push`, `fetch`, `clone`, atau `pull`.** Modul tidak memuat verb itu sama sekali dan tidak mengonfigurasi remote.

### Bentuk yang diimplementasikan

- **Baseline commit.** `init --quiet` (hanya bila `.git` belum ada) → `git config user.name nexus` + `user.email nexus@localhost` **di config lokal workspace itu** → `add -A -- .` → `commit --quiet --allow-empty -m "nexus snapshot"` → `rev-parse HEAD`. Identitasnya **bukan** `-c` per perintah dan bukan config host: tidak ada `HOME` dan tidak ada global config, jadi commit butuh apa pun dari host. `--allow-empty` memberi titik kembali bahkan untuk workspace yang tidak tersentuh. `add -A` **sengaja** tidak men_stage berkas yang di-ignore. Baseline kedua pada workspace yang sama diizinkan, dan commit lama tetap bisa direstore.
- **Restore = `reset --hard` + `clean -fd`, bukan `-fdx`.** Sha harus cocok `^[0-9a-f]{7,40}$`, lalu `rev-parse --verify <sha>^{commit}` diverifikasi **sebelum** workspace disentuh, lalu `reset --hard --quiet` dan `clean -fd -q`. Setelah itu `HEAD` dan `status` dibaca ulang; kalau `HEAD` tidak sama dengan target atau status masih nonempty, restore melempar dan workspace tidak pernah tertinggal setengah pulih. `changedFiles` mengembalikan path relatif yang berubah **sebelum** restore, ter-sortir, tanpa path absolut atau `..`. **Berkas yang di-ignore dipertahankan** karena modul tidak bisa expresses `-x`/`--ignored` — build output dan cache di dalam workspace selamat dari restore, seperti `git checkout` milik developer sendiri, dan file yang di-ignore juga tidak bisa dihidupkan kembali oleh restore.
- **Env git disaring, dengan deadline, output cap, dan teks error terbatas.** Yang diwariskan hanya `PATH` dan `LC_ALL=C`, ditambah `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` ke `/dev/null`, dan `GIT_TERMINAL_PROMPT=0`. Tanpa `HOME`, `~/.gitconfig` dan `~/.config/nexus` di luar jangkauan, jadi `credential.helper`, `http.proxy`, dan `insteadOf` milik host tidak pernah terbaca. Tiap perintah juga diberi `-c core.hooksPath=/dev/null -c commit.gpgsign=false`, `shell: false` dengan argv tetap, `stdio: ignore/pipe/pipe`, dan `detached: true` supaya sinyal dikirim per process group. Deadline 30.000 ms memberi `SIGTERM` ke group, `SIGKILL` setelah grace 500 ms, dan resolve paksa 2 detik kemudian; stdout+stderr dijumlah byte-nya dan di-`SIGKILL` di atas 8 MiB; teks error dibatasi baris stderr pertama yang dipotong 160 karakter supaya child yang membanjiri tidak bisa menitipkan payload ke satu-satunya tempat yang pasti dibaca caller. Nama workspace tidak mungkin menjadi perintah karena argv tidak pernah melewati shell. **Koreksi:** ini **bukan** `maxBuffer` milik `spawn` — tidak ada opsi `maxBuffer` di modul; cap-nya penghitung byte eksplisit.
- **Auto-restore lewat flag CLI, tanpa opt-out.** `node dist/src/cli.js run --sandbox --snapshot <task>` membaseline workspace lalu restore otomatis setelah run apa pun hasilnya — `completed`, `error`, atau dihentikan — dan selalu sebelum `dispose()`. `--snapshot` ditolak di luar `--sandbox` dengan `--snapshot requires --sandbox`, termasuk di `session resume`, jadi flag itu tidak pernah diabaikan diam-diam. `run --sandbox` tanpa flag itu persis seperti 3.1: request empat key yang dulu tidak berubah dan tidak pernah memuat field `snapshot`, karena `runSandbox()` hanya menyisipkan `snapshot: true` ketika flag diberikan. Restore yang tidak selesai dilaporkan `rolledBack: false`, **bukan** error yang dilempar, karena pesan error bisa membawa path keluar dari envelope tertutup sementara run sudah punya hasilnya. **Exit code tetap hanya berasal dari `status`**, jadi `rolledBack: false` tidak mengubah kode keluar. **Tidak ada flag pembatal**: workspace dihapus bersama temp tree sesudah run, jadi `rolledBack` satu-satunya sinyal dan inspeksi sesudah run tidak mungkin. Selain CLI, `SandboxOptions.snapshot` menyalakannya untuk seluruh sandbox dan `SandboxRunOptions.snapshot` untuk satu run (menang atas default); field `snapshot` pada request divalidasi sebagai boolean lalu **dihormati** — string non-boolean ditolak, bukan dipalsukan.
- **Nol secret atau config host yang ter-snapshot.** Git root adalah `workspace/` saja: `config/`, `user/` kosong, dan `config/default.yaml` berada di luar git root, begitu juga `data/` repo, `config/`/`user/` repo, dan store sesi di home. `changedFiles` hanya memberi path relatif, bukan isi berkas, sehingga tidak ada key atau path secret yang masuk snapshot maupun envelope hasil.

### Yang TIDAK ada di 3.2

Tidak ada rollback atas repo developer, tidak ada `git worktree`, tidak ada branch/remote/push, tidak ada tag, tidak ada `stash`, tidak ada canary, tidak ada monitor, dan tidak ada gate yang memanggil restore sebagai keputusan swap. **3.2 memulihkan isi workspace sandbox — bukan keputusan dan bukan checkout plugin official.** Satu-satunya rollback yang benar-benar ada di source tetap rollback **objek** di `reload()` (1.2). Pipeline `worktree → lint/type → unit → eval → smoke sandbox → canary → swap → rollback` tetap **7.1**, dan `plugin.create`/`plugin.test`/`plugin.install`, `agent-made/staging`+`active`, hot reload plugin buatan agent tetap **7.2–7.4**. Semuanya `- [ ]`. Trace log **3.4** ditutup terpisah di kotaknya sendiri dan tidak menambah gate, canary, monitor, atau rollback keputusan apa pun pada 3.2. Budget guard **3.3** ditutup terpisah di kotaknya sendiri, dan penutupan itu tidak menambah gate, canary, monitor, atau rollback keputusan apa pun pada 3.2.

### Bukti falsifiable, dan catatan platform

38 test di empat file, semuanya memanggil implementasi sungguhan: 11 di `src/snapshot.test.ts`, 11 di `src/snapshot-security.contract.test.ts`, 10 di `src/sandbox.test.ts` (7 describe "snapshot and rollback" plus 3 CLI seam nyata), dan 6 di `src/cli.test.ts` describe "CLI sandbox snapshot". Bukti `npx vitest run --reporter=verbose src/snapshot.test.ts src/snapshot-security.contract.test.ts src/sandbox.test.ts src/sandbox-security.contract.test.ts` → `Test Files 4 passed (4)`, `Tests 53 passed (53)`, dan `src/cli.test.ts` → `Tests 31 passed (31)`. Nama persis setiap butir ada di `TASKS.md`.

Dua catatan jujur soal bukti ini:

- **Test git punya kondisi lingkungan, dan itu harus disebut.** 11 test di `src/snapshot.test.ts` semuanya `it.skipIf(!gitReady)`, jadi suite itu **dilewati di mesin tanpa `git` di PATH**. Di `src/snapshot-security.contract.test.ts`, 8 test ber-`skipIf(!gitAvailable)` dan 3 ber-`skipIf(!shellShim)` — yang terakhir butuh host POSIX **dan** `git` — sementara 2 test containment dan `git is not available` berjalan tanpa kondisi. Sebaliknya 10 test 3.2 di `src/sandbox.test.ts` dan 6 di `src/cli.test.ts` **tidak punya `skipIf` sama sekali** (`grep -c skipIf src/sandbox.test.ts` = 0), jadi bukti level sandbox dan envelope CLI tidak bergantung pada `git` di PATH. Pada run yang tercatat di `TASKS.md` tidak ada satu pun test yang ter-skip.
- **Dua gap yang tercatat sebelumnya sudah tertutup, dan keduanya dipalsukan test.** (a) *Containment direktori temp itu sendiri*: `fromTemp === ""` kini ditolak eksplisit di `canonicalRoot()`, dan `..` traversal gugur di aturan yang sama, jadi penolakan datang dari gerbang containment dengan pesan `snapshot root …` — dibuktikan "refuses a relative, traversing, or missing root" dan contract "refuses the real repo, user, data, home, traversing, and escaping symlinked roots". (b) *Auto-restore di level sandbox*: kini ada describe "snapshot and rollback" (7 test) plus CLI seam nyata di `src/sandbox.test.ts`, jadi `snapshot: true`, `rolledBack`, `restoreQuietly()` yang tidak melempar, dan `run --sandbox --snapshot` semuanya dipalsukan tanpa host yang di-inject. Koreksi isi versi sebelumnya: klaim marker `.git/nexus-snapshot` sebagai mekanisme containment salah, dan digantikan di atas oleh perbandingan `rev-parse --absolute-git-dir` dengan `realpath(<root>/.git)`.

## Status Task 3.3 — Budget guard

Task 3.3 di `TASKS.md` adalah "budget guard (token, uang, waktu)". **Kotaknya sudah `- [x]`**: full gate hijau 2026-09-27 pada working tree yang sama, rinciannya di `TASKS.md`. Yang enforcing adalah `plugins/loop-react/src/index.ts`; policy, konstanta, dan parsing usage milik kernel. Tiga kegagalan contract yang tercatat di versi bagian ini sebelumnya sudah tertutup dan dipalsukan test.

### Bentuk yang diimplementasikan

- **Kernel** — `BudgetPolicy` { `enabled`, `maxTotalTokens`, `maxCostUsd`, `maxElapsedMs`, `prices` }; `DEFAULT_BUDGET_POLICY` beku dengan `enabled: false`, ketiga limit `null`, `prices` kosong; `resolveBudgetPolicy()` yang mengisi field yang absen dengan `null` dan menolak cap non-bulat atau negatif serta entri harga yang tidak lengkap; lima konstanta alasan stop beserta `BUDGET_STOP_REASONS` dan `BudgetStopReason`; `usage?: ModelUsage` pada `AgentResult`; `budget?: BudgetPolicy` pada `AgentRunOptions`. Di `kernel/src/model.ts`: `ModelUsage` { `inputTokens`, `outputTokens`, `totalTokens`, `source` }, `ModelPrice` { `inputUsdPerMillionTokens`, `outputUsdPerMillionTokens` }, dan `usage?` opsional pada **kedua** varian `ModelResult`.
- **Config** — blok `budget` strict di `kernel/src/config.ts` dengan `enabled` default `false`, ketiga cap nullable default `null`, `prices` nullable default `null`; menolak `0`, negatif, `NaN`, non-finite, dan key unknown. `config/default.yaml` memuat blok itu dengan `enabled: false` dan ketiga cap `null`, dan `user/config.example.yaml` menyalinnya dengan cap dan `prices` terkomentari — guard mati karena default, dan cara mengaktifkannya terdokumentasi di config yang terkirim.
- **Runtime** — `configBudget()` mengembalikan `BudgetPolicy | undefined`, dan `undefined` kecuali `config.budget.enabled === true`. Ia meneruskan **seluruh peta harga** dari config ke `prices` apa adanya dan memanggil `resolveBudgetPolicy`. `runtime.budget` jadi `undefined` saat guard mati, jadi `runSession` dan `src/cli.ts` meneruskan key `budget` hanya saat policy ada — key absen, bukan object kosong.
- **Loop** — `plugins/loop-react/src/index.ts` inilah yang benar-benar menghentikan run. `budgetStop()` adalah lapis ketiga: mengecek harga sebelum menagih turn, sehingga cap biaya tanpa harga berhenti di langkah pertama; `BUDGET_USAGE_UNAVAILABLE` bila ada cap aktif tapi provider tidak melaporkan usage; `unpair()` menjawab tool call yang tersisa supaya transkript tidak ditinggalkan berpasangan; `usageSource` menjadi `"multiple"` kalau dua turn melaporkan sumber berbeda; timer kedua hanya di-arm untuk policy aktif yang punya `maxElapsedMs`; `usage` hanya ditempel ke hasil saat policy aktif **dan** ada yang dilaporkan.
- **Biaya** — dihitung dalam **mikro-USD bulat** (`inputTokens * inputUsdPerMillionTokens + outputTokens * outputUsdPerMillionTokens` dibandingkan `maxCostUsd * 1_000_000`), sehingga pembulatan floating point tidak dapat membuat cap lolos. Harga dicari dengan kunci persis lewat `Object.hasOwn`, jadi member prototipe seperti `constructor` tidak pernah menjadi harga.

### Harga per model, dan fail closed saat tidak ada harga

`budget.prices` adalah **peta per model**, bukan pasangan datar tunggal. Nama field di config sama persis dengan `ModelPrice`: `inputUsdPerMillionTokens` dan `outputUsdPerMillionTokens`, dikunci nama model yang dipanggil runtime (`model.model`). `configBudget()` meneruskan peta itu tanpa mengubah kuncinya dan tanpa memilih satu model, sehingga kernel tidak pernah menebak harga maupun menutupi model yang tidak disebut; sisi harga yang `0` ditolak karena akan menghitung satu dimensi sebagai gratis.

Loop menerima identitas model sebagai `modelIdentity`, yang diteruskan `AgentRunnerFactory = (model, modelName) => AgentRunner` dan diisi `config.model.model` oleh runtime. Harga dibaca dengan `Object.hasOwn(budget.prices, modelIdentity)` — kecocokan persis, tidak longgar. Kalau ada `maxCostUsd` tetapi `modelIdentity` tidak ada di peta, run berhenti `BUDGET_COST_UNPRICED` pada langkah pertama, bukan dianggap gratis. Konsekuensi yang harus dibaca apa adanya: peta per model tidak membuat semua model bisa dihargai — **hanya model yang dipanggil run itu** yang bisa, dan model lain di luar peta menghasilkan stop, bukan lolos gratis.

### Stop reason: satu kosakata, konstanta, tanpa field tersendiri

Kernel yang memiliki kosakata itu. `kernel/src/agent.ts` menerbitkan `BUDGET_TIME = "budget:time"`, `BUDGET_TOKENS = "budget:tokens"`, `BUDGET_COST = "budget:cost"`, `BUDGET_USAGE_UNAVAILABLE = "budget:usage-unavailable"`, `BUDGET_COST_UNPRICED = "budget:cost-unpriced"` sebagai lima konstanta, merangkainya di `BUDGET_STOP_REASONS` dengan tipe `BudgetStopReason`, dan menerbitkan satu teks `BUDGET_STOP_TEXT = "Agent stopped: budget reached."`. Runner di `plugins/loop-react` **me-re-export** kelima konstanta itu (`BUDGET_STOP_TEXT` di-`export` sebagai `BUDGET_TEXT`) alih-alih menyalin nilainya, dan keanggotaan kosakata diuji lewat `new Set(BUDGET_STOP_REASONS)`. Jadi alasan yang di-emit tidak bisa melenceng dari yang diterbitkan.

**Koreksi untuk versi dokumen sebelumnya:** versi ini pernah menulis kernel menerbitkan `["max-total-tokens", "max-cost-usd", "max-elapsed-ms"]` sementara runner memakai `budget:*` — dua kosakata yang berbeda. Itu sudah tidak berlaku; kernel dan loop sekarang memakai daftar yang sama, dan "reports the kernel's stop reason vocabulary as the one the loop actually emits" memalsukannya dari titik konsumsi. Tidak ada jumlah, harga, nama model, path, atau teks provider yang di-interpolasi ke reason maupun `text`. `AgentResult` juga **tidak** punya field `stopReason`: alasannya konstanta string di `error`, seperti empat alasan lama (`step limit reached`, `tool call limit reached`, `agent timeout`, `agent cancelled`).

### Batas yang tidak boleh hilang

- **Tidak ada penulisan usage ke mana pun.** `src/session.ts` tidak memuat satu pun kemunculan `usage`; `runEndSchema` tetap `.strict()` dengan `status`, `text?`, `error?`, `limits?`. Budget adalah input run, bukan record: dibuktikan "forwards the configured budget on a new run and on a resume, and never stores it" (`src/runtime.test.ts`) dan "reports usage on stdout only, never in the persisted run end" (`src/cli.test.ts`). Konsekuensinya, `run-end` tidak dapat membedakan stop budget dari stop langkah, dan usage tidak dapat dibangun ulang lintas proses.
- **Resume hanya boleh mengencangkan batas.** `tightestLimits()` di `src/runtime.ts` mengambil `Math.min` per field antara `maxSteps`, `maxToolCalls`, dan `timeoutMs` yang direkam session dan yang diminta caller, dan `resumeSession()` menghitungnya dari **setiap** `run-end`, bukan hanya yang terakhir — sehingga record yang belakangan tidak bisa mengembalikan plafon yang lebih longgar. `null` bukan nilai di sini, jadi field yang absen membiarkan sisi lain berlaku. Dipalsukan "does not let a resume weaken the limits its last run recorded".
- **Dua plafon waktu.** `agent.timeoutMs` sudah lama ada; `budget.maxElapsedMs` adalah plafon kedua yang hanya di-arm saat policy aktif dan punya cap. Yang diuji 3.3 adalah bahwa keduanya jujur dan tidak saling mencuri kredit: plafon kedua tidak di-arm saat guard mati, dan stop pada plafon kedua memakai `BUDGET_TIME`. Perilaku mana yang lebih ketat pada waktu tertentu belum jadi keputusan produk.
- **Tidak ada flag CLI budget.** `parseArgs` di `src/cli.ts` hanya menerima `--root`, `--model`, `--session`, `--sandbox`, `--snapshot`, `--mock`, `--help`; help text tidak menyebut budget.
- **Tidak ada event usage baru.** `PluginEventMap` tetap `plugin:loaded` dan `plugin:unloaded`; tidak ada capability atau service `usage:*`. Usage mengalir lewat return value dan stdout.
- **Benchmark tidak tersentuh.** `benchmarks/run.ts` dan `benchmarks/accept.ts` tidak berubah, dan config benchmark yang ditulis `run.ts` tidak punya blok `budget` sama sekali sehingga guard mati karena default: `usage.status "unavailable"`, `method "provider-does-not-report"`, token `null`, dan `cost.amount 0` dengan `source "mock-not-billed"` tetap **literal di source**. Karena `runBenchmark` memaksa provider `mock` dan `model-mock` tidak melaporkan usage, contract `usage?` yang baru **tidak mengubah satu pun angka benchmark**; `taskSetHash`/`reproducibilityHash` tidak bergeser karena 3.3. Tidak ada suite live, tidak ada API key, tidak ada network, tidak ada tagihan.

### Yang TIDAK ada di 3.3

Tidak ada flag CLI budget, tidak ada persistence usage, tidak ada event usage, tidak ada agregasi usage lintas run atau proses, tidak ada `stopReason` terstruktur, dan tidak ada akuntansi biaya nyata — harga di config disuplai user, bukan diambil dari katalog provider. Trace log **3.4** sudah ditutup terpisah di kotaknya sendiri — detail statusnya di "Status Task 3.4" di bawah — dan menutupnya tidak menambah gate, canary, atau rollback keputusan apa pun. Dashboard biaya/token **4.6**, pipeline gate **7.1**, `plugin.create`/`plugin.test`/`plugin.install` **7.2**, `agent-made/staging`+`active` **7.3**, hot reload plugin buatan agent **7.4** tetap `- [ ]`.

## Status Task 3.4 — Trace log terstruktur

Task 3.4 di `TASKS.md` adalah "Trace log terstruktur". **Kotaknya sudah `- [x]` — ditutup 2026-09-27 setelah full gate `docs/AGENT_WORKFLOW.md` bagian 4 hijau pada working tree yang sama.** Gate yang obligatory semuanya dijalankan coordinator di tree ini: `corepack pnpm install --frozen-lockfile` exit 0, `lint` `Checked 83 files` tanpa fix, `typecheck` bersih, `test` **453 test di 32 file** vitest + 2 `node --test`, `build` exit 0, `check` exit 0, `bench:smoke` `{"ok":true,…,"elapsedMs":46}`, `bench:20` 20/20, `bench:accept` `accepted` dengan `violations: []`, dan `git diff --check` tanpa output. **Angka itu hasil run yang tercatat, bukan jaminan deterministik lintas run**, dan catatan jujur soal dua test timing lama ada di kotak 3.4 `TASKS.md`: pada run gate ini keduanya hijau, dan ketika muncul gagal masing-masing lolos sendiri saat file terkait dijalankan terpisah — keduanya bukan test trace. Yang dicentang hanya trace log; menutupnya tidak menambah gate, canary, atau rollback keputusan apa pun, dan `4.6` serta `7.1`–`7.4` tidak ikut tercentang. Kalau ada butir di bawah yang berbeda dari source, source yang menang dan dokumen ini yang salah.

### Bentuk yang sudah ada di source

- **Config** — `kernel/src/config.ts` punya blok strict `trace`. `DEFAULT_TRACE_MAX_BYTES = 1_048_576`; `maxBytes` adalah `z.number().int().min(1).max(DEFAULT_TRACE_MAX_BYTES * 64)`, jadi ceiling kerasnya `67_108_864`; `TraceConfigSchema` = { `enabled` default `false`, `maxBytes` default `1_048_576` } `.strict()` dengan overlay opsional keduanya. `ConfigSchema.trace` punya default, jadi **blok yang hilang berarti mati** dan run default tidak membangun apa pun. `config/default.yaml` memuat blok itu eksplisit dengan `enabled: false` dan `maxBytes: 1048576`. Bloknya **tidak punya key lokasi**: `path`, `dir`, `root`, `file`, dan `apiKeyFile` bukan field yang dikenal, jadi strict object menolaknya — "where a trace lands is the writer's business" ditulis di source.
- **Writer** — `src/trace.ts` mengekspor `createTraceWriter(options: TraceWriterOptions)`, `traceRecordSchema`, `TRACE_SCHEMA_VERSION = 1`, `TRACE_FILE = "trace.jsonl"`, dan `TRACE_ROTATED = "trace.jsonl.1"`. `TraceWriterOptions` adalah `{ enabled?, root?, maxBytes? }`, `enabled` aktif hanya kalau `options.enabled === true`, dan `maxBytes` ditolak di luar `[1, MAX_TRACE_MAX_BYTES]` sehingga enabled trace tidak bisa tumbuh tanpa batas siapa pun yang memanggil writer. Root default `join(homedir(), ".config", "nexus", "user", "traces")` — `${HOME}/.config/nexus/user/traces`, sebelah session store dan di luar repo. Batasnya: cap rotasi dari `options.maxBytes` (default `DEFAULT_TRACE_MAX_BYTES`), `MAX_RECORD_BYTES = 8 KiB`, `MAX_SCALAR_CHARS = 128`, `MAX_TAIL_WINDOW = 64 KiB`. **Tidak ada konstanta cap internal lagi** — cap hanya satu sumber, yaitu config.
- **Format dan urutan** — JSONL, satu objek JSON per baris, `O_APPEND | O_CREAT | O_RDWR | O_NOFOLLOW` mode `0600`, root di-`mkdir` dan di-`chmod` `0700` pada append pertama. `ensureRoot` men-follow root yang berupa symlink ke target-nya sendiri lebih dulu karena `mkdir` menolak link tanpa target, dan `mkdir` tidak mengubah mode directory yang sudah ada sehingga mode longgar dikencangkan ulang. `refuseExisting` gagal closed atas symlink, directory, file milik uid lain, dan file yang mode-nya bukan `0600` —alasannya tertulis di source: mode longgar berarti isi yang sudah tertulis sudah bisa dibaca orang lain, dan mengetatkannya sesudah itu tidak membatalkannya. `trimTornTail` membuang paling banyak satu record parsial sebelum append berikutnya supaya record berikutnya tidak tersambung ke fragmen.
- **Record scalar** — `traceRecordSchema` adalah discriminated union strict **lima** varian: `run-start` { `provider`, `model` }, `run-step` { `steps` }, `run-end` { `status`, `steps`, `toolCalls`, `budgetReason?`, `usage?` }, `plugin-load` { `name`, `required` }, dan `plugin-load-failed` { `name`, `required` }; masing-masing membawa `schemaVersion`, `ts`, `seq`, dan `runId`. Field writer (`schemaVersion`, `ts`, `seq`, `runId`) diterapkan **terakhir**, jadi caller tidak bisa memalsukan `seq` atau `runId`, dan key tambahan apa pun yang dibawa caller masih ada di kandidat sehingga strict object menolaknya. `run-end` boleh membawa `budgetReason` hanya dari vocabulary `BUDGET_STOP_REASONS` milik kernel dan `usage` hanya bila provider melapor. Dua bentuk plugin sengaja sempit: **tidak ada** path manifest, versi, atau teks error, dan `name` bukan scalar bebas — ia harus juga cocok `^[a-z0-9]+(?:-[a-z0-9]+)*$` (aturan kebab-case kanonik yang sama dengan `kernel/src/manifest.ts`), sehingga load error, directory, dan credential yang diselundupkan ke `name` ditolak.
- **Redaction sebagai aturan nilai, bukan penyaringan** — `scalar` membuang karakter kontrol, menolak nilai yang jadi kosong setelah itu, menolak yang diawali `/`, `~/`, `../`, atau drive letter (`absoluteLocation`), dan menolak `secretShape` (`sk-…`, `Bearer `, `-----BEGIN`, atau penugasan `api_key`/`secret`/`token`/`password`/`passwd`/`credential`/`authorization`/`cookie` yang diikuti `:` atau `=`). Scalar yang ditolak **membuat record ditolak**, bukan disimpan tersamar; alasannya tertulis di source: trace yang tidak bisa dibaca tidak berguna, trace yang bocor lebih buruk daripada tidak ada trace.
- **Kegagalan tulis tidak pernah mematikan run** — `append` mengembalikan `boolean` dan tidak pernah melempar; `refused`, `oversized`, dan `gagal menulis` semuanya menambah `stats().failures`, sedangkan yang berhasil menambah `stats().written` dan rotasi menambah `stats().rotations`. `append` di-serialize lewat `tail` promise supaya dua append tidak berinterleaving di tengah baris.
- **Rotasi** — **satu generasi**: saat `size + line` melewati cap yang diberikan, `trace.jsonl` di-`rename` ke `trace.jsonl.1` dan append berikutnya mulai file baru; jadi jumlah file tidak menumpuk. Cap itu `options.maxBytes`, yaitu `config.trace.maxBytes` yang sudah dibatasi kernel. Ini cap per generasi, bukan kebijakan retensi, dan `ponytail:` comment di source menyebut upgrade-nya: sweep bernomor bila riwayat tanpa batas diinginkan.
- **Runtime** — `src/runtime.ts` memanggil `createTraceWriter` **langsung**, hanya saat `config.trace.enabled === true`; `openTrace(config, host = createTraceWriter)` mengembalikan `undefined` untuk semua config lain, jadi off adalah **ketiadaan pemanggilan**, bukan writer yang dimatikan. `Runtime.trace` adalah writer atau `undefined`, dan `RuntimeOptions.traceHost` (tipe `typeof createTraceWriter`) ada untuk test double. `tracedRunner` membungkus `runtime.runner` sehingga `runSession` dan CLI ikut terlacak tanpa keduanya tahu: `run-start` { `provider`, `model` }, `run-step` { `steps` }, `run-end` { `status`, `steps`, `toolCalls`, `usage?`, `budgetReason?` }. `onStep` caller tetap jalan lebih dulu dan tetap memiliki run; `traced` selalu dipasang—even untuk run yang tidak diberi hook—dan di-await inline dengan alasan tertulis: step record yang bisa mendahului `run-end` membuat log berbohong soal urutan. `traceSink` menelan kegagalan append dan melakukan `logger.warn` **sekali per tipe record**, supaya run yang sama tidak terlalu spam; hanya vocabulary `budget:*` yang boleh ikut, bukan teks error lain. Dua bentuk plugin berasal dari host: `registry.events.on("plugin:loaded", …)` yang **sudah ada** untuk `plugin-load`, dan `plugin-load-failed` untuk nama yang tidak pernah come up — required di jalur fail-closed, optional saat `registry.load` melempar.
- **Test** — `src/trace.test.ts` (46 test) dan `src/trace-security.contract.test.ts` (16 test) menguji writer; `src/trace.fixtures.ts` menyediakan `withTraceWriter`, `stubbedHome`, dan `fillTraceFile`. Fixture memakai `mkdtemp` di OS temp dan `vi.stubEnv("HOME")`, bukan `$HOME` asli. `src/runtime.fixtures.ts` dan `src/runtime.test.ts` describe "structured trace host" (11 test) menguji sisi runtime, dan `kernel/src/config.test.ts` describe "kernel config trace" (10 test) menguji blok config. Jumlah suite pada run gate tercatat di kotak 3.4 `TASKS.md`, bukan di dokumen ini.
### Dua scope yang dulu terbuka, dan decision yang dipakai

- **`config.trace.maxBytes` sekarang punya konsumen — cap yang berlaku adalah cap yang ditulis user.** `openTrace` memanggil `createTraceWriter({ enabled: true, maxBytes: config.trace.maxBytes })` (`grep -c maxBytes src/runtime.ts` = 1), dan `TraceWriterOptions.maxBytes` menegakkan `MAX_TRACE_MAX_BYTES` yang sama dengan config, jadi cap yang diberikan langsung ke writer pun tidak bisa membeli generasi tanpa batas. **Konstanta internal 4 MiB yang lama sudah dihapus dari `src/trace.ts`** — cap sekarang hanya satu sumber, yaitu config; `config/default.yaml` dan `user/config.example.yaml` akhirnya meminta pengaturan yang benar-benar berjalan. Bukti: `passes config.trace.maxBytes to the writer, so the cap is the configured one` (`src/runtime.test.ts`), `rotates at the cap it was given, not at a constant of its own` dan `refuses a cap that is not a bounded whole number of bytes` (`src/trace.test.ts`), `never grows a generation past the configured cap, and refuses an unbounded one` (contract), plus `accepts the cap bounds and a cap-only block` dan `lets the user overlay enable tracing and tighten the cap, keeping what it did not touch` (`kernel/src/config.test.ts`).

- **Record plugin sekarang mendarat, dan bentuknya tetap sempit.** Union writer punya **lima** varian, jadi `plugin-load` { `name`, `required` } dan `plugin-load-failed` { `name`, `required` } benar-benar ditulis; `HostRecord` dan cast di `traceSink` yang dulu menyembunyikan gap itu **sudah hilang** (`grep -rn "HostRecord" src/` kosong, `grep -rn "as unknown as" src/` kosong). Yang tidak ikut adalah path manifest, versi, dan teks error, karena `name` harus juga cocok nama plugin kanonik. Bukti: `stores a plugin outcome as a name and a boolean, and nothing else` dan `refuses a plugin record that carries anything but a name and a boolean` (`src/trace.test.ts`), `keeps a plugin lifecycle to a name and a boolean, never a load error or a path` (contract), `records host-known plugin outcomes, including one optional failure` dan `records a required plugin failure as a scalar and still fails closed` (`src/runtime.test.ts`). **Konsekuensi yang harus dibaca apa adanya:** menambah varian ke union writer adalah perubahan schema — bukan detail, dan bukan tambahan sepele.

- **Gate coordinator sudah dijalankan.** Lihat paragraf pembuka bagian ini dan kotak 3.4 `TASKS.md` untuk angka lengkapnya, termasuk catatan jujur soal dua test timing lama yang bukan bagian 3.4.
### Batas yang disepakati, dan mana yang sudah terbukti

| Batas | Status |
| --- | --- |
| Mati secara default; blok config hilang berarti mati | `terpenuhi` — `ConfigSchema.trace` default `enabled: false`, `config/default.yaml` `enabled: false`, dan `openTrace` hanya memanggil writer saat `enabled === true` |
| Lokasi `${HOME}/.config/nexus/user/traces` | `terpenuhi` — default `createTraceWriter`; runtime **tidak** meng-override root, jadi path produksi adalah default writer itu |
| JSONL dengan `schemaVersion` 1 | `terpenuhi` — `TRACE_SCHEMA_VERSION = 1`, `TRACE_FILE = "trace.jsonl"`, satu JSON per baris |
| Record scalar saja, tanpa transcript, output tool, path, secret | `terpenuhi` — union strict writer menolak key tak dikenal, dan `emits no task text, model text, tool output, key, header, or absolute path` memalsukkannya dari file yang benar-benar ditulis |
| Redaction menolak, bukan menyamar | `terpenuhi` — aturan nilai `scalar` plus strict object |
| Ukuran dan rotasi terbatas | `terpenuhi` — cap dari `config.trace.maxBytes` yang sudah sampai ke writer dan ke rotasinya, ditegakkan ulang di `TraceWriterOptions`, plus satu generasi; tidak ada lagi konstanta cap internal |
| Kegagalan tulis tidak mematikan run | `terpenuhi` di writer (`append` boolean, `failures` dihitung) dan di `traceSink` (warn sekali per tipe, tidak pernah melempar) |
| Tidak ada flag CLI | `terpenuhi` — `grep -c trace src/cli.ts` = 0; `parseArgs` tetap hanya `--root`, `--model`, `--session`, `--sandbox`, `--snapshot`, `--mock`, `--help` |
| Tidak ada event plugin baru | `terpenuhi` — `PluginEventMap` tetap `plugin:loaded` dan `plugin:unloaded`; runtime **menyubscribe** `plugin:loaded` yang sudah ada, dan kegagalan load dicatat host, bukan dipublikasikan sebagai event |
| Tidak ada dashboard atau reader | `terpenuhi` — `grep -ril trace scripts/` kosong; satu-satunya kemunculan di `task-dashboard.html` adalah entri task `{"id":"3.4", …}`, bukan panel atau endpoint |
| Session tetap transcript | `terpenuhi` — `src/session.ts` tidak berubah; `SESSION_SCHEMA_VERSION` masih 1, `run-end` masih `status`/`text?`/`error?`/`limits?`, dan tidak ada field trace di schema itu |
| Lifecycle plugin terlacak | `terpenuhi` — `plugin-load` { `name`, `required` } dari event `plugin:loaded` yang sudah ada, dan `plugin-load-failed` { `name`, `required` } dicatat host; tanpa path, versi, atau teks error |
| Config tidak pernah memilih lokasi | `terpenuhi` — `rejects a path, root, or secret lever anywhere in the block` (`kernel/src/config.test.ts`); blok `trace` hanya punya `enabled` dan `maxBytes` |
| Writer tidak lewat `PermissionGate` | disengaja dan sama seperti session store 2.4 — konfinement sendiri, `0700`/`0600`, `O_NOFOLLOW`, `refuseExisting` |

### Kriteria falsifiable 3.4

Nama file dan nama test di bawah sudah diverifikasi ada persis di file-nya pada saat dokumen ini ditulis. Semua butir `terpenuhi`: ada test persis yang memalsukan perilaku itu **dan hijau pada run gate** yang tercatat di kotak 3.4 `TASKS.md`. Tidak ada butir `belum`.

- **Mati secara default dan tidak menyentuh disk.** `src/trace.test.ts`: "writes nothing at all while disabled" dan "defaults to disabled when told nothing" `terpenuhi`. Sisi runtime `src/runtime.test.ts`: "is off by default and for an explicit false: no writer, no file, no record" `terpenuhi`.
- **Lokasi produksi.** `src/trace.test.ts`: "defaults the root to HOME/.config/nexus/user/traces once enabled" dengan `stubbedHome()` `terpenuhi` untuk default writer. Sisi runtime: `openTrace` **tidak** meng-override root, "hands the real log every host record, plugin lifecycle included" (`src/runtime.test.ts`) menjalankan **writer sungguhan** lewat `traceHost` lalu membaca `trace.jsonl` yang benar-benar ditulis, dan "writes only inside its own root: the repo user/data/config and the real home stay identical" (contract) membuktikannya untuk jalur produksi — `terpenuhi` untuk root temp sebagai ganti default.
- **Scalar saja, tanpa transcript/tool output/path/secret.** `src/trace.test.ts`: "refuses every field that is not a scalar the schema names", "refuses a scalar that is a secret or a location, and keeps it off the disk", "strips control characters so a record never spans lines" (`terpenuhi`). `src/trace-security.contract.test.ts`: "refuses a path, text, argument, or secret field, and any value the schema does not name", "keeps a canary API key, an absolute path, and a secret out of the bytes", dan "strips control characters and refuses a scalar that is nothing but them" (`terpenuhi`). Sisi runtime: "emits no task text, model text, tool output, key, header, or absolute path" (`src/runtime.test.ts`) `terpenuhi`. **Tidak ada lagi butir penolakan-record-plugin di sini** — kedua bentuk plugin kini mendarat sebagai `name` + `required` dan sempitnya dibuktikan "stores a plugin outcome as a name and a boolean, and nothing else" (`src/trace.test.ts`) serta "keeps a plugin lifecycle to a name and a boolean, never a load error or a path" (contract).
- **Schema version dan urutan.** `TRACE_SCHEMA_VERSION = 1` ada dan "accepts a record the writer itself produces" mengikat `traceRecordSchema` pada output writer (`terpenuhi`), "round-trips a run with monotonic sequence numbers" dan "gives two writers of one run their own run id and sequence" (`terpenuhi`). Urutan dari `run` nyata diuji "creates one writer per runtime and writes run-start, run-step, then run-end" dan "hands the real log every host record, plugin lifecycle included" (`src/runtime.test.ts`) — keduanya `terpenuhi`, dan keduanya membaca file yang benar-benar ditulis.
- **Ukuran, rotasi, dan tail.** "rotates one generation at the file cap", "rotates at the cap it was given, not at a constant of its own", "refuses a cap that is not a bounded whole number of bytes", dan "trims a torn tail instead of splicing onto it" (`src/trace.test.ts`) `terpenuhi`; "rotates one generation at the cap and never stacks a second copy", "never grows a generation past the configured cap, and refuses an unbounded one", dan "trims a torn tail instead of splicing the next record onto it" (contract) `terpenuhi`. **`config.trace.maxBytes` sebagai cap yang controlling juga `terpenuhi`**: "passes config.trace.maxBytes to the writer, so the cap is the configured one" (`src/runtime.test.ts`) membuktikan cap config benar-benar sampai ke writer, dan "accepts the cap bounds and a cap-only block" (`kernel/src/config.test.ts`) membuktikan batasnya ditegakkan di sisi config.
- **Kegagalan tulis tidak fatal.** `src/trace.test.ts`: "counts every failure instead of throwing into the run" `terpenuhi`. Contract: "counts a write failure, stays nonfatal, and recovers when the path is usable again" `terpenuhi`. `terpenuhi` di sisi runtime: "keeps a refused write out of the run's result and its exit" dan "records a budget stop as a vocabulary scalar and never as prose" (`src/runtime.test.ts`).
- **Privat dan confinement.** `src/trace.test.ts`: "keeps the root 0700 and the file 0600, tightening a loosened root" dan "refuses a dangling symlink, a directory, and a widened file at the trace path" `terpenuhi`. Contract: "keeps the root 0700 and the file 0600, and refuses a widened one", "never appends through a symlinked trace file" dan "follows a symlinked root to one real target rather than two directories", dan "writes only inside its own root: the repo user/data/config and the real home stay identical" `terpenuhi`. Ketiganya adalah bukti privat yang serius, jadi jangan menyebutnya berlapis: konfinement-nya sendiri, **bukan** permission plugin.
- **Nol network.** `src/trace.test.ts`: "runs a whole lifecycle without any network access" `terpenuhi`. Contract: "makes no network call over a whole lifecycle, including a rotation" `terpenuhi`.
- **Append serial dan tidak kehilangan record.** "serializes concurrent appends into whole lines in order" (`src/trace.test.ts`) dan "serializes concurrent appends into whole lines and a single sequence" (contract) `terpenuhi`.
- **Tidak ada surface baru.** Klaim negatif, diverifikasi `grep -c trace src/cli.ts` = 0, `grep -c trace kernel/src/events.ts` = 0, `grep -ril trace scripts/` kosong. **Tidak ada test yang menjaganya**, jadi ketiga klaim itu harus diulang setiap kali dokumen ini disentuh.
- **Ruang lingkup yang sudah diputuskan.** (a) `config.trace.maxBytes` **diteruskan ke writer** dan ditegakkan ulang di `TraceWriterOptions`, jadi field config itu sekarang menjalankan sesuatu; (b) batas "record plugin ditolak" **dibatalkan sebagai keputusan** dan diganti jadi dua varian plugin yang sempit — `name` + `required` — jadi lifecycle plugin **ada** di trace, tanpa path, versi, atau teks error; (c) gate bagian 4 sudah dijalankan dan angkanya dicatat di `TASKS.md`, bukan di dokumen ini.
- **Tiga lapis lain yang sudah tertutup di runtime.** `records host-known plugin outcomes, including one optional failure` dan "records a required plugin failure as a scalar and still fails closed" membuktikan kedua bentuk plugin **mendarat** sebagai fakta host; `records a budget stop as a vocabulary scalar and never as prose" membuktikan `budgetReason` datang dari `BUDGET_STOP_REASONS` dan bukan teks error; `records the usage a gateway reported as three scalars` membuktikan `usage` hanya ikut laporan provider; dan "leaves the session transcript and the sandbox run as they were" membuktikan trace tidak mengubah transcript session maupun jalur sandbox.

### Yang TIDAK ada di 3.4

Tidak ada flag CLI trace, tidak ada event plugin baru, tidak ada capability atau service `trace:*`, tidak ada panel dashboard atau endpoint, tidak ada reader/parser/`trace show`/`trace list`, tidak ada TTL atau garbage collection, tidak ada retensi lebih dari satu generasi rotasi, tidak ada kompresi, sampling, atau export, tidak ada korelasi lintas proses di luar `runId` acak, dan tidak ada field trace di schema session. Trace **bukan** akuntansi biaya: `usage` hanya ikut apa yang provider laporkan, dan `plugins/model-mock` tidak melaporkannya sehingga field itu tidak muncul pada run mock. Trace juga bukan telemetry untuk agent: tidak ada agent yang membacanya, tidak ada compaction yang memakainya, dan tidak ada gate yang bergantung padanya. `4.6` (dashboard biaya/token) dan `7.1`–`7.4` tetap `- [ ]` dan tidak boleh dibaca ikut tercentang.

## Status Task 4.1 — Prompt caching

**Status 2026-09-27: ditutup** (lihat juga "Status Task 4.1b", yang menutup dua butir yang tadinya
tertahan di kernel). Kotak 4.1 tidak punya ✓ kriteria; kriteria ditulis ulang di `TASKS.md` sebagai
spesifikasi, dan tiga di antaranya sudah terpenuhi sebelum task ini dimulai. Kotak `4.1` di `TASKS.md` tidak punya ✓ kriteria, jadi kriteria
ditulis ulang di sana sebagai spesifikasi, dan dua di antaranya masih `belum` karena butuh perubahan
kontrak `kernel/`. Halaman ini menulis bentuk yang sudah ada di source dan batas yang belum ada —
bukan daftar rencana.

### Bentuk yang sudah ada di source

- **Hitungan cache dibaca, bukan dikarang.** `plugins/model-openai/src/index.ts` membaca
  `usage.prompt_tokens_details.cached_tokens` dan mengembalikannya sebagai `cachedTokens` pada
  `OpenAIUsage` (`ModelUsage & { readonly cachedTokens?: number }`). Blok `usage` yang hilang, `null`,
  kosong, `0/0/0`, atau penghitung dengan tipe salah tetap menghasilkan `usage: undefined` atau
  error — tidak pernah nol karangan.
- **Prefix prompt stabil.** `plugins/loop-react/src/index.ts` memakai satu system prompt statis
  (tanpa timestamp, tanpa ID) lalu hanya **menambah** pesan; tidak ada pesan `system` setelah user
  pertama, dan `options.tools.definitions()` dipanggil per giliran dengan urutan yang sama. Inilah
  syarat yang membuat cache sisi gateway mungkin terjadi: prefix yang tidak berubah.

### Yang TIDAK ada di 4.1

- **`prompt_cache_key` sudah dikirim, opt-in** — ditutup 4.1b lewat `plugins["model-openai"].promptCacheKey`.
  Tanpa key, field itu tidak dikirim sama sekali, jadi gateway yang menolak field asing tidak rusak.
- **`cachedTokens` sudah melewati batas loop** — ditutup 4.1b: `ModelUsage` punya slot opsional dan
  `plugins/loop-react` menjumlahkannya per giliran. Nilainya **masih hilang saat proses selesai**,
  karena session v1 tetap tidak menyimpan usage (keputusan 2.4 tidak berubah oleh task ini).
- **Tingkat hit cache di gateway live tidak pernah diukur.** Semua test offline dengan fetcher palsu.
  Tidak ada request live ke 9Router, tidak ada API key, tidak ada tagihan.

### Kriteria falsifiable 4.1

1. `terpenuhi` — "keeps the cacheable prefix byte-identical on every turn of a run"
   (`plugins/loop-react/src/index.test.ts`). Dipalsukan: system prompt yang diacak dengan
   `Date.now()` membuat test ini gagal sendiri dan tidak ada test lain yang ikut gagal.
2. `terpenuhi` — "sends the same tool definitions in the same order on every turn" (file sama).
3. `terpenuhi` — "returns the reported token counters and cache reads on final and tool-call results"
   plus "leaves usage undefined when the gateway omits, nulls, empties, or zeroes it"
   (`plugins/model-openai/src/index.test.ts`).
4. `terpenuhi (4.1b)` — "sends a configured prompt cache key and omits the field without one"
   (`plugins/model-openai/src/index.test.ts`) dan "carries an optional prompt cache key into the model
   plugin config" (`kernel/src/config.test.ts`).
5. `terpenuhi (4.1b)` — "sums the cache reads a provider reports and drops the block when one is not a
   count" (`plugins/loop-react/src/index.test.ts`): 1024 + 64 menjadi 1088, dan hitungan yang bukan
   bilangan bulat membuat seluruh blok `usage` hilang (fail closed), bukan separuh.

## Status Task 4.1b — Prompt caching di kontrak

**Status 2026-09-27: ditutup** setelah `corepack pnpm check` hijau pada working tree yang sama
(`Checked 83 files`, `tsc --noEmit` bersih, 460 test di 32 file + 2 `node --test`), `build` exit 0,
`bench:smoke` `{"ok":true,…}`, `bench:20` 20/20 dengan `taskSetHash 645a15f7…` dan
`reproducibilityHash 8135d0ff…` (identik dengan 2.6/3.3/3.4 karena report provider `mock`-nya sama),
`bench:accept` `accepted` dengan `violations: []`, dan `git diff --check` tanpa output.

### Bentuk yang sudah ada di source

- **`ModelUsage.cachedTokens?: number`** (`kernel/src/model.ts`). Opsional dan aditif: tidak ada field
  yang dihapus, tidak ada yang berubah makna, dan `schemaVersion` session tidak naik karena
  `ModelUsage` bukan bagian record session v1.
- **`plugins["model-openai"].promptCacheKey`** (`kernel/src/config.ts`, `ModelPluginConfigSchema`
  `.strict()`, `z.string().max(256).pipe(safeTextSchema)`). Hanya di level plugin; blok `model:`
  tidak berubah. `plugins/model-openai/src/index.ts` memvalidasinya lagi di trust boundary kedua lalu
  mengirim `prompt_cache_key` **hanya** kalau ada.
- **Penjumlahan per giliran** di `plugins/loop-react/src/index.ts`: `cacheReadCount()` menerima hanya
  bilangan bulat non-negatif, jumlah masuk ke `aggregate()`, dan `cachedTokens` **tidak pernah
  Charge dua kali** karena sudah tercakup `inputTokens`.

### Yang TIDAK ada di 4.1b

- **Tidak ada harga untuk token cache-read.** `ModelPrice` tetap dua field, jadi biaya dihitung dengan
  tarif input penuh: run ber-budget bisa overestimate. Kernel tidak menebak harga.
- **Tidak ada persistence.** `src/session.ts` tetap menyimpan `run-start`/`run-step`/`run-end` tanpa
  usage; hit cache hanya hidup di memori proses.
- **Tidak ada bukti pada gateway live.** Semua test memakai fetcher palsu; `prompt_cache_key` belum
  pernah dikirim ke router sungguhan, jadi perilaku gateway terhadap key itu belum diketahui.
- **Tidak ada event `usage:*`, tidak ada service baru, tidak ada perubahan kernel lain.**

### Kriteria falsifiable 4.1b

1. "carries an optional prompt cache key into the model plugin config" (`kernel/src/config.test.ts`).
2. "sends a configured prompt cache key and omits the field without one" dan "refuses a prompt cache
   key that is empty, padded, control-bearing, or oversized" (`plugins/model-openai/src/index.test.ts`).
3. "refuses a prompt cache key that is empty, padded, control-bearing, or oversized"
   (`kernel/src/config.test.ts`) — dua lapisan validasi, bukan satu.
4. "sums the cache reads a provider reports and drops the block when one is not a count"
   (`plugins/loop-react/src/index.test.ts`) — sisi negatifnya ada di test yang sama: `-1`, `1.5`,
   `NaN`, `"1024"`, dan `null` menghasilkan run `budget:usage-unavailable` tanpa `usage`.

## Permission dan trust

Manifest permissions adalah requested capabilities, bukan grant otomatis. `PermissionGate` menerapkan `allow`, `ask`, atau `deny`, dengan default `fs.read: allow`, `fs.write: deny`, `shell: deny`, dan `network: deny`; `ask` tanpa callback approval ditolak.

Permission gate adalah cooperative. Plugin official diharapkan memanggil `check` sebelum side effect, tetapi plugin tidak dapat dipaksa oleh library untuk tidak menjalankan kode. File root confinement, symlink checks, shell allowlist, dan `shell: false` hanya guardrails tool, bukan sandbox OS.

Plugin tidak membaca `user/` atau `data/` langsung. Exception canonical v1 hanya `model-openai` untuk `apiKeyFile` dengan permission `fs.read`, dan hanya dua scope yang diizinkan: runtime root `${root}/user/secrets/` atau `${root}/user/providers/`, dan trusted home `${HOME}/.config/nexus/user/secrets/` atau `${HOME}/.config/nexus/user/providers/`. Home scope diturunkan dari home direktori proses, bukan dari path user hardcoded. Kernel memberi tahu plugin scope runtime yang sudah divalidasi; plugin memvalidasi ulang secara independen pada file dan pada parent directory-nya, sehingga segment `user` di bawah `/tmp`, symlink file, dan symlink `secrets/` atau `providers/` yang keluar scope semuanya ditolak. Target tetap harus regular file `0600`. Permission itu tidak memberi akses di luar exception; tidak ada exception untuk plugin untrusted atau config user arbitrary.

Exception kedua adalah session store Task 2.4: satu path scope tambahan di trusted home, yaitu `${HOME}/.config/nexus/user/sessions/`, untuk JSONL append-only. Path store diturunkan dari home direktori proses, seperti scope home `model-openai`, dan `data/` di root runtime **bukan** scope store: `data/` ada di volume fuseblk yang sama dengan repo, di-gitignore sebagai scratch, dan bukan trusted home scope. Store adalah modul runtime host di `src/`, bukan plugin, jadi ia tidak tunduk pada aturan "plugin tidak membaca `user/` atau `data/`" — ia tidak pernah membaca `user/secrets/` maupun `user/providers/`, dan konfinement-nya sendiri: root `0700`, file `0600`, `O_NOFOLLOW`, serta perbandingan `realpath` terhadap store root. Perlu dibaca apa adanya: store **tidak** lewat `PermissionGate`, jadi `fs.write: deny` yang default tidak memblokirnya. Detail dan batasnya ada di "Status Task 2.4" di atas.

## Config dan data boundary

`config/default.yaml` adalah default official. Overlay user harus strict: unknown key, malformed type, `null`, unsafe key, URL invalid, dan plugin config yang tidak dikenal menghasilkan error. `tools.root` dan plugin roots di-resolve terhadap runtime root. Config tidak dapat mengganti provider code atau memuat arbitrary plugin.

## Tests dan CI

Acceptance test untuk metadata/API contract harus secret-free: temporary roots, offline/mock provider, fake boundary, dan tanpa live network. Test/CI tidak membaca `user/config.yaml`, `user/providers/`, `user/secrets/`, API key, atau environment secret tracked. Benchmark mock juga tidak boleh bergantung pada user data.

Acceptance run Task 1.1 (sudah hijau):

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm bench:smoke
corepack pnpm bench:20
```

Acceptance run Task 1.1 sudah hijau di urutan itu: lockfile, canonical package `0.1.0`, import `@nexusmycelium/*`, secret-free tests, dan fail-closed discovery terverifikasi. Task 1.1 closed final untuk v1; angka acceptance di `TASKS.md` berasal dari run tersebut.

Slice documentation 1.2/1.3 hanya menyentuh dokumen: tidak ada perubahan kernel/plugin source, tests, package metadata, user config, dashboard, atau benchmark source. Acceptance run penuh untuk 1.2/1.3 sudah dijalankan dan hijau pada 2026-09-26 di repo ini: `corepack pnpm check` (biome 62 file bersih, `tsc --noEmit` bersih, 166 vitest + 2 `node --test` hijau), `corepack pnpm build`, `corepack pnpm bench:smoke` (`"ok": true`), `corepack pnpm bench:20` (20/20 sukses, `taskSetHash 645a15f7…`, `reproducibilityHash 8135d0ff…`), dan `git diff --check` tanpa output. Bukti per butir 1.2 dan 1.3 ada di `TASKS.md`, dan test yang dipakai langsung adalah `kernel/src/registry.test.ts`, `kernel/src/plugin.reload.test.ts`, `kernel/src/events.test.ts`, `src/plugin-lifecycle.contract.test.ts`, `src/runtime.test.ts`, dan `src/plugin-api.contract.test.ts`. `corepack pnpm install --frozen-lockfile` tidak diulang pada slice ini karena `pnpm-lock.yaml` tidak berubah; ulangi bila lockfile atau `package.json` berubah.

Provenance angka benchmark tidak boleh dilepas dari sumbernya: `reproducibilityHash` dan `taskSetHash` berasal dari `benchmarks/README.md`, provider `mock` dengan usage `unavailable` dan cost `mock-not-billed`. Angka itu bukan tagihan, bukan bukti biaya provider live, dan `elapsedMs` adalah observasi satu run, bukan SLA.

Acceptance run Task 2.4 sudah hijau pada 2026-09-26 di working tree yang sama, dengan `corepack pnpm check` (biome `Checked 66 files … No fixes applied`, `tsc --noEmit` bersih, 219 vitest di 22 file + 2 `node --test`), `corepack pnpm build` (exit 0), `corepack pnpm bench:20` (20/20, `successRate 1`, `taskSetHash 645a15f7…`, `reproducibilityHash 8135d0ff…`), dan `git diff --check` tanpa output. `corepack pnpm install --frozen-lockfile` tidak diulang karena `package.json` dan `pnpm-lock.yaml` tidak berubah. Slice finalisasi 2.4 hanya menyentuh `TASKS.md`, `README.md`, dan `docs/`; source, test, package metadata, `user/`, dashboard, dan benchmark source tidak berubah. Test 2.4 yang dipakai sebagai bukti butir ada di `src/session.test.ts`, `src/session-security.contract.test.ts`, `src/session.fixtures.ts`, bagian sesi di `src/cli.test.ts`, dan bagian sesi di `src/runtime.test.ts`; semuanya memakai store root sementara atau `HOME` yang di-stub, provider mock, tanpa live network, dan tanpa menulis ke home asli. Verifikasi CLI memakai `HOME` dan `--root` temporer; store user asli terverifikasi tidak berubah (3 file, 2440 byte, mtime identik sebelum dan sesudah).

Acceptance run Task 2.6 juga sudah hijau pada 2026-09-26 di working tree yang sama, dan Unlike 1.2/1.3/2.4, slice ini **menambah** source dan test: `benchmarks/accept.ts` (acceptance harness), `benchmarks/acceptance.test.ts` (6 test), dan script `bench:accept` di `package.json`. Yang **tidak** berubah adalah `benchmarks/run.ts`, `benchmarks/tasks.ts`, `benchmarks/smoke.ts`, dan seluruh `src/` serta `kernel/` — `accept.ts` hanya menilai report yang sudah ada, jadi `taskSetHash` dan `reproducibilityHash` tidak bergeser.

Urutan yang dijalankan dan hasilkannya:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm typecheck
corepack pnpm build
corepack pnpm bench:smoke
corepack pnpm bench:20
corepack pnpm bench:accept
corepack pnpm vitest run benchmarks/acceptance.test.ts
git diff --check
```

Hasil 2026-09-26: `install --frozen-lockfile` lockfile up to date di 8 workspace project; `corepack pnpm check` exit 0 dengan biome `Checked 68 files … No fixes applied`, `tsc --noEmit` bersih, **225 vitest di 23 file** + 2 `node --test`; `typecheck` exit 0; `build` exit 0; `bench:smoke` `"ok": true`; `bench:20` 20/20 dengan `successRate 1`, `taskSetHash 645a15f7…`, `reproducibilityHash 8135d0ff…`; `bench:accept` exit 0 dengan `status "accepted"` dan `violations []`; `benchmarks/acceptance.test.ts` 6 test hijau; dan `git diff --check` tanpa output. `install --frozen-lockfile` **dijalankan ulang** pada slice ini karena `package.json` berubah, dan lockfile ternyata tidak perlu berubah karena yang ditambahkan hanya script.

Test 2.6 yang dipakai sebagai bukti butir ada di `benchmarks/acceptance.test.ts`; test kontrak benchmark yang menopangnya tetap di `benchmarks/run.test.ts`. Semuanya memakai root sementara, provider mock, tanpa live network, tanpa credential, dan tanpa membaca `user/config.yaml`, `user/providers/`, atau `user/secrets/`. Rinciannya ada di "Status Task 2.6" di atas.

## Benchmark dan dashboard

`corepack pnpm bench:smoke` adalah sanity check melalui `createRuntime`, config, plugin, runner, dan tool file. `corepack pnpm bench:20` adalah command mock 20-task yang melakukan build lalu menjalankan `node dist/benchmarks/run.js` tanpa nested `pnpm`. `corepack pnpm bench:accept` adalah acceptance gate Task 2.6 yang melakukan build lalu menjalankan `node dist/benchmarks/accept.js`; ia memakai task set kanonik yang sama dan hanya menilai report `run.ts`, dengan ambang `MIN_SUCCEEDED = 5`. Ketiganya memakai provider offline, root temporary, dan config eksplisit; usage/cost tidak boleh diklaim sebagai live usage atau tagihan.

`node dist/src/cli.js serve` hanya bind ke `127.0.0.1:18765`. Dashboard dan API/SSE adalah surface lokal, bukan bagian dari plugin trust boundary. Smoke/test dashboard tidak boleh membaca user config atau secret.

Task 2.6 memakai command yang sama dengan 0.4, tanpa mode tambahan: `corepack pnpm bench:20` untuk run 20-task, dan `corepack pnpm vitest run benchmarks/run.test.ts` untuk contract/verifier test-nya. Keduanya deterministik dan offline. Yang diukur di situ adalah plumbing harness/tool/verifier; provider live, token, biaya, dan budget guard ditunda, dan alasannya tercatat di "Status Task 2.6" di atas.

## Peta folder

```text
kernel/        manifest, config, events, registry, permissions
plugins/       official source-workspace plugins
agent-made/    bukan runtime boundary
user/          config dan data milik user
data/          scratch runtime di-gitignore; bukan session store
benchmarks/    mock smoke dan benchmark contract
docs/          arsitektur dan kontrak plugin
```

## Non-goals MVP

Tidak ada sandbox **OS**, permission enforcement terhadap plugin yang tidak patuh, gate/canary/monitor sebelum swap, rollback keputusan sebelum swap, untrusted plugin loading, atau external package publish. Tidak ada klaim autonomous security. Task 3.1 menambahkan process/workspace sandbox runner, dan itu **bukan** sandbox OS: tidak ada container, `git worktree`, namespace, seccomp, cgroup, atau `uid` drop, dan karena agent-nya jalan in-process lewat `createRuntime`, ia juga **bukan** pertahanan terhadap plugin in-process yang berbahaya — lihat "Status Task 3.1". `tools-basic` adalah canonical tool provider; `tools-core` hanya legacy compatibility status. Yang ada di 1.2 adalah swap objek plugin official plus rollback bila swap gagal, tanpa pipeline pengaman; gate, canary, dan hot reload plugin buatan agent ditunda ke Fase 7 (`7.1` gate pipeline, `7.4` hot reload) dan hanya menyangkut plugin official source-workspace. Snapshot/rollback berbasis git sudah ada di 3.2, dan cakupannya hanya isi workspace sandbox temp — bukan rollback keputusan dan bukan rollback repo developer. Persistensi sesi ada di 2.4 sebagai append-only JSONL di trusted home dengan resume dan fork, tetapi tanpa compaction, TTL, garbage collection, index, hapus sesi, integrasi dashboard, atau persistence config dan secret.
