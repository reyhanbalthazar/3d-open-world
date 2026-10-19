// Builds the game-ready nature models in public/models/nature/ from Quaternius' Ultimate
// Stylized Nature pack (public/ultimate_stylized_nature_may_2022/), for the models listed
// in lib/nature-catalog.ts:
//   - glTF models: bark normal maps (~20 MB each) dropped, see-through foliage switched from
//     alpha blending to alpha testing (sorts correctly and casts leaf-shaped shadows)
//   - OBJ-only models (pine, rocks, plants...): copied; lib/nature.ts textures them by material name
//   - every texture used: shrunk to at most 1024 px
//
// Run again after changing the catalog:  npm run assets:nature

import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { NATURE_MODELS, OBJ_MATERIALS } from "../lib/nature-catalog.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "public/ultimate_stylized_nature_may_2022");
const OUT = join(ROOT, "public/models/nature");
const MAX_TEXTURE_SIZE = 1024;

interface TextureRef {
  index: number;
}

interface Gltf {
  materials?: Array<Record<string, unknown> & { alphaMode?: string; alphaCutoff?: number; normalTexture?: unknown }>;
  textures?: Array<{ source?: number; sampler?: number }>;
  images?: Array<{ uri?: string }>;
  buffers: Array<{ uri: string }>;
}

// every { index } texture reference inside a material (baseColorTexture, emissiveTexture...)
function textureRefs(value: unknown, refs: TextureRef[] = []): TextureRef[] {
  if (!value || typeof value !== "object") return refs;
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("Texture") && child && typeof (child as TextureRef).index === "number") {
      refs.push(child as TextureRef);
    } else {
      textureRefs(child, refs);
    }
  }
  return refs;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "textures"), { recursive: true });

const textures = new Set<string>(Object.values(OBJ_MATERIALS).map((material) => material.texture));

for (const [id, format] of Object.entries(NATURE_MODELS)) {
  if (format === "obj") {
    copyFileSync(join(SOURCE, "obj", `${id}.obj`), join(OUT, `${id}.obj`));
    continue;
  }

  const gltf: Gltf = JSON.parse(readFileSync(join(SOURCE, "gltf", `${id}.gltf`), "utf8"));

  for (const material of gltf.materials ?? []) {
    delete material.normalTexture;
    if (material.alphaMode === "BLEND") {
      material.alphaMode = "MASK";
      material.alphaCutoff = 0.5;
    }
  }

  // keep only the textures and images still referenced, renumbering the references
  const refs = (gltf.materials ?? []).flatMap((material) => textureRefs(material));
  const textureMap = new Map<number, number>();
  const imageMap = new Map<number, number>();
  const keptTextures: NonNullable<Gltf["textures"]> = [];
  const keptImages: NonNullable<Gltf["images"]> = [];

  for (const ref of refs) {
    if (!textureMap.has(ref.index)) {
      const texture = { ...gltf.textures![ref.index] };
      if (texture.source !== undefined) {
        if (!imageMap.has(texture.source)) {
          const uri = basename(gltf.images![texture.source].uri!);
          textures.add(uri);
          imageMap.set(texture.source, keptImages.push({ uri: `textures/${uri}` }) - 1);
        }
        texture.source = imageMap.get(texture.source);
      }
      textureMap.set(ref.index, keptTextures.push(texture) - 1);
    }
    ref.index = textureMap.get(ref.index)!;
  }
  gltf.textures = keptTextures;
  gltf.images = keptImages;

  for (const buffer of gltf.buffers) copyFileSync(join(SOURCE, "gltf", buffer.uri), join(OUT, buffer.uri));
  writeFileSync(join(OUT, `${id}.gltf`), JSON.stringify(gltf));
}

for (const name of textures) {
  const image = sharp(join(SOURCE, "gltf", name)).resize(MAX_TEXTURE_SIZE, MAX_TEXTURE_SIZE, {
    fit: "inside",
    withoutEnlargement: true,
  });
  const output = name.endsWith(".png") ? image.png({ compressionLevel: 9 }) : image.jpeg({ quality: 82, mozjpeg: true });
  await output.toFile(join(OUT, "textures", name));
}

const size = (path: string) => statSync(path).size;
const modelBytes = Object.entries(NATURE_MODELS).reduce((sum, [id, format]) => sum + size(join(OUT, `${id}.${format}`)), 0);
const textureBytes = [...textures].reduce((sum, name) => sum + size(join(OUT, "textures", name)), 0);
console.log(
  `${Object.keys(NATURE_MODELS).length} models (${(modelBytes / 1e6).toFixed(1)} MB without .bin), ` +
    `${textures.size} textures (${(textureBytes / 1e6).toFixed(1)} MB) written to public/models/nature`,
);
