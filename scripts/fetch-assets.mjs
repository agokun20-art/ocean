// Downloads the CC0 assets (Poly Haven) used by the scene into public/assets.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');
const SKIES = [
  'qwantani_sunset', 'syferfontein_6d_clear', 'sunflowers', 'kloofendal_48d_partly_cloudy',
  'industrial_sunset_02', 'mud_road',
];

const exists = (p) => access(p).then(() => true, () => false);

async function download(url, file) {
  if (await exists(file)) return;
  await mkdir(dirname(file), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  console.log('  fetched', file.slice(root.length + 1));
}

const jobs = [];
const files = await (await fetch('https://api.polyhaven.com/files/ship_pinnace')).json();
const gltf = files.gltf['2k'].gltf;
jobs.push(() => download(gltf.url, join(root, 'ship', 'ship_pinnace.gltf')));
for (const [path, f] of Object.entries(gltf.include)) jobs.push(() => download(f.url, join(root, 'ship', path)));
for (const name of SKIES) {
  const file = `${name}_puresky_4k.hdr`;
  jobs.push(() => download(`https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/${file}`, join(root, 'sky', file)));
}

console.log(`Checking ${jobs.length} asset files (about 170 MB on first run)...`);
const workers = Array.from({ length: 6 }, async () => { while (jobs.length) await jobs.shift()(); });
await Promise.all(workers);
console.log('Assets ready.');
