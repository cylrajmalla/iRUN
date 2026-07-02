import { PoolClient } from 'pg';
import { pool } from '../config/db';
import {
  AppError,
  ProcessRunResult,
  RawCoordinate,
  TerritoryFeatureCollection,
} from '../types/domain';

// How far (in meters) two GPS traces can differ and still be considered
// "the same street" for capture purposes. Consumer GPS drift is typically
// 3-8m in open sky, more under tree cover / urban canyon — 10m is a
// reasonable middle ground for Kathmandu's dense street grid.
const CAPTURE_TOLERANCE_METERS = 10;

// Below this, a captured/remaining fragment is GPS noise, not a real street
// segment — discard it rather than littering the map with slivers.
const MIN_SEGMENT_LENGTH_METERS = 3;

const TERRITORY_LIFESPAN_HOURS = 24;

function toLineStringGeoJSON(coordinates: RawCoordinate[]): string {
  return JSON.stringify({
    type: 'LineString',
    coordinates: coordinates.map((c) => [c.lng, c.lat]),
  });
}

/**
 * Dumps a (possibly Multi)LineString GeoJSON blob into individual simple
 * LineString rows in territory_lines, discarding sub-length slivers.
 * Returns nothing — caller re-queries for the response payload.
 */
async function insertDumpedSegments(
  client: PoolClient,
  args: {
    geoJSON: string;
    userId: string;
    sourceRunId: string | null;
    paceSecondsPerKm: number;
    expiresAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO territory_lines
       (id, user_id, source_run_id, geom, length_meters, fastest_pace_seconds_per_km, expires_at)
     SELECT
       gen_random_uuid(),
       $1,
       $2,
       dumped.geom,
       ST_Length(dumped.geom::geography),
       $3,
       $4
     FROM (
       SELECT (ST_Dump(ST_SetSRID(ST_GeomFromGeoJSON($5), 4326))).geom AS geom
     ) dumped
     WHERE ST_Length(dumped.geom::geography) >= $6
       AND GeometryType(dumped.geom) = 'LINESTRING'`,
    [
      args.userId,
      args.sourceRunId,
      args.paceSecondsPerKm,
      args.expiresAt,
      args.geoJSON,
      MIN_SEGMENT_LENGTH_METERS,
    ],
  );
}

async function fetchFeatureCollectionNear(
  client: PoolClient,
  lineGeoJSON: string,
  bufferMeters: number,
): Promise<TerritoryFeatureCollection> {
  const { rows } = await client.query(
    `SELECT
       tls.id, tls.user_id, tls.username, tls.team_color, tls.status,
       tls.fastest_pace_seconds_per_km, tls.expires_at,
       ST_AsGeoJSON(tls.geom) AS geom_json
     FROM territory_lines_with_status tls
     WHERE ST_DWithin(
       tls.geom::geography,
       ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography,
       $2
     )`,
    [lineGeoJSON, bufferMeters],
  );

  return {
    type: 'FeatureCollection',
    features: rows.map((r) => ({
      type: 'Feature',
      geometry: JSON.parse(r.geom_json),
      properties: {
        id: r.id,
        userId: r.user_id,
        username: r.username,
        teamColor: r.team_color,
        status: r.status,
        fastestPaceSecondsPerKm: Number(r.fastest_pace_seconds_per_km),
        expiresAt: r.expires_at,
      },
    })),
  };
}

/**
 * Processes a finished run: validates the geometry, splits/reassigns any
 * intersecting enemy territory, refreshes the runner's own territory, and
 * claims whatever portion of the path was previously unclaimed.
 *
 * All mutations happen inside a single serializable-per-row transaction
 * (via SELECT ... FOR UPDATE on the intersecting rows) so two runners
 * finishing on the same street at the same instant can't both "win" the
 * same segment.
 */
export async function processRun(args: {
  userId: string;
  coordinates: RawCoordinate[];
  paceSecondsPerKm: number;
  isSuspicious: boolean;
  startedAt: Date;
  endedAt: Date;
}): Promise<ProcessRunResult> {
  const { userId, coordinates, paceSecondsPerKm, isSuspicious, startedAt, endedAt } = args;
  const client = await pool.connect();
  const capturedFromUserIds = new Set<string>();

  try {
    await client.query('BEGIN');

    const lineGeoJSON = toLineStringGeoJSON(coordinates);

    // 1. Build + sanity-check the run geometry.
    const {
      rows: [geomCheck],
    } = await client.query(
      `SELECT
         ST_Length(line::geography) AS length_m,
         ST_IsValid(line) AS is_valid
       FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS line) t`,
      [lineGeoJSON],
    );

    if (!geomCheck.is_valid || Number(geomCheck.length_m) < 20) {
      throw new AppError(
        'INVALID_GEOMETRY',
        'Run path is too short or geometrically invalid to register as territory.',
        422,
      );
    }

    // 2. Always log the raw run for audit, even if it's about to be flagged.
    const {
      rows: [{ id: runId }],
    } = await client.query(
      `INSERT INTO runs
         (id, user_id, raw_geom, distance_meters, duration_seconds,
          avg_pace_seconds_per_km, is_flagged_suspicious, started_at, ended_at)
       VALUES
         (gen_random_uuid(), $1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        userId,
        lineGeoJSON,
        geomCheck.length_m,
        Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
        paceSecondsPerKm,
        isSuspicious,
        startedAt,
        endedAt,
      ],
    );

    // Suspicious runs are logged for review but never awarded territory.
    if (isSuspicious) {
      await client.query('COMMIT');
      return {
        runId,
        isSuspicious: true,
        capturedFromUserIds: [],
        updatedFeatures: { type: 'FeatureCollection', features: [] },
      };
    }

    const expiresAt = new Date(Date.now() + TERRITORY_LIFESPAN_HOURS * 3600 * 1000);

    // 3. Lock every territory row (active OR neutral/expired) that spatially
    //    overlaps the new path within GPS tolerance. Locking here — not just
    //    reading — is what prevents two concurrent runs on the same street
    //    from both thinking they captured it.
    const { rows: overlapping } = await client.query(
      `SELECT tl.id, tl.user_id, tl.expires_at, tl.fastest_pace_seconds_per_km
       FROM territory_lines tl
       WHERE ST_Intersects(
               tl.geom,
               ST_Buffer(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)::geometry
             )
       FOR UPDATE`,
      [lineGeoJSON, CAPTURE_TOLERANCE_METERS],
    );

    for (const row of overlapping) {
      if (row.user_id === userId) {
        // Re-running your own street: refresh the 24h clock and keep the
        // better of the two paces. Geometry is untouched — no split needed.
        await client.query(
          `UPDATE territory_lines
             SET expires_at = $1,
                 fastest_pace_seconds_per_km = LEAST(fastest_pace_seconds_per_km, $2)
           WHERE id = $3`,
          [expiresAt, paceSecondsPerKm, row.id],
        );
        continue;
      }

      // --- Enemy (or neutral-but-owned-by-someone-else) territory: split it ---
      capturedFromUserIds.add(row.user_id);

      const {
        rows: [split],
      } = await client.query(
        `WITH buffered_new AS (
           SELECT ST_Buffer(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)::geometry AS b
         ),
         original AS (
           SELECT geom FROM territory_lines WHERE id = $3
         )
         SELECT
           ST_AsGeoJSON(ST_CollectionExtract(ST_Intersection(original.geom, buffered_new.b), 2)) AS captured,
           ST_AsGeoJSON(ST_CollectionExtract(ST_Difference(original.geom, buffered_new.b), 2))   AS remaining
         FROM original, buffered_new`,
        [lineGeoJSON, CAPTURE_TOLERANCE_METERS, row.id],
      );

      // The original row is superseded by up to two new rows below —
      // delete it first so we never end up with stale/overlapping geometry.
      await client.query(`DELETE FROM territory_lines WHERE id = $1`, [row.id]);

      // Whatever the original owner's path DIDN'T overlap stays exactly as
      // it was — same owner, same original expiry (no free extension for
      // territory the original owner didn't actually re-run).
      const remainingGeom = split.remaining ? JSON.parse(split.remaining) : null;
      if (remainingGeom && remainingGeom.coordinates?.length) {
        await insertDumpedSegments(client, {
          geoJSON: split.remaining,
          userId: row.user_id,
          sourceRunId: null,
          paceSecondsPerKm: row.fastest_pace_seconds_per_km,
          expiresAt: row.expires_at, // preserve, don't extend
        });
      }

      // The overlapped portion transfers to the new runner.
      const capturedGeom = split.captured ? JSON.parse(split.captured) : null;
      if (capturedGeom && capturedGeom.coordinates?.length) {
        await insertDumpedSegments(client, {
          geoJSON: split.captured,
          userId,
          sourceRunId: runId,
          paceSecondsPerKm,
          expiresAt,
        });
      }
    }

    // 4. Whatever portion of the new path never overlapped ANY existing
    //    territory (own or enemy) is brand-new, unclaimed street — award it
    //    outright. We re-derive this from current DB state (post-splits)
    //    rather than tracking it through the loop above, which keeps the
    //    logic correct regardless of how many rows were touched.
    const {
      rows: [freshResult],
    } = await client.query(
      `SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_Difference(
                ST_SetSRID(ST_GeomFromGeoJSON($1), 4326),
                ST_Buffer(
                  COALESCE(ST_Union(tl.geom), ST_GeomFromText('LINESTRING EMPTY', 4326))::geography,
                  $2
                )::geometry
              ), 2)) AS fresh
       FROM territory_lines tl
       WHERE ST_DWithin(
               tl.geom::geography,
               ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography,
               $2
             )`,
      [lineGeoJSON, CAPTURE_TOLERANCE_METERS],
    );

    const freshGeom = freshResult?.fresh ? JSON.parse(freshResult.fresh) : null;
    if (freshGeom && freshGeom.coordinates?.length) {
      await insertDumpedSegments(client, {
        geoJSON: freshResult.fresh,
        userId,
        sourceRunId: runId,
        paceSecondsPerKm,
        expiresAt,
      });
    }

    // 5. Pull back everything near the run for the response payload so the
    //    client can patch its local map state without a full re-fetch.
    const updatedFeatures = await fetchFeatureCollectionNear(client, lineGeoJSON, 50);

    await client.query('COMMIT');

    return {
      runId,
      isSuspicious: false,
      capturedFromUserIds: Array.from(capturedFromUserIds),
      updatedFeatures,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
