import { PlaywrightCrawler, log } from 'crawlee';
import fs from 'node:fs/promises';
import path from 'node:path';

log.setLevel(log.LEVELS.INFO);

// Paths for incremental persistence
const STORAGE_DIR = path.resolve('storage');
const NDJSON_PATH = path.join(STORAGE_DIR, 'results.ndjson');
const JSON_PATH = path.join(STORAGE_DIR, 'results.json');

// Aggregate in memory too (optional), but persistence is immediate
const collectedResults = [];

const startUrls = [
  'https://work.1688.com/home/page/index.htm?spm=a262jm.22620049.wktopbar.dtopindex.7db64aadiTVaTY',
];

const crawler = new PlaywrightCrawler({
  // You can increase concurrency as needed
  maxConcurrency: 5,
  // Allow long interactive login
  requestHandlerTimeoutSecs: 900,
  navigationTimeoutSecs: 120,
  // Playwright launch options
  launchContext: {
    launchOptions: {
      // Show the browser so you can log in manually on first run
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
      ],
    },
    // Persist authenticated session across runs
    useIncognitoPages: false,
    userDataDir: './storage/user-data',
  },
  // Try to preload cookies from previous login
  preNavigationHooks: [
    async ({ page, request }, gotoOptions) => {
      const cookieFile = path.resolve('storage/cookies.json');
      try {
        const existing = await page.context().cookies();
        if (!existing || existing.length === 0) {
          const raw = await fs.readFile(cookieFile, 'utf-8');
          const cookies = JSON.parse(raw);
          if (Array.isArray(cookies) && cookies.length > 0) {
            await page.context().addCookies(cookies);
          }
        }
      } catch (_) {
        // ignore if no cookie file yet
      }
    },
  ],
  async requestHandler({ request, page, response, enqueueLinks, log }) {
    // Wait for possible redirects and login page
    await page.waitForLoadState('domcontentloaded');

    // If not logged in yet, wait for the app shell menu to appear after manual login
    const menuLocator = page.locator('ali-bar-single-menu');
    if (!(await menuLocator.first().isVisible().catch(() => false))) {
      log.info('Waiting for user to log in...');
      await menuLocator.waitFor({ state: 'visible', timeout: 10 * 60 * 1000 }); // up to 10 minutes
      log.info('Login detected, menu visible.');
      // Persist cookies to file for re-use
      try {
        const cookies = await page.context().cookies();
        await fs.mkdir(path.resolve('storage'), { recursive: true });
        await fs.writeFile(path.resolve('storage/cookies.json'), JSON.stringify(cookies, null, 2));
        log.info('Cookies saved to storage/cookies.json');
      } catch (err) {
        log.warning(`Failed to save cookies: ${err?.message || err}`);
      }
    }

    // Click the specific link inside the menu; it opens a new tab
    const linkText = '铺货跨境ERP的货品';
    // Try piercing shadow DOM of the menu (open shadow roots)
    const link = page.locator(`ali-bar-single-menu >>> a[href*="pdt_puhuo.html"][title="${linkText}"]`);

    // Ensure the menu shadow DOM if needed; try a couple strategies
    const hasLink = await link.first().count().then(c => c > 0).catch(() => false);
    if (!hasLink) {
      // Fallbacks: search in light DOM by href and/or text
      let alt = page.locator('a[href*="pdt_puhuo.html"][title]');
      if (!(await alt.first().count().then(c => c > 0))) {
        alt = page.locator(`a:has-text("${linkText}")`);
      }
      if (await alt.first().count().then(c => c > 0)) {
        await alt.first().scrollIntoViewIfNeeded();
        const [popup] = await Promise.all([
          page.waitForEvent('popup'),
          alt.first().click({ button: 'left' }),
        ]);
        await popup.waitForLoadState('domcontentloaded');
        log.info(`Opened: ${popup.url()}`);

    // Scrape table rows with inventory warning across pagination
    await paginateAndScrape(popup, request.url, log, true);
        return;
      }
      log.warning('Target link not found');
      return;
    }

    await link.first().scrollIntoViewIfNeeded();
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      link.first().click({ button: 'left' }),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    log.info(`Opened: ${popup.url()}`);

    // Scrape table rows with inventory warning across pagination
    await paginateAndScrape(popup, request.url, log, true);
  },

  // helper functions scoped to crawler

  async failedRequestHandler({ request, error }) {
    log.error(`Request failed: ${request.url} -> ${error?.message}`);
  },
});

await crawler.addRequests(startUrls);
await crawler.run();

// --- Helpers ---
async function scrapeInventoryTightRows(popupPage, sourceUrl, performDelete = false, logger) {
  // Wait for table body presence
  await popupPage.waitForSelector('tbody.next-table-body', { timeout: 120000 });

  // Scroll to bottom to ensure lazy-loaded rows (try a few times)
  for (let i = 0; i < 5; i++) {
    await popupPage.mouse.wheel(0, 2000);
    await popupPage.waitForTimeout(500);
  }

  const rows = popupPage.locator('tbody.next-table-body tr.next-table-row');
  let rowCount = await rows.count();

  const results = [];
  for (let i = rowCount - 1; i >= 0; i--) {
    const row = rows.nth(i);

    // Check inventory warning within this row
    const tight = await row.locator('.col-second-row:has-text("库存紧张")').count();
    // Also include taken-down items
    const statusText = (await row.locator('.col-status .col-value').first().textContent().catch(() => ''))?.trim() || '';
    const takenDown = /已下架/.test(statusText);
    if (tight === 0 && !takenDown) continue;

    const title = (await row.locator('.td-product .info .subject').first().textContent().catch(() => ''))?.trim();
    const goodsNoText = (await row.locator('.td-product .info .number').first().textContent().catch(() => ''))?.trim();
    // Extract code after 货号：
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
          await popupPage.bringToFront();

          // 1) Try confirm dialog quickly; some flows skip this and show only success dialog
          const didConfirm = await clickConfirmDialog(popupPage, logger, 3000);

          // 2) Handle success alert dialog (移除提示/移除成功)
          await clickSuccessDialogIfPresent(popupPage, logger, 10000);

          // 3) Wait until this row is gone (by matching title+goodsNo)
          await waitRowGoneByKey(popupPage, { title: title || '', goodsNo: goodsNo || '' });

          record.deleted = true;
        } else {
          record.deleted = false;
        }
      } catch (e) {
        record.deleted = false;
        logger?.warn?.(`Delete action failed for ${title || goodsNo}: ${e?.message || e}`);
      }
    }

    results.push(record);
  }

  if (results.length > 0) {
    collectedResults.push(...results);
    await persistResultsIncremental(results);
  }
}

async function paginateAndScrape(popupPage, sourceUrl, logger, performDelete = false) {
  // Ensure table and pagination exist (pagination may render after data)
  await popupPage.waitForSelector('tbody.next-table-body', { timeout: 120000 });
  await popupPage.waitForSelector('.next-pagination', { timeout: 120000 }).catch(() => null);

  const visitedPages = new Set();
  // Try to read total pages if available
  const getDisplay = async () => {
    const text = (await popupPage.locator('.next-pagination-display').first().innerText().catch(() => '')) || '';
    const m = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return { current: Number(m[1]), total: Number(m[2]) };
    // Fallback: find current in button with .next-current
    const currentText = await popupPage.locator('.next-pagination-list .next-current .next-btn-helper').first().innerText().catch(() => '');
    const lastText = await popupPage.locator('.next-pagination-list button.next-pagination-item').last().locator('.next-btn-helper').innerText().catch(() => '');
    const current = Number(currentText || '1');
    const total = Number(lastText || current);
    return { current, total };
  };

  const getFirstRowKey = async () => {
    const title = (await popupPage.locator('tbody.next-table-body tr.next-table-row .td-product .info .subject').first().textContent().catch(() => ''))?.trim() || '';
    const goodsNoText = (await popupPage.locator('tbody.next-table-body tr.next-table-row .td-product .info .number').first().textContent().catch(() => ''))?.trim() || '';
    return `${title}||${goodsNoText}`;
  };

  while (true) {
    const { current, total } = await getDisplay();
    if (current && visitedPages.has(current)) break;
    if (current) visitedPages.add(current);
    logger?.info(`Scanning page ${current || '?'} of ${total || '?'}`);

    await scrapeInventoryTightRows(popupPage, sourceUrl, performDelete, logger);

    if (total && current && current >= total) break;

    const nextBtn = popupPage.locator('button.next-next');
    const disabled = (await nextBtn.isDisabled().catch(() => false)) || (await nextBtn.getAttribute('disabled').catch(() => null)) !== null;
    if (disabled) break;

    const beforeKey = await getFirstRowKey();
    await Promise.all([
      popupPage.waitForTimeout(300),
      nextBtn.click(),
    ]);
    // Wait for first row to change or timeout
    try {
      await popupPage.waitForFunction((key) => {
        const titleEl = document.querySelector('tbody.next-table-body tr.next-table-row .td-product .info .subject');
        const numEl = document.querySelector('tbody.next-table-body tr.next-table-row .td-product .info .number');
        const title = titleEl ? titleEl.textContent?.trim() : '';
        const goodsNoText = numEl ? numEl.textContent?.trim() : '';
        const cur = `${title}||${goodsNoText}`;
        return cur && cur !== key;
      }, beforeKey, { timeout: 30000 });
    } catch (_) {
      // As a fallback, wait briefly
      await popupPage.waitForTimeout(1500);
    }
  }
}

async function persistResultsIncremental(batch) {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    // Append NDJSON lines for crash-safe accumulation
    const ndLines = batch.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await fs.appendFile(NDJSON_PATH, ndLines, 'utf-8');

    // Also keep a compact JSON array snapshot updated
    let existing = [];
    try {
      const raw = await fs.readFile(JSON_PATH, 'utf-8');
      existing = JSON.parse(raw);
      if (!Array.isArray(existing)) existing = [];
    } catch (_) {}
    const merged = existing.concat(batch);
    await fs.writeFile(JSON_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (e) {
    log.error(`Failed incremental persist: ${e?.message || e}`);
  }
}

async function clickConfirmDialog(page, logger, timeoutMs = 10000) {
  // Confirm dialog (with two buttons 确认/取消)
  const selector = 'div.next-dialog[aria-hidden="false"] .next-dialog-footer button.next-btn.next-medium.next-btn-primary.next-dialog-btn:has(span.next-btn-helper:has-text("确认"))';
  try {
    const btn = page.locator(selector).first();
    await btn.waitFor({ state: 'visible', timeout: timeoutMs });
    await btn.click();
    return true;
  } catch (e) {
    // Fallback: any visible confirm button with text 确认
    const fallback = page.locator('div.next-dialog[aria-hidden="false"] .next-dialog-footer button:has-text("确认")').first();
    if (await fallback.count()) {
      await fallback.click().catch(() => {});
      return true;
    }
    return false;
  }
}

async function clickSuccessDialogIfPresent(page, logger, timeoutMs = 10000) {
  // Generic alert dialog; prefer one that shows 移除提示/移除成功
  const anyDialog = page.locator('div[role="alertdialog"].next-dialog[aria-hidden="false"]');
  try {
    await anyDialog.first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (_) {
    return; // no alert dialog appeared
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
    // Fallback to close icon
    const closeIcon = target.locator('a.next-dialog-close');
    await closeIcon.click({ timeout: 5000 }).catch(() => {});
  }

  await target.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
}

async function waitRowGoneByKey(page, { title, goodsNo }) {
  // Wait until no row contains both the same title and same goodsNo
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
    }, { t: title, g: goodsNo }, { timeout: 20000 });
  } catch (_) {
    // last resort wait briefly
    await page.waitForTimeout(800);
  }
}
