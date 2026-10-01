# NexusMycelium

Runtime plugin source-workspace untuk menjalankan task bounded secara lokal. Ini adalah vertical slice MVP, bukan autonomous-security, sandbox, atau pipeline hot-swap; yang ada hanya swap objek plugin official in-process.

## Mulai

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
node dist/src/cli.js --help
```

Butuh Node.js `^22.12.0 || ^24.0.0 || >=26.0.0` dan pnpm `12.6.0` sesuai `packageManager`.

## Runtime MVP

- `node dist/src/cli.js run` menjalankan satu task mock offline bounded dan mencetak JSON.
- `node dist/src/cli.js run 'Write hello.txt with content "hello" and read hello.txt'` memakai tool; `fs.write` harus diizinkan secara eksplisit di config.
- `node dist/src/cli.js serve` menjalankan dashboard lokal di `http://127.0.0.1:18765/task-dashboard.html`; API dan SSE tersedia di endpoint lokal yang sama.
- `node dist/src/cli.js report` mencetak tabel biaya dan token per task yang dibaca dari trace log (`trace.enabled: true`); run tanpa laporan usage tampil `unavailable`, model tanpa harga tampil `unpriced`, tidak pernah `0`.

- Skill adalah folder `skills/<nama>/SKILL.md` (atau `user/skills/<nama>/SKILL.md`) dengan frontmatter `name` + `description`. Yang masuk ke prompt hanya index nama/deskripsi/path; model membaca isinya sendiri lewat `read_text`. Skill tidak dieksekusi, dan skill user yang namanya sama dengan official ditolak.
- `corepack pnpm bench:smoke` menjalankan smoke task melalui `createRuntime`, config, dan runner yang setara CLI.
- `corepack pnpm bench:20` adalah command kanonik benchmark mock 20-task; command ini melakukan build lalu menjalankan runner tanpa nested `pnpm`.

Provider default adalah `model-mock`. `model-openai` bersifat opsional dan tetap melewati permission `network`; credential tidak boleh ditulis ke config atau docs tracked.

## CLI

`nexus` adalah nama command yang terpasang; di dalam repo ini jalannya lewat `node dist/src/cli.js`. Block help di bawah adalah help text yang benar-benar ada di `src/cli.ts`:

```text
NexusMycelium CLI (command: nexus)

Usage:
  node dist/src/cli.js run [task] [--root PATH] [--model mock|openai] [--session ID]
  node dist/src/cli.js run --sandbox <task> [--root PATH]
  node dist/src/cli.js session list
  node dist/src/cli.js session resume <id> <task> [--root PATH] [--model mock|openai]
  node dist/src/cli.js session fork <id> <newId> [atStep]
  node dist/src/cli.js serve [--root PATH]
  node dist/src/cli.js --help

Commands:
  run      Run one bounded agent task and print a JSON result.
  session  list, resume, or fork the stored sessions. Omitting atStep forks the whole session.
  serve    Serve the realtime task dashboard on 127.0.0.1:18765.

The default model is offline mock. Network and shell permissions deny by default.

run --sandbox is opt-in and hands the task to the isolated sandbox host. It prints the same
one-line JSON result and uses the same exit codes as run. A sandbox run is offline by contract:
the mock provider, network, and shell are all denied, so it reads no user config, no provider
key, and no session store, and it rejects --model openai and --session.
```

- `run` tanpa `--session` tidak menyentuh session store sama sekali.
- `run --session <id>` membuat sesi dengan id itu dan merekam setiap langkah ke JSONL append-only. Menjalankan lagi dengan id yang sama **menambah** record pada file yang sama, bukan menimpa.
- `session list` mencetak `{ sessions }` dari `readdir`, tanpa index file; tiap entri `{ id, bytes, updatedAt }`.
- `session resume <id> <task>` memutar transcript tersimpan lalu melanjutkan. Resume lintas provider atau model ditolak, bukan dinegosiasi.
- `session fork <id> <newId> [atStep]` menyalin prefix record source ke file baru; file source tidak pernah diubah. Tanpa `atStep`, fork memakai langkah terakhir.
- `serve` tetap hanya dashboard lokal dan tidak menyentuh data user.
- `run --sandbox <task>` menjalankan task di process/workspace sandbox: akar sementara di OS temp, `config/` dan `user/` kosong, tools root dipaksa relatif ke `workspace/`, `network` dan `shell` deny, config dibangun tanpa user overlay, dan `root` dari argumen tidak pernah dibaca. Ia menolak `--model openai` dan `--session`, mencetak satu baris JSON yang sama dengan `run`, dan memakai exit code yang sama. Rinciannya di "Status Task 3.1".

## Package boundary dan identitas

| Manifest name | Package canonical | Status |
|---|---|---|
| `model-mock` | `@nexusmycelium/plugin-model-mock` | canonical |
| `model-openai` | `@nexusmycelium/plugin-model-openai` | canonical, optional |
| `loop-react` | `@nexusmycelium/plugin-loop-react` | canonical |
| `tools-basic` | `@nexusmycelium/plugin-tools-basic` | canonical tool provider |
| `tools-core` | `@nexusmycelium/plugin-tools-core` | legacy compatibility status |
| `example-hello` | `@nexusmycelium/plugin-example-hello` | official sample |

Root `nexusmycelium`, kernel `@nexusmycelium/kernel`, dan semua plugin memakai versi `0.1.0`. Package tetap `private: true` dan hanya untuk source workspace; v1 tidak menjanjikan publish ke registry atau kompatibilitas package eksternal. Import internal yang dijaga adalah `@nexusmycelium/*`.

## Kontrak Plugin API v1

Rincian normative ada di `docs/PLUGIN_API.md`:

- `apiVersion` harus number literal `1`; nilai `"1"` atau versi lain ditolak. API bump memerlukan migration guide dan adapter/compatibility test.
- Manifest strict dan immutable: field unknown, default yang berubah, dan mutasi setelah validation tidak boleh menjadi perilaku yang tersembunyi.
- `provides` adalah capability contract yang ditegakkan registry: registration service ditolak jika service tidak ada di `provides` owner. `requires` berisi manifest names dan delegation load/lifecycle dilakukan registry, bukan direct import plugin.
- Lifecycle events bertipe: `plugin:loaded` dan `plugin:unloaded` dengan payload `{ name }`, divalidasi schema strict sebelum dispatch, dengan `onError` yang mengisolasi kegagalan handler. `MAX_EMIT_DEPTH = 16` membatasi emit bersarang. Belum ada wildcard listener maupun timeout emit.
- Service selalu owner-aware; `setup` dapat async dan dapat mengembalikan `Disposer`; unload membersihkan owner resource, error tidak ditelan.
- Permission `allow`/`ask`/`deny` bersifat cooperative. Official plugin berjalan di proses Node yang sama, sehingga gate bukan sandbox.
- `tools-basic` adalah provider canonical. `tools-core` hanya legacy compatibility dan tidak boleh diaktifkan bersamaan dengan `tools-basic`.
- Official discovery hanya menerima canonical `plugins/` real path dan fail-closed terhadap path luar, URL non-file, package/manifest malformed, atau fallback arbitrary.
- `apiVersion`, manifest, package version, dan nama canonical harus tetap konsisten; root, kernel, dan 6 plugin sudah `0.1.0` + `private` dengan import `@nexusmycelium/*` resolve via link pnpm.

## Config, user data, dan secret

`config/default.yaml` adalah default official; `user/config.yaml` hanya overlay data yang strict dan tidak dapat memuat kode atau plugin arbitrary. Plugin tidak membaca `user/` atau `data/` langsung. Exception canonical v1 hanya `model-openai` untuk `apiKeyFile` dengan permission `fs.read`, dengan dua scope yang diizinkan: runtime root `${root}/user/secrets/` atau `${root}/user/providers/`, dan trusted home `${HOME}/.config/nexus/user/secrets/` atau `${HOME}/.config/nexus/user/providers/`. Path harus canonical dan target harus regular file mode `0600`; canonical check berjalan pada file dan parent directory, sehingga segment `user` di bawah `/tmp`, symlink file, dan symlink parent yang keluar scope ditolak. Permission itu tidak memberi akses di luar exception.

Exception kedua adalah session store Task 2.4: `${HOME}/.config/nexus/user/sessions/` untuk JSONL append-only. Path store diturunkan dari home direktori proses, dan `data/` di root runtime bukan scope store — `data/` ada di volume fuseblk yang sama dengan repo, di-gitignore sebagai scratch, dan bukan state user. Store adalah modul runtime host di `src/`, bukan plugin, jadi ia tidak tunduk pada aturan "plugin tidak membaca `user/` atau `data/`"; ia tidak pernah membaca `user/secrets/` maupun `user/providers/`, dan konfinement-nya sendiri (root `0700`, file `0600`, `O_NOFOLLOW`, perbandingan `realpath`). Perlu dibaca apa adanya: store tidak lewat `PermissionGate`, jadi `fs.write: deny` yang default tidak memblokirnya.

Test, smoke, benchmark mock, dan CI harus secret-free: temporary roots, offline/mock provider, fake boundary, tanpa live provider, tanpa API key, dan tanpa membaca `user/config.yaml`, `user/providers/`, atau `user/secrets/` tracked.

## Trust dan batasan

Official plugin di `plugins/` dipercaya, tetapi `agent-made/` dan plugin untrusted tidak memiliki loader, sandbox, atau gate. Yang ada adalah reload object-level untuk plugin official: swap objek in-process dengan rollback ke objek sebelumnya bila swap gagal, plus cache-bust `cacheKey` di loader. Yang tidak ada adalah file watcher, canary, monitor, rollback keputusan sebelum swap, dan pipeline hot swap; semuanya ditunda ke Task 7.1 dan 7.4. Tidak ada external publish promise. `ask` tanpa approval callback ditolak; guardrail root/symlink/shell bukan OS isolation. Task 3.1 menambah process/workspace sandbox runner (`run --sandbox`) untuk task, **tetapi** itu bukan sandbox OS dan bukan pertahanan terhadap plugin in-process yang berbahaya — agent-nya tetap jalan di proses Node yang sama. Detail dan batasnya di "Status Task 3.1".

## Status Task 1.2 dan 1.3

Kedua task sudah dicentang di `TASKS.md` pada 2026-09-26 setelah full gate hijau: `corepack pnpm check` (biome, `tsc --noEmit`, 166 vitest + 2 `node --test`), `corepack pnpm build`, `corepack pnpm bench:smoke`, `corepack pnpm bench:20` (20/20), dan `git diff --check`. Bukti falsifiable per butir ada di `TASKS.md`.

Sudah terverifikasi test hijau:

- 1.2 — urutan dependensi: `requires` dimuat rekursif sebelum `setup`, cycle dan dependency hilang ditolak, unload ditolak saat dependent loaded atau loading, `close()` menutup reverse load order, `load`/`unload` konkuren berbagi satu operasi, dan setup failure membersihkan service parsial tanpa menandai loaded. `loadAll(names, { strict })` mengisolasi kegagalan per nama dengan pre-check graph yang tidak menjalankan setup, melaporkan `loaded`/`failures` per nama, dan `strict` mengubahnya jadi `AggregateError`. `reload(name, replacement)` menukar objek plugin official beserta dependent closure-nya dan mengembalikan objek serta service sebelumnya bila swap ditolak; `loadPlugin`/`discoverPlugins` menerima `{ cacheKey }` untuk mengevaluasi ulang entry yang sama. `close()` terminal dan idempotent: `load`/`loadAll`/`reload` setelah close menolak, `close()` konkuren berbagi satu promise.
- 1.3 — katalog runtime `PLUGIN_EVENT_NAMES`/`PLUGIN_EVENT_SCHEMAS` yang hanya berisi `plugin:loaded` dan `plugin:unloaded`, validasi payload `z.strictObject({ name: z.string().min(1) })` dengan `safeParse` sebelum dispatch, kegagalan handler diisolasi ke `onError` yang ditelan bila ia sendiri melempar, ceiling reentrancy `MAX_EMIT_DEPTH = 16`, dispatch memakai snapshot handler, dan urutan lifecycle dependency-first saat load serta reverse saat unload.

Belum ada, jadi tidak boleh diklaim sebagai fitur:

- 1.2 — file watcher `plugins/`, loader `agent-made/`, canary, gate/monitor sebelum swap, rollback keputusan sebelum swap, bulk load lintas trust boundary, dan sandbox OS. Object-level reload bukan hot swap pipeline; gate, canary, dan hot reload plugin buatan agent ditunda ke Task 7.1 dan 7.4. Process/workspace sandbox yang ada sejak 3.1 tidak mengubah ini: `reload()` tetap swap in-process tanpa pengaman.
- 1.3 — wildcard listener dan timeout emit. `emit` tidak memasang timeout per handler maupun per event, jadi handler yang tidak resolve membuat `load`/`unload`/`close` menggantung; batas yang ada hanya kedalaman emit.

Rinciannya ada di `docs/ARCHITECTURE.md` ("Status Task 1.2", "Status Task 1.3") dan `docs/PLUGIN_API.md` ("Loader dan event bus: yang tersedia dan yang belum dijanjikan").

## Status Task 2.4

Task 2.4 sudah dicentang di `TASKS.md` pada 2026-09-26 setelah full gate hijau di working tree yang sama. Implementasi ada di `src/session.ts` dengan `src/runtime.ts` dan `src/cli.ts` sebagai pemanggilnya; test ada di `src/session.test.ts`, `src/session-security.contract.test.ts`, `src/session.fixtures.ts`, serta bagian sesi di `src/runtime.test.ts` dan `src/cli.test.ts`. Yang ada:

- JSONL append-only di `${HOME}/.config/nexus/user/sessions/<sessionId>.jsonl`, bukan `data/` di root repo yang ada di volume fuseblk. Record `run-start` / `run-step` / `run-end` semuanya strict dan membawa `schemaVersion: 1`. `sessionId` harus cocok `[A-Za-z0-9_-]{1,64}`, directory `0700`, file `0600`, symlink keluar root ditolak.
- Resume memutar transcript dari record lewat `AgentRunOptions.history`, dengan `onStep` yang menambahkan satu record per langkah. Torn tail diperbaiki, line rusak di tengah file gagal closed. Mismatch provider/model ditolak.
- Fork menyalin `run-start` plus `run-step` sampai `atStep` ke file baru, dan file source tidak pernah dibuka untuk tulis.
- CLI terverifikasi langsung dengan `HOME` dan `--root` temporer: `run --session` → `session list` → `session resume` → `session fork` (dengan dan tanpa `atStep`) semuanya berhasil, directory `0700`, file `0600`, file diakhiri newline, dan store user asli terbukti tidak berubah.
- Nol dependency baru: `dependencies` root tetap `yaml` dan `zod`, tanpa SQLite.
- Full gate: `corepack pnpm check` (biome 66 file bersih, `tsc --noEmit` bersih, 219 vitest + 2 `node --test`), `corepack pnpm build`, `corepack pnpm bench:20` (20/20), dan `git diff --check` tanpa output.
- Belum ada dan tidak boleh diklaim: compaction atau summary history, TTL/expiry/garbage collection, hapus/rename/prune sesi, index atau catalog file, `session show`, integrasi dashboard, dan persistence config atau secret. Session store juga bukan capability plugin: tidak ada service atau event `session:*`.

Rinciannya ada di `docs/ARCHITECTURE.md` ("Status Task 2.4") dan `docs/PLUGIN_API.md` ("Session store dan batasnya terhadap Plugin API").

## Verifikasi

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm bench:smoke
corepack pnpm bench:20
corepack pnpm bench:accept
```

`corepack pnpm install --frozen-lockfile` mendahului commands di atas. Acceptance run Task 1.1 sudah hijau di keenam commands ini; ulangi seluruh urutan bila kontrak, manifest, permission, atau package metadata berubah. `corepack pnpm check` (lint + typecheck + test) adalah gate wajib sebelum serah terima.

## Dokumen

- `AGENTS.md` — aturan untuk agent coding
- `TASKS.md` — daftar task dan acceptance gate
- `docs/ARCHITECTURE.md` — arsitektur dan batas runtime
- `docs/PLUGIN_API.md` — kontrak Plugin API v1
- `docs/AGENT_WORKFLOW.md` — SOP kerja agent dan serah terima
- `task-dashboard.html` — dashboard lokal
- `benchmarks/README.md` — kontrak benchmark mock dan acceptance 2.6

## Status Task 1.1

Task 1.1 closed final untuk v1; acceptance run hijau: `install --frozen-lockfile`, `lint`, `typecheck`, `test`, `build`, `check`, `bench:smoke`, `bench:20` (20/20), dan `git diff --check`. Yang terverifikasi: strict/immutable manifest, `provides` enforcement, typed lifecycle events, owner-scoped service disposal, fail-closed discovery, import `@nexusmycelium/*`, lockfile, dan secret-free tests. Kontrak yang berubah membuka task baru dengan migration guide. Tidak ada klaim autonomous security, sandbox, atau pipeline hot swap.

Provenance angka benchmark: `reproducibilityHash` dan `taskSetHash` berasal dari run `bench:20` dengan provider `mock` dan sumbernya `benchmarks/README.md`. Usage berstatus `unavailable` dan cost `mock-not-billed`, jadi angka itu bukan tagihan dan bukan bukti biaya provider live; `elapsedMs` adalah observasi satu run, bukan SLA.

## Status Task 2.6

Task 2.6 adalah "jalankan benchmark" dengan ambang **≥ 5 dari 20 tugas selesai end-to-end**. Statusnya per 2026-09-26: **ditutup** setelah full gate hijau, dengan acceptance harness khusus — bukan dengan 20/20 milik 0.4. Yang ditambahkan hanya `benchmarks/accept.ts` (`MIN_SUCCEEDED = 5`, `CANONICAL_TASKS = 20`), test `benchmarks/acceptance.test.ts`, dan script `bench:accept`. `runBenchmark`, report, `taskSetHash`, dan `reproducibilityHash` tetap milik `benchmarks/run.ts` sebagai satu-satunya sumber kebenaran; `accept.ts` hanya menjalankan task set kanonik lalu menilai report-nya.

Command acceptance:

```bash
corepack pnpm bench:accept
corepack pnpm vitest run benchmarks/acceptance.test.ts
```

- `corepack pnpm bench:accept` exit 0 dengan `scope "acceptance"`, `status "accepted"`, `violations []`, `summary { planned 20, attempted 20, succeeded 20, failed 0 }`, dan kelima `phases` terisi (`tasksWithTools 20`, `tasksWithSteps 20`, `tasksWithToolCalls 20`, `verified 20`, `rejected 0`). Laporan tepat satu baris JSON, sama seperti `run.ts`. Tidak ada mode report-only: penolakan selalu exit 1.
- `corepack pnpm vitest run benchmarks/acceptance.test.ts` → 6 test hijau. Nama test yang dipakai sebagai bukti ada di `TASKS.md` dan `benchmarks/README.md`.
- Gate terbukti tidak bisa dilewati: test negatif "rejects a wrong expected artifact even when the runner status is completed" memakai `expected` yang salah sehingga `status` tetap `completed` dengan `steps > 0` dan `toolCalls > 0`, tetapi `success: false` dengan `error: "expected-files-mismatch"`. Status saja tidak pernah memenuhi gate.
- Nol live provider, API key, dan network: `accept.ts` memanggil `runBenchmark({ provider: "mock" })`, config benchmark memaksa `network: deny` dan `shell: deny`, dan test "emits one report line, exits 0, and touches no user config, key, or network" memasang spy pada `globalThis.fetch` lalu memalsukkannya dengan `expect(fetchSpy).not.toHaveBeenCalled()`.
- Full gate 2026-09-26: `install --frozen-lockfile` (dijalankan ulang karena `package.json` berubah), `check` (biome `Checked 68 files … No fixes applied`, `tsc --noEmit` bersih, 225 vitest di 23 file + 2 `node --test`), `typecheck`, `build`, `bench:smoke`, `bench:20` (20/20), `bench:accept` (exit 0), dan `git diff --check` tanpa output.

Provenansi angka: provider `mock`, `taskSetHash 645a15f7…`, `reproducibilityHash 8135d0ff…`, `usage.status unavailable`, `cost 0 / mock-not-billed`. Angka itu bukan tagihan dan bukan bukti biaya provider live; `elapsedMs` adalah observasi satu run, bukan SLA. Angka 20/20 tetap milik Task 0.4 dan bukan achievement baru 2.6.

Yang dibuktikan dan yang tidak:

- **Dibuktikan** — plumbing harness/tool/verifier: konfigurasi, discovery plugin official, loop agent, tool call file, artefak tertulis, verifikasi file yang terpisah dari status model, laporan acceptance, dan gate exit code.
- **Tidak dibuktikan** — kemampuan coding model open-ended. `model-mock` hanya mem-parsing prompt dengan satu regex lalu meneruskan konten yang sudah tertulis di prompt, 20 task adalah tulis satu file dengan konten persis, dan runner dibatasi `maxSteps: 4` serta `maxToolCalls: 2`. Tidak ada iterasi panjang, pemulihan error, maupun retry yang terukur.
- **Ditunda** — suite live 9Router dan akuntansi token/biaya nyata. Alasannya ada di source, dan bentuknya berubah: `ModelResult` di `kernel/src/model.ts` kini punya `usage?: ModelUsage` **opsional**, jadi "tidak ada field usage" tidak lagi benar — tetapi `plugins/model-mock` tidak melaporkannya, tidak ada harga di kontrak provider, dan `config` benchmark tidak punya blok `budget` sehingga guard mati karena default. `usage.status` tetap `unavailable` dan `cost 0` tetap placeholder, bukan hasil pengukuran. Budget guard adalah Task 3.3 dan sudah ditutup; yang ditunda adalah **akuntansi nyata**nya — suite live dan harga yang benar-benar terpakai, bukan enforcement-nya.

Rinciannya ada di `benchmarks/README.md` ("Status Task 2.6") dan `docs/ARCHITECTURE.md` ("Status Task 2.6").

## Status Task 3.1

Task 3.1 di `TASKS.md` adalah "sandbox runner (container atau git worktree terisolasi)". **Kedua opsi itu tidak diambil.** Yang ada di source adalah opsi ketiga yang lebih lemah: **process/workspace sandbox di host**. Kotak 3.1 di `TASKS.md` sudah `- [x]` — full gate hijau pada working tree yang sama, rinciannya di `TASKS.md`. Yang dicentang hanya process/workspace sandbox; 3.2, 3.3, dan 3.4 sudah dicentang di kotak-kotaknya sendiri, 7.1–7.4 tetap `- [ ]`, dan 3.2 yang sudah tertutup hanya memulihkan isi workspace sandbox temp — bukan keputusan swap, bukan checkout plugin official, dan bukan repo developer.

Yang benar-benar ada, dan perlu dibaca apa adanya:

- **Temp workspace.** `mkdtemp` di OS temp dengan prefix `nexus-sandbox-`, bukan `data/` repo. Di dalamnya `config/`, `user/` kosong, dan `workspace/`, dengan `workspace` di-`realpath` supaya containment dibandingkan lewat symlink apa pun.
- **Tools root dipaksa relatif dan absolut terkurung.** Config sandbox menulis `tools.root: workspace` relatif supaya kernel yang me-resolve-nya di bawah akar sementara, karena `tools.root` absolut akan melewati containment kernel. Lalu `assertSandboxEnforced` memverifikasi, bukan memercayai: workspace non-absolute, `network` bukan `deny`, provider bukan `mock`, `tools.root` di luar workspace, atau root `plugins.tools-basic`/`plugins.tools-core` yang keluar workspace semuanya ditolak.
- **`network`/`shell` deny.** `network: deny` permanen; `shell` deny ganda lewat `permissions.shell: deny` **plus** `deny: ["*"]`. Satu-satunya jalan membuka shell adalah `shell.allow` eksplisit.
- **Tidak ada user overlay, dan `root` dari request tidak pernah dibaca.** Config dibangun dari nol tanpa `config/user.yaml` host, `user/` dibiarkan kosong, dan `SandboxRequest.root` divalidasi lalu dibuang — mengadopsi root caller adalah satu-satunya rute ke `user/config.yaml` dan provider key.
- **Env child dibersihkan.** Hanya `PATH`, `LANG`, `LC_ALL`, `TMPDIR` yang menyeberang ke child; tidak ada `HOME` dan tidak ada API key.
- **Process group terpisah, timeout, dan hard deadline.** Child di-`spawn` `detached: true` lalu disinyal per process group (`kill(-pid)`), sehingga descendant ikut mati tanpa orphan. `SIGTERM` → grace → `SIGKILL`, plus hard timer untuk child yang menahan pipe. `timeoutMs` dibatasi 30.000 ms dan output dipotong 64.000 byte.
- **Cleanup.** `dispose()` single-flight dan idempoten, dipanggil pada sukses, error, run terhenti, penolakan, dan kegagalan konstruksi; `workspaceCleaned` hanya `true` setelah pohon diverifikasi hilang.
- **CLI seam nyata.** `node dist/src/cli.js run --sandbox "write a note"` → `{"status":"completed","steps":1,"toolCalls":0,"workspaceCleaned":true}`, exit 0, tanpa sisa `/tmp/nexus-sandbox-*`.

Yang **tidak** ada dan tidak boleh diklaim: tidak ada container, Docker, `git worktree`, namespace, seccomp, cgroup, `uid`/`gid` drop, chroot, Landlock, atau AppArmor. **Dan ini bukan pertahanan terhadap plugin in-process yang berbahaya** — agent-nya berjalan di proses Node yang sama lewat `createRuntime`, jadi plugin official yang sudah dimuat tetap punya akses proses seperti sebelumnya; permission gate tetap cooperative. Tidak ada gate sebelum swap, canary, monitor, atau rollback keputusan. Snapshot/rollback git sudah tertutup di **3.2** dan hanya memulihkan isi workspace sandbox temp, budget guard **3.3** sudah ditutup di kotaknya sendiri, trace log **3.4** juga sudah ditutup di kotaknya sendiri (writer yang default mati, di luar repo), sementara pipeline gate **7.1** (serta 7.2–7.4) tetap `- [ ]`.

Bukti falsifiable per butir ada di `TASKS.md`; 23 test di `src/sandbox.test.ts` (12) dan `src/sandbox-security.contract.test.ts` (11) memanggil host sungguhan, termasuk CLI seam tanpa host yang di-inject. Test process-group adalah `it.skipIf(!posix)`, jadi dilewati di platform non-POSIX. Rinciannya di `docs/ARCHITECTURE.md` ("Status Task 3.1").

## Status Task 3.2

Task 3.2 adalah "snapshot dan rollback berbasis git". **Kotaknya sudah `- [x]`** — full gate hijau 2026-09-27 pada working tree yang sama, rinciannya di `TASKS.md`. Yang dipulihkan 3.2 adalah **isi workspace sandbox temp**: bukan keputusan, bukan checkout plugin official, dan bukan repo developer. `src/snapshot.ts` mengekspor `createSnapshot(root)` dan `restoreSnapshot(root, commit)`, sudah di-import `src/sandbox.ts` dan sudah di-wire ke flag `--snapshot` di `src/cli.ts`.

Yang benar-benar ada, dan perlu dibaca apa adanya:

- **Hanya workspace sandbox yang terisolasi.** Targetnya `workspace` milik `createSandbox()` di OS temp, bukan `SandboxRequest.root` — dan `root` itu tetap divalidasi lalu dibuang seperti pada 3.1. `canonicalRoot()` menolak root non-absolute atau non-direktori, root yang **tidak ada di dalam** OS temp (menutup `..`, `/`, `$HOME`, repo developer, dan temp dir itu sendiri), dan root yang git-nya menunjuk ke git dir milik orang lain — aturan terakhir membandingkan `rev-parse --absolute-git-dir` dengan `realpath(<root>/.git)`, **bukan** marker file. Root yang memang repository-nya sendiri diizinkan, dan `git init` hanya jalan kalau `.git` belum ada. **Repo developer asli tidak pernah di-snapshot dan tidak pernah di-rollback**; tidak ada `worktree`, `stash`, `branch`, `remote`, `tag`, `push`, `fetch`, atau `clone`.
- **Baseline commit** sekali per run: `init --quiet` (bila perlu) → `user.name`/`user.email` di config **lokal workspace** → `add -A -- .` → `commit --allow-empty`, dengan identitas `nexus <nexus@localhost>` yang tidak bergantung pada config host. `add -A` sengaja tidak men_stage berkas yang di-ignore.
- **Restore = `reset --hard` + `clean -fd`, bukan `-fdx`.** Sha hex diverifikasi sebagai objek commit sungguhan **sebelum** workspace disentuh, `HEAD` dan `status` dibaca ulang sesudahnya, dan restore fail closed kalau tidak sampai ke commit yang diminta. **Berkas yang di-ignore tetap dipertahankan** (`node_modules/`, cache, `.env`-class) karena modul tidak bisa expresses `-x`/`--ignored` sama sekali.
- **Env git disaring, tiap perintah berbatas.** Hanya `PATH` dan `LC_ALL=C` yang diwarisi, plus `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, dan per-perintah `core.hooksPath=/dev/null` + `commit.gpgsign=false`, `shell: false`, `detached: true` supaya sinyal per process group. Deadline 30.000 ms → `SIGTERM` → grace 500 ms → `SIGKILL`; stdout+stderr dijumlah byte-nya dan di-`SIGKILL` di atas 8 MiB; teks error dipotong 160 karakter. Tanpa `HOME`, `~/.gitconfig` dan `~/.config/nexus` tidak pernah terbaca.
- **Auto-restore lewat flag, seam nyata:** `node dist/src/cli.js run --sandbox --snapshot <task>` membaseline lalu restore otomatis pada `completed`, `error`, atau run dihentikan, selalu sebelum `dispose()`. `--snapshot` ditolak di luar `--sandbox` (`--snapshot requires --sandbox`). Restore yang tidak selesai dilaporkan `rolledBack: false`, bukan error yang dilempar, dan **exit code tetap hanya dari `status`**. **Tidak ada flag pembatal** — workspace dihapus bersama temp tree, jadi `rolledBack` satu-satunya sinyal. `run --sandbox` tanpa flag itu persis seperti 3.1.
- **Nol secret/config yang ter-snapshot:** git root adalah `workspace/` saja, sedangkan `config/`, `user/` kosong, `data/` repo, dan store sesi di home berada di luarnya; `changedFiles` hanya memberi path relatif, bukan isi berkas.

**Yang tidak ada di 3.2:** tidak ada rollback atas repo developer, tidak ada `git worktree`, tidak ada canary, monitor, atau gate yang memanggil restore sebagai keputusan swap. 3.2 memulihkan **isi workspace sandbox** — `reload()` pada 1.2 (rollback objek plugin official) tetap satu-satunya rollback yang benar-benar ada di source. Pipeline gate tetap **7.1** dan 7.2–7.4 tetap `- [ ]`. Trace log **3.4** ditutup terpisah di kotaknya sendiri, dan penutupan itu tidak menambah rollback keputusan apa pun. Budget guard **3.3** ditutup terpisah di kotaknya sendiri, dan penutupan itu tidak menambah gate, canary, monitor, atau rollback keputusan apa pun pada 3.2.

Bukti falsifiable: 11 test di `src/snapshot.test.ts` (semuanya `it.skipIf(!gitReady)`) plus 11 di `src/snapshot-security.contract.test.ts`, 10 di `src/sandbox.test.ts` (7 describe "snapshot and rollback" + 3 CLI seam nyata), dan 6 di `src/cli.test.ts` describe "CLI sandbox snapshot". Full gate: `Checked 77 files`, `tsc --noEmit` bersih, **308 test di 28 file** vitest + 2 `node --test`, build exit 0, `git diff --check` tanpa output. Test git di `src/snapshot.test.ts` dan contract **dilewati di mesin tanpa `git` di PATH** (dan tiga butir contract butuh host POSIX), jadi bukti itu tidak boleh dibaca sebagai jaminan lintas platform; test 3.2 di `src/sandbox.test.ts` dan `src/cli.test.ts` tidak punya `skipIf` sama sekali. Dua gap yang tercatat di versi section ini sebelumnya — containment direktori temp itu sendiri, dan auto-restore level sandbox yang belum punya test — sudah tertutup; koreksi isi juga termasuk klaim marker `.git/nexus-snapshot` yang tidak pernah ada di implementasi. Rincian kriteria dan nama test ada di `TASKS.md`; analisisnya di `docs/ARCHITECTURE.md` ("Status Task 3.2").

## Status Task 3.3

Task 3.3 adalah "budget guard (token, uang, waktu) — agent berhenti saat batas tercapai". **Kotaknya sudah `- [x]`** — full gate hijau 2026-09-27 pada working tree yang sama, rinciannya di `TASKS.md`. Yang ada:

- **Mati secara default, dan `null` berarti tanpa plafon — bukan nol.** `DEFAULT_BUDGET_POLICY` beku dengan `enabled: false`, ketiga limit `null`, `prices` kosong. `config/default.yaml` memuat blok `budget` dengan `enabled: false` dan ketiga cap `null`, dan `user/config.example.yaml` menyalinnya dengan semua cap serta `prices` terkomentari. `configBudget()` mengembalikan `undefined` kecuali `config.budget.enabled === true`, jadi blok yang `enabled: false` **dengan cap terisi** tetap mati dan runner tidak melihat key `budget` sama sekali.
- **Config strict dengan cap nullable.** `budget.enabled` plus `maxTotalTokens`/`maxCostUsd`/`maxElapsedMs` nullable default `null`, `prices` nullable default `null`; menolak `0`, negatif, `NaN`, non-finite, dan key unknown. `Infinity` tidak pernah muncul — `null` sudah memisahkan "tanpa plafon" dari angka nyata.
- **Harga per model, dihitung dalam mikro-USD bulat.** `budget.prices` adalah peta per model dengan field persis `inputUsdPerMillionTokens` dan `outputUsdPerMillionTokens`, dikunci nama model yang dipanggil runtime. `configBudget()` meneruskan seluruh peta itu apa adanya; kernel tidak pernah menebak harga, tidak pernah mengikatnya ke satu model, dan menolak sisi harga yang `0` karena itu akan menghitung satu dimensi sebagai gratis. Cap biaya pada model yang tidak ada di peta menghentikan run `budget:cost-unpriced`, bukan memperlakukannya gratis.
- **Usage opsional dan tidak diketahui tidak pernah jadi nol.** `ModelResult` punya `usage?: ModelUsage` opsional pada kedua variannya, dan `AgentResult.usage` **hanya ada** bila guard aktif **dan** ada yang dilaporkan. Run dengan guard mati tidak mendapat key `usage` sama sekali. `budget:usage-unavailable` menghentikan run di langkah pertama bila ada cap aktif tapi provider tidak melapor. `model-mock` tidak melapor sama sekali.
- **Satu kosakata alasan stop, konstan tanpa interpolate.** Kernel menerbitkan `budget:time`, `budget:tokens`, `budget:cost`, `budget:usage-unavailable`, `budget:cost-unpriced` sebagai lima konstanta yang dirangkai di `BUDGET_STOP_REASONS`, plus satu teks `Agent stopped: budget reached.`; `plugins/loop-react` me-re-export-nya alih-alih menyalin nilai. Tidak ada jumlah, harga, nama model, path, atau teks provider yang masuk ke reason maupun `text`. `AgentResult` tidak punya field `stopReason` — alasannya konstanta string di `error`, seperti empat alasan stop lama.
- **Provider di-abort saat stop**, dan transkript tidak ditinggalkan berpasangan: tool call turn yang dihentikan dijawab supaya tidak ada `tool_call` tanpa pasangan.
- **Resume hanya boleh mengencangkan batas.** `tightestLimits()` mengambil `Math.min` per field antara yang direkam session dan yang diminta caller, jadi keduanya bisa menurunkan plafon dan tidak satu pun bisa menaikkannya.
- **Tidak ada flag CLI budget.** `parseArgs` hanya menerima `--root`, `--model`, `--session`, `--sandbox`, `--snapshot`, `--mock`, `--help`; config adalah satu-satunya permukaan aktivasi, dan budget diambil dari runtime, bukan dari caller, transcript, atau overlay plugin.

**Yang tidak ada, dan tidak boleh diklaim.** Usage **tidak dipersistensi**: `src/session.ts` tidak memuat `usage`, `run-end` tetap `status`/`text?`/`error?`/`limits?`, dan budget adalah input run bukan record — CLI hanya mencetaknya ke stdout. Konsekuensinya, `run-end` tidak dapat membedakan stop budget dari stop langkah, dan usage tidak dapat dibangun ulang lintas proses. Tidak ada event usage: `PluginEventMap` tetap `plugin:loaded` dan `plugin:unloaded`. Tidak ada agregasi usage lintas run atau proses, tidak ada `stopReason` terstruktur, dan tidak ada suite live, API key, network, atau tagihan.

**Benchmark tidak berubah.** `usage.status "unavailable"` dan `cost 0 / mock-not-billed` tetap literal di `benchmarks/run.ts`, dan config benchmark tidak punya blok `budget` sama sekali sehingga guard mati karena default. Karena benchmark memaksa provider `mock` yang tidak melapor usage, contract `usage?` **tidak mengubah satu pun angka** — `taskSetHash 645a15f7…` dan `reproducibilityHash 8135d0ff…` identik dengan yang tercatat di 2.6.

Bukti falsifiable per butir ada di `TASKS.md` (kotak 3.3): 58 test di enam file — 18 di `src/budget-security.contract.test.ts`, 10 di `kernel/src/budget.test.ts`, 11 di `kernel/src/config.test.ts` describe "kernel config budget", 8 di `plugins/loop-react/src/index.test.ts` describe "loop-react budget guard", 7 di `src/runtime.test.ts`, dan 4 di `src/cli.test.ts` describe "CLI budget". Full gate: `Checked 79 files`, `tsc --noEmit` bersih, **370 test di 30 file** vitest + 2 `node --test`, build exit 0, `bench:20` 20/20, `bench:accept` `accepted`, `git diff --check` tanpa output. **Angka itu hasil run yang tercatat, bukan jaminan deterministik**: `corepack pnpm test` berflake pada satu test yang bukan bagian 3.3 — "kills a child that ignores the deadline, grandchild included" (`src/sandbox-security.contract.test.ts`, test process-group milik 3.1) gagal 1 dari 7 run pada mesin ini dan hijau lagi pada run berikutnya; tidak ada file 3.3 yang ikut gagal. Trace log **3.4** sudah ditutup terpisah di kotaknya sendiri (status di "Status Task 3.4" di bawah); dashboard biaya/token **4.6** dan 7.1–7.4 tetap `- [ ]`.


## Status Task 3.4

Task 3.4 adalah "Trace log terstruktur". **Kotaknya sudah `- [x]`** — ditutup 2026-09-27 setelah full gate coordinator hijau pada working tree yang sama: `install --frozen-lockfile`, `lint` (`Checked 83 files`, tanpa fix), `typecheck`, `test` (**453 test di 32 file** vitest + 2 `node --test`), `build`, `check`, `bench:smoke`, `bench:20` (20/20), `bench:accept` (`accepted`), dan `git diff --check` tanpa output. Angka itu hasil run yang tercatat, bukan jaminan deterministik: pada run gate ini `corepack pnpm test` **tidak berflake**, dan dua test timing lama yang kadang gagal — "runs the mock benchmark twice without leaking artifacts or report-only data" (`benchmarks/run.test.ts`, di bawah default 5 s vitest) dan "kills a child that ignores the deadline, grandchild included" (`src/sandbox-security.contract.test.ts`, process-group milik 3.1) — **lolos sendiri saat file terkait dijalankan terpisah** dan **bukan test trace**. Test bukti 3.4: 46 di `src/trace.test.ts`, 16 di `src/trace-security.contract.test.ts`, 11 di `src/runtime.test.ts` describe "structured trace host", 10 di `kernel/src/config.test.ts` describe "kernel config trace".

**Desain yang disepakati.** Trace adalah diagnostik host yang **mati secara default** (blok config hilang berarti mati, tidak ada file yang ditulis), JSONL di `${HOME}/.config/nexus/user/traces` dengan `schemaVersion` 1, isinya **record scalar** untuk run/step/plugin saja — **tanpa transcript, tanpa output tool, tanpa path, tanpa secret**; redaction yang **menolak** nilai, bukan menyamarnya; ukuran dan rotasi terbatas; kegagalan tulis **tidak pernah mematikan run**; **tidak ada flag CLI**; **tidak ada event plugin baru**; **tidak ada dashboard, endpoint, atau reader**; dan **session tetap transcript**.

**Yang sudah ada di source.** Blok config strict `trace` di `kernel/src/config.ts` (`enabled` default `false`, `maxBytes` default `1_048_576`, ceiling `67_108_864`, tanpa key lokasi) dan blok eksplisit di `config/default.yaml`; `src/trace.ts` dengan `createTraceWriter`, union strict **lima** varian `run-start`/`run-step`/`run-end`/`plugin-load`/`plugin-load-failed`, `TRACE_SCHEMA_VERSION = 1`, root default `${HOME}/.config/nexus/user/traces`, root `0700` / file `0600`, `O_NOFOLLOW`, `refuseExisting`, `trimTornTail`, rotasi satu generasi pada cap dari `options.maxBytes`, dan `append` yang mengembalikan `boolean` tanpa pernah melempar; `src/runtime.ts` dengan `openTrace` yang hanya memanggil writer saat `trace.enabled === true` dan **meneruskan `config.trace.maxBytes`**, `traceSink` yang menelan kegagalan, `tracedRunner`, `Runtime.trace`, dan `RuntimeOptions.traceHost`; test di `src/trace.test.ts`, `src/trace-security.contract.test.ts`, dan fixture-nya.

**Dua scope yang dulu terbuka, dan decision yang dipakai.** (1) `config.trace.maxBytes` **sampai ke writer** — `openTrace` memanggil `createTraceWriter({ enabled: true, maxBytes: config.trace.maxBytes })`, dan `TraceWriterOptions.maxBytes` menegakkan ceiling yang sama dengan config, jadi cap yang berlaku adalah cap yang ditulis user. **Konstanta internal 4 MiB yang lama sudah dihapus**; cap sekarang hanya satu sumber: config. (2) Record plugin **mendarat** sebagai `plugin-load`/`plugin-load-failed` { `name`, `required` } — **tanpa** path manifest, versi, atau teks error, karena `name` juga harus berbentuk nama plugin kanonik. Menambah varian ke union writer adalah perubahan schema, bukan detail.

**Yang tidak ada dan tidak boleh diklaim.** Tidak ada capability/service `trace:*`, `trace show`, `trace list`, reader/parser, TTL, garbage collection, retensi lebih dari satu generasi rotasi, kompresi, sampling, export, atau korelasi lintas proses di luar `runId` acak. Trace juga **bukan** akuntansi biaya dan bukan telemetry yang dibaca agent: `usage` hanya ikut apa yang provider laporkan, dan `model-mock` tidak melaporkannya. Lifecycle plugin yang ada di trace hanya nama dan boolean, dan plugin tidak punya cara membacanya. Writer ini **tidak** lewat `PermissionGate`, sama seperti session store 2.4. `4.6` dan `7.1`–`7.4` tetap `- [ ]`.

Bukti falsifiable per butir ada di `TASKS.md` (kotak 3.4); rinciannya di `docs/ARCHITECTURE.md` ("Status Task 3.4") dan `docs/PLUGIN_API.md` ("Trace log dan batasnya terhadap Plugin API (Task 3.4)").

## Nama

Produk/display: `NexusMycelium`; package root: `nexusmycelium`; package scope: `@nexusmycelium/*`; CLI executable/command: `nexus`.
