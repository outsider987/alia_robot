import fs from 'node:fs/promises';
import path from 'node:path';
import XLSX from 'xlsx';

async function run() {
  // Prefer compact JSON array if present; otherwise merge NDJSON
  const jsonArrayPath = path.resolve('storage/results2.json');
  const ndjsonPath = path.resolve('storage/results.ndjson');
  const outDir = path.resolve('storage');
  const outPath = path.join(outDir, 'results.xlsx');

  let data;
  try {
    try {
      const raw = await fs.readFile(jsonArrayPath, 'utf-8');
      data = JSON.parse(raw);
      if (!Array.isArray(data)) throw new Error('results.json must be an array');
    } catch (_) {
      // Fallback to NDJSON accumulation
      const rawNd = await fs.readFile(ndjsonPath, 'utf-8');
      data = rawNd
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean);
    }
  } catch (err) {
    console.error(`Failed to read results.json or results.ndjson:`, err.message || err);
    process.exit(1);
  }

  // Normalize rows
  const rows = data.map((r) => ({
    sourceUrl: r.sourceUrl || '',
    title: r.title || '',
    goodsNo: r.goodsNo || '',
    status: r.status || '',
    tightInventory: r?.flags?.tightInventory ? 'Y' : '',
    takenDown: r?.flags?.takenDown ? 'Y' : '',
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'results');
  await fs.mkdir(outDir, { recursive: true });
  XLSX.writeFile(wb, outPath);
  console.log(`Wrote Excel to ${outPath}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
