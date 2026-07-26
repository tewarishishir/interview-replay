/**
 * Generates PNG favicon files at required sizes from public/favicon.svg.
 * Run once after brand changes: node scripts/generate-favicons.mjs
 *
 * Requires sharp (already a transitive dep via Next.js image optimisation).
 * Output files land in public/ and are committed to the repo.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const svgPath = resolve(root, "public", "favicon.svg");
const svgBuffer = readFileSync(svgPath);

// Sizes required by the favicon spec + Google search result requirements
const sizes = [32, 64, 180, 192, 256, 512];

// Sharp lives in the pnpm store — resolve it relative to the project root
// so the script works without a dedicated dev-dependency entry.
const sharpPath = new URL(
  "../node_modules/.pnpm/sharp@0.34.5/node_modules/sharp/lib/index.js",
  import.meta.url
);
const { default: sharp } = await import(sharpPath);

console.log("Generating favicons from public/favicon.svg …");

for (const size of sizes) {
  const outPath = resolve(root, "public", `favicon-${size}.png`);
  await sharp(svgBuffer)
    .resize(size, size)
    .png()
    .toFile(outPath);
  console.log(`  ✓ favicon-${size}.png`);
}

// Generate favicon.ico from the 32×32 PNG (browsers still prefer .ico for <link rel="shortcut icon">)
// We embed a single 32×32 image inside the ICO container.
const png32 = await sharp(svgBuffer).resize(32, 32).png().toBuffer();

// Minimal ICO file: header + one directory entry + image data
// Reference: https://en.wikipedia.org/wiki/ICO_(file_format)
function buildIco(pngBuffer) {
  const imageData = pngBuffer;
  const dataOffset = 6 + 16; // ICONDIR (6) + one ICONDIRENTRY (16)
  const buf = Buffer.alloc(dataOffset + imageData.length);

  // ICONDIR
  buf.writeUInt16LE(0, 0);      // reserved
  buf.writeUInt16LE(1, 2);      // type: 1 = ICO
  buf.writeUInt16LE(1, 4);      // count: 1 image

  // ICONDIRENTRY
  buf.writeUInt8(32, 6);        // width  (0 = 256)
  buf.writeUInt8(32, 7);        // height (0 = 256)
  buf.writeUInt8(0, 8);         // color count (0 = no palette)
  buf.writeUInt8(0, 9);         // reserved
  buf.writeUInt16LE(1, 10);     // color planes
  buf.writeUInt16LE(32, 12);    // bits per pixel
  buf.writeUInt32LE(imageData.length, 14); // size of image data
  buf.writeUInt32LE(dataOffset, 18);       // offset of image data

  imageData.copy(buf, dataOffset);
  return buf;
}

const icoPath = resolve(root, "public", "favicon.ico");
writeFileSync(icoPath, buildIco(png32));
console.log("  ✓ favicon.ico");

console.log("\nDone. All favicon files written to public/");
