import { describe, it, expect } from 'vitest';
import { detectBitmapFlip, imageryUploadsViaImage, type FlipTestCanvas } from '../src/splats/SplatsLayer.js';

/** A tiny 2D canvas: an RGBA pixel array with just the calls the flip test makes. */
function fakeCanvas(w: number, h: number): FlipTestCanvas & { px: number[][] } {
  const px: number[][] = Array.from({ length: w * h }, () => [0, 0, 0, 0]);
  const parse = (c: string): number[] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 255];
  const self = {
    px,
    getContext: () => ({
      fillStyle: '#000000' as string,
      fillRect(x: number, y: number, rw: number, rh: number) {
        for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) px[j * w + i] = parse(this.fillStyle as string);
      },
      drawImage(img: ImageBitmap) {
        const rows = (img as unknown as { rows: number[][] }).rows;
        rows.forEach((p, k) => { px[k] = [...p]; });
      },
      getImageData(x: number, y: number) { return { data: px[y * w + x] }; }
    })
  };
  return self;
}
/** createImageBitmap stand-ins: one that honours imageOrientation, one that ignores it. */
const honours = async (src: FlipTestCanvas, opts: ImageBitmapOptions): Promise<ImageBitmap> => {
  const rows = (src as unknown as { px: number[][] }).px.map((p) => [...p]);
  return { rows: opts.imageOrientation === 'flipY' ? rows.reverse() : rows, close() {} } as unknown as ImageBitmap;
};
const ignores = async (src: FlipTestCanvas): Promise<ImageBitmap> =>
  ({ rows: (src as unknown as { px: number[][] }).px.map((p) => [...p]), close() {} }) as unknown as ImageBitmap;

describe('ImageBitmap flipY capability test', () => {
  it('true where the decode flips, so imagery can upload as bitmaps', async () => {
    expect(await detectBitmapFlip(honours, fakeCanvas)).toBe(true);
  });
  it('false where the option is ignored (the imagery would show upside down) → <img> path', async () => {
    expect(await detectBitmapFlip(ignores, fakeCanvas)).toBe(false);
  });
  it('false without the APIs, or when the decode throws', async () => {
    expect(await detectBitmapFlip(undefined, fakeCanvas)).toBe(false);
    expect(await detectBitmapFlip(honours, undefined)).toBe(false);
    expect(await detectBitmapFlip(async () => { throw new Error('no'); }, fakeCanvas)).toBe(false);
  });
});

describe('imageryUploadsViaImage — WebKit takes the <img> path', () => {
  const safariMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
  const playwrightWebKit = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const chromeMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const edgeWin = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
  const firefox = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0';
  const iosSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const iosChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1';

  it('is true for Safari, Playwright WebKit and every iOS browser', () => {
    expect(imageryUploadsViaImage(safariMac, 'Apple Computer, Inc.')).toBe(true);
    expect(imageryUploadsViaImage(playwrightWebKit, 'Apple Computer, Inc.')).toBe(true);
    expect(imageryUploadsViaImage(iosSafari, 'Apple Computer, Inc.')).toBe(true);
    expect(imageryUploadsViaImage(iosChrome, 'Apple Computer, Inc.')).toBe(true);
  });

  it('is false for Chromium-based browsers and Firefox', () => {
    expect(imageryUploadsViaImage(chromeMac, 'Google Inc.')).toBe(false);
    expect(imageryUploadsViaImage(edgeWin, 'Google Inc.')).toBe(false);
    expect(imageryUploadsViaImage(firefox, '')).toBe(false);
    expect(imageryUploadsViaImage('', '')).toBe(false);
  });
});
