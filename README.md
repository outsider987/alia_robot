# alia_robot

Playwright-based crawler options for Python (Scrapy) and Node.js (Crawlee).

## Node.js (Crawlee + Playwright)

1. Install Node dependencies and browsers:

```bash
npm install
npx playwright install chromium
```

2. Run the crawler:

```bash
npm run crawl
```

Outputs will be saved into `storage/datasets/default` as JSON.

## Python (Scrapy + scrapy-playwright)

1. Create and activate a virtualenv (optional):

```bash
python3 -m venv .venv
source .venv/bin/activate
```

2. Install Python dependencies and Playwright browser:

```bash
pip install -U pip
pip install -e .
python -m playwright install chromium
```

3. Run the example spider:

```bash
scrapy crawl example_playwright -O out.json
```
