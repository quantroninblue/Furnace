// Regenerates the Furnace app icons in release/icon/ from release/icon/furnace-icon.svg.
//   node scripts/test-display.mjs scripts/make-icons.mjs
// Renders the SVG with the development Electron (Chromium), then packs .icns (macOS) and .ico
// (Windows app, taskbar and installer) in plain Node, so no image tools are needed. The outputs
// are committed; release.mjs copies them over upstream's icons when packaging. Also writes the
// landing page's icon and link preview (site/images/).
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { root, upstream } from './environment.mjs';

const icons = path.join(root, 'release/icon');
const svg = await readFile(path.join(icons, 'furnace-icon.svg'), 'utf8');
// macOS: the whole 1024 canvas (tile on Apple's grid, with its shadow). Windows and Linux: cropped
// to the tile, no shadow, so the glyph stays large at 16 px.
const tile = svg.replace('viewBox="0 0 1024 1024"', 'viewBox="96 96 832 832"').replace(/<rect id="shadow"[^>]*\/>/, '');
// The link preview for the landing page (site/images/social-card.png), 1200 × 630.
const card = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <defs><radialGradient id="g" cx="0.28" cy="0.55" r="0.6"><stop offset="0" stop-color="#ff7a2a" stop-opacity="0.28"/><stop offset="1" stop-color="#ff7a2a" stop-opacity="0"/></radialGradient></defs>
  <rect width="1200" height="630" fill="#121214"/><rect width="1200" height="630" fill="url(#g)"/>
  <image href="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" x="70" y="135" width="360" height="360"/>
  <text x="470" y="270" fill="#e6e5e3" font-family="DejaVu Sans, Segoe UI, Helvetica, sans-serif" font-size="88" font-weight="700">Furnace</text>
  <text x="474" y="338" fill="#a3a2a6" font-family="DejaVu Sans, Segoe UI, Helvetica, sans-serif" font-size="32">The AI coding workspace</text>
  <text x="474" y="382" fill="#a3a2a6" font-family="DejaVu Sans, Segoe UI, Helvetica, sans-serif" font-size="32">where you stay in charge.</text>
  <text x="474" y="460" fill="#ff9a55" font-family="DejaVu Sans Mono, Consolas, monospace" font-size="24">Free · open source · macOS and Windows</text>
</svg>`;
const jobs = [
    { name: 'social-card', svg: card, size: 1200, height: 630 },
    ...[16, 32, 64, 128, 256, 512, 1024].map(size => ({ name: `mac-${size}`, svg, size })),
    ...[16, 20, 24, 32, 40, 48, 64, 70, 150, 256, 512].map(size => ({ name: `tile-${size}`, svg: tile, size })),
];

const work = await mkdtemp(path.join(os.tmpdir(), 'furnace-icons-'));
try {
    await writeFile(path.join(work, 'jobs.json'), JSON.stringify(jobs));
    await writeFile(path.join(work, 'render.cjs'), renderer());
    execFileSync(path.join(upstream, '.build/electron/code-oss'), [path.join(work, 'render.cjs'), work], {
        stdio: 'inherit',
        env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
    });
    const png = async name => readFile(path.join(work, `${name}.png`));

    // .icns: PNG entries by type code (https://en.wikipedia.org/wiki/Apple_Icon_Image_format).
    const icnsTypes = [
        ['icp4', 16],
        ['icp5', 32],
        ['ic11', 32],
        ['ic12', 64],
        ['ic07', 128],
        ['ic13', 256],
        ['ic08', 256],
        ['ic14', 512],
        ['ic09', 512],
        ['ic10', 1024],
    ];
    const entries = await Promise.all(
        icnsTypes.map(async ([type, size]) => {
            const data = await png(`mac-${size}`),
                head = Buffer.alloc(8);
            head.write(type, 0, 'ascii');
            head.writeUInt32BE(data.length + 8, 4);
            return Buffer.concat([head, data]);
        }),
    );
    const icnsHead = Buffer.alloc(8);
    icnsHead.write('icns', 0, 'ascii');
    icnsHead.writeUInt32BE(8 + entries.reduce((sum, entry) => sum + entry.length, 0), 4);
    await writeFile(path.join(icons, 'furnace.icns'), Buffer.concat([icnsHead, ...entries]));

    // .ico: PNG-compressed images (Windows Vista and later).
    const icoSizes = [16, 20, 24, 32, 40, 48, 64, 256];
    const images = await Promise.all(icoSizes.map(size => png(`tile-${size}`)));
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach((data, index) => {
        const at = 6 + 16 * index,
            size = icoSizes[index] === 256 ? 0 : icoSizes[index];
        header.writeUInt8(size, at);
        header.writeUInt8(size, at + 1);
        header.writeUInt16LE(1, at + 4);
        header.writeUInt16LE(32, at + 6);
        header.writeUInt32LE(data.length, at + 8);
        header.writeUInt32LE(offset, at + 12);
        offset += data.length;
    });
    await writeFile(path.join(icons, 'furnace.ico'), Buffer.concat([header, ...images]));

    // Windows Start tiles (VisualElementsManifest) and the Linux icon.
    await writeFile(path.join(icons, 'furnace_70x70.png'), await png('tile-70'));
    await writeFile(path.join(icons, 'furnace_150x150.png'), await png('tile-150'));
    await writeFile(path.join(icons, 'furnace.png'), await png('tile-512'));
    // The landing page (site/) uses the icon and the social card.
    const site = path.join(root, '../../site/images');
    await writeFile(path.join(site, 'social-card.png'), await png('social-card'));
    await writeFile(path.join(site, 'furnace-icon-150.png'), await png('tile-150'));
    await writeFile(path.join(site, 'furnace-icon.svg'), svg);
    console.log(`Icons written to ${icons}`);
} finally {
    await rm(work, { recursive: true, force: true });
}

// Electron main script: draws each SVG into a canvas at its size and saves a PNG.
function renderer() {
    return String.raw`
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[process.argv.length - 1];
app.disableHardwareAcceleration();
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html,<canvas></canvas>');
    for (const job of JSON.parse(fs.readFileSync(path.join(dir, 'jobs.json'), 'utf8'))) {
        const url = await win.webContents.executeJavaScript('(' + (async (svg, size, height) => {
            const image = new Image();
            image.src = 'data:image/svg+xml;base64,' + btoa(String.fromCharCode(...new TextEncoder().encode(svg)));
            await image.decode();
            if (height) {
                const flat = document.createElement('canvas'); flat.width = size; flat.height = height;
                flat.getContext('2d').drawImage(image, 0, 0, size, height);
                return flat.toDataURL('image/png');
            }
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = size;
            const context = canvas.getContext('2d');
            context.imageSmoothingQuality = 'high';
            // Draw large, then step down by halves: crisper small sizes than one big downscale.
            let source = image, current = Math.max(size, 1024);
            const big = document.createElement('canvas'); big.width = big.height = current;
            big.getContext('2d').drawImage(image, 0, 0, current, current); source = big;
            while (current / 2 >= size) {
                const next = document.createElement('canvas'); next.width = next.height = current / 2;
                const nc = next.getContext('2d'); nc.imageSmoothingQuality = 'high'; nc.drawImage(source, 0, 0, current / 2, current / 2);
                source = next; current /= 2;
            }
            context.drawImage(source, 0, 0, size, size);
            return canvas.toDataURL('image/png');
        }).toString() + ')(' + JSON.stringify(job.svg) + ',' + job.size + ',' + (job.height || 0) + ')');
        fs.writeFileSync(path.join(dir, job.name + '.png'), Buffer.from(url.split(',')[1], 'base64'));
    }
    app.quit();
});
`;
}
