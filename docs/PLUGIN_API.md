# NexusMycelium Plugin API v1

Dokumen ini adalah kontrak normative untuk plugin source-workspace. Task 1.1 sudah closed final untuk v1: acceptance run hijau dan acceptance gate di bawah terverifikasi terhadap implementasi kernel serta test. Perubahan kontrak ke depan memerlukan task baru, migration guide, dan adapter/compatibility test. Task 1.2 dan 1.3 sudah dicentang setelah full gate hijau: bagian "Loader dan event bus: yang tersedia dan yang belum dijanjikan" memisahkan API yang boleh dipakai plugin dari batas yang tetap tidak dijanjikan. Task 2.4 sudah ada implementasinya di working tree dan full gate sudah hijau; bagian "Session store dan batasnya terhadap Plugin API" menyatakan apa yang ditambahkan ke kernel dan apa yang sengaja tidak ditambahkan ke kontrak plugin. Task 2.6 sudah dicentang pada 2026-09-26; bagian "Acceptance 2.6 dan batasnya terhadap Plugin API" menyatakan bahwa acceptance benchmark tidak menambah apa pun ke kontrak plugin, termasuk mengapa token dan biaya tetap tidak bisa dilaporkan.

## Identitas dan batas package

- Runtime: Node.js `^22.12.0 || ^24.0.0 || >=26.0.0` dan pnpm `12.6.0`.
- Root package: `nexusmycelium`; kernel: `@nexusmycelium/kernel`; plugin package: `@nexusmycelium/plugin-<manifest-name>`.
- Manifest `name` adalah nama runtime kanonik. Package tidak menjadi alias runtime dan package loader tidak menerima nama selain nama manifest.
- Semua package workspace saat ini `private: true` dan hanya untuk source workspace. v1 tidak menjanjikan publish ke registry atau kompatibilitas package eksternal.
- Package-level internal identity dan import boundary adalah `@nexusmycelium/*`; source module dapat memakai workspace-relative source entry, tetapi tidak boleh beralih ke scope lama.

| Manifest name | Package | Status v1 |
|---|---|---|
| `model-mock` | `@nexusmycelium/plugin-model-mock` | canonical |
| `model-openai` | `@nexusmycelium/plugin-model-openai` | canonical, opsional |
| `loop-react` | `@nexusmycelium/plugin-loop-react` | canonical |
| `tools-basic` | `@nexusmycelium/plugin-tools-basic` | canonical tool provider |
| `tools-core` | `@nexusmycelium/plugin-tools-core` | legacy compatibility package; jangan menjadi dependency baru |
| `example-hello` | `@nexusmycelium/plugin-example-hello` | contoh official |

Versi canonical workspace saat ini adalah `0.1.0` untuk root, kernel, dan seluruh plugin. `version` manifest adalah versi plugin sendiri, bukan versi API kernel.

## Manifest v1

| Field | Tipe | Aturan |
|---|---|---|
| `name` | string | Wajib; canonical kebab-case (huruf kecil/angka, satu hyphen pemisah, tanpa hyphen awal/akhir), unik, tanpa alias |
| `version` | string | Wajib; `x.y.z` tanpa prefix `v`; workspace canonical `0.1.0` |
| `apiVersion` | number | Wajib; literal `1`, bukan string `"1"` |
| `description` | string | Opsional; default string kosong |
| `provides` | string[] | Kapabilitas yang ditawarkan plugin; default `[]` |
| `requires` | string[] | Nama manifest plugin yang harus tersedia; default `[]` |
| `permissions` | enum[] | `fs.read`, `fs.write`, `shell`, atau `network`; default `[]` |

Manifest adalah record strict dan immutable: hanya field di atas yang boleh ada, key unknown ditolak, default hanya di-materialisasi sekali, dan objek manifest tidak boleh dimutasi setelah plugin didefinisikan atau dimuat. Penolakan manifest terjadi sebelum `setup`; plugin tidak boleh bergantung pada key yang dihapus atau diam-dikan.

`apiVersion` v1 adalah angka tepat `1`. Loader v1 menolak nilai lain, termasuk `"1"`, `2`, dan nilai string. Migrasi otomatis tidak dilakukan: perubahan API memerlukan nomor baru, migration guide, adapter/compatibility period yang eksplisit, dan test migrasi. Kernel tidak menebak atau menjalankan dua kontrak sekaligus. Kompatibilitas backwards tidak boleh diklaim sebelum migration guide ada.

## `provides` dan `requires`

`provides` adalah deklarasi kapabilitas yang ditegakkan di boundary registry, bukan permission OS. Plugin yang menawarkan capability harus terdaftar sebagai owner capability/service yang sesuai; service yang tidak dideklarasikan, owner yang salah, atau capability ganda yang bertentangan harus ditolak. Penolakan tersebut membatalkan setup dan membersihkan service parsial. `provides` tidak memberi akses ke filesystem, network, atau process.

`requires` berisi nama manifest, bukan nama package dan bukan string capability. Registry yang memiliki lifecycle delegation memuat dependency secara rekursif sebelum `setup` plugin, menolak dependency hilang atau cycle, lalu memberikan dependency scope ke `capabilities`/`services`. Plugin tidak mengimpor atau me-load plugin lain secara langsung; komunikasi tambahan memakai event atau capability yang diminta.

Status verifikasi: `requires` delegation, owner-scoped service access, dan `provides` enforcement adalah perilaku registry yang sudah ditegakkan dan punya test hijau, begitu juga strict unknown-key rejection dan `deepFreeze` manifest.

## Context, lifecycle, dan error

`setup({ events, log, config, services, capabilities, permissions })` boleh synchronous atau async. Ia dapat mengembalikan `undefined` atau satu `Disposer`, yaitu fungsi sync/async yang membersihkan handler, timer, koneksi, dan resource plugin.

- `definePlugin` memvalidasi manifest sebelum plugin dapat didaftarkan.
- `Registry.load` memuat dependency, memanggil `setup`, lalu menandai plugin loaded dan mengirim event lifecycle.
- Setup yang melempar error membatalkan load, membersihkan service milik plugin, dan tidak menulis status loaded.
- `unload` menolak plugin yang masih dibutuhkan plugin lain. Setelah disposal, service owner plugin dihapus bahkan ketika disposer melaporkan error; error disposal dikembalikan ke caller.
- `Registry.loadAll(names, { strict })` adalah bulk load yang mengisolasi kegagalan per nama: urutan dependency-first, pre-check graph (unknown, cycle, dependency hilang) yang tidak menjalankan setup, laporan `loaded` + `failures` per nama, kegagalan memblokir hanya dependent-nya, dan `strict: true` mengubah laporan menjadi `AggregateError` untuk caller fail-closed.
- `Registry.reload(name, replacement)` adalah swap objek untuk plugin official: dependent closure di-unload dalam reverse load order dan dimuat ulang dalam urutan dependensi, dan swap yang gagal mengembalikan objek sebelumnya beserta service hidup sebelum menolak. `loadPlugin`/`discoverPlugins` menerima `{ cacheKey }` untuk mengevaluasi ulang entry yang sama, jadi caller yang ingin generasi baru memperoleh objek baru lebih dulu lalu menyerahkannya ke `reload()`.
- `Registry.close` terminal dan idempotent: menunggu operasi in-flight, menutup plugin dalam reverse load order, menggabungkan error shutdown, lalu menolak `load`/`loadAll`/`reload` berikutnya. `runtime.close()` juga idempotent.
- Handler event yang gagal diisolasi dan dilaporkan ke logger; Kegagalan satu handler tidak membatalkan handler lain.

Setiap service memiliki owner plugin. `services` dan `capabilities` adalah scoped view yang sama: plugin dapat melihat service milik dirinya dan dependency transitifnya, bukan service plugin yang tidak direlasikan. `capabilities` adalah read-only view; registrasi hanya melalui `services.register`. Owner yang diberikan eksplisit harus sama dengan nama plugin; unload selalu melepas seluruh service milik owner.

## Event lifecycle bertipe

Public lifecycle event map v1 diekspor sebagai `PluginEventMap`:

```ts
type PluginEventMap = {
  "plugin:loaded": { name: string };
  "plugin:unloaded": { name: string };
};
```

`plugin:loaded` dikirim setelah setup dan service registration berhasil. `plugin:unloaded` dikirim setelah disposer dan service owner selesai; event tersebut tidak mengubah error disposal menjadi sukses. `EventBus<Events>` harus diketik dengan map event yang disepakati, `on` mengembalikan unsubscribe, dan event lifecycle tidak boleh diganti dengan string event yang tidak terdaftar.

Urutan dan batas yang terverifikasi: `plugin:loaded` dikirim setelah setup, registrasi service, dan penandaan loaded; `plugin:unloaded` dikirim setelah disposer dan penghapusan seluruh service owner. Untuk rantai `a → b → c`, urutan emit load adalah `a`, `b`, `c` dan urutan unload adalah `c`, `b`, `a`. `load()`/`unload()` resolve setelah listener selesai, dan error disposer tidak diubah menjadi sukses oleh event. Handler boleh memuat atau membuang plugin yang sama dari dalam listener karena state lifecycle sudah settle sebelum emit; itu berasal dari urutan settle, bukan dari depth limit.

## Permission, trust, dan path

Manifest `permissions` hanya menyatakan permintaan. `permissions.check(permission, action)` menerapkan policy `allow`, `ask`, atau `deny`; permission yang tidak diminta otomatis menjadi `deny`. Default runtime adalah `fs.read: allow`, `fs.write: deny`, `shell: deny`, dan `network: deny`. `ask` membutuhkan callback approval; tanpa callback, request ditolak.

Permission gate bersifat cooperative. Plugin official memang harus memanggil gate sebelum side effect, tetapi plugin tidak dapat dipaksa oleh gate untuk tidak menjalankan kode. Official plugin berjalan di proses Node yang sama; allowlist path bukan sandbox. Karena itu plugin untrusted, plugin `agent-made/`, dan reload object-level tidak boleh diasumsikan aman atau didukung.

Task 3.1 menambah process/workspace sandbox runner (`run --sandbox`) untuk task, tetapi **itu tidak mengubah sifat cooperative di atas**. Sandbox membuat akar sementara, tools root terkurung, `network`/`shell` deny, dan child proses dibersihkan; ia **bukan** sandbox OS (tanpa container, `git worktree`, namespace, seccomp, cgroup, atau `uid` drop) dan **bukan** pertahanan terhadap plugin in-process yang berbahaya, karena agent-nya tetap berjalan di proses Node yang sama. Rinciannya di `docs/ARCHITECTURE.md` ("Status Task 3.1").

Root confinement tool, symlink checks, shell executable allowlist, dan `shell: false` adalah guardrails tool, bukan OS isolation.

Aturan umum adalah plugin tidak membaca `user/` atau `data/` langsung. Satu exception canonical v1 adalah `model-openai` untuk `apiKeyFile`: plugin harus mendeklarasikan `fs.read` dan hanya ada dua scope yang diizinkan, yaitu runtime root `${root}/user/secrets/` atau `${root}/user/providers/`, dan trusted home `${HOME}/.config/nexus/user/secrets/` atau `${HOME}/.config/nexus/user/providers/`. Path harus canonical: relative path, segment `..`, dan backslash ditolak sebelum resolution. Kernel mengirim scope runtime ke plugin sebagai `runtimeUserRoot`; key itu di-inject kernel, bukan key config user, dan user config tidak dapat menetapkannya. Plugin memvalidasi ulang scope tersebut secara independen, jadi path dengan segment `user` di bawah `/tmp` atau scope lain yang tidak di-grant ditolak meski secara struktur terlihat benar. Target harus regular file mode `0600`, dan canonical check wajib dijalankan pada file dan pada parent directory-nya, sehingga symlink pada file maupun pada `secrets/` atau `providers/` yang mengarah keluar scope ditolak. Permission `fs.read` tidak memberi akses di luar exception tersebut. Tidak ada exception untuk config user arbitrary, model catalog arbitrary, atau plugin untrusted.

Exception scope kedua adalah session store Task 2.4, dan itu **sudah diimplementasikan**: trusted home `${HOME}/.config/nexus/user/sessions/` untuk JSONL append-only. Scope itu tidak memberi akses ke `user/secrets/` maupun `user/providers/`, dan `data/` di root runtime bukan scope store. Perlu dibaca apa adanya: store ini **tidak** memakai `PermissionGate`. Ia punya konfinement sendiri — root `0700`, file `0600`, `O_NOFOLLOW`, dan perbandingan `realpath` terhadap store root — sehingga `fs.write: deny` yang default juga tidak memblokirnya. Store hanya aktif kalau caller memintanya eksplisit lewat `--session` atau `session resume`; `run` tanpa `--session` tidak menyentuh store sama sekali. Memindahkan writer ke dalam permission gate adalah perubahan keamanan dan butuh task tersendiri.

## Session store dan batasnya terhadap Plugin API (Task 2.4)

Task 2.4 sudah dicentang di `TASKS.md` setelah full gate hijau. Yang penting bagi plugin authoring: store ini **tidak** menambah apa pun ke kontrak plugin.

- Store adalah modul runtime host di `src/session.ts`, bukan plugin. Tidak ada capability, service, atau event baru: `CoreServiceMap` tidak berubah, dan `grep -rn "session" kernel/src/services.ts kernel/src/events.ts` kosong. `apiVersion` tetap `1` dan tidak ada migration guide, karena tidak ada field yang dihapus atau berubah tipe.
- Plugin tidak membaca, menulis, me-fork, atau me-resume file sesi. Tidak ada service `session:*` yang bisa dipanggil, dan bentuk file JSONL tidak diekspos ke plugin space. Kalau suatu task nanti butuh itu, itu task API baru.
- **Kernel berubah secara additive untuk task ini.** `kernel/src/agent.ts` menambah tipe `AgentStepRecord` (`{ step, messages }`) dan dua field optional pada `AgentRunOptions`: `history` untuk memutar transcript run sebelumnya, dan `onStep` yang dipanggil setelah setiap step selesai. Plugin yang menulis `AgentRunner` sendiri tidak wajib memakainya, dan runner existing yang tidak memakai keduanya tetap valid.
- Yang dipersistensi hanya bentuk record yang strict: `run-start` (`provider`, `model`, `task`, `parent` opsional), `run-step` (`step`, `messages`), dan `run-end` (`status`, `text`, `error`, `limits`). `config`, `apiKeyFile`, `headers`, `path`, dan `HOME` bukan field yang dikenal, jadi `safeParse` menolaknya sebelum data sampai disk. Tidak ada config ter-resolve, `baseUrl`, API key, isi `user/secrets/`, atau nilai `process.env` yang dipersistensi.
- Store punya konfinement sendiri dan **tidak** lewat `PermissionGate`: root `0700`, file `0600`, `O_NOFOLLOW`, serta perbandingan `realpath` terhadap store root di `${HOME}/.config/nexus/user/sessions/`. Plugin tidak mendapat akses ke path itu dari gate, dan `fs.write: deny` yang default juga tidak memblokir store — store bukan plugin.

Rincian lengkap ada di `docs/ARCHITECTURE.md` ("Status Task 2.4").

## Acceptance 2.6 dan batasnya terhadap Plugin API (Task 2.6)

Task 2.6 adalah "jalankan benchmark" dengan ambang ≥ 5 dari 20 tugas selesai end-to-end, dan **sudah dicentang** di `TASKS.md` pada 2026-09-26 setelah full gate hijau. Yang penting bagi plugin authoring: 2.6 **tidak menambah apa pun** ke kontrak plugin.

- Tidak ada capability, service, atau event baru. `CoreServiceMap` dan `PluginEventMap` tidak berubah, `apiVersion` tetap `1`, dan tidak ada migration guide karena tidak ada field yang dihapus atau berubah tipe. Tidak ada file di `kernel/src` atau `src/` yang berubah untuk 2.6.
- Yang ditambahkan hanya lapisan penilaian di luar kernel: `benchmarks/accept.ts` memanggil `runBenchmark({ provider: "mock" })` lalu menilai report yang sudah ada, dengan ambang `MIN_SUCCEEDED = 5` dan `CANONICAL_TASKS = 20`. `run.ts`, `BenchmarkReport`, `taskSetHash`, dan `reproducibilityHash` tetap satu-satunya sumber kebenaran, dan `apiVersion`, manifest, capability, dan permission plugin tidak tersentuh.
- **Usage provider kini opsional di kontrak, dan harga tetap di luar kontrak.** Koreksi untuk versi dokumen sebelumnya: `ModelResult` di `kernel/src/model.ts` **sudah** punya `usage?: ModelUsage` pada kedua variannya, jadi kalimat "tidak ada field token" tidak lagi benar. Yang benar: `usage` bersifat **opsional dan additive** — provider yang tidak melaporkannya tetap valid secara tipe, dan `AgentResult.usage` pada run seperti itu **tidak ada** (bukan `0`). `ModelUsage` adalah { `inputTokens`, `outputTokens`, `totalTokens`, `source` } dengan `source` bebas bentuknya. **Harga tidak pernah ada di kontrak provider**: `ModelPrice` { `inputUsdPerMillionTokens`, `outputUsdPerMillionTokens` } harus disuplai caller, dan kernel tidak pernah menebaknya. Konsekuensi yang harus dibaca apa adanya oleh plugin author: laporan benchmark dan acceptance tetap memakai `usage.status` `unavailable` dengan `method: "provider-does-not-report"` dan token `null`, serta `cost.amount` `0` dengan `source: "mock-not-billed"` — angka nol itu placeholder, bukan hasil pengukuran, dan `elapsedMs` yang kecil adalah konsekuensi provider offline, bukan kecepatan model. Suite live 9Router dan akuntansi token/biaya nyata tetap ditunda; **budget guard sendiri sudah ditutup sebagai Task 3.3**, dan yang tetap ditunda adalah akuntansi nyatanya, bukan enforcement-nya. Perubahan yang sudah masuk bersifat additive sehingga tidak memerlukan migration guide, tetapi **menambah field non-opsional, mengubah `apiVersion`, atau menambah event `usage:*` di `PluginEventMap` adalah perubahan API** dan butuh migration guide beserta adapter/compatibility test. Lihat "Budget guard dan batasnya terhadap Plugin API (Task 3.3)" di bawah.
- **Acceptance hijau bukan sinyal kualitas model.** `plugins/model-mock` mem-parsing prompt dengan satu regex `write|create … with content …` lalu mengeluarkan `write_text` dengan konten yang sudah tertulis di prompt. Jadi 20/20 mock membuktikan plumbing harness/tool/verifier, bukan kemampuan coding. Plugin author tidak boleh menyimpulkan `loop-react` atau tool plugin-nya "cukup pintar" dari angka itu; yang terbukti hanyalah tool, permission, verifikasi, dan gate exit code berjalan.
- **Gate menutup jalan provider live.** `accept.ts` selalu meminta provider `mock`, `run.ts` menolak `provider` selain `mock` di `selectTasks`, violation `provider-not-mock` menolak report yang memakai provider atau model selain `mock`, dan config benchmark memaksa `network: deny` serta `shell: deny`. Tidak ada API key atau credential yang dibaca. `model-openai` tetap plugin opsional yang melewati permission `network` seperti biasa, dan tidak pernah dipakai benchmark.
- **Tidak ada mode report-only di acceptance 2.6.** Penolakan selalu exit 1 dan tidak ada opsi yang mengubahnya menjadi lulus, jadi `bench:accept` tidak bisa dipakai untuk melewati gate seperti `main({ reportOnly: true })` pada `run.ts`. Kegagalan harness juga dilaporkan sebagai report `rejected` dengan `harness-error`, tidak pernah sebagai lulus.

Rincian lengkap ada di `docs/ARCHITECTURE.md` ("Status Task 2.6") dan `benchmarks/README.md` ("Status Task 2.6").

## Discovery official yang fail-closed

Discovery hanya menerima root official `plugins/`, membandingkan real path, dan menolak URL non-`file:` atau path di luar root. Package JSON, root export, default export, manifest, dan `setup` yang malformed semuanya menggagalkan discovery; tidak ada fallback ke module arbitrary, import network, atau plugin user. Directory kosong yang tidak memiliki package/export tetap tidak menjadi kandidat yang dimuat.

`user/config.yaml` hanya overlay data dengan schema plugin official yang dikenal; file tersebut tidak dapat memuat kode atau plugin. Nama package, nama manifest, dan version harus tetap canonical; acceptance Task 1.1 sudah tertutup dengan syarat itu terpenuhi.

## Loader dan event bus: yang tersedia dan yang belum dijanjikan (Task 1.2/1.3)

Task 1.2 dan 1.3 sudah dicentang di `TASKS.md` setelah full gate hijau. API pada daftar pertama boleh dipakai integrator; pada daftar kedua tidak ada yang boleh diasumsikan sebagai API.

Tersedia pada 1.2:

- `Registry.loadAll(names, { strict })` melakukan bulk load dalam urutan dependensi dengan isolasi kegagalan per nama. Pre-check graph menolak nama unknown, cycle, dan dependency hilang tanpa menjalankan setup apa pun; sibling independen tetap dimuat; hasilnya `{ loaded, failures }` per nama, dan `strict: true` mengubahnya menjadi `AggregateError`.
- `Registry.reload(name, replacement)` menukar objek plugin official beserta dependent closure-nya, dan mengembalikan objek serta service sebelumnya bila swap ditolak. Ini swap in-process: bukan file watcher, bukan loader `agent-made/`, dan bukan sandbox.
- `loadPlugin(specifier, { cacheKey })` dan `discoverPlugins(directory, { cacheKey })` memberi cache-bust yang tervalidasi, sehingga caller bisa memperoleh objek generasi baru sebelum menyerahkannya ke `reload()`.
- `Registry.close()` terminal dan idempotent: `load`, `loadAll`, dan `reload` setelah close menolak dengan `plugin registry is closed`, `unload` setelah close no-op, dan `close()` konkuren berbagi satu promise.

Tidak tersedia pada 1.2:

- Tidak ada file watcher, tidak ada pemuatan ulang berbasis perubahan disk, tidak ada loader `agent-made/`, dan tidak ada canary. `agent-made/staging/` serta `agent-made/active/` bukan kandidat runtime. Gate, canary, dan hot reload plugin buatan agent ditunda ke Task 7.1 dan 7.4.
- Tidak ada gate, smoke sandbox, atau monitor yang memutuskan swap sebelum `reload()` berjalan, dan tidak ada rollback keputusan sebelum swap terjadi. `reload()` swap atas nama caller. Primitive `run --sandbox` dari 3.1 memang bisa dipakai sebagai satu smoke run, tetapi tidak ada pipeline yang memanggilnya sebagai gate, dan hasil satu run tidak pernah menjadi keputusan swap. Snapshot/restore git **3.2** sudah tertutup (full gate 2026-09-27) dan **tidak menambah gate apa pun**: ia hanya memulihkan isi workspace sandbox temp sebelum/sesudah satu run. Scope 3.2 hanya workspace sandbox temp — `canonicalRoot()` menolak root yang bukan absolut atau bukan direktori, root yang tidak ada **di dalam** OS temp (termasuk temp dir itu sendiri, `..`, `/`, `$HOME`, dan repo developer), dan root yang git-nya menempatkan git dir milik orang lain (`rev-parse --absolute-git-dir` dibandingkan dengan `realpath(<root>/.git)`, tanpa marker file) — sehingga **tidak ada `reset --hard`/`clean -fd` atas repo developer dan tidak ada `git worktree`**. `worktree`, canary, monitor, dan keputusan swap tetap **7.1**. Satu-satunya rollback yang benar-benar ada di source adalah rollback **objek** di `reload()` pada 1.2 — 3.2 memulihkan isi workspace terisolasi, bukan plugin.
- `Registry.close()` tidak dapat dibatalkan dan tidak dapat dibuka kembali; registry yang sudah closed tidak dapat dipakai untuk memuat plugin lagi.

Catalog event v1 beserta schema-nya sudah diekspor dari kernel:

```ts
import { EventBus, MAX_EMIT_DEPTH, PLUGIN_EVENT_NAMES, PLUGIN_EVENT_SCHEMAS } from "@nexusmycelium/kernel";

PLUGIN_EVENT_NAMES; // ["plugin:loaded", "plugin:unloaded"]
MAX_EMIT_DEPTH; // 16
```

`PLUGIN_EVENT_SCHEMAS` `satisfies` `EventCatalog<PluginEventMap>`, jadi nama, key schema, dan map tipe tidak bisa melenceng; test membandingkan ketiganya. `EventBus<PluginEventMap>` memakai katalog plugin sebagai default, dan bus untuk map event lain wajib mengoper catalog sendiri. Tanpa catalog, setiap nama yang di-`emit` atau di-`on` dianggap `unknown event`, gagal closed, dan tidak dispatch.

Aturan yang berlaku untuk plugin:

- `emit` memvalidasi payload dengan `safeParse` sebelum dispatch. Schema lifecycle adalah `z.strictObject({ name: z.string().min(1) })`, jadi key unknown, string kosong, dan non-object ditolak. Payload invalid hanya dilaporkan ke `onError` dan tidak pernah sampai ke handler.
- Nama di luar katalog gagal closed di kedua arah. `on` tidak mendaftarkan handler dan mengembalikan unsubscribe no-op; `emit` melaporkan `unknown event: <name>` tanpa dispatch.
- Kegagalan satu handler dilaporkan ke `onError(event, error)` tanpa membatalkan handler lain, dan `emit` tetap menunggu seluruh handler. `onError` yang melempar ditelan, sehingga `emit` tidak pernah reject karena reporting.
- `MAX_EMIT_DEPTH` adalah 16. Emit di dalam handler menaikkan kedalaman, dan emit yang melewati batas gagal closed dengan `emit depth limit 16 exceeded` tanpa dispatch. Penghitung diturunkan setelah emit selesai, sehingga emit berikutnya tetap jalan. Ini ceiling kedalaman tetap, bukan detektor cycle.
- Dispatch memakai snapshot handler: handler yang di-unsubscribe atau ditambahkan saat dispatch berjalan hanya memengaruhi emit berikutnya.
- Tidak ada wildcard listener dan tidak ada pola; setiap `on` spesifik pada satu nama event dari katalog.
- Tidak ada timeout. `emit` tidak memasang timeout per handler maupun per event, sehingga handler yang tidak pernah resolve membuat `load`/`unload`/`close` menggantung. Batas yang ada hanya kedalaman, bukan durasi.

## Budget guard dan batasnya terhadap Plugin API (Task 3.3)

Task 3.3 **sudah dicentang** di `TASKS.md` pada 2026-09-27 setelah full gate hijau. Bagian ini menulis apa yang masuk ke kontrak plugin dan apa yang tetap **tidak** menutup, supaya plugin author tidak salah membaca policy yang aktif. Rinciannya di `docs/ARCHITECTURE.md` ("Status Task 3.3").

### Yang masuk ke kontrak, dan sifatnya

- `ModelResult` di `kernel/src/model.ts` punya `usage?: ModelUsage` opsional pada **kedua** variannya, dengan `ModelUsage` { `inputTokens`, `outputTokens`, `totalTokens`, `source` }. Ini **addition**: plugin provider yang sudah ada tidak harus berubah, `apiVersion` tetap `1`, dan tidak ada field yang dihapus atau berubah tipe — jadi tidak ada migration guide untuk bagian ini.
- `AgentResult` di `kernel/src/agent.ts` punya `usage?: ModelUsage` — penjumlahan turn run, dan **hanya ada** bila policy aktif dan ada provider yang melapor. Tidak ada `0` default: run dengan guard mati tidak mendapat key `usage` sama sekali.
- `AgentRunOptions` punya `budget?: BudgetPolicy`; `BudgetPolicy` { `enabled`, `maxTotalTokens`, `maxCostUsd`, `maxElapsedMs`, `prices` }; `DEFAULT_BUDGET_POLICY` beku dengan `enabled: false` dan ketiga limit `null`; `resolveBudgetPolicy()` mengekspos artinya `null` (tanpa plafon) dan menolak cap atau harga yang tidak masuk akal.
- **Harga tidak ada di kontrak provider, dan bentuknya di config adalah peta per model.** `ModelPrice` { `inputUsdPerMillionTokens`, `outputUsdPerMillionTokens` } harus disuplai caller, kernel tidak pernah menebaknya, dan `prices` kosong berarti biaya tidak bisa dibatasi. Di config, `budget.prices` memakai **nama field yang sama persis** dan dikunci nama model: `budget.prices.<model>.inputUsdPerMillionTokens` / `.outputUsdPerMillionTokens`. `configBudget()` meneruskan seluruh peta itu apa adanya, jadi satu config dapat mencakup lebih dari satu model — tetapi hanya model yang dipanggil run itu yang bisa dihargai, dan cap biaya pada model yang tidak ada di peta menghentikan run `budget:cost-unpriced`, bukan memperlakukannya gratis.
- **Tidak ada capability, service, atau event baru.** `PluginEventMap` tetap tepat `plugin:loaded` dan `plugin:unloaded`; tidak ada `usage:*`. Usage mengalir lewat return value dan stdout, bukan lewat bus.
- **Config adalah satu-satunya aktivasi.** Blok `budget` strict di `kernel/src/config.ts`, dan `configBudget()` di `src/runtime.ts` meneruskan peta harga ke policy. `runtime.budget` adalah `BudgetPolicy | undefined`, dan `undefined` kecuali `config.budget.enabled === true`. Budget diambil dari runtime, bukan dari caller, transcript, atau overlay plugin. `AgentRunnerFactory` kini menerima `(model, modelName)` — nama itu adalah identitas yang dikunci peta harga, jadi plugin loop tidak lagi bisa diberi model yang tidak bernama.

### Stop reason: satu kosakata milik kernel

Kernel menerbitkan kelima konstanta itu sendiri — `BUDGET_TIME`, `BUDGET_TOKENS`, `BUDGET_COST`, `BUDGET_USAGE_UNAVAILABLE`, `BUDGET_COST_UNPRICED`, yaitu `"budget:time"`, `"budget:tokens"`, `"budget:cost"`, `"budget:usage-unavailable"`, `"budget:cost-unpriced"` — merangkainya di `BUDGET_STOP_REASONS` dengan tipe `BudgetStopReason`, plus satu teks `BUDGET_STOP_TEXT = "Agent stopped: budget reached."`. Runner di `plugins/loop-react` **me-re-export** konstanta itu (`BUDGET_STOP_TEXT` sebagai `BUDGET_TEXT`) dan menguji keanggotaannya lewat `new Set(BUDGET_STOP_REASONS)`, jadi yang di-emit tidak bisa melenceng dari yang diterbitkan. **Koreksi untuk versi dokumen sebelumnya:** versi ini pernah menulis dua kosakata yang berbeda — kernel `max-total-tokens`/`max-cost-usd`/`max-elapsed-ms` melawan loop `budget:*` — dan pencocokan `AgentResult.error` tidak akan pernah kena. Itu sudah tidak berlaku; "reports the kernel's stop reason vocabulary as the one the loop actually emits" di `src/budget-security.contract.test.ts` memalsukannya dari titik konsumsi.

### Batas yang tetap berlaku, dan tidak boleh ditulis sebagai kemampuan

- **`AgentResult` tidak punya field `stopReason`.** Alasan stop dibawa di `error` dan `text`, konsisten dengan empat alasan lama (`step limit reached`, `tool call limit reached`, `agent timeout`, `agent cancelled`). Mengurai `error` dengan pencocokan string tidak boleh dihitung sebagai API stabil.
- **Stop reason tidak pernah meng-interpolate apa pun.** Tidak ada jumlah, harga, nama model, path, atau teks provider yang masuk ke reason atau `text`; dibuktikan "interpolates no secret, price, or transcript into a stop reason or its text" dan "returns one constant reason per arm, whatever the overrun and whatever the transcript held".
- **Usage tidak dipersistensi di schema session v1.** `src/session.ts` tidak memuat `usage`; `runEndSchema` tetap `.strict()` dengan `status`, `text?`, `error?`, `limits?`. Budget adalah input run, bukan record — dibuktikan "forwards the configured budget on a new run and on a resume, and never stores it" (`src/runtime.test.ts`) dan "reports usage on stdout only, never in the persisted run end" (`src/cli.test.ts`). Plugin tidak boleh mengandalkan `run-end` untuk membedakan stop budget dari stop langkah, dan tidak boleh mengharapkan usage bisa dibaca kembali dari store.
- **Tidak ada flag CLI budget.** `parseArgs` hanya menerima `--root`, `--model`, `--session`, `--sandbox`, `--snapshot`, `--mock`, `--help`; help text tidak menyebut budget.
- **Ketelitianan dan harga.** `source` pada usage yang sampai ke loop disaring dari karakter kontrol dan dipotong 64 karakter; `source` bisa menjadi `"multiple"` bila dua turn melaporkan sumber berbeda.
- **Resume hanya boleh mengencangkan batas, dan itu menutup seluruh `AgentLimits`.** `tightestLimits()` mengambil `Math.min` per field antara yang direkam dan yang diminta, jadi tidak ada field yang bisa dinaikkan oleh resume maupun caller. Dipalsukan "does not let a resume weaken the limits its last run recorded".

### Aturan untuk task berikutnya

Menambah field non-opsional ke `ModelResult` atau `AgentResult`, mengubah `apiVersion`, menambah `usage:*` ke `PluginEventMap`, menjadikan usage bagian dari record session, mengganti salah satu dari lima konstanta alasan stop, atau mengubah `AgentRunnerFactory` kembali ke satu argumen adalah perubahan kontrak. Semuanya butuh migration guide, adapter/compatibility test, dan penulisan ulang batas di dokumen ini — bukan tambahan kecil.

## Trace log dan batasnya terhadap Plugin API (Task 3.4)

Task 3.4 sudah dicentang di `TASKS.md`: ditutup 2026-09-27 setelah full gate bagian 4 hijau pada working tree yang sama, dengan `config.trace.maxBytes` yang sudah sampai ke writer dan ke rotasinya. Bagian ini menulis **batas yang sudah disepakati plus apa yang sudah ada di source**, bukan sebagai kemampuan. Rinciannya di `docs/ARCHITECTURE.md` ("Status Task 3.4").

### Yang masuk ke kontrak, dan sifatnya

- **Tidak ada apa pun di kontrak plugin.** `PluginEventMap` tetap tepat `plugin:loaded` dan `plugin:unloaded`; `PLUGIN_EVENT_NAMES` dan `PLUGIN_EVENT_SCHEMAS` tidak berubah, dan tidak ada capability atau service `trace:*`. Trace bukan surface plugin, jadi `apiVersion` tetap `1` dan tidak ada migration guide.
- **Host yang menyubscribe, plugin yang tidak.** `src/runtime.ts` mendaftarkan `registry.events.on("plugin:loaded", …)` — event yang **sudah ada** — dan mencatatnya sebagai `plugin-load` { `name`, `required` }. Kegagalan load dicatat host sebagai `plugin-load-failed` { `name`, `required` }, karena nama plugin yang gagal tidak ada di payload penolakan. Jadi dua dari lima nama tipe record trace adalah **fakta host tentang** lifecycle plugin, bukan event baru. Plugin tidak melihat, tidak berlangganan, dan tidak bisa mengaktifkan trace; `EventBus` fail closed tetap berlaku untuk nama di luar katalog. **Perlu dibaca apa adanya:** kedua record itu **mendarat** di union writer lima varian, jadi lifecycle plugin **ada** di trace — tetapi hanya sebagai `name` dan `required`. `name` bukan scalar bebas: ia harus juga cocok nama plugin kanonik `^[a-z0-9]+(?:-[a-z0-9]+)*$` (aturan yang sama dengan `kernel/src/manifest.ts`), sehingga load error, directory, dan credential yang diselundupkan ke `name` ditolak. **Tidak ada** path manifest, versi, atau teks error di record plugin, dan menambah field seperti itu berarti menambah varian pada union writer — perubahan schema, bukan detail.
- **Writer adalah modul runtime host di `src/`, bukan plugin.** Sama seperti session store 2.4, ia punya konfinement sendiri (`0700` root, `0600` file, `O_NOFOLLOW`, `refuseExisting` yang menolak symlink/directory/uid lain/mode longgar) dan **tidak** lewat `PermissionGate`, sehingga `fs.write: deny` yang default juga tidak memblokirnya. Memindahkan writer ke dalam permission gate adalah perubahan keamanan dan butuh task tersendiri, bukan detail kecil.
- **Tidak ada flag CLI.** `parseArgs` tetap hanya menerima `--root`, `--model`, `--session`, `--sandbox`, `--snapshot`, `--mock`, `--help`; `grep -c trace src/cli.ts` = 0. Aktivasi hanya lewat blok config strict `trace` yang default-nya `enabled: false`, dan `openTrace` mengembalikan `undefined` tanpa memanggil writer sama sekali saat blok itu mati.
- **Config tidak pernah memilih lokasi, dan cap-nya milik config.** Blok `trace` cuma `enabled` dan `maxBytes`; `path`, `dir`, `root`, `file`, dan `apiKeyFile` ditolak strict object. Plugin tidak bisa meminta logging destination lewat config maupun lewat manifest, dan `openTrace` juga tidak meng-override root writer. `maxBytes` **tidak** memberi plugin apa pun: itu cap rotasi yang diteruskan host ke writer, bukan surface plugin.
- **Kernel berubah additive.** `kernel/src/config.ts` hanya menambah blok `trace` pada `ConfigSchema` dan `ConfigOverlaySchema`; `kernel/src/agent.ts`, `kernel/src/events.ts`, dan `kernel/src/services.ts` tidak berubah. Runner existing yang tidak tahu apa-apa tentang trace tetap valid — `tracedRunner` membungkus runner yang sama dan option yang sama diteruskan apa adanya.

### Batas yang tetap berlaku, dan tidak boleh ditulis sebagai kemampuan

- **Tidak ada transcript, output tool, path, atau secret di trace.** Record trace adalah scalar `string`/`number`/`boolean` dalam union strict; `task`, `text`, `observations`, `arguments`, `config`, `env`, dan `headers` ditolak sebagai key tak dikenal. `run-step` hanya membawa `steps` — **count**-nya, bukan transkripnya. Scalar yang isinya secret atau berbentuk lokasi ditolak **membuat record ditolak**, bukan disimpan tersamar, dan karakter kontrol dibuang supaya satu record tidak pernah melintasi baris.
- **Tidak ada persistence usage di session.** `src/session.ts` tidak berubah: `SESSION_SCHEMA_VERSION` masih 1 dan `run-end` masih `status`/`text?`/`error?`/`limits?`. Trace `run-end` membawa `usage` **hanya** dari `AgentResult.usage`, jadi nilainya tidak bisa dibangun ulang dari session dan tidak boleh dianggap akuntansi biaya. Plugin yang mau tahu alasan stop budget harus tetap membaca `AgentResult.error` dan memeriksa keanggotaannya di `BUDGET_STOP_REASONS` — `budgetReason` di trace tidak boleh jadi API.
- **Tidak ada surface baca.** Tidak ada panel dashboard, endpoint, `trace show`, `trace list`, atau reader/parser mana pun; `grep -ril trace scripts/` kosong. Trace ditulis untuk diperiksa manusia di host, bukan untuk dibaca plugin.
- **Tidak ada surface baru yang perlu dijaga test.** Ketiadaan flag CLI, event, capability, dan reader **tidak** dijaga test apa pun, jadi klaim negatif itu harus diverifikasi ulang dengan grep setiap kali dokumen ini disentuh.

### Aturan untuk task berikutnya

Menambah nama baru ke `PluginEventMap`, memberi trace capability atau service `trace:*`, membiarkan config trace memilih path, membuat plugin berlangganan trace, atau menjadikan trace bagian dari record session adalah perubahan kontrak. Semuanya butuh migration guide, adapter/compatibility test, dan penulisan ulang batas di dokumen ini. Trace reader, retensi, dan dashboard biaya/token adalah **4.6** dan **7.1**–**7.4**, bukan bagian 3.4.
## Prompt caching dan batasnya terhadap Plugin API (Task 4.1)

### Yang masuk ke kontrak, dan sifatnya

- Tidak ada. Kontrak `ModelUsage` di `kernel/src/model.ts` **tidak berubah** untuk 4.1: tetap tiga
  penghitung plus `source`. `OpenAIUsage` di `plugins/model-openai` adalah tipe **milik plugin**,
  `ModelUsage & { readonly cachedTokens?: number }`, dan `OpenAICompatibleResult` adalah
  `ModelResult & { readonly usage?: OpenAIUsage }`. Plugin yang memakai `ModelResult` dari provider lain
  tidak melihat field itu, dan plugin yang memakai `services.get("model:openai")` melihat
  `ModelProvider` sehingga tipe `usage` yang kembali adalah `ModelUsage`.

### Batas yang tetap berlaku, dan tidak boleh ditulis sebagai kemampuan

- **`cachedTokens` berhenti di plugin.** `parseUsage` di `plugins/loop-react` hanya menerima tiga
  angka finite plus `source` dan membangun ulang `ModelUsage`, sehingga hitungan cache-read tidak
  pernah mencapai `AgentResult.usage`, session v1, atau trace. Plugin yang butuh angka itu harus
  membaca `OpenAIUsage` langsung dari `createOpenAICompatibleModel`, bukan dari runner.
- **`prompt_cache_key` tidak dikirim.** Menambahkannya sebagai key config menyentuh
  `ModelPluginConfigSchema` yang `.strict()` di `kernel/src/config.ts`, yaitu kontrak kernel.

### Aturan untuk task berikutnya

- Kalau sebuah task berikutnya mengizinkan `kernel/`, slot cache-read harus datang sebagai migration
  kontrak: versi schema, adapter, dan compatibility test — bukan field tambahan diam-diam. Aturan yang
  sama sudah berlaku untuk `usage` di session v1 (lihat 2.4) dan untuk event `usage:*` yang memang
  tidak pernah ada (lihat 3.3).

## Test dan CI secret-free


Test, smoke, benchmark mock, dan CI tidak boleh membutuhkan API key, environment secret, `user/config.yaml`, `user/providers/`, atau `user/secrets/` tracked. Test memakai root temporary, provider offline/mock, dan fake boundary; live provider bukan acceptance test v1. Nilai URL, key, model catalog, atau file user tidak boleh ditulis ke docs/source tracked.

Test Task 2.4 menambah dua aturan yang sama, dan keduanya perlu disebut karena mekanismenya berbeda: store root di-override ke direktori sementara lewat `createSessionStore({ root })` untuk test yang butuh store eksplisit, dan `HOME`/`USERPROFILE` di-stub ke direktori sementara untuk test yang justru memverifikasi default home scope. Tidak ada test yang menulis ke `${HOME}/.config/nexus/user/sessions` asli. Assertion redaction juga harus membuktikan nilai rahasianya benar-benar tidak bocor ke file — bukan sekadar menguji nama fieldnya.

Acceptance run Task 1.1 (sudah hijau, ulangi bila kontrak berubah):

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm bench:smoke
corepack pnpm bench:20
```

Task 1.1 sudah dicentang final untuk v1: lockfile konsisten, seluruh package canonical `0.1.0` + `private`, import `@nexusmycelium/*` tetap resolve, dan test secret-free lulus. Angka acceptance tersebut berasal dari run coordinator itu juga; provenance benchmark hidup di `benchmarks/README.md` dengan provider `mock`, usage `unavailable`, dan cost `mock-not-billed`, sehingga tidak boleh dikutip sebagai biaya live. Full gate 1.2/1.3 sudah dijalankan dan hijau pada 2026-09-26 di repo ini tanpa perubahan source: `corepack pnpm check` (biome, `tsc --noEmit`, 166 vitest + 2 `node --test`), `corepack pnpm build`, `corepack pnpm bench:smoke`, `corepack pnpm bench:20` (20/20), dan `git diff --check`; `corepack pnpm install --frozen-lockfile` tidak diulang karena lockfile tidak berubah.

Full gate Task 2.4 juga sudah hijau pada 2026-09-26 di working tree yang sama: `corepack pnpm check` (biome `Checked 66 files … No fixes applied`, `tsc --noEmit` bersih, **219 vitest** di 22 file + 2 `node --test`), `corepack pnpm build` (exit 0), `corepack pnpm bench:20` (20/20, `successRate 1`, `taskSetHash 645a15f7…`, `reproducibilityHash 8135d0ff…`, usage `unavailable`, cost `mock-not-billed`), dan `git diff --check` tanpa output. `corepack pnpm install --frozen-lockfile` tidak diulang karena `pnpm-lock.yaml` dan `package.json` tidak berubah pada slice ini. Slice finalisasi 2.4 hanya menyentuh dokumen; source, test, package metadata, `user/`, dashboard, dan benchmark source tidak berubah.

Task 2.6 menambah acceptance harness di `benchmarks/accept.ts` beserta 6 test di `benchmarks/acceptance.test.ts`, dan menambah satu script `bench:accept` di `package.json`. Kernel contract tetap sama; yang ditambahkan hanya penilaian di atas report benchmark:

```bash
corepack pnpm vitest run benchmarks/acceptance.test.ts
corepack pnpm bench:accept
```

Keduanya deterministik dan offline; tidak ada live provider, API key, network, atau credential. Keduanya diverifikasi pada 2026-09-26: 6 test hijau, dan `bench:accept` exit 0 dengan `scope "acceptance"`, `status "accepted"`, `violations []`, `summary { planned 20, attempted 20, succeeded 20, failed 0 }`, `usage unavailable`, dan `cost 0 / mock-not-billed`. `benchmarks/acceptance.test.ts` tidak menulis ke `${HOME}` asli, tidak membuat direktori `user/`, dan salah satu test-nya memalsukan `globalThis.fetch` untuk membuktikan tidak ada panggilan jaringan.

Full gate Task 2.6 juga sudah hijau pada 2026-09-26 di working tree yang sama: `corepack pnpm install --frozen-lockfile` (dijalankan ulang karena `package.json` berubah; lockfile up to date di 8 workspace project), `corepack pnpm check` (biome `Checked 68 files … No fixes applied`, `tsc --noEmit` bersih, **225 vitest** di 23 file + 2 `node --test`, exit 0), `corepack pnpm typecheck` (exit 0), `corepack pnpm build` (exit 0), `corepack pnpm bench:smoke` (`"ok": true`), `corepack pnpm bench:20` (20/20, `successRate 1`, `taskSetHash 645a15f7…`, `reproducibilityHash 8135d0ff…`), `corepack pnpm bench:accept` (exit 0), dan `git diff --check` tanpa output.

## Membuat plugin

1. Salin `plugins/example-hello/` ke `plugins/<nama>/` dan pilih nama manifest canonical.
2. Isi package `@nexusmycelium/plugin-<nama>` dengan versi `0.1.0`, `private: true`, dan source export yang relatif.
3. Deklarasikan `apiVersion: 1`, `provides`, `requires`, dan permission minimum secara eksplisit.
4. Gunakan `@nexusmycelium/kernel` untuk API source-workspace; jangan menambahkan registry eksternal atau publish promise.
5. Tambahkan test boundary tanpa secret, lalu jalankan acceptance commands di atas.
