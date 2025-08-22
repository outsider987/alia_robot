import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

// --- Configuration ---
const STORAGE_DIR = path.resolve('storage');
const USER_DATA_DIR = path.join(STORAGE_DIR, 'user-data');
const NDJSON_PATH = path.join(STORAGE_DIR, 'results.ndjson');
const JSON_PATH = path.join(STORAGE_DIR, 'results.json');

const startUrls = [
  'https://work.1688.com/home/page/index.htm?spm=a262jm.22620049.wktopbar.dtopindex.7db64aadiTVaTY',
];

// In-memory collection (optional)
const collectedResults = [];

async function run() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1440, height: 900 },
  });

  // Ensure single page to start
  let page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(120_000);

  for (const url of startUrls) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Wait for manual login if needed
    const menuLocator = page.locator('ali-bar-single-menu');
    const isMenuVisible = await menuLocator.first().isVisible().catch(() => false);
    if (!isMenuVisible) {
      console.log('Waiting for user to log in...');
      await menuLocator.first().waitFor({ state: 'visible', timeout: 10 * 60 * 1000 });
      console.log('Login detected, menu visible.');
      // Persist cookies for convenience (persistent context also stores session)
      try {
        const cookies = await context.cookies();
        await fs.writeFile(path.join(STORAGE_DIR, 'cookies.json'), JSON.stringify(cookies, null, 2));
        console.log('Cookies saved to storage/cookies.json');
      } catch (err) {
        console.warn(`Failed to save cookies: ${err?.message || String(err)}`);
      }
    }

    // Navigate to target link that opens a new tab
    const linkText = '铺货跨境ERP的货品';
    const primary = page.locator(`ali-bar-single-menu >>> a[href*="pdt_puhuo.html"][title="${linkText}"]`).first();
    const primaryCount = await primary.count().catch(() => 0);

    let popupPage;
    if (primaryCount === 0) {
      // Fallbacks
      let alt = page.locator('a[href*="pdt_puhuo.html"][title]');
      if ((await alt.count()) === 0) {
        alt = page.locator(`a:has-text("${linkText}")`);
      }
      if ((await alt.count()) > 0) {
        await alt.first().scrollIntoViewIfNeeded();
        [popupPage] = await Promise.all([
          context.waitForEvent('page'),
          alt.first().click({ button: 'left' }),
        ]);
      } else {
        console.warn('Target link not found');
        continue;
      }
    } else {
      await primary.scrollIntoViewIfNeeded();
      [popupPage] = await Promise.all([
        context.waitForEvent('page'),
        primary.click({ button: 'left' }),
      ]);
    }

    await popupPage.waitForLoadState('domcontentloaded');
    console.log(`Opened: ${popupPage.url()}`);

    // Scrape rows and optionally delete
    await paginateAndScrape(popupPage, url, true);

    await popupPage.close().catch(() => {});
  }

  await context.close();

  // Ensure results files exist and are stored as JSON arrays (migrate if needed)
  await persistResultsIncremental([]);
}

// --- Scraping helpers ---
async function paginateAndScrape(popupPage, sourceUrl, performDelete = false) {
  await popupPage.waitForSelector('tbody.next-table-body', { timeout: 120000 });
  await popupPage.waitForSelector('.next-pagination', { timeout: 120000 }).catch(() => null);

  const visitedPages = new Set();

  async function getDisplay() {
    const text = (await popupPage.locator('.next-pagination-display').first().innerText().catch(() => '')) || '';
    const m = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return { current: Number(m[1]), total: Number(m[2]) };
    const currentText = await popupPage.locator('.next-pagination-list .next-current .next-btn-helper').first().innerText().catch(() => '');
    const lastText = await popupPage.locator('.next-pagination-list button.next-pagination-item').last().locator('.next-btn-helper').innerText().catch(() => '');
    const current = Number(currentText || '1');
    const total = Number(lastText || current);
    return { current, total };
  }

  async function getFirstRowKey() {
    const title = (await popupPage.locator('tbody.next-table-body tr.next-table-row .td-product .info .subject').first().textContent().catch(() => ''))?.trim() || '';
    const goodsNoText = (await popupPage.locator('tbody.next-table-body tr.next-table-row .td-product .info .number').first().textContent().catch(() => ''))?.trim() || '';
    return `${title}||${goodsNoText}`;
  }

  while (true) {
    const { current, total } = await getDisplay();
    if (current && visitedPages.has(current)) break;
    if (current) visitedPages.add(current);

    console.log(`Scanning page ${current || '?'} of ${total || '?'}`);
    await scrapeInventoryTightRows(popupPage, sourceUrl, performDelete);

    if (total && current && current >= total) break;

    const nextBtn = popupPage.locator('button.next-next');
    const disabled = (await nextBtn.isDisabled().catch(() => false)) || (await nextBtn.getAttribute('disabled').catch(() => null)) !== null;
    if (disabled) break;

    const beforeKey = await getFirstRowKey();
    await Promise.all([
      popupPage.waitForTimeout(300),
      nextBtn.click(),
    ]);
    try {
      await popupPage.waitForFunction((key) => {
        const titleEl = document.querySelector('tbody.next-table-body tr.next-table-row .td-product .info .subject');
        const numEl = document.querySelector('tbody.next-table-body tr.next-table-row .td-product .info .number');
        const title = titleEl ? titleEl.textContent?.trim() : '';
        const goodsNoText = numEl ? numEl.textContent?.trim() : '';
        const cur = `${title}||${goodsNoText}`;
        return cur && cur !== key;
      }, beforeKey, { timeout: 30_000 });
    } catch {
      await popupPage.waitForTimeout(1500);
    }
  }
}

async function scrapeInventoryTightRows(popupPage, sourceUrl, performDelete = false) {
  await popupPage.waitForSelector('tbody.next-table-body', { timeout: 120000 });

  // Scroll to encourage lazy-loading
  for (let i = 0; i < 5; i++) {
    await popupPage.mouse.wheel(0, 2000);
    await popupPage.waitForTimeout(500);
  }

  const rows = popupPage.locator('tbody.next-table-body tr.next-table-row');
  const rowCount = await rows.count();

  const results = [];
  for (let i = rowCount - 1; i >= 0; i--) {
    const row = rows.nth(i);

    const tight = await row.locator('.col-second-row:has-text("库存紧张")').count();
    const statusText = (await row.locator('.col-status .col-value').first().textContent().catch(() => ''))?.trim() || '';
    const takenDown = /已下架/.test(statusText);
    if (tight === 0 && !takenDown) continue;

    const title = (await row.locator('.td-product .info .subject').first().textContent().catch(() => ''))?.trim();
    const goodsNoText = (await row.locator('.td-product .info .number').first().textContent().catch(() => ''))?.trim();

    let goodsNo = '';
    if (goodsNoText) {
      const m = goodsNoText.match(/货号[:：]\s*(.+)$/);
      goodsNo = m ? m[1].trim() : goodsNoText;
    }

    const record = {
      sourceUrl,
      title,
      goodsNo,
      status: statusText,
      flags: { tightInventory: tight > 0, takenDown },
    };

    if (performDelete) {
      try {
        const delBtn = row.locator('a:has(span.next-btn-helper:has-text("删除商品")), button:has(span.next-btn-helper:has-text("删除商品"))').first();
        if (await delBtn.count() > 0) {
          await delBtn.scrollIntoViewIfNeeded();
          await delBtn.click();

          // Confirm and success dialogs
          await clickConfirmDialog(popupPage, 3000);
          await clickSuccessDialogIfPresent(popupPage, 10000);

          // Wait for row to disappear
          await waitRowGoneByKey(popupPage, { title: title || '', goodsNo: goodsNo || '' });

          record.deleted = true;
        } else {
          record.deleted = false;
        }
      } catch (e) {
        record.deleted = false;
        console.warn(`Delete action failed for ${title || goodsNo}: ${e?.message || String(e)}`);
      }
    }

    results.push(record);
  }

  if (results.length > 0) {
    collectedResults.push(...results);
    await persistResultsIncremental(results);
  }
}

async function clickConfirmDialog(page, timeoutMs = 10_000) {
  const selector = 'div.next-dialog[aria-hidden="false"] .next-dialog-footer button.next-btn.next-medium.next-btn-primary.next-dialog-btn:has(span.next-btn-helper:has-text("确认"))';
  try {
    const btn = page.locator(selector).first();
    await btn.waitFor({ state: 'visible', timeout: timeoutMs });
    await btn.click();
    return true;
  } catch {
    const fallback = page.locator('div.next-dialog[aria-hidden="false"] .next-dialog-footer button:has-text("确认")').first();
    if (await fallback.count()) {
      await fallback.click().catch(() => {});
      return true;
    }
    return false;
  }
}

async function clickSuccessDialogIfPresent(page, timeoutMs = 10_000) {
  const anyDialog = page.locator('div[role="alertdialog"].next-dialog[aria-hidden="false"]');
  try {
    await anyDialog.first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return; // none
  }

  let target = anyDialog.filter({
    has: page.locator('.next-message-title:has-text("移除提示"), .next-message-content:has-text("移除成功")'),
  }).first();
  if (await target.count() === 0) target = anyDialog.first();

  let btn = target.locator('.next-dialog-footer button.next-btn.next-medium.next-btn-primary.next-dialog-btn:has(span.next-btn-helper:has-text("确认"))').first();
  if (await btn.count() === 0) {
    btn = target.locator('.next-dialog-footer button:has-text("确认")').first();
  }
  if (await btn.count() > 0) {
    await btn.click({ timeout: 5000 }).catch(() => {});
  } else {
    const closeIcon = target.locator('a.next-dialog-close');
    await closeIcon.click({ timeout: 5000 }).catch(() => {});
  }

  await target.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
}

async function waitRowGoneByKey(page, { title, goodsNo }) {
  try {
    await page.waitForFunction(({ t, g }) => {
      const rows = Array.from(document.querySelectorAll('tbody.next-table-body tr.next-table-row'));
      return !rows.some((tr) => {
        const titleEl = tr.querySelector('.td-product .info .subject');
        const numEl = tr.querySelector('.td-product .info .number');
        const titleText = titleEl ? titleEl.textContent.trim() : '';
        const numText = numEl ? numEl.textContent.trim() : '';
        return titleText === t && numText.includes(g);
      });
    }, { t: title, g: goodsNo }, { timeout: 20_000 });
  } catch {
    await page.waitForTimeout(800);
  }
}

async function persistResultsIncremental(batch) {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });

    // Read existing content from results.ndjson, supporting legacy NDJSON format
    const existingArray = await readArrayFromFileWithNdjsonFallback(NDJSON_PATH);
    const merged = existingArray.concat(batch);

    // Write back as pretty JSON array to both files
    await fs.writeFile(NDJSON_PATH, JSON.stringify(merged, null, 2), 'utf-8');
    await fs.writeFile(JSON_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (e) {
    console.error(`Failed incremental persist: ${e?.message || String(e)}`);
  }
}

async function readArrayFromFileWithNdjsonFallback(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    // Try JSON array first
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Fallback: parse as NDJSON lines
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const items = [];
      for (const line of lines) {
        try { items.push(JSON.parse(line)); } catch { /* ignore bad line */ }
      }
      return items;
    }
  } catch {
    return [];
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
