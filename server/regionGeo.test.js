import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRENDING_COUNTRIES,
  findNearestListedByCoords,
  resolveNearestTrendingRegion,
} from '../src/utils/regionGeo.js';
import { detectVisitorRegion, isPrivateOrLoopbackIp } from './visitorGeo.js';

test('direct listed trending countries map to themselves', () => {
  for (const c of TRENDING_COUNTRIES) {
    assert.equal(resolveNearestTrendingRegion({ countryCode: c.code.toUpperCase() }), c.code);
  }
});

test('Timor-Leste resolves to Indonesia (id) via code, coords, timezone, and locale', () => {
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'TL' }), 'id');
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'TL', lat: -8.5569, lon: 125.5603 }), 'id');
  assert.equal(resolveNearestTrendingRegion({ timeZone: 'Asia/Dili' }), 'id');
  assert.equal(resolveNearestTrendingRegion({ locale: 'pt-TL' }), 'id');
});

test('Argentina resolves to Brazil (br) via code, coords, timezone, and locale', () => {
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'AR' }), 'br');
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'AR', lat: -34.6037, lon: -58.3816 }), 'br');
  assert.equal(resolveNearestTrendingRegion({ timeZone: 'America/Argentina/Buenos_Aires' }), 'br');
  assert.equal(resolveNearestTrendingRegion({ locale: 'es-AR' }), 'br');
});

test('non-listed countries resolve to geographically nearest listed country', () => {
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'NZ' }), 'au');
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'HK' }), 'tw');
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'IE' }), 'gb');
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'ES' }), 'fr');
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'NL' }), 'de');
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'CL' }), 'br');
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'UY' }), 'br');
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'GT' }), 'mx');
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'PK' }), 'in');
  assert.equal(resolveNearestTrendingRegion({ countryCode: 'BD' }), 'in');
  // Coords near Dili, Timor-Leste -> id
  assert.equal(findNearestListedByCoords(-8.55, 125.56), 'id');
  // Coords near Buenos Aires, Argentina -> br
  assert.equal(findNearestListedByCoords(-34.6, -58.38), 'br');
});

test('server detectVisitorRegion respects proxy geo headers and loopback IP checks', async () => {
  assert.equal(isPrivateOrLoopbackIp('127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('10.0.0.5'), true);
  assert.equal(isPrivateOrLoopbackIp('192.168.1.10'), true);
  assert.equal(isPrivateOrLoopbackIp('8.8.8.8'), false);

  const tl = await detectVisitorRegion({ headers: { 'cf-ipcountry': 'TL' }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(tl.detected, true);
  assert.equal(tl.region, 'id');
  assert.equal(tl.countryCode, 'tl');
  assert.equal(tl.isExactMatch, false);

  const ar = await detectVisitorRegion({ headers: { 'cf-ipcountry': 'AR' }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(ar.detected, true);
  assert.equal(ar.region, 'br');
  assert.equal(ar.countryCode, 'ar');

  const jp = await detectVisitorRegion({ headers: { 'cf-ipcountry': 'JP' }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(jp.detected, true);
  assert.equal(jp.region, 'jp');
  assert.equal(jp.isExactMatch, true);

  const localFallback = await detectVisitorRegion({
    headers: { 'accept-language': 'es-AR,es;q=0.9' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(localFallback.region, 'br');
  assert.equal(localFallback.source, 'accept-language');
});
