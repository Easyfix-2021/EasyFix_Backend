/*
 * Great-circle distance between two GPS points (km).
 * GPS inputs are the "lat,lng" string format used throughout EasyFix DB
 * (e.g. "28.6139,77.2090"). Returns Infinity for missing/malformed inputs
 * so callers can filter them out of candidate lists rather than crashing.
 */

function parseGps(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.trim().match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

const EARTH_KM = 6371;

function haversineKm(a, b) {
  const pa = typeof a === 'string' ? parseGps(a) : a;
  const pb = typeof b === 'string' ? parseGps(b) : b;
  if (!pa || !pb) return Infinity;

  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(pb.lat - pa.lat);
  const dLng = toRad(pb.lng - pa.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(pa.lat)) * Math.cos(toRad(pb.lat)) *
    Math.sin(dLng / 2) ** 2;
  return EARTH_KM * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

module.exports = { haversineKm, parseGps };
