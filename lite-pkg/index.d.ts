export type ScrapeEngine = "http" | "chrome" | "camoufox";

export interface ScrapeResult {
  url: string;
  status_code: number | null;
  success: boolean;
  engine: ScrapeEngine;
  error_message: string | null;
  metadata: Record<string, string>;
  markdown: string;
  images: { src: string; alt: string }[];
  links: { internal: { href: string; text: string }[]; external: { href: string; text: string }[] };
  tables: { headers: string[]; rows: string[][] }[];
  html?: string;
}

export interface ScrapeOptions {
  /** auto: HTTP, then your Chrome (CDP) when the page needs JS or blocks plain HTTP. */
  engine?: "auto" | ScrapeEngine;
  full?: boolean;
  timeoutMs?: number;
  /** Delegate browser work to a running `camoufox-agent serve` when one is reachable (default true). */
  useServer?: boolean;
  /** Skip human-like mouse/scroll. */
  fast?: boolean;
}

export function scrape(url: string, options?: ScrapeOptions): Promise<ScrapeResult>;
