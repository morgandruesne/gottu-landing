export const WEB_RADIUS_M = 300;
export const COARSE_ACCURACY_M = 1000;

const CHROME_FOLLOW_UP =
  'La position est toujours approximative. Dans Chrome, ouvre les réglages du site, puis Localisation, et active la position exacte.';
const GENERIC_FOLLOW_UP =
  'La position est toujours approximative. Ouvre les réglages de localisation du navigateur pour ce site et active la position exacte.';

export function isChromeBrowser(userAgent) {
  return /Chrome|CriOS/.test(userAgent) && !/Edg|OPR|SamsungBrowser|Firefox/.test(userAgent);
}

export function coarseFollowUpCopy(userAgent) {
  return isChromeBrowser(userAgent) ? CHROME_FOLLOW_UP : GENERIC_FOLLOW_UP;
}

export function haversineMeters(a, b) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusM = 6_371_000;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(Math.min(1, h)));
}

function accuracyKnown(accuracyMeters) {
  return Number.isFinite(accuracyMeters) && accuracyMeters >= 0;
}

/**
 * coarse: OS approximate band, never send.
 * weak: blurrier than the cafe, and the error circle does not cover it.
 * send: inside the radius, the error circle still covers the cafe, or the cafe position is unknown.
 * far: a fine fix that is honestly outside.
 */
export function classifyWebClaimFix({ accuracyMeters, distanceMeters }) {
  if (accuracyKnown(accuracyMeters) && accuracyMeters >= COARSE_ACCURACY_M) {
    return 'coarse';
  }

  const distanceReady = Number.isFinite(distanceMeters) && distanceMeters >= 0;
  if (!distanceReady) {
    return 'send';
  }

  if (distanceMeters <= WEB_RADIUS_M) {
    return 'send';
  }

  if (!accuracyKnown(accuracyMeters)) {
    return 'far';
  }

  if (distanceMeters - accuracyMeters <= WEB_RADIUS_M) {
    return 'send';
  }

  if (accuracyMeters > WEB_RADIUS_M) {
    return 'weak';
  }

  return 'far';
}

export function webTooFarMode(accuracyMeters) {
  return accuracyKnown(accuracyMeters) && accuracyMeters > WEB_RADIUS_M ? 'weak' : 'far';
}
