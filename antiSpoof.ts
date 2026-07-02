import { RawCoordinate, SpoofCheckResult } from '../types/domain';

const EARTH_RADIUS_METERS = 6_371_000;

// Elite marathon pace is ~2:50/km (~5.9 m/s). Elite 5K/10K pace can briefly
// hit ~6.0 m/s. We give real headroom above that before calling a *sustained*
// speed suspicious, and a hard, physically-impossible ceiling for outright
// rejection (covers a runner sprinting downhill, GPS jitter on a short leg, etc).
const SUSTAINED_SUSPICIOUS_SPEED_MPS = 7.0; // ~25.2 km/h, faster than any sustained human run
const HARD_REJECT_SPEED_MPS = 12.5; // ~45 km/h — impossible on foot, this is a car/bike/teleport
const MIN_REALISTIC_SEGMENT_SECONDS = 0.5; // guards against divide-by-near-zero on duplicate timestamps
const MAX_ACCEPTABLE_GPS_ACCURACY_METERS = 75; // discard/flag wildly noisy fixes
const CLAIMED_PACE_TOLERANCE_RATIO = 0.15; // client pace must be within 15% of server-computed pace
const MIN_RUN_DISTANCE_METERS = 20;
const MIN_POINTS = 2;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lat/lng points, in meters. */
export function haversineDistanceMeters(a: RawCoordinate, b: RawCoordinate): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

/**
 * Validates a raw GPS trace against realistic human-running physics.
 *
 * This is deliberately conservative in what it *rejects* outright (only
 * physically impossible traces) versus what it *flags* for review (borderline
 * traces still get logged and can still be reviewed/banned after pattern
 * analysis, but we don't want to reject a legitimate runner mid-race due to
 * a single noisy GPS blip).
 */
export function validateRunTrace(coordinates: RawCoordinate[]): SpoofCheckResult {
  const reasons: string[] = [];
  let isValid = true;
  let isSuspicious = false;

  if (coordinates.length < MIN_POINTS) {
    return {
      isValid: false,
      isSuspicious: false,
      reasons: ['INSUFFICIENT_POINTS'],
      distanceMeters: 0,
      durationSeconds: 0,
      serverAvgPaceSecondsPerKm: 0,
    };
  }

  let totalDistance = 0;
  let suspiciousSegmentCount = 0;

  for (let i = 1; i < coordinates.length; i++) {
    const prev = coordinates[i - 1];
    const curr = coordinates[i];

    // Timestamps must be strictly increasing — a stalled or rewound clock
    // is either a bug or an attempt to fake pace.
    if (curr.timestamp <= prev.timestamp) {
      isValid = false;
      reasons.push('NON_MONOTONIC_TIMESTAMP');
      continue;
    }

    // Reject wildly inaccurate fixes outright rather than letting them
    // silently distort the speed calculation.
    if (
      (prev.accuracyMeters !== undefined && prev.accuracyMeters > MAX_ACCEPTABLE_GPS_ACCURACY_METERS) ||
      (curr.accuracyMeters !== undefined && curr.accuracyMeters > MAX_ACCEPTABLE_GPS_ACCURACY_METERS)
    ) {
      isSuspicious = true;
      reasons.push('LOW_GPS_ACCURACY');
    }

    const segmentSeconds = (curr.timestamp - prev.timestamp) / 1000;
    const segmentDistance = haversineDistanceMeters(prev, curr);
    totalDistance += segmentDistance;

    if (segmentSeconds < MIN_REALISTIC_SEGMENT_SECONDS) {
      // Too many points fired within the same fraction of a second; can't
      // trust the instantaneous speed for this segment, skip its speed check.
      continue;
    }

    const segmentSpeedMps = segmentDistance / segmentSeconds;

    if (segmentSpeedMps > HARD_REJECT_SPEED_MPS) {
      isValid = false;
      reasons.push(
        `IMPOSSIBLE_SPEED_SEGMENT_${i}_${segmentSpeedMps.toFixed(1)}MPS`,
      );
    } else if (segmentSpeedMps > SUSTAINED_SUSPICIOUS_SPEED_MPS) {
      suspiciousSegmentCount += 1;
    }
  }

  // A handful of GPS-jitter blips over a long run is normal. A run where a
  // meaningful fraction of segments are "too fast" points to spoofing
  // (teleport-style GPS mocking apps) rather than noise.
  const suspiciousRatio = suspiciousSegmentCount / (coordinates.length - 1);
  if (suspiciousRatio > 0.1) {
    isSuspicious = true;
    reasons.push('SUSTAINED_SUSPICIOUS_SPEED');
  }

  const durationSeconds = (coordinates[coordinates.length - 1].timestamp - coordinates[0].timestamp) / 1000;

  if (totalDistance < MIN_RUN_DISTANCE_METERS) {
    isValid = false;
    reasons.push('DISTANCE_TOO_SHORT');
  }

  const serverAvgPaceSecondsPerKm =
    totalDistance > 0 ? durationSeconds / (totalDistance / 1000) : Infinity;

  return {
    isValid,
    isSuspicious,
    reasons,
    distanceMeters: totalDistance,
    durationSeconds,
    serverAvgPaceSecondsPerKm,
  };
}

/**
 * Cross-checks the client's self-reported average pace against the pace we
 * independently computed from raw coordinates + timestamps. A large mismatch
 * means the client is sending a manipulated summary alongside a (possibly
 * also manipulated) trace — flag it even if the trace itself looked plausible.
 */
export function checkClaimedPaceMismatch(
  serverPaceSecondsPerKm: number,
  clientClaimedPaceSecondsPerKm?: number,
): boolean {
  if (clientClaimedPaceSecondsPerKm === undefined) return false;
  if (!Number.isFinite(serverPaceSecondsPerKm) || serverPaceSecondsPerKm <= 0) return true;

  const delta = Math.abs(serverPaceSecondsPerKm - clientClaimedPaceSecondsPerKm);
  return delta / serverPaceSecondsPerKm > CLAIMED_PACE_TOLERANCE_RATIO;
}
