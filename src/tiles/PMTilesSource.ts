import { PMTiles, type Header } from 'pmtiles';
import { logger } from '../util/log.js';

/**
 * Turn whatever the pmtiles reader threw into something a first-time user can act on.
 *
 * This is the FIRST failure anyone hits, and the raw errors name neither the URL nor the cause:
 * a cross-origin archive rejects with a bare "Failed to fetch", and a server without range support
 * rejects with a message about byte serving that never mentions which URL it was reading. Both are
 * configuration problems with specific fixes, so say which one it looks like.
 *
 * Exported for testing — it is pure, so the classification is covered without a network.
 */
export function describePMTilesFailure(url: string, err: unknown, pageOrigin?: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (!url) {
    return `\`pmtiles_url\` is ${url === '' ? 'empty' : String(url)} — it is required, and must point at a .pmtiles archive the browser can read. Original error: ${raw}`;
  }
  const head = `Could not open the PMTiles archive at ${url}`;
  // The reader checks content-length against the range it asked for, so this is its byte-serving
  // complaint. Static servers that ignore Range headers land here (python3 -m http.server does).
  if (/byte serving|content-length/i.test(raw)) {
    return `${head} — the server answered, but not with the byte range that was asked for. PMTiles reads the archive in pieces, so the host must support HTTP range requests (\`Accept-Ranges: bytes\` and 206 responses). Static servers that ignore \`Range\` will fail here. Original error: ${raw}`;
  }
  // fetch() rejects with a TypeError and deliberately says nothing more when CORS blocks it.
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(raw)) {
    // Only blame CORS when the archive is actually on another origin. Saying "probably CORS" about
    // a same-origin file sends people to fix a header that was never the problem — the likelier
    // causes there are a wrong path or a file that is not a PMTiles archive at all.
    return crossOrigin(url, pageOrigin)
      ? `${head} — the request never completed. Usually this is CORS: the archive is on another origin and does not send \`Access-Control-Allow-Origin\` (browsers hide the real reason from scripts). It can also mean the host is unreachable or the URL is wrong. Original error: ${raw}`
      : `${head} — the request never completed. The archive is on this origin, so this is not CORS: check the path is right and that the file really is a .pmtiles archive. Original error: ${raw}`;
  }
  if (/\b404\b|not found/i.test(raw)) {
    return `${head} — the server returned 404. Check the path, and that the file is actually published. Original error: ${raw}`;
  }
  if (/\b(401|403)\b|forbidden|unauthorized/i.test(raw)) {
    return `${head} — the server refused the request (401/403). The archive is probably private. Original error: ${raw}`;
  }
  return `${head}. Original error: ${raw}`;
}

/** Is `url` on a different origin than the page? Relative URLs never are. */
function crossOrigin(url: string, pageOrigin?: string): boolean {
  const origin = pageOrigin ?? (typeof location !== 'undefined' ? location.origin : undefined);
  if (!origin) return /^https?:\/\//i.test(url); // no page to compare against: absolute = remote
  try {
    return new URL(url, origin).origin !== origin;
  } catch {
    return false;
  }
}

export class PMTilesSource {
  readonly url: string;
  private archive: PMTiles;
  private header: Header | null = null;

  constructor(url: string) {
    this.url = url;
    this.archive = new PMTiles(url);
  }

  async open(): Promise<void> {
    try {
      this.header = await this.archive.getHeader();
    } catch (err) {
      throw new Error(describePMTilesFailure(this.url, err), { cause: err });
    }
    logger.info('pmtiles opened', {
      minZoom: this.header.minZoom,
      maxZoom: this.header.maxZoom
    });
  }

  get minZoom(): number {
    return this.header?.minZoom ?? 0;
  }

  get maxZoom(): number {
    return this.header?.maxZoom ?? 14;
  }

  async getTile(z: number, x: number, y: number): Promise<ArrayBuffer | null> {
    const response = await this.archive.getZxy(z, x, y);
    return response?.data ?? null;
  }
}
