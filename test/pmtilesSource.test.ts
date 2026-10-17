import { describe, it, expect } from 'vitest';
import { describePMTilesFailure } from '../src/tiles/PMTilesSource.js';

const URL_A = 'https://tiles.example.com/us.pmtiles';

describe('describePMTilesFailure — the first error a new user sees', () => {
  it('always names the URL, whatever was thrown', () => {
    for (const thrown of [new Error('boom'), 'a string', 42, null, undefined]) {
      expect(describePMTilesFailure(URL_A, thrown)).toContain(URL_A);
    }
  });

  it('recognises a host that ignores Range requests', () => {
    // Verbatim from the pmtiles reader, hit by serving the archive with `python3 -m http.server`.
    const real = new Error(
      'Server returned no content-length header or content-length exceeding request. ' +
        'Check that your storage backend supports HTTP Byte Serving.'
    );
    const msg = describePMTilesFailure(URL_A, real);
    expect(msg).toMatch(/range request/i);
    expect(msg).toMatch(/206|Accept-Ranges/);
  });

  it('recognises the CORS case, which the browser refuses to explain', () => {
    // fetch() rejects with exactly this and nothing else when CORS blocks it.
    const msg = describePMTilesFailure(URL_A, new TypeError('Failed to fetch'));
    expect(msg).toMatch(/CORS/);
    expect(msg).toMatch(/Access-Control-Allow-Origin/);
  });

  it('recognises 404 and 403 separately — different fixes', () => {
    expect(describePMTilesFailure(URL_A, new Error('HTTP 404 Not Found'))).toMatch(/404/);
    expect(describePMTilesFailure(URL_A, new Error('403 Forbidden'))).toMatch(/private/i);
  });

  it('does not blame CORS for a SAME-ORIGIN archive — it cannot be the cause there', () => {
    const msg = describePMTilesFailure('/tiles.pmtiles', new TypeError('Failed to fetch'), 'https://app.example.com');
    expect(msg).not.toMatch(/Usually this is CORS/);   // (the message does say "this is not CORS")
    expect(msg).toMatch(/not CORS/);
    expect(msg).toMatch(/path|archive/i);
  });

  it('still blames CORS for a genuinely cross-origin archive', () => {
    const msg = describePMTilesFailure(URL_A, new TypeError('Failed to fetch'), 'https://app.example.com');
    expect(msg).toMatch(/CORS/);
  });

  it('says the option is missing rather than inventing a network cause', () => {
    for (const bad of ['', undefined as unknown as string, null as unknown as string]) {
      const msg = describePMTilesFailure(bad, new TypeError('Failed to fetch'));
      expect(msg).toMatch(/`pmtiles_url` is/);
      expect(msg).not.toMatch(/CORS/);
    }
  });

  it('keeps the original text so nothing is lost when the guess is wrong', () => {
    expect(describePMTilesFailure(URL_A, new Error('something unforeseen')))
      .toContain('something unforeseen');
  });

  it('does not mistake a byte-serving failure for CORS', () => {
    // A TypeError whose message is about content-length must take the range branch, not the
    // `err instanceof TypeError` one — order matters here.
    const msg = describePMTilesFailure(URL_A, new TypeError('content-length exceeding request'));
    expect(msg).toMatch(/range request/i);
    expect(msg).not.toMatch(/CORS/);
  });
});
