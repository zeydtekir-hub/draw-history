import * as turf from '@turf/turf';

export const EMPTY_COLLECTION = () => ({ type: 'FeatureCollection', features: [] });

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `feature-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function assertRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) {
    throw new Error('Each polygon ring must contain at least three vertices and a closing coordinate.');
  }
  const distinct = new Set(ring.slice(0, -1).map(([lng, lat]) => `${lng},${lat}`));
  if (distinct.size < 3) throw new Error('Each polygon ring needs at least three distinct vertices.');
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw new Error('Polygon rings must be closed.');
  }
  for (const point of ring) {
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) ||
        !Number.isFinite(point[1]) || point[0] < -180 || point[0] > 180 ||
        point[1] < -90 || point[1] > 90) {
      throw new Error('GeoJSON contains invalid longitude or latitude coordinates.');
    }
  }
}

export function normalizeFeature(input, fallbackName = 'Polygon') {
  if (!input || input.type !== 'Feature' || !input.geometry) {
    throw new Error('Expected a GeoJSON Feature with a geometry.');
  }
  if (!['Polygon', 'MultiPolygon'].includes(input.geometry.type)) {
    throw new Error(`Unsupported geometry type: ${input.geometry.type}. Import Polygon or MultiPolygon features.`);
  }

  const feature = clone(input);
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates;
  if (!Array.isArray(polygons) || polygons.length === 0) throw new Error('The polygon has no rings.');
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length === 0) throw new Error('The polygon has no outer ring.');
    polygon.forEach(assertRing);
  }

  feature.properties = feature.properties && typeof feature.properties === 'object'
    ? feature.properties
    : {};
  feature.properties._id = String(feature.properties._id || input.id || makeId());
  feature.properties.name = String(feature.properties.name || fallbackName).slice(0, 120);
  feature.properties.visible = feature.properties.visible !== false;

  const cleaned = turf.cleanCoords(feature);
  if (!turf.booleanValid(cleaned)) throw new Error('GeoJSON polygon is topologically invalid.');
  return cleaned;
}

export function importFeatures(value) {
  let candidates;
  if (value?.type === 'FeatureCollection' && Array.isArray(value.features)) {
    candidates = value.features;
  } else if (value?.type === 'Feature') {
    candidates = [value];
  } else if (value?.type === 'Polygon' || value?.type === 'MultiPolygon') {
    candidates = [{ type: 'Feature', properties: {}, geometry: value }];
  } else {
    throw new Error('Choose a GeoJSON Feature, FeatureCollection, Polygon, or MultiPolygon.');
  }

  if (!candidates.length) throw new Error('The GeoJSON file contains no features.');
  return candidates.map((feature, index) => normalizeFeature(feature, `Imported ${index + 1}`));
}

export function featureArea(feature) {
  return turf.area(feature);
}

export function featurePerimeter(feature) {
  return turf.length(feature, { units: 'kilometers' });
}

export function featureVertexCount(feature) {
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates;
  return polygons.reduce((sum, polygon) =>
    sum + polygon.reduce((ringSum, ring) => ringSum + Math.max(0, ring.length - 1), 0), 0);
}

export function formatArea(squareMeters) {
  const km2 = squareMeters / 1_000_000;
  if (km2 >= 1_000_000) return `${(km2 / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}m km²`;
  return `${km2.toLocaleString(undefined, { maximumFractionDigits: 2 })} km²`;
}

export function ringsWithPaths(feature) {
  if (feature.geometry.type === 'Polygon') {
    return feature.geometry.coordinates.map((ring, ringIndex) => ({
      ring,
      path: [ringIndex],
    }));
  }
  return feature.geometry.coordinates.flatMap((polygon, polygonIndex) =>
    polygon.map((ring, ringIndex) => ({ ring, path: [polygonIndex, ringIndex] })));
}

export function getRing(feature, path) {
  return path.length === 1
    ? feature.geometry.coordinates[path[0]]
    : feature.geometry.coordinates[path[0]][path[1]];
}

export function setRing(feature, path, ring) {
  if (path.length === 1) feature.geometry.coordinates[path[0]] = ring;
  else feature.geometry.coordinates[path[0]][path[1]] = ring;
}

function screenDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function closestPointOnScreenSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return {
    pixel: { x: start.x + t * dx, y: start.y + t * dy },
    t,
  };
}

export function findSnapTarget(map, features, lngLat, tolerance = 12, extraPoints = []) {
  const cursor = map.project(lngLat);
  let best = null;
  const consider = (coordinate, kind, pixel) => {
    const distance = screenDistance(cursor, pixel);
    if (distance <= tolerance && (!best || distance < best.distance ||
        (distance === best.distance && kind === 'vertex' && best.kind !== 'vertex'))) {
      best = { coordinate, kind, distance };
    }
  };

  for (const coordinate of extraPoints) {
    consider(coordinate, 'vertex', map.project(coordinate));
  }

  for (const feature of features) {
    for (const { ring } of ringsWithPaths(feature)) {
      const uniqueCount = ring.length - 1;
      for (let index = 0; index < uniqueCount; index += 1) {
        const start = ring[index];
        const end = ring[(index + 1) % uniqueCount];
        const startPixel = map.project(start);
        const endPixel = map.project(end);
        consider(start, 'vertex', startPixel);

        const nearestScreen = closestPointOnScreenSegment(cursor, startPixel, endPixel);
        if (screenDistance(cursor, nearestScreen.pixel) <= tolerance) {
          const nearestGeo = turf.nearestPointOnLine(
            turf.lineString([start, end]),
            lngLat,
            { units: 'kilometers' },
          );
          consider(nearestGeo.geometry.coordinates, 'edge', nearestScreen.pixel);
        }
      }
    }
  }
  return best;
}

export function nearestEdge(map, feature, lngLat, tolerance = 12) {
  const cursor = map.project(lngLat);
  let best = null;
  for (const { ring, path } of ringsWithPaths(feature)) {
    const uniqueCount = ring.length - 1;
    for (let index = 0; index < uniqueCount; index += 1) {
      const start = ring[index];
      const end = ring[(index + 1) % uniqueCount];
      const nearestScreen = closestPointOnScreenSegment(cursor, map.project(start), map.project(end));
      const distance = screenDistance(cursor, nearestScreen.pixel);
      if (distance > tolerance || (best && distance >= best.distance)) continue;
      const nearestGeo = turf.nearestPointOnLine(
        turf.lineString([start, end]),
        lngLat,
        { units: 'kilometers' },
      );
      best = {
        coordinate: nearestGeo.geometry.coordinates,
        path,
        insertAt: Math.min(index + 1, uniqueCount),
        distance,
      };
    }
  }
  return best;
}

export function fitBoundsForFeatures(features) {
  if (!features.length) return null;
  return turf.bbox({ type: 'FeatureCollection', features });
}

