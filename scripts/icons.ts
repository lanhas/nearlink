import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

await mkdir('build/icon.iconset', { recursive: true })
const svg = await readFile('resources/icon.svg')
for (const size of [16, 32, 64, 128, 256, 512]) {
  await sharp(svg).resize(size, size).png().toFile(`build/icon.iconset/icon_${size}x${size}.png`)
  await sharp(svg)
    .resize(size * 2, size * 2)
    .png()
    .toFile(`build/icon.iconset/icon_${size}x${size}@2x.png`)
}
await sharp(svg).resize(1024).png().toFile('resources/icon.png')
await writeFile('build/icon.ico', await pngToIco(await sharp(svg).resize(256).png().toBuffer()))
// ICNS uses a big-endian container of PNG representations. This also generates
// macOS icons on Windows/Linux, without an OS-specific icon compiler.
const chunks: Buffer[] = []
for (const [kind, size] of [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024]
] as const) {
  const png = await sharp(svg).resize(size).png().toBuffer()
  const header = Buffer.alloc(8)
  header.write(kind)
  header.writeUInt32BE(png.length + 8, 4)
  chunks.push(header, png)
}
const header = Buffer.alloc(8)
header.write('icns')
header.writeUInt32BE(8 + chunks.reduce((n, chunk) => n + chunk.length, 0), 4)
await writeFile('build/icon.icns', Buffer.concat([header, ...chunks]))
console.log('Nearlink icons generated.')
