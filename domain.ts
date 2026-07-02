export interface RawCoordinate {
  lat: number;
  lng: number;
  /** Unix epoch milliseconds. Required — anti-spoof checks are impossible without it. */
  timestamp: number;
  /** Optional GPS horizontal accuracy in meters, if the device reports it. */
  accuracyMeters?: number;
}

export interface SubmitRunPayload {
  userId: string;
  coordinates: RawCoordinate[];
  /** Client-reported average pace, cross-checked against server-computed pace. */
  clientAvgPaceSecondsPerKm?: number;
}

export interface SpoofCheckResult {
  isValid: boolean;
  isSuspicious: boolean;
  reasons: string[];
  distanceMeters: number;
  durationSeconds: number;
  serverAvgPaceSecondsPerKm: number;
}

export interface TerritoryFeatureProperties {
  id: string;
  userId: string;
  username: string;
  teamColor: string;
  status: 'active' | 'neutral';
  fastestPaceSecondsPerKm: number;
  expiresAt: string;
}

export type TerritoryFeatureCollection = GeoJSON.FeatureCollection<
  GeoJSON.LineString,
  TerritoryFeatureProperties
>;

export interface ProcessRunResult {
  runId: string;
  isSuspicious: boolean;
  capturedFromUserIds: string[];
  updatedFeatures: TerritoryFeatureCollection;
}

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
