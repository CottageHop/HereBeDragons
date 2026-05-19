import { PMTiles, type Header } from 'pmtiles';
import { logger } from '../util/log.js';

export class PMTilesSource {
  readonly url: string;
  private archive: PMTiles;
  private header: Header | null = null;

  constructor(url: string) {
    this.url = url;
    this.archive = new PMTiles(url);
  }

  async open(): Promise<void> {
    this.header = await this.archive.getHeader();
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
