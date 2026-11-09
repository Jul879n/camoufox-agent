import { buildSuccessContent } from "../responses.js";
import type { ScrapeToolInput } from "../schema/tools.js";
import { scrape } from "./index.js";

export async function handleScrapeTool(input: ScrapeToolInput) {
  const result = await scrape(input.url, { ...input, useServer: false });
  return buildSuccessContent(result);
}
