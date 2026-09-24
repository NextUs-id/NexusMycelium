# Plugin API (v1, draf)

## Manifest
| Field | Tipe | Keterangan |
|---|---|---|
| `name` | string (kebab-case) | Unik, contoh `loop-react` |
| `version` | semver `x.y.z` | Versi plugin |
| `apiVersion` | `1` | Versi API kernel yang dituju |
| `description` | string | Opsional |
| `provides` | string[] | Kapabilitas, contoh `["tool:fs"]` |
| `requires` | string[] | Plugin yang harus dimuat lebih dulu |
| `permissions` | `fs.read` \| `fs.write` \| `shell` \| `network` | Izin yang diminta (ditegakkan di Task 1.5) |

## Kontrak
```ts
import { definePlugin } from "@nexus/kernel";

export default definePlugin({
  manifest: { name: "my-plugin", version: "0.1.0", apiVersion: 1 },
  setup({ events, log, config }) {
    // daftarkan handler / tool di sini
    return () => {
      // cleanup: dipanggil saat unload atau hot swap
    };
  },
});
```
- `setup` boleh async dan boleh mengembalikan **disposer**.
- Disposer wajib membersihkan semua yang didaftarkan (handler, timer, koneksi).
- `config` = default official digabung config user.

## Aturan
1. Plugin tidak mengimpor plugin lain secara langsung; berkomunikasi lewat event atau kapabilitas `provides`/`requires`.
2. Plugin tidak mengakses `user/` atau `data/` selain lewat API kernel.
3. Perubahan `apiVersion` butuh migrasi terdokumentasi; versi lama tidak dihapus.
4. Plugin buatan agent memakai kontrak yang sama, tetapi wajib lolos gate.

## Membuat plugin baru
1. Salin `plugins/example-hello/` ke `plugins/<nama>/`.
2. Ubah `name` di `package.json` dan manifest.
3. Tulis tes dulu, lalu implementasi.
4. Jalankan `pnpm check`.
