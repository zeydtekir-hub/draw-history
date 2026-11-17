import * as turf from '@turf/turf';

let oceanGeometry;

async function loadOcean() {
  if (oceanGeometry) return oceanGeometry;
  self.postMessage({ type: 'progress', percent: 5, message: 'Loading ocean dataset…' });
  const response = await fetch('/ne_10m_ocean.geojson');
  if (!response.ok) {
    throw new Error('Ocean dataset not found. Place ne_10m_ocean.geojson in the public folder.');
  }
  const data = await response.json();
  const oceanFeatures = data.type === 'FeatureCollection'
    ? data.features
    : data.type === 'Feature'
      ? [data]
      : [{ type: 'Feature', properties: {}, geometry: data }];
  const polygons = oceanFeatures.filter((feature) =>
    feature?.geometry && ['Polygon', 'MultiPolygon'].includes(feature.geometry.type));
  if (!polygons.length) throw new Error('Ocean dataset contains no Polygon or MultiPolygon features.');

  self.postMessage({ type: 'progress', percent: 30, message: 'Preparing ocean geometry…' });
  oceanGeometry = polygons.length === 1
    ? polygons[0]
    : turf.union(turf.featureCollection(polygons));
  if (!oceanGeometry || !['Polygon', 'MultiPolygon'].includes(oceanGeometry.geometry?.type)) {
    oceanGeometry = undefined;
    throw new Error('Ocean dataset could not be combined into polygon geometry.');
  }
  return oceanGeometry;
}

self.onmessage = async (event) => {
  if (event.data?.type !== 'apply') return;
  try {
    const { feature, requestId } = event.data;
    self.postMessage({ type: 'progress', requestId, percent: 45, message: 'Removing ocean areas…' });
    const ocean = await loadOcean();
    const result = turf.difference(turf.featureCollection([feature, ocean]));
    if (!result) throw new Error('No land area remains after removing the ocean; the original geometry was kept.');

    self.postMessage({ type: 'progress', requestId, percent: 88, message: 'Validating land geometry…' });
    const cleaned = turf.cleanCoords(result);
    if (!['Polygon', 'MultiPolygon'].includes(cleaned.geometry?.type) ||
        !turf.booleanValid(cleaned)) {
      throw new Error('Water Mask produced invalid geometry; the original geometry was kept.');
    }
    self.postMessage({ type: 'result', requestId, feature: cleaned });
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId: event.data?.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
