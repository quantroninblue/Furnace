// Writes the signed update feed for a release (run by .github/workflows/release.yml).
//   FURNACE_UPDATE_KEY=<Ed25519 private key, PEM> node scripts/release-feed.mjs <version> <dir> [notes]
// <dir> holds the release downloads (Furnace-darwin-arm64.zip, FurnaceUserSetup-x64.exe). Writes
// <dir>/latest.json (each platform's download with its size and SHA-256) and <dir>/latest.json.sig
// (Ed25519 over the exact bytes), then checks the signature against release/update-key.pem, the
// public key every build carries, so a wrong key fails the release instead of every update.
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './environment.mjs';
import { updateRepository } from './release.mjs';

// The file each platform's updater installs (product/updater.cjs).
export const downloads = { 'darwin-arm64': 'Furnace-darwin-arm64.zip', 'win32-x64': 'FurnaceUserSetup-x64.exe' };

async function sha256(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

const [version, dir, notes = ''] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || '') || !dir) throw new Error('Usage: node scripts/release-feed.mjs <version, e.g. 0.2.0> <dir> [notes]');
if (!process.env.FURNACE_UPDATE_KEY) throw new Error('FURNACE_UPDATE_KEY (the update signing key) is not set.');
const base = `https://github.com/${updateRepository}/releases`;
const assets = {};
for (const [key, file] of Object.entries(downloads)) {
    const full = path.join(dir, file);
    assets[key] = { file, url: `${base}/download/v${version}/${file}`, size: (await stat(full)).size, sha256: await sha256(full) };
}
const feed = Buffer.from(JSON.stringify({ version, url: `${base}/tag/v${version}`, notes: notes.slice(0, 300), assets }, null, 2) + '\n');
const signature = crypto.sign(null, feed, process.env.FURNACE_UPDATE_KEY).toString('base64');
const publicKey = await readFile(path.join(root, 'release/update-key.pem'), 'utf8');
if (!crypto.verify(null, feed, publicKey, Buffer.from(signature, 'base64'))) throw new Error('FURNACE_UPDATE_KEY does not match release/update-key.pem; builds would refuse this feed.');
await writeFile(path.join(dir, 'latest.json'), feed);
await writeFile(path.join(dir, 'latest.json.sig'), signature + '\n');
console.log(feed.toString());
