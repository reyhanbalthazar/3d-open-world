# Platform Aset 3D Gratis

Catatan sumber aset 3D gratis untuk game ini (three.js), beserta lisensi dan tips pemakaiannya.

> Lisensi bisa berubah sewaktu-waktu. Selalu cek halaman lisensi di situsnya sebelum memakai aset.

## Arti lisensi singkat

| Lisensi | Boleh untuk game komersial? | Wajib kredit? |
|---|---|---|
| **CC0** (public domain) | Ya | Tidak |
| **CC-BY** | Ya | Ya, cantumkan nama pembuat |
| **CC-BY-NC** (NonCommercial) | **Tidak** | Ya |
| **Royalty-free** (misalnya Mixamo) | Ya, sesuai syarat platform | Biasanya tidak |

## Rekomendasi utama (CC0)

| Platform | Link | Isi | Cocok untuk |
|---|---|---|---|
| **Kenney** | https://kenney.nl/assets | Ribuan aset game low-poly: kota, alam, kendaraan, UI, suara | Isi dunia: pohon, rumah, pagar, koin |
| **Quaternius** | https://quaternius.com | Pack low-poly, termasuk karakter beranimasi (idle, jalan, lari) | Karakter pemain dan musuh, alam, senjata |
| **KayKit** | https://kaylousberg.itch.io | Pack low-poly bertema (dungeon, kota, karakter beranimasi) | Dunia bergaya kartun yang konsisten |
| **Poly Haven** | https://polyhaven.com | Model realistis, tekstur PBR, HDRI | Lantai, tanah, langit, pencahayaan |
| **ambientCG** | https://ambientcg.com | Tekstur PBR (rumput, batu, tanah, kayu) | Mengganti lantai kotak-kotak dengan rumput atau tanah |

## Sumber lain (cek lisensi per aset)

| Platform | Link | Catatan |
|---|---|---|
| **Poly Pizza** | https://poly.pizza | Mesin pencari model low-poly. Sebagian besar CC0, sebagian CC-BY. |
| **Sketchfab** | https://sketchfab.com | Koleksi terbesar. Centang filter *Downloadable*, lalu cek lisensi tiap model. Hindari yang *NonCommercial* kalau game-nya akan berbayar. |
| **Mixamo** | https://www.mixamo.com | Gratis dengan akun Adobe. Berisi karakter dan ribuan animasi (lompat, menari, menyerang), dan bisa memasang animasi ke karakter sendiri. Model Soldier di game ini berasal dari sini. |
| **itch.io** | https://itch.io/game-assets/free/tag-3d | Banyak pack dari kreator indie, lisensinya campur-campur. |
| **OpenGameArt** | https://opengameart.org | Arsip lama komunitas, lisensinya campur-campur. |

## Tips untuk proyek ini

- **Format `.glb` / `.gltf`** langsung bisa dimuat `GLTFLoader`. Kalau hanya ada FBX/OBJ, konversi lewat [Blender](https://www.blender.org) (gratis): *File → Import*, lalu *File → Export → glTF 2.0*.
- **Gaya visual konsisten.** Jangan campur low-poly dengan realistis. Untuk mini game, low-poly (Kenney, Quaternius, KayKit) paling aman dan ringan di browser.
- **Karakter beranimasi:** kode sekarang memilih animasi Soldier berdasarkan urutan clip (`CLIP_INDEX` di `lib/remote-players.ts`). Kalau ganti karakter, ubah supaya animasi dipilih berdasarkan nama (`Idle`, `Walk`, `Run`).
- **Ukuran file:** usahakan tiap model di bawah beberapa MB, karena setiap pemain harus mengunduhnya.
- **Lokasi file:** taruh model di `public/models/` dan tekstur di `public/textures/`.
- **Catat sumbernya.** Simpan nama aset, link, pembuat, dan lisensinya di `public/models/CREDITS.md`, terutama untuk aset CC-BY yang wajib kredit.

## Contoh format CREDITS.md

```md
| Aset | Sumber | Pembuat | Lisensi |
|---|---|---|---|
| soldier.glb | three.js examples (dari Mixamo) | Adobe Mixamo | Royalty-free |
| Nature Kit | https://kenney.nl/assets/nature-kit | Kenney | CC0 |
```
