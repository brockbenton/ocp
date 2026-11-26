import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';


import { createApp, parseCorsOrigins } from '../src/app';

const app = createApp();
const ALLOWED = 'http://localhost:3000';
const UNLISTED = 'https://evil.example.com';

describe('security headers', () => {
  it('sets the key headers and hides the framework', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('also sets them on error responses', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it.each(['/api/v1/art/Spring%202026', '/api/v1/badge/founding'])(
    'serves %s as an embeddable, non-sniffable SVG',
    async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    },
  );
});

describe('CORS allowlist', () => {
  it('echoes a listed origin', async () => {
    const res = await request(app).get('/health').set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['vary']).toContain('Origin');
  });

  it('ignores a trailing slash in the configured origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://app.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it.each([UNLISTED, 'http://localhost:3001', 'https://app.example.com.evil.com', 'null'])(
    'sends no Access-Control-Allow-Origin to %s',
    async (origin) => {
      const res = await request(app).get('/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    },
  );

  it('sends no Access-Control-Allow-Origin on a preflight from an unlisted origin', async () => {
    const res = await request(app)
      .options('/api/v1/check-in')
      .set('Origin', UNLISTED)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows only the methods and headers the frontend uses', async () => {
    const res = await request(app)
      .options('/api/v1/check-in')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,PATCH,DELETE');
    expect(res.headers['access-control-allow-headers']).toBe('Authorization,Content-Type');
  });

  it('parses an unset or blank value as an empty allowlist, never a wildcard', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins(' , ')).toEqual([]);
    expect(parseCorsOrigins('https://a.com/, http://b.com')).toEqual(['https://a.com', 'http://b.com']);
  });
});
