# Agent Workflow — NexusMycelium

Dokumen ini adalah SOP kerja agent untuk NexusMycelium. Baca bersama `AGENTS.md` dan `docs/ARCHITECTURE.md` sebelum mengubah kode.

## 0. Scope dan safety

- Repo aktif: folder `nexus/` di dalam scaffold NexusMycelium. Path absolutnya tidak ditulis di dokumen ini; dari dalam repo, pakai `git rev-parse --show-toplevel`.
- Satu task = satu branch = satu perubahan kecil.
- Jangan menyentuh `user/` atau `data/` dari implementasi fitur.
- Jangan mengubah `kernel/` kecuali task menyebutkannya secara eksplisit.
- Jangan mengklaim fitur selesai hanya karena file dibuat. Jalankan check yang relevan.
- Jangan menambah dependency, framework, atau service sebelum ada task yang membutuhkannya.
- Jangan menulis nilai path, URL, atau key milik user ke dokumen tracked. Path runtime ditulis dengan placeholder `${HOME}` atau `${root}`.
- Jangan mengubah `kernel/`, `user/`, `data/`, `task-dashboard.html`, atau `scripts/` kecuali task menyebutkannya secara eksplisit.

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

## 2. Test lebih dulu

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

## 5.1 Aturan dokumentasi dan checkbox

- Dokumentasi harus cocok dengan source. Sebelum menulis klaim, cek implementasi; jika fitur belum ada, tulis sebagai batas yang belum ada, bukan sebagai kemampuan.
- Setiap ✓ kriteria harus falsifiable: sebutkan test, command, atau file yang membuktikan atau menggagalkannya, dan tandai `terpenuhi` atau `belum` per butir. Kriteria kabular seperti "baseline sudah ada" tidak boleh dipakai.
- Kotak `- [ ]` tidak dicentang hanya karena file dibuat atau test lokal hijau. Kotak kernel baru dicentang setelah full gate di bagian 4 dijalankan hijau pada working tree yang sama dan tiap butir ✓ punya test atau command yang memalsukannya. Task 1.2, 1.3, dan 2.4 sudah dicentang dengan cara itu pada 2026-09-26.
- Angka benchmark selalu menyebut provenance: provider mock, `reproducibilityHash` dari `benchmarks/README.md`, usage `unavailable`, cost `mock-not-billed`. Jangan menyebutnya tagihan, biaya live, atau SLA.
- Jangan menulis "terminal", "rollback", "isolated", atau "hot swap" untuk perilaku yang belum ada di source.
- Desain yang sudah disepakati tetapi belum diimplementasikan ditulis sebagai desain, bukan sebagai kemampuan. Task 2.4 adalah kasus dua arah: saat pertama kali didokumentasikan, desainnya final sementara implementasinya belum ada; setelah implementasi masuk working tree dan full gate hijau pada 2026-09-26, dokumen menyebut gate yang sudah dijalankan plus batas yang masih kosong, bukan langsung menulis "sudah ada". Nama file dan nama test boleh disebut sebagai kriteria, dan harus dinyatakan eksplisit apakah keduanya sudah ada atau belum.
- Setiap nama test yang dikutip di `TASKS.md` atau `docs/` harus **persis** ada di file test-nya, termasuk sufiksnya. Dua nama test 2.4 pernah keliru dikutip dan sudah dikoreksi: yang benar adalah "never persists provider config, secret paths, or headers in the record envelope" dan "keeps secret paths and absolute locations out of stored tool-call arguments". Verifikasi cepat: `grep -oE 'it\("[^"]+"' src/session*.test.ts src/runtime.test.ts src/cli.test.ts`.
- Bukti "tidak disentuh" harus tahan hype. `git diff --stat -- task-dashboard.html scripts/` **tidak** kosong di working tree ini, karena `task-dashboard.html` sudah berubah di task lain; bukti yang benar untuk 2.4 adalah `grep -rin session task-dashboard.html scripts/` yang tidak menghasilkan apa pun. Jangan memakai "diff kosong" sebagai bukti kalau working tree sudah accumulating perubahan dari task sebelumnya.
- Kalau sebuah task menolak sebuah opsi (`SQLite`, dependency baru, dashboard), alasan penolakan itu ikut ditulis supaya task berikutnya tidak mengulang opsi itu lagi. Untuk 2.4, session store juga tidak lewat `PermissionGate`; memindahkan writer ke dalam permission gate adalah perubahan keamanan dan butuh task tersendiri, bukan detail kecil.
- **Ambang yang longgar tidak menutup kotak dengan sendirinya.** Kalau ambang sebuah task lebih longgar dari gate yang sudah ada, angka itu tidak bisa dipakai sebagai achievement task tersebut. Task 2.6 adalah kasusnya: ambang ≥ 5/20 dari 20 tugas, sementara `bench:20` sudah mewajibkan 20/20, jadi secara aritmetika 2.6 sudah terpenuhi jauh sebelum kotaknya dicentang — tetapi 8 test di `benchmarks/run.test.ts` adalah kontrak benchmark 0.4 dan tidak satu pun mengencodings ambang 2.6, sehingga pada 2026-09-26 kotaknya **belum** dicentang. Yang menutup 2.6 bukan 20/20 milik 0.4, melainkan harness acceptance baru: `benchmarks/accept.ts` dengan `MIN_SUCCEEDED = 5` dan `CANONICAL_TASKS = 20`, 6 test di `benchmarks/acceptance.test.ts`, dan script `bench:accept`. Pelajaran yang bisa dipakai task lain: kalau ambang task lebih longgar dari gate yang sudah ada, **tulis test yang mengencodings ambang itu secara eksplisit** — termasuk di batasnya, bukan hanya di atasnya. "passes at exactly five end-to-end successes and fails below the floor" menguji 5 → `accepted` dan 4 → ditolak, jadi ambangnya dipalsukan, bukan hanya ditembus.
- **Test negatif wajib, bukan cuma test hijau.** Gate apa pun yang mengevaluate `status` atau `success` harus punya test yang memalsukan input sehingga gate itu menolak, dan test itu harus menyatakan bentuk penolakannya. Untuk 2.6, "rejects a wrong expected artifact even when the runner status is completed" memakai `expected` yang salah sehingga `status` tetap `completed` dengan `steps > 0` dan `toolCalls > 0`, tetapi `success: false` dengan `error: "expected-files-mismatch"`; itulah yang membuktikan gate tidak bisa dilewati lewat status. "exits 1 and reports a rejection when the harness fails" membuktikan kegagalan harness exit 1 dan tidak pernah jadi lulus.
- **Pisahkan "pipeline yang berjalan" dari "kemampuan yang diukur".** Benchmark mock membuktikan plumbing harness/tool/verifier, bukan kemampuan coding model, karena `model-mock` hanya mem-parsing prompt dengan regex dan meneruskan konten yang sudah tertulis di prompt. Kalau suatu task mengklaim benchmark mock sebagai bukti kualitas model, tulis eksplisit apa yang tidak dibuktikan: provider deterministic, task bertipe tulis-satu-file-dengan-konten-persis, dan runner bounded `maxSteps: 4` / `maxToolCalls: 2`. Jangan lupa menyebut bahwa `elapsedMs` yang kecil adalah konsekuensi provider offline, bukan kecepatan model.
- **"Tidak aktif", "tidak ada", dan "sudah ada" adalah tiga klaim berbeda.** Untuk 3.3 ketiganya berlaku pada saat yang berbeda, jadi dokumen harus menyebut yang mana. Policy, konstanta, blok config, `usage?` opsional, dan enforcement di `plugins/loop-react/src/index.ts` **ada**; full gate **sudah** hijau dan kotak 3.3 sudah dicentang. Yang tetap harus ditulis terpisah: apa yang ada, apa yang **tidak** ada sama sekali (flag CLI, persistence usage, event usage, akuntansi nyata), dan apa yang hanya ditunda. Menulis "budget guard sudah ada" tanpa menyebut bagian yang memang tidak ada adalah klaim pals juga.
- **Tiga lapis yang sering tertukar: tipe, config, default — dan keempatnya, enforcement.** (a) *Tipe*: `BUDGET_STOP_REASONS` adalah kosakata; kalau tidak ada yang menghasilkannya, itu daftar yang tidak dijalankan. (b) *Config*: blok `budget` strict bisa di-resolve, ditolak, dan di-overlay, tapi nilainya baru berarti kalau ada yang membacanya saat run. (c) *Default*: `enabled: false` plus `null` untuk tiap cap berarti guard mati **karena default**, bukan karena tidak ada cara mengaktifkannya — `null` berarti "tanpa plafon", bukan nol, dan `config/default.yaml` memuat blok itu dengan `enabled: false` serta ketiga cap `null`. Pelajaran 3.3: (a) dan (b) bisa hijau sementara (c) dan closure-nya belum, jadi lapis tidak boleh dijumlahkan menjadi "selesai" — dan setelah semua lapis hijau, **angka suite baru boleh dikutip** di kotak itu.
- **Dua kosakata yang berbeda adalah bug kontrak, bukan detail.** 3.3 pernah menerbitkan `BUDGET_STOP_REASONS` di kernel (`max-total-tokens`/`max-cost-usd`/`max-elapsed-ms`) lalu runner emitting `budget:time`/`budget:tokens`/`budget:cost`/`budget:usage-unavailable`/`budget:cost-unpriced`, sehingga konstanta kernel **tidak dipakai apa pun di luar turunannya sendiri**. Closure-nya: kernel menerbitkan kelima konstanta itu sendiri, runner **me-re-export**-nya alih-alih menyalin nilai, dan keanggotaan kosakata diuji lewat `new Set(BUDGET_STOP_REASONS)`. Aturannya tetap: kalau sebuah konstanta diterbitkan untuk konsumen, ia harus diuji dari **titik konsumsi**, bukan hanya dari deklarasinya — "reports the kernel's stop reason vocabulary as the one the loop actually emits" persis itu. Dan `AgentResult` tidak punya `stopReason`, jadi `error` yang diurai dengan pencocokan string tidak boleh dihitung sebagai API stabil.
- **Angka nol bukan pengukuran, termasuk di dalam tipe baru.** `usage.status unavailable` dan `cost 0 / mock-not-billed` adalah placeholder. Sekarang `ModelUsage` sudah ada di kontrak, jadi godaannya lebih besar: usage yang tidak diketahui harus **tidak ada**, bukan `0`. Tiga lapis yang menjaga itu di 3.3: `parseUsage` di `plugins/model-openai` mengembalikan `undefined` untuk blok `null`, hilang, kurang satu penghitung, atau `0/0/0`; `parseUsage` di `plugins/loop-react` hanya menerima tiga angka finite plus `source` non-kosong dan memotongnya di 64 karakter; dan `budgetStop()` mengembalikan `BUDGET_USAGE_UNAVAILABLE` bila ada cap aktif tanpa laporan — **fail closed**, bukan melanjutkan tanpa pengukuran. Nol karangan akan menghitung under-count, jadi lebih berbahaya daripada tidak ada angka. Suite live 9Router dan akuntansi token/biaya nyata tetap ditunda; acceptance harness tidak boleh mengarang usage untuk menutupi kekosongan itu.
- **"Biaya gratis" adalah asumsi yang harus gagal closed.** Kernel tidak pernah menebak harga: `ModelPrice` disuplai caller, `resolveBudgetPolicy` menolak entri harga yang tidak lengkap atau negatif, dan `configBudget()` menolak pasangan harga yang hanya separuh. Di runner, cap biaya tanpa harga untuk model itu menghasilkan `BUDGET_COST_UNPRICED` pada langkah pertama, bukan "gratis". Hitungannya juga harus flawless secara aritmetika: 3.3 memakai mikro-USD bulat (`tokens * usdPerMillion` dibandingkan `cap * 1_000_000`) justru supaya pembulatan float tidak bisa membuat cap lolos — pola yang layak ditiru task biaya lain.
- **Pakai kembali yang sudah ada, dan jangan menghitungnya sebagai achievement task baru.** Batas langkah, jumlah tool call, dan wall-clock per run sudah ada jauh sebelum 3.3 lewat `agent.maxSteps`/`agent.maxToolCalls`/`agent.timeoutMs` dengan empat alasan stop konstan. 3.3 tidak boleh mengklaimnya, dan `budget.maxElapsedMs` tidak boleh ditulis sebagai penggantinya sampai interaksinya dengan `agent.timeoutMs` diputuskan dan dipalsukan test. Pola sama berlaku di kotak lain: 3.1 tidak mengklaim rollback (1.2), dan 3.2 tidak mengklaim snapshot sebagai isolasi benchmark.
- **Bila sebuah task butuh mapping antar lapis, mapping itu bagian task — dan harus diuji dari lapisan itu.** Config `budget.prices` memakai **nama field yang sama persis** dengan `ModelPrice` — `inputUsdPerMillionTokens` dan `outputUsdPerMillionTokens` — sebagai peta berkunci nama model, dan yang menjembataninya ke enforcement adalah `configBudget()` di `src/runtime.ts` (meneruskan peta itu apa adanya) plus `modelIdentity` yang dibawa `AgentRunnerFactory = (model, modelName)`. Test yang memanggil `resolveBudgetPolicy` langsung **tidak** membuktikan jalur config, dan test jalur config **tidak** membuktikan runner; jalur penuh baru terbukti oleh test yang menjalankan run sungguhan — "enforces a configured cost cap on a real loop, priced by the configured model". Tiga lapis itu perlu tiga test, bukan satu. Dan **jangan menulis bentuk config yang tidak ada**: `budget.prices` bukan pasangan datar `{ inputUsdPerMillion, outputUsdPerMillion }`, dan runtime tidak lagi mengikat harga ke satu model.
- **Persistence adalah keputusan yang harus ditulis, bukan kelalaian.** Usage tidak ada di schema session v1: `src/session.ts` tidak memuat `usage`, `runEndSchema` tetap `.strict()` dengan `status`, `text?`, `error?`, `limits?`, dan budget hanya diteruskan ke runner tanpa pernah ditulis. Konsekuensi yang wajib disebut: `run-end` tidak dapat membedakan stop budget dari stop langkah, dan usage tidak dapat dibangun ulang lintas proses. Bukti "tidak dipersistensi" di sini adalah assertion isi file yang tidak cocok dengan pola (`expect(await fixture.bytes(id)).not.toMatch(/budget|maxTokens|maxCostUsd/)`) plus test stdout, bukan sekadar ketiadaan key.
- **Arahkan pembaca ke sumber angka.** Angka `elapsedMs`, `taskSetHash`, `reproducibilityHash`, dan `cost` hanya boleh dikutip bersama sumbernya di `benchmarks/README.md`, dan hanya sebagai observasi satu run. Task yang memakai pipeline benchmark tidak mendapat hak atas angka itu sebagai kebaruan; kalau task baru menghasilkan angka yang **identik** dengan task lama karena membaca report yang sama, itu harus disebut eksplisit. Konkret untuk 3.3: `usage` dan `cost` di `benchmarks/run.ts` adalah **literal di source**, `runBenchmark` memaksa provider `mock`, dan `model-mock` tidak melaporkan usage — jadi contract `usage?` yang baru **tidak mengubah satu pun angka** dan `taskSetHash`/`reproducibilityHash` tidak boleh bergeser.
- **Judul task yang menyebut opsi tidak boleh ditulis seolah opsi itu yang dipakai.** Task 3.1 judulnya "sandbox runner (container atau git worktree terisolasi)", tetapi yang diimplementasikan adalah process/workspace sandbox di host — tanpa container dan tanpa `git worktree`. Laporkan yang benar-benar ada plus daftar yang tidak ada, dan sebut alasan kalau opsi judulnya memang tidak diambil. Gap yang harus ditulis eksplisit adalah "tidak ada container, `git worktree`, namespace, seccomp, cgroup, `uid` drop" dan "bukan pertahanan terhadap plugin in-process yang berbahaya", karena ketiadaan itu yang mencegah docs ini dibaca sebagai klaim keamanan.
- **Test yang platform-spesifik harus disebut apa adanya.** Bukti process-group di `src/sandbox-security.contract.test.ts` ("kills a child that ignores the deadline, grandchild included") adalah `it.skipIf(!posix)`, jadi ia dilewati di platform non-POSIX. Test yang punya kondisi platform tidak boleh dihitung sebagai jaminan lintas platform.
- **Nama test yang belum ada hanya boleh ditulis sebagai spesifikasi, tidak sebagai bukti.** Aturan di atas melarang mengutip nama test yang tidak persis ada di file test-nya. Untuk task yang belum diimplementasikan, kriterianya tetap harus falsifiable, jadi nama test yang **dipersyaratkan** boleh ditulis asal ditandai eksplisit `belum` dan disebut bahwa nama itu belum ada di repo. Kotak tetap `- [ ]` sampai test-nya benar-benar ada **dan** coordinator menjalankan full gate bagian 4. Kebalikannya juga berlaku: nama test yang sudah ada di file test-nya **bukan** bukti bahwa task-nya hijau — task 3.2 pernah persis dalam keadaan itu, dengan `src/snapshot.test.ts` dan test CLI sudah ada tapi kotaknya tetap `- [ ]` karena dua gap masih terbuka (containment direktori temp itu sendiri, dan auto-restore level sandbox yang belum punya test langsung). Yang menutupnya bukan tambahan file, melainkan test yang memalsukan kedua gap itu plus full gate 2026-09-27, setelah itu kotaknya jadi `- [x]`. Suite yang sedang disunting tidak boleh dikutip angkanya di docs; gate coordinator satu-satunya berwenang atas angka itu.
- **Klaim mekanisme harus dicek ke source, bukan ke versi dokumen sebelumnya.** Task 3.2 pernah di dokumenkan dengan marker `.git/nexus-snapshot` sebagai containment — **tidak ada marker itu di implementasi**. Yang benar adalah perbandingan `rev-parse --absolute-git-dir` dengan `realpath(<root>/.git)`, dan `grep -rn "nexus-snapshot" src/ kernel/src/ plugins/*/src` hanya mengenai prefix scratch di test. Aturan yang berlaku: nama file, flag, marker, option, dan nama test yang dikutip harus dicek ulang ke source setiap kali doc disentuh, karena versi dokumen sebelumnya bisa saja sudah menyimpang tanpa ada yang memperingatkan.
- **"Rollback" harus menyatakan targetnya.** Satu-satunya rollback yang benar-benar ada di source adalah rollback **objek plugin** di `reload()` (1.2). Snapshot/rollback git 3.2 hanya memulihkan **isi workspace sandbox temp**, tidak pernah repo developer dan tidak pernah checkout plugin official — `canonicalRoot()` di `src/snapshot.ts` menolak apa pun yang bukan absolut atau bukan direktori, apa pun yang tidak ada di dalam OS temp (termasuk temp dir itu sendiri), dan apa pun yang git-nya menempatkan git dir milik orang lain. Jangan menulis "rollback" tanpa menyebut yang dipulihkan, karena pembacaan itu yang membuat entri 3.2 terbaca sebagai klaim keamanan yang belum ada. `worktree` repo developer, canary, monitor, dan keputusan swap tetap 7.1.
- **Nama yang di-import harus dicek dari titik pemanggilnya, dan test yang hanya menguji satu sisi tidak menutup task.** 3.4 pernah punya dua kontrak yang tidak pernah bertemu: `src/runtime.ts` meng-import `./trace.js` dan memanggil `factory.createTrace({ root, enabled, maxBytes })`, sementara `src/trace.ts` hanya mengekspor `createTraceWriter(options)` dan tanpa `close()`. Karena nama yang di-import tidak ada, `openTrace()` menangkap `TypeError`-nya dan run berakhir **untraced** dengan satu baris warn — jadi semua test writer bisa hijau sementara tidak ada satu pun run yang menulis trace. Aturannya: sebelum menyatakan sebuah task "ada", jalankan **grep nama yang di-import** di titik pemanggil (`grep -rn "createTrace" src/ kernel/src/`) dan pastikan simbol itu benar-benar diekspor; dan kalau satu task memang butuh dua sisi, **test integrasi yang memanggil sisi produksi lewat seam yang sama** adalah criteria wajib, bukan opsional. Kelas yang sama: dua kosakata event yang berbeda (`run-step` di writer melawan `step-end`/tambahan `plugin-*` di runtime) tidak akan pernah saling mengenali, dan tidak ada test yang gagal kalau keduanya hidup berdampingan.
- **Config yang tidak punya konsumen adalah tipe yang belum jadi, dan harus ditulis begitu — sampai consumer-nya benar-benar ada.** `trace.maxBytes` pernah strict, punya default `1_048_576`, punya ceiling `67_108_864`, dan sudah muncul di `config/default.yaml` — lalu `openTrace` memanggil `createTraceWriter({ enabled: true })` **tanpa** `maxBytes`, dan `TraceWriterOptions` juga tidak punya opsi itu, sehingga cap yang benar-benar berlaku adalah konstanta internal yang tidak ada hubungannya dengan config. Lapis config hijau, lapis writer hijau, closure-nya belum; itu persis pola "tipe, config, default, enforcement" dari 3.3, jadi aturan yang sama berlaku: **jangan menjumlahkan lapis menjadi "selesai"**, dan kalau sebuah field config belum punya konsumen, tulis sebagai `belum` beserta alasannya, bukan sebagai kemampuan. **Closure 3.4 membuktikannya**: `openTrace` kini meneruskan `maxBytes: config.trace.maxBytes`, `TraceWriterOptions` menegakkan ceiling yang sama dengan config, konstanta cap internal dihapus, dan closure itu dijaga "passes config.trace.maxBytes to the writer, so the cap is the configured one" (`src/runtime.test.ts`) plus "rotates at the cap it was given, not at a constant of its own" (`src/trace.test.ts`).
- **"Ditolak oleh desain" dan "ditolak karena belum selesai" adalah dua klaim berbeda, dan yang kedua tidak boleh ditulis sebagai batas.** 3.4 punya lima jenis record dari host — `run-start`, `run-step`, `run-end`, plus `plugin-load` dan `plugin-load-failed` — sementara union writer hanya punya tiga. Awalnya itu ditutup dengan `as unknown as TraceInput`, yang membuatnya terlihat "tidak error" padahal record-nya tidak pernah mendarat; bentuk berikutnya satu cast di satu boundary dengan komentar yang menyebut alasannya, plus `stats().failures` dan satu `logger.warn` per tipe. Bentuk itu **boleh** jadi batas, karena ia menutup gap secara eksplisit dan measurable: test runtime yang membacanya `trace.jsonl` sungguhan (nama test-nya sudah tidak ada di repo setelah closure, jadi tidak boleh dikutip sebagai bukti) menyatakan isinya tepat `["run-start","run-step","run-end"]`, lalu menyatakan `failures` = 4 untuk record yang memang tidak punya slot. Pelajarannya: setiap record yang host kirim harus punya test yang **menyatakan di file mana pun ia tidak muncul** — bukan test yang memeriksa warn — supaya "ditolak" jadi terukur dan tidak bisa disamarkan jadi "sudah ada". Dan `grep -rn "as unknown as" src/` tetap cara tercepat menemukan cast yang menyembunyikan gap. **Closure 3.4 mengambil jalan ketiga**: kedua bentuk plugin jadi varian union yang sempit { `name`, `required` }, cast itu dihapus (`grep -rn "HostRecord" src/` dan `grep -rn "as unknown as" src/` kosong), dan test sekarang menyatakan record-nya **ada** di file, sementara sempitnya dibuktikan "stores a plugin outcome as a name and a boolean, and nothing else" (`src/trace.test.ts`). Aturan untuk task berikutnya tidak berubah: kalau sebuah batas ternyata menutupi kerja yang belum selesai, tutup itu dengan test-nya — jangan menutupnya dengan label yang nyaman.
- **Satu lokasi default yang berbeda antara dua lapisan adalah konflik desain, bukan detail — dan harus ada test yang memeriksa path yang benar-benar ditulis.** Default writer adalah `${HOME}/.config/nexus/user/traces`, dan `data/` ditolak sebagai lokasi state user oleh Task 2.4 karena berada di volume fuseblk yang sama dengan repo. Config trace sengaja tidak punya key lokasi, jadi tidak ada yang mengikat default itu ke lokasi produksi. Test yang menguji **default** writer tidak membuktikan lokasi produksi; yang membuktikannya adalah test yang menjalankan `run`/`createRuntime` dan memeriksa path yang benar-benar ditulis. **Closure 3.4**: hanya ada satu lokasi — `openTrace` **tidak** meng-override root, dan "writes only inside its own root: the repo user/data/config and the real home stay identical" (contract) membuktikannya untuk jalur produksi. Yang tetap berlaku adalah aturan kuncinya: test default writer dan test jalur produksi adalah dua bukti berbeda, dan yang menutup kotak adalah yang kedua.

## 6. Commit dan serah terima

1. Commit kecil dengan pesan yang menyebut task, misalnya `task/1.4: add config resolution`.
2. Pastikan diff dan status bersih setelah commit.
3. Isi `TASKS.md` hanya setelah kriteria selesai terverifikasi, dan untuk task kernel hanya setelah coordinator menjalankan acceptance run penuh.
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

Tahap `smoke sandbox` punya satu primitive yang sudah ada sejak 3.1: `node dist/src/cli.js run --sandbox "<task>"` menjalankan satu task hermetik di akar sementara dan mencetak satu baris JSON dengan `workspaceCleaned`. Yang **belum** ada adalah pipeline yang memanggilnya sebagai gate, Cananya, monitor, rollback, dan `worktree` itu sendiri. Satu run sandbox yang hijau bukan keputusan swap, dan process/workspace sandbox itu bukan sandbox OS maupun pertahanan terhadap plugin in-process.

Snapshot/restore git **3.2** sudah tertutup (full gate 2026-09-27) dan **tidak menambah tahap gate mana pun**. Implementasinya ada di `src/snapshot.ts` dengan `createSnapshot`/`restoreSnapshot`, sudah di-import `src/sandbox.ts` dan di-wire ke `node dist/src/cli.js run --sandbox --snapshot <task>`, yang membaseline workspace lalu restore otomatis apa pun hasil run. Cakupannya hanya workspace sandbox temp: baseline commit, `reset --hard` + `clean -fd` dengan berkas ignored dipertahankan, env git disaring, deadline dan output cap per perintah git, dan `rolledBack` sebagai satu-satunya laporan. Repo developer tidak pernah di-snapshot dan tidak pernah di-rollback, dan `worktree` repo developer, canary, monitor, serta keputusan swap tetap **7.1**. Satu run snapshot yang hijau juga bukan keputusan swap. Kriteria falsifiable 3.2 ada di `TASKS.md`.

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

Jangan menambah provider, MCP, memory, scheduler, UI, atau Laya sebelum task yang membutuhkannya aktif. Task 1.2 dan 1.3 sudah closed; sebelum lanjut, baca "Status Task 1.2" dan "Status Task 1.3" di `docs/ARCHITECTURE.md` supaya tidak menulis ulang perilaku yang sudah ada dan tidak mengklaim yang belum ada. Gate, canary, watcher, dan hot reload plugin buatan agent masih kosong di 7.1/7.4.

Sebelum mengerjakan 2.4, baca "Status Task 2.4" di `docs/ARCHITECTURE.md`. Implementasinya sudah ada di working tree dan 2.4 sudah dicentang setelah full gate hijau, jadi tidak ada yang perlu designing dari nol: bentuk record, lokasi path, aturan path, batas ukuran, semantika resume dan fork, perilaku CLI yang sudah terverifikasi, serta daftar hal yang sengaja ditolak sudah tercatat di sana. Kalau source dan dokumen itu berbeda, source yang menang dan dokumen yang diperbaiki — jangan menulis ulang source supaya cocok dengan dokumen lama.

Kotak 2.4 sudah dicentang pada 2026-09-26 setelah full gate hijau di working tree yang sama. Aturan itu bukan hak khusus 2.4: dokumentasi desain saja tidak cukup untuk mencentang kotak mana pun, dan test hijau lokal juga tidak cukup.

Kotak 2.4 sudah dicentang pada 2026-09-26 setelah full gate hijau di working tree yang sama. Aturan itu bukan hak khusus 2.4: dokumentasi desain saja tidak cukup untuk mencentang kotak mana pun, dan test hijau lokal juga tidak cukup.

Kotak 2.6 sudah dicentang pada 2026-09-26, tetapi **bukan** karena 20/20 dari 0.4 — melainkan karena acceptance harness khusus yang mengencodings ambangnya: `benchmarks/accept.ts` dengan `MIN_SUCCEEDED = 5` dan `CANONICAL_TASKS = 20`, 6 test di `benchmarks/acceptance.test.ts`, dan script `bench:accept`. Baca "Status Task 2.6" di `docs/ARCHITECTURE.md` dan "Status Task 2.6" di `benchmarks/README.md` sebelum mengubah apa pun di sana: keduanya sudah memisahkan apa yang dibuktikan run itu (plumbing harness/tool/verifier) dari apa yang tidak dibuktikan (kemampuan coding model open-ended), dan apa yang tetap ditunda (suite live 9Router, akuntansi token/biaya nyata, budget guard 3.3).

Kalau ada task benchmark berikutnya, dua hal ini yang harus diulang: test negatif yang memalsukan input sehingga gate menolak, dan angka nol yang ditulis sebagai `unavailable`/`mock-not-billed` alih-alih sebagai hasil pengukuran. Acceptance harness tidak boleh mengarang usage, dan tidak boleh punya mode report-only yang mengubah penolakan menjadi lulus.

Task 3.3 sudah ditutup pada 2026-09-27 dan kotaknya sudah `- [x]`. Baca "Status Task 3.3" di `docs/ARCHITECTURE.md` dan "Budget guard dan batasnya terhadap Plugin API (Task 3.3)" di `docs/PLUGIN_API.md` sebelum mengubah apa pun di sana. Cara kotaknya menutup adalah contoh yang layak ditiru: **enforcement sudah ada** di `plugins/loop-react/src/index.ts` sejak awal, dan yang menutup kotak bukan dokumentasi tambahan melainkan **tiga kegagalan contract** — satu kosakata alasan stop (kernel menerbitkan `budget:*` sendiri dan loop me-re-export-nya), jalur cap biaya ter-meter (`modelIdentity` yang dibawa factory), dan resume yang boleh melemahkan batas (`tightestLimits()` dengan `Math.min` per field) — yang semuanya dipalsukan test, **lalu** gate bagian 4 (`lint`, `typecheck`, `test`, `build`, `bench:smoke`, `bench:20`, `bench:accept`, `git diff --check`) dijalankan **pada working tree yang sama**; kotaknya baru dicentang setelah itu. Angka gate yang tercatat: `Checked 79 files`, `tsc --noEmit` bersih, 370 test di 30 file + 2 `node --test`, `bench:20` 20/20, `bench:accept` `accepted`, `git diff --check` tanpa output. Yang tidak berubah dan tidak boleh lupa: usage tidak dipersistensi di session v1, tidak ada flag CLI budget, tidak ada event `usage:*`, dan `agent.maxSteps`/`maxToolCalls`/`timeoutMs` bukan achievement 3.3. Kalau sebuah task memutuskan sebaliknya — usage masuk record session, atau ada event `usage:*`, atau salah satu dari lima konstanta alasan stop diganti — itu perubahan kontrak dan butuh migration guide plus adapter/compatibility test, bukan tambahan kecil.
