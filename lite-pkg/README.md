# camoufox-scrape

Zero-dependency scraper (~270 KB). HTTP first; if the page needs JavaScript or blocks plain requests it drives **your own Chrome** over raw DevTools Protocol (no Playwright, no bundled browser).

```js
import { scrape } from "camoufox-scrape";
const r = await scrape("https://quotes.toscrape.com/js/");
// r.markdown, r.images, r.links, r.tables, r.metadata, r.engine ("http" | "chrome")
```

Needs Node >= 22.15 and, for JS pages, Chrome/Edge/Brave/Chromium (or `CAMOUFOX_AGENT_CHROME`). Anti-bot walls that need Camoufox are delegated to a running `camoufox-agent serve` (`useServer`), otherwise `error_message` explains the block.
