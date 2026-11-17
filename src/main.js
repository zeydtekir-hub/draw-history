import { Map as MapLibreMap, NavigationControl, AttributionControl, setWorkerUrl } from 'maplibre-gl';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { createClient } from '@supabase/supabase-js';
import {
  clone,
  EMPTY_COLLECTION,
  featureArea,
  featurePerimeter,
  featureVertexCount,
  findSnapTarget,
  fitBoundsForFeatures,
  formatArea,
  getRing,
  importFeatures,
  makeId,
  nearestEdge,
  normalizeFeature,
  ringsWithPaths,
  setRing,
} from './geometry.js';
import './style.css';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(mapLibreWorkerUrl);

const $ = (selector) => document.querySelector(selector);
const env = import.meta.env;
const configuredStyle = (env.VITE_MAPTILER_STYLE_URL || env.VITE_MAPTILER_KEY || '').trim();
const mapStyle = configuredStyle.startsWith('http')
  ? configuredStyle
  : configuredStyle
    ? `https://api.maptiler.com/maps/satellite-v4/style.json?key=${encodeURIComponent(configuredStyle)}`
    : '';
const maptilerKey = (() => {
  try {
    return new URL(mapStyle).searchParams.get('key') || '';
  } catch {
    return '';
  }
})();
const supabaseUrl = env.VITE_SUPABASE_URL || 'https://qazirczodfolcogqntvr.supabase.co';
const supabaseKey = env.VITE_SUPABASE_ANON_KEY || '';
const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const STORAGE_KEY = 'draw-history-project-v1';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function readProject() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!stored || !Array.isArray(stored.features)) {
      return {
        name: 'Untitled historical map',
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        features: [],
      };
    }
    return {
      name: String(stored.name || 'Untitled historical map'),
      createdAt: stored.createdAt || new Date().toISOString(),
      modifiedAt: stored.modifiedAt || new Date().toISOString(),
      features: importFeatures({ type: 'FeatureCollection', features: stored.features }),
    };
  } catch (error) {
    console.error('Could not restore the browser project:', error);
    setTimeout(() => toast('The saved browser project could not be restored. Start with a new project or inspect the browser console.', 'error'), 0);
    return {
      name: 'Untitled historical map',
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      features: [],
    };
  }
}

const project = readProject();
let features = project.features;
let selectedId = features[0]?.properties._id || null;
let activeTool = 'select';
let activePanel = 'layers';
let page = 'studio';
let snapEnabled = true;
let drawingPoints = [];
let drawingRedo = [];
let cursorCoordinate = null;
let snapCoordinate = null;
let edgePreview = null;
let isSpacePanning = false;
let draggingVertex = null;
let dragBefore = null;
let suppressNextClick = false;
let map;
let mapReady = false;
let worker = null;
let currentUser = null;
let archiveItems = [];
let archiveLoaded = false;
let archiveError = '';
let saveTimer;
let oceanDatasetAvailable = false;
let oceanDatasetStatus = 'Checking ocean dataset…';

const undoStack = [];
const redoStack = [];

function currentFeature() {
  return features.find((feature) => feature.properties._id === selectedId) || null;
}

function toast(message, type = 'success') {
  const toastNode = document.createElement('div');
  toastNode.className = `toast toast-${type}`;
  toastNode.innerHTML = `<span class="toast-mark">${type === 'error' ? '!' : '✓'}</span><span>${escapeHtml(message)}</span>`;
  $('#toast-stack').append(toastNode);
  window.setTimeout(() => toastNode.remove(), 4200);
}

function saveProject() {
  project.modifiedAt = new Date().toISOString();
  clearTimeout(saveTimer);
  $('#save-status').textContent = 'Saving…';
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        name: project.name,
        createdAt: project.createdAt,
        modifiedAt: project.modifiedAt,
        features,
      }));
      $('#save-status').textContent = 'Saved in this browser';
    } catch (error) {
      $('#save-status').textContent = 'Browser save failed';
      console.error('Could not save the browser project:', error);
      toast(`Browser save failed: ${error.message}`, 'error');
    }
  }, 180);
}

function snapshot() {
  return {
    features: clone(features),
    selectedId,
    projectName: project.name,
  };
}

function restoreSnapshot(value) {
  features = clone(value.features);
  selectedId = value.selectedId;
  project.name = value.projectName;
  updateAll();
}

function commitHistory(before = snapshot()) {
  undoStack.push(before);
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
  updateHistoryButtons();
}

function undo() {
  if (activeTool === 'pen' && drawingPoints.length) {
    drawingRedo.push(drawingPoints.pop());
    updateDrawing();
    return;
  }
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restoreSnapshot(undoStack.pop());
  updateHistoryButtons();
  toast('Change undone.');
}

function redo() {
  if (activeTool === 'pen' && drawingRedo.length) {
    drawingPoints.push(drawingRedo.pop());
    updateDrawing();
    return;
  }
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restoreSnapshot(redoStack.pop());
  updateHistoryButtons();
  toast('Change restored.');
}

function updateHistoryButtons() {
  $('#undo-button').disabled = activeTool === 'pen'
    ? drawingPoints.length === 0 && undoStack.length === 0
    : undoStack.length === 0;
  $('#redo-button').disabled = activeTool === 'pen'
    ? drawingRedo.length === 0 && redoStack.length === 0
    : redoStack.length === 0;
  $('#pen-undo').disabled = drawingPoints.length === 0;
  $('#pen-redo').disabled = drawingRedo.length === 0;
}

function collectionForMap() {
  return {
    type: 'FeatureCollection',
    features: features.filter((feature) => feature.properties.visible !== false).map((feature) => ({
      ...clone(feature),
      properties: { ...feature.properties, _selected: feature.properties._id === selectedId },
    })),
  };
}

function makePointCollection(coordinates) {
  return {
    type: 'FeatureCollection',
    features: coordinates.map((coordinates, index) => ({
      type: 'Feature',
      properties: { index },
      geometry: { type: 'Point', coordinates },
    })),
  };
}

function renderMap() {
  if (!mapReady) return;
  map.getSource('geometry-data')?.setData(collectionForMap());
  const feature = currentFeature();
  const vertices = feature
    ? ringsWithPaths(feature).flatMap(({ ring, path }) => ring.slice(0, -1).map((coordinates, index) => ({
      type: 'Feature',
      properties: { vertexIndex: index, ringPath: JSON.stringify(path) },
      geometry: { type: 'Point', coordinates },
    })))
    : [];
  map.getSource('vertex-data')?.setData({ type: 'FeatureCollection', features: vertices });

  const draftFeatures = [];
  if (drawingPoints.length > 1) {
    draftFeatures.push({
      type: 'Feature',
      properties: { role: 'fixed' },
      geometry: { type: 'LineString', coordinates: drawingPoints },
    });
  }
  if (cursorCoordinate && activeTool === 'pen' && drawingPoints.length) {
    draftFeatures.push({
      type: 'Feature',
      properties: { role: 'preview' },
      geometry: { type: 'LineString', coordinates: [drawingPoints.at(-1), cursorCoordinate] },
    });
  }
  if (drawingPoints.length) draftFeatures.push(...makePointCollection(drawingPoints).features);
  map.getSource('drawing-data')?.setData({ type: 'FeatureCollection', features: draftFeatures });

  const hoverPoints = [];
  if (snapCoordinate) hoverPoints.push({ type: 'Feature', properties: { role: 'snap' }, geometry: { type: 'Point', coordinates: snapCoordinate } });
  else if (edgePreview) hoverPoints.push({ type: 'Feature', properties: { role: 'edge' }, geometry: { type: 'Point', coordinates: edgePreview.coordinate } });
  map.getSource('hover-data')?.setData({ type: 'FeatureCollection', features: hoverPoints });
}

function updateStats() {
  const count = features.length;
  const totalVertices = features.reduce((sum, feature) => sum + featureVertexCount(feature), 0);
  const area = features.reduce((sum, feature) => sum + featureArea(feature), 0);
  $('#feature-count').textContent = count.toLocaleString();
  $('#vertex-count').textContent = totalVertices.toLocaleString();
  $('#total-area').textContent = formatArea(area);
  $('#geometry-status').textContent = count ? 'Geometry valid' : 'No geometry';
  $('.status-clean').classList.toggle('has-geometry', count > 0);
  renderPanel();
}

function updateAll() {
  renderMap();
  updateStats();
  saveProject();
  updateHistoryButtons();
}

function setSelected(id) {
  selectedId = id;
  renderMap();
  renderPanel();
}

function addFeature(feature, message = 'Geometry added.') {
  features.push(feature);
  selectedId = feature.properties._id;
  updateAll();
  toast(message);
}

function addGeoJSON(rawFeatures, label = 'GeoJSON imported successfully.') {
  const before = snapshot();
  const uniqueFeatures = rawFeatures.map((feature) => {
    feature.properties._id = makeId();
    return feature;
  });
  commitHistory(before);
  features = [...features, ...uniqueFeatures];
  selectedId = uniqueFeatures.at(-1)?.properties._id || selectedId;
  updateAll();
  fitSelected();
  toast(label);
}

function setTool(tool) {
  if (!['select', 'pen', 'add', 'delete'].includes(tool)) return;
  if (activeTool === 'pen' && tool !== 'pen' && drawingPoints.length) {
    if (!window.confirm('Discard the unfinished polygon?')) return;
    cancelDrawing();
  }
  activeTool = tool;
  document.querySelectorAll('.tool-button[data-tool]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.tool === tool);
  });
  $('#pen-toolbar').classList.toggle('hidden', tool !== 'pen');
  if (mapReady) {
    if (tool === 'pen') map.dragPan.disable();
    else map.dragPan.enable();
    map.getCanvas().style.cursor = tool === 'pen' ? 'crosshair' : '';
  }
  if (tool !== 'pen') {
    drawingPoints = [];
    drawingRedo = [];
    cursorCoordinate = null;
    snapCoordinate = null;
  }
  if (tool !== 'add') edgePreview = null;
  updateDrawing();
  renderMap();
  updateHistoryButtons();
}

function updateDrawing() {
  $('#pen-count').textContent = `${drawingPoints.length} ${drawingPoints.length === 1 ? 'point' : 'points'}`;
  updateHistoryButtons();
  renderMap();
}

function snapFor(coordinate, excludedId = null, extras = []) {
  if (!snapEnabled || !mapReady) return null;
  return findSnapTarget(
    map,
    features.filter((feature) => feature.properties._id !== excludedId),
    coordinate,
    12,
    extras,
  );
}

function effectiveCoordinate(coordinate, excludedId = null, extras = []) {
  return snapFor(coordinate, excludedId, extras)?.coordinate || coordinate;
}

function handleMapMove(event) {
  const { lng, lat } = event.lngLat;
  $('#cursor-lat').textContent = lat.toFixed(4);
  $('#cursor-lng').textContent = lng.toFixed(4);
  cursorCoordinate = [lng, lat];
  snapCoordinate = null;
  edgePreview = null;

  if (activeTool === 'pen') {
    const snap = snapFor(cursorCoordinate, null, drawingPoints);
    if (snap) {
      cursorCoordinate = snap.coordinate;
      snapCoordinate = snap.coordinate;
    }
    const indicator = $('#snap-indicator');
    indicator.classList.toggle('hidden', !snap);
    if (snap) {
      const point = map.project(snap.coordinate);
      indicator.style.left = `${point.x + 14}px`;
      indicator.style.top = `${point.y - 12}px`;
    }
    renderMap();
    return;
  }

  $('#snap-indicator').classList.add('hidden');
  if (draggingVertex) {
    const feature = currentFeature();
    if (!feature) return;
    const ring = getRing(feature, draggingVertex.path);
    const otherVertices = ring.slice(0, -1).filter((_, index) => index !== draggingVertex.index);
    const nextCoordinate = effectiveCoordinate(cursorCoordinate, feature.properties._id, otherVertices);
    ring[draggingVertex.index] = nextCoordinate;
    if (draggingVertex.index === 0) ring[ring.length - 1] = [...nextCoordinate];
    renderMap();
    return;
  }
  if (activeTool === 'add' && currentFeature()) {
    const snap = snapFor(cursorCoordinate, selectedId);
    if (snap) {
      snapCoordinate = snap.coordinate;
    } else {
      edgePreview = nearestEdge(map, currentFeature(), cursorCoordinate, 12);
    }
    renderMap();
  }
}

function addDrawingPoint(lngLat) {
  const coordinate = [lngLat.lng, lngLat.lat];
  const snap = snapFor(coordinate, null, drawingPoints);
  drawingPoints.push(snap?.coordinate || coordinate);
  drawingRedo = [];
  cursorCoordinate = null;
  snapCoordinate = null;
  updateDrawing();
}

function finishDrawing() {
  if (drawingPoints.length < 3) {
    toast('A polygon needs at least three points.', 'error');
    return;
  }
  const ring = [...drawingPoints.map((point) => [...point]), [...drawingPoints[0]]];
  let feature;
  try {
    feature = normalizeFeature({
      type: 'Feature',
      properties: { name: `Polygon ${features.length + 1}` },
      geometry: { type: 'Polygon', coordinates: [ring] },
    }, `Polygon ${features.length + 1}`);
  } catch (error) {
    toast(`Polygon could not be finished: ${error.message}`, 'error');
    return;
  }
  commitHistory();
  features.push(feature);
  selectedId = feature.properties._id;
  drawingPoints = [];
  drawingRedo = [];
  cursorCoordinate = null;
  snapCoordinate = null;
  activeTool = 'select';
  $('#pen-toolbar').classList.add('hidden');
  document.querySelectorAll('.tool-button[data-tool]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.tool === 'select');
  });
  map.dragPan.enable();
  map.getCanvas().style.cursor = '';
  updateAll();
  fitSelected();
  toast('Polygon created.');
}

function cancelDrawing() {
  drawingPoints = [];
  drawingRedo = [];
  cursorCoordinate = null;
  snapCoordinate = null;
  $('#snap-indicator').classList.add('hidden');
  updateDrawing();
}

function fitSelected() {
  if (!mapReady) return;
  const visible = selectedId
    ? features.filter((feature) => feature.properties._id === selectedId && feature.properties.visible !== false)
    : features.filter((feature) => feature.properties.visible !== false);
  if (!visible.length) {
    toast('There is no visible geometry to fit.', 'error');
    return;
  }
  const bounds = fitBoundsForFeatures(visible);
  map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], {
    padding: 72,
    maxZoom: 12,
    duration: 650,
  });
}

function queryFeature(point) {
  const hits = map.queryRenderedFeatures(point, { layers: ['geometry-fill', 'geometry-line'] });
  const id = hits[0]?.properties?._id;
  return features.find((feature) => feature.properties._id === id) || null;
}

function nearestVertex(point, feature, tolerance = 10) {
  if (!feature) return null;
  let best = null;
  for (const { ring, path } of ringsWithPaths(feature)) {
    for (let index = 0; index < ring.length - 1; index += 1) {
      const pixel = map.project(ring[index]);
      const distance = Math.hypot(pixel.x - point.x, pixel.y - point.y);
      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = { path, index, distance };
      }
    }
  }
  return best;
}

function onMapClick(event) {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  if (activeTool === 'pen') {
    if (isSpacePanning) return;
    addDrawingPoint(event.lngLat);
    return;
  }

  const hit = queryFeature(event.point);
  if (activeTool === 'select') {
    setSelected(hit?.properties._id || null);
    return;
  }

  if (activeTool === 'add') {
    const feature = currentFeature();
    if (!feature) {
      toast('Select a polygon layer before editing its vertices.', 'error');
      return;
    }
    const edge = nearestEdge(map, feature, [event.lngLat.lng, event.lngLat.lat], 12);
    if (!edge) {
      if (hit && hit.properties._id !== selectedId) setSelected(hit.properties._id);
      else toast('Click close to a polygon edge or vertex.', 'error');
      return;
    }
    const before = snapshot();
    const ring = [...getRing(feature, edge.path)];
    ring.splice(edge.insertAt, 0, [...edge.coordinate]);
    setRing(feature, edge.path, ring);
    try {
      const normalized = normalizeFeature(feature);
      features = features.map((item) => item.properties._id === selectedId ? normalized : item);
      commitHistory(before);
      updateAll();
      toast('Vertex added.');
    } catch (error) {
      restoreSnapshot(before);
      toast(error.message, 'error');
    }
    return;
  }

  if (activeTool === 'delete') {
    if (!hit) {
      toast('Click a shape to delete it.', 'error');
      return;
    }
    removeFeature(hit.properties._id);
  }
}

function removeFeature(id) {
  const feature = features.find((item) => item.properties._id === id);
  if (!feature || !window.confirm(`Delete “${feature.properties.name}”? This cannot be undone outside this session's history.`)) return;
  commitHistory();
  features = features.filter((item) => item.properties._id !== id);
  selectedId = features[0]?.properties._id || null;
  updateAll();
  toast('Geometry deleted.');
}

function startVertexDrag(event) {
  if (activeTool !== 'add' || !currentFeature()) return;
  const vertex = nearestVertex(event.point, currentFeature(), 10);
  if (!vertex) return;
  draggingVertex = vertex;
  dragBefore = snapshot();
  map.dragPan.disable();
  map.getCanvas().style.cursor = 'grabbing';
  event.preventDefault();
}

function endVertexDrag() {
  if (!draggingVertex) return;
  draggingVertex = null;
  map.dragPan.enable();
  map.getCanvas().style.cursor = 'crosshair';
  try {
    const feature = currentFeature();
    const normalized = normalizeFeature(feature);
    features = features.map((item) => item.properties._id === selectedId ? normalized : item);
    commitHistory(dragBefore);
    updateAll();
    toast('Vertex moved.');
  } catch (error) {
    restoreSnapshot(dragBefore);
    toast(`Vertex move rejected: ${error.message}`, 'error');
  } finally {
    dragBefore = null;
    suppressNextClick = true;
  }
}

function addMapSourcesAndLayers() {
  map.addSource('geometry-data', { type: 'geojson', data: EMPTY_COLLECTION() });
  map.addLayer({
    id: 'geometry-fill',
    type: 'fill',
    source: 'geometry-data',
    paint: {
      'fill-color': ['case', ['boolean', ['get', '_selected'], false], '#e8b84f', '#9d7629'],
      'fill-opacity': ['case', ['boolean', ['get', '_selected'], false], 0.3, 0.22],
    },
  });
  map.addLayer({
    id: 'geometry-line',
    type: 'line',
    source: 'geometry-data',
    paint: {
      'line-color': ['case', ['boolean', ['get', '_selected'], false], '#f4cd78', '#d2ad5c'],
      'line-width': ['case', ['boolean', ['get', '_selected'], false], 2.4, 1.5],
    },
  });
  map.addSource('vertex-data', { type: 'geojson', data: EMPTY_COLLECTION() });
  map.addLayer({
    id: 'vertex-points',
    type: 'circle',
    source: 'vertex-data',
    paint: {
      'circle-radius': 4,
      'circle-color': '#f4cd78',
      'circle-stroke-color': '#171914',
      'circle-stroke-width': 1.5,
    },
  });
  map.addSource('drawing-data', { type: 'geojson', data: EMPTY_COLLECTION() });
  map.addLayer({
    id: 'drawing-line',
    type: 'line',
    source: 'drawing-data',
    filter: ['==', ['get', 'role'], 'preview'],
    paint: {
      'line-color': '#f4cd78',
      'line-width': 2,
      'line-dasharray': [2, 1.7],
    },
  });
  map.addLayer({
    id: 'drawing-fixed-line',
    type: 'line',
    source: 'drawing-data',
    filter: ['==', ['get', 'role'], 'fixed'],
    paint: {
      'line-color': '#f4cd78',
      'line-width': 2,
    },
  });
  map.addLayer({
    id: 'drawing-points',
    type: 'circle',
    source: 'drawing-data',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 4,
      'circle-color': '#e8b84f',
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#121411',
    },
  });
  map.addSource('hover-data', { type: 'geojson', data: EMPTY_COLLECTION() });
  map.addLayer({
    id: 'hover-point',
    type: 'circle',
    source: 'hover-data',
    paint: {
      'circle-radius': 7,
      'circle-color': '#fff1be',
      'circle-stroke-color': '#e8b84f',
      'circle-stroke-width': 2,
    },
  });
}

function initializeMap() {
  if (!mapStyle) {
    $('#map-loading').classList.add('hidden');
    $('#map-error').classList.remove('hidden');
    $('#map-error').textContent = 'MapTiler style is not configured. Set VITE_MAPTILER_KEY in .env.local and restart Vite.';
    return;
  }
  try {
    map = new MapLibreMap({
      container: 'map',
      style: mapStyle,
      center: [15, 25],
      zoom: 2,
      attributionControl: false,
      maxZoom: 20,
      cooperativeGestures: true,
    });
    map.addControl(new NavigationControl({ showCompass: true }), 'bottom-right');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
    map.on('load', () => {
      mapReady = true;
      $('#map-loading').classList.add('hidden');
      $('#map-error').classList.add('hidden');
      addMapSourcesAndLayers();
      renderMap();
      map.on('mousemove', handleMapMove);
      map.on('click', onMapClick);
      map.on('mousedown', startVertexDrag);
      map.on('mouseup', endVertexDrag);
      map.on('mouseleave', endVertexDrag);
      map.on('zoom', () => {
        $('#zoom-level').textContent = map.getZoom().toFixed(1);
      });
      map.on('dragstart', () => {
        if (activeTool === 'pen' && !isSpacePanning) map.dragPan.disable();
      });
      $('#zoom-level').textContent = map.getZoom().toFixed(1);
    });
    map.on('error', (event) => {
      if (!mapReady) {
        $('#map-loading').classList.add('hidden');
        $('#map-error').classList.remove('hidden');
        $('#map-error').textContent = `The satellite map could not load. Check the MapTiler key and allowed domains. ${event.error?.message || ''}`;
      }
    });
  } catch (error) {
    $('#map-loading').classList.add('hidden');
    $('#map-error').classList.remove('hidden');
    $('#map-error').textContent = `Map initialization failed: ${error.message}`;
  }
}

function renderPanel() {
  const root = $('#panel-content');
  if (!root) return;
  if (activePanel === 'layers') root.innerHTML = renderLayersPanel();
  if (activePanel === 'operations') root.innerHTML = renderOperationsPanel();
  if (activePanel === 'project') root.innerHTML = renderProjectPanel();
  if (activePanel === 'media') root.innerHTML = renderMediaPanel();
}

function renderLayersPanel() {
  const selected = currentFeature();
  const totalSelected = selected ? 1 : 0;
  const layerRows = features.map((feature) => {
    const isSelected = feature.properties._id === selectedId;
    return `<article class="layer-card ${isSelected ? 'is-selected' : ''}" data-layer-id="${escapeHtml(feature.properties._id)}">
      <div class="layer-card-main">
        <button class="layer-select" data-action="select-layer" data-id="${escapeHtml(feature.properties._id)}" aria-label="Select ${escapeHtml(feature.properties.name)}">
          <span class="layer-color"></span>
          <span class="layer-title-block"><strong>${escapeHtml(feature.properties.name)}</strong><small>${feature.geometry.type} · ${featureVertexCount(feature)} vertices</small></span>
        </button>
        <label class="visibility-control" title="Toggle visibility"><input type="checkbox" data-action="visibility" data-id="${escapeHtml(feature.properties._id)}" ${feature.properties.visible !== false ? 'checked' : ''}><span></span></label>
      </div>
      <div class="layer-card-meta"><span>${formatArea(featureArea(feature))}</span><span>${featurePerimeter(feature).toLocaleString(undefined, { maximumFractionDigits: 1 })} km perimeter</span></div>
    </article>`;
  }).join('');
  const area = selected ? featureArea(selected) : 0;
  const perimeter = selected ? featurePerimeter(selected) : 0;
  const vertices = selected ? featureVertexCount(selected) : 0;
  return `<div class="panel-section">
    <div class="section-title-row"><div><h2>Geometry Layers</h2><p>${features.length} ${features.length === 1 ? 'layer' : 'layers'} · ${totalSelected} selected</p></div><button class="small-icon-button" data-action="import" title="Import GeoJSON">＋</button></div>
    <div class="layer-actions">
      <button class="text-action" data-action="fit-all" ${features.length ? '' : 'disabled'}>Fit all</button>
      <button class="text-action" data-action="duplicate" ${selected ? '' : 'disabled'}>Duplicate</button>
      <button class="text-action text-danger" data-action="delete-selected" ${selected ? '' : 'disabled'}>Delete</button>
    </div>
    <div class="layer-list">${layerRows || `<div class="empty-state"><span class="empty-icon">◇</span><strong>No geometry yet</strong><p>Choose Pen and click on the map to draw a polygon, or import a GeoJSON file.</p></div>`}</div>
  </div>
  <div class="panel-section inspector-section">
    <div class="section-title-row"><div><h2>Selection Inspector</h2><p>Live geometry analysis</p></div><span class="inspector-badge">${selected ? 'VALID' : '—'}</span></div>
    <div class="inspector-grid">
      <div><small>Features</small><strong>${selected ? 1 : 0}</strong></div>
      <div><small>Vertices</small><strong>${vertices}</strong></div>
      <div><small>Area</small><strong>${formatArea(area)}</strong></div>
      <div><small>Perimeter</small><strong>${perimeter.toLocaleString(undefined, { maximumFractionDigits: 1 })} km</strong></div>
    </div>
    ${selected ? `<label class="rename-field">Layer name<input data-action="rename" data-id="${escapeHtml(selectedId)}" maxlength="120" value="${escapeHtml(selected.properties.name)}"></label>` : ''}
  </div>`;
}

function renderOperationsPanel() {
  const selected = currentFeature();
  return `<div class="panel-section">
    <div class="section-title-row"><div><h2>Geometry Operations</h2><p>Apply spatial operations to the selected feature.</p></div></div>
    <article class="operation-card water-card">
      <div class="operation-icon">◒</div>
      <div><strong>Water Mask</strong><p>Remove ocean areas from a rough polygon while preserving separate land fragments and islands.</p></div>
      <button class="button button-primary button-wide" data-action="watermask" ${selected && oceanDatasetAvailable ? '' : 'disabled'}>Apply Water Mask <span>→</span></button>
      <small class="dataset-status ${oceanDatasetAvailable ? '' : 'dataset-missing'}">${escapeHtml(oceanDatasetStatus)}</small>
    </article>
    <div class="operation-list">
      <div class="operation-row"><span><i>⊕</i> Merge</span><span class="planned-tag">PLANNED</span></div>
      <div class="operation-row"><span><i>−</i> Subtract</span><span class="planned-tag">PLANNED</span></div>
      <div class="operation-row"><span><i>∩</i> Intersect</span><span class="planned-tag">PLANNED</span></div>
      <div class="operation-row"><span><i>⌕</i> Fix Geometry</span><span class="planned-tag">PLANNED</span></div>
      <div class="operation-row"><span><i>⌁</i> Reduce Points</span><span class="planned-tag">PLANNED</span></div>
    </div>
    <p class="panel-footnote">Heavy Water Mask processing runs in a Web Worker. The original geometry is kept if processing or validation fails.</p>
  </div>`;
}

function renderProjectPanel() {
  const area = features.reduce((sum, feature) => sum + featureArea(feature), 0);
  return `<div class="panel-section">
    <div class="section-title-row"><div><h2>Project</h2><p>Current browser workspace</p></div><span class="live-pill">LOCAL</span></div>
    <label class="rename-field">Project name<input id="project-name" maxlength="120" value="${escapeHtml(project.name)}"></label>
    <div class="project-meta">
      <div><span>Created</span><strong>${new Date(project.createdAt).toLocaleString()}</strong></div>
      <div><span>Last modified</span><strong>${new Date(project.modifiedAt).toLocaleString()}</strong></div>
      <div><span>Geometries</span><strong>${features.length}</strong></div>
      <div><span>Total area</span><strong>${formatArea(area)}</strong></div>
      <div><span>Save status</span><strong id="project-save-state">Saved in this browser</strong></div>
    </div>
    <p class="panel-footnote">Project geometry is autosaved in this browser. Published maps are stored separately in Supabase.</p>
  </div>`;
}

function renderMediaPanel() {
  return `<div class="panel-section">
    <div class="section-title-row"><div><h2>Reference Media</h2><p>Historical source material</p></div></div>
    <div class="empty-state media-empty"><span class="empty-icon">▧</span><strong>No media attached</strong><p>Reference images and map overlays are not available in this workspace yet.</p></div>
    <p class="panel-footnote">Media upload and image overlays are not implemented; no upload control is shown.</p>
  </div>`;
}

function openModal(content, onOpen) {
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true">${content}</section></div>`;
  $('#modal-root').querySelector('.modal-backdrop').addEventListener('click', (event) => {
    if (event.target.classList.contains('modal-backdrop')) closeModal();
  });
  $('#modal-root').querySelectorAll('[data-close-modal]').forEach((button) =>
    button.addEventListener('click', closeModal));
  onOpen?.();
}

function closeModal() {
  $('#modal-root').innerHTML = '';
}

function safeFilename(name, year) {
  const slug = name.normalize('NFKD').toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100) || 'historical-map';
  return `${slug}-${year}.geojson`;
}

function downloadGeoJSON(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportCollection(name, year) {
  const selected = currentFeature();
  const exported = selected ? [selected] : features;
  if (!exported.length) throw new Error('Draw or import at least one valid polygon before exporting.');
  const normalized = importFeatures({ type: 'FeatureCollection', features: exported });
  return {
    type: 'FeatureCollection',
    name,
    year,
    features: normalized,
  };
}

function openExportModal() {
  const selected = currentFeature();
  openModal(`<div class="modal-header"><div><span class="eyebrow">GEOJSON EXPORT</span><h2>Export Map</h2></div><button class="modal-close" data-close-modal aria-label="Close">×</button></div>
    <p class="modal-description">Export the current ${selected ? 'selected geometry' : 'workspace geometries'} or publish it to the public Data Bank.</p>
    <form id="export-form" class="modal-form">
      <label>Realm / Region Name<input name="name" required maxlength="120" value="${escapeHtml(selected?.properties.name || project.name)}" placeholder="e.g. Kingdom of Prussia"></label>
      <label>Year<input name="year" type="number" step="1" min="-10000" max="3000" required placeholder="e.g. 1648"></label>
      <p class="form-error hidden" id="export-error"></p>
      <div class="modal-actions"><button type="button" class="button button-quiet" data-close-modal>Cancel</button><button type="submit" class="button button-quiet">Download GeoJSON</button><button type="button" class="button button-primary" id="publish-button">Publish to Data Bank</button></div>
    </form>`, () => {
    const form = $('#export-form');
    const errorNode = $('#export-error');
    const readValues = () => {
      const data = new FormData(form);
      const name = String(data.get('name') || '').trim();
      const yearText = String(data.get('year') || '');
      const year = Number(yearText);
      if (!name || name.length > 120) throw new Error('Enter a name between 1 and 120 characters.');
      if (!Number.isInteger(year) || year < -10000 || year > 3000) throw new Error('Year must be an integer between -10000 and 3000.');
      return { name, year, geojson: exportCollection(name, year) };
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        const values = readValues();
        downloadGeoJSON(values.geojson, safeFilename(values.name, values.year));
        toast('GeoJSON downloaded.');
        errorNode.classList.add('hidden');
      } catch (error) {
        errorNode.textContent = error.message;
        errorNode.classList.remove('hidden');
      }
    });
    $('#publish-button').addEventListener('click', async () => {
      try {
        const values = readValues();
        await publishMap(values);
        closeModal();
      } catch (error) {
        errorNode.textContent = error.message;
        errorNode.classList.remove('hidden');
      }
    });
  });
}

async function publishMap(values) {
  if (!supabase) throw new Error('Supabase is not configured. Add VITE_SUPABASE_ANON_KEY to .env.local and restart Vite.');
  if (!currentUser) throw new Error('Sign in before publishing. Your local GeoJSON download is available separately.');
  const { data, error } = await supabase.from('maps').insert({
    name: values.name,
    year: values.year,
    geojson: values.geojson,
    created_by: currentUser.id,
  }).select('id,name,year,geojson,created_at,created_by').single();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error('Supabase did not confirm the published map.');
  toast('Map published successfully.');
  if (page === 'databank') await loadArchive();
}

function importButtonClick() {
  $('#geojson-file').click();
}

async function handleImport(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const imported = importFeatures(parsed);
    addGeoJSON(imported);
  } catch (error) {
    toast(`GeoJSON import failed: ${error.message}`, 'error');
  }
}

function duplicateSelected() {
  const feature = currentFeature();
  if (!feature) return;
  const duplicate = clone(feature);
  duplicate.properties._id = makeId();
  duplicate.properties.name = `${duplicate.properties.name} copy`;
  commitHistory();
  features.push(duplicate);
  selectedId = duplicate.properties._id;
  updateAll();
  toast('Geometry duplicated.');
}

function fitAll() {
  const visible = features.filter((feature) => feature.properties.visible !== false);
  if (!visible.length) {
    toast('There is no visible geometry to fit.', 'error');
    return;
  }
  const bounds = fitBoundsForFeatures(visible);
  map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], {
    padding: 72,
    maxZoom: 12,
    duration: 650,
  });
}

function clearWorkspace() {
  if (!features.length) return;
  if (!window.confirm('Clear every geometry in this browser workspace?')) return;
  commitHistory();
  features = [];
  selectedId = null;
  updateAll();
  toast('Workspace cleared.');
}

function showShortcuts() {
  openModal(`<div class="modal-header"><div><span class="eyebrow">QUICK REFERENCE</span><h2>Keyboard shortcuts</h2></div><button class="modal-close" data-close-modal aria-label="Close">×</button></div>
    <div class="shortcut-list"><div><span>Finish polygon</span><kbd>Enter</kbd></div><div><span>Cancel drawing / close dialog</span><kbd>Esc</kbd></div><div><span>Undo</span><kbd>Ctrl Z</kbd></div><div><span>Redo</span><kbd>Ctrl Y</kbd></div><div><span>Temporarily pan while drawing</span><kbd>Hold Space</kbd></div></div>`);
}

function switchPage(nextPage) {
  page = nextPage;
  $('#studio-page').classList.toggle('hidden', page !== 'studio');
  $('#databank-page').classList.toggle('hidden', page !== 'databank');
  document.querySelectorAll('.nav-link').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === page);
  });
  if (page === 'databank') loadArchive();
  else if (mapReady) map.resize();
}

function updateAccount() {
  $('#account-status').textContent = currentUser ? currentUser.email : (supabase ? 'Not signed in' : 'Local workspace');
  $('#account-button').textContent = currentUser ? 'Sign out' : 'Sign in';
}

function openAuthModal() {
  if (!supabase) {
    toast('Supabase is not configured. Add its URL and public anon key to .env.local.', 'error');
    return;
  }
  openModal(`<div class="modal-header"><div><span class="eyebrow">DRAW HISTORY ACCOUNT</span><h2>Sign in or create account</h2></div><button class="modal-close" data-close-modal aria-label="Close">×</button></div>
    <p class="modal-description">Your account is used to publish maps and manage only the maps you own.</p>
    <form id="auth-form" class="modal-form">
      <label>Email<input name="email" type="email" required autocomplete="email"></label>
      <label>Password<input name="password" type="password" required minlength="6" autocomplete="current-password"></label>
      <p class="form-error hidden" id="auth-error"></p>
      <div class="modal-actions"><button class="button button-quiet" type="button" id="sign-up-button">Create account</button><button class="button button-primary" type="submit">Sign in</button></div>
    </form>`, () => {
    const form = $('#auth-form');
    const errorNode = $('#auth-error');
    const authenticate = async (mode) => {
      const data = new FormData(form);
      const email = String(data.get('email') || '').trim();
      const password = String(data.get('password') || '');
      const response = mode === 'signup'
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
      if (response.error) throw response.error;
      if (mode === 'signup' && !response.data.session) {
        toast('Check your email to confirm the new account.');
        closeModal();
        return;
      }
      currentUser = response.data.user;
      updateAccount();
      closeModal();
      toast(mode === 'signup' ? 'Account created.' : 'Signed in.');
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      authenticate('signin').catch((error) => {
        errorNode.textContent = error.message;
        errorNode.classList.remove('hidden');
      });
    });
    $('#sign-up-button').addEventListener('click', () => {
      authenticate('signup').catch((error) => {
        errorNode.textContent = error.message;
        errorNode.classList.remove('hidden');
      });
    });
  });
}

async function loadArchive() {
  $('#archive-list').innerHTML = '';
  const message = $('#archive-message');
  message.classList.remove('hidden', 'archive-error');
  if (!supabase) {
    archiveError = 'Supabase is not configured. Add VITE_SUPABASE_ANON_KEY to .env.local to load the real public archive.';
    message.textContent = archiveError;
    message.classList.add('archive-error');
    archiveItems = [];
    archiveLoaded = false;
    renderArchive();
    return;
  }
  message.textContent = 'Loading maps…';
  const { data, error } = await supabase
    .from('maps')
    .select('id,name,year,geojson,created_at,created_by')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) {
    archiveError = `Could not load maps: ${error.message}`;
    message.textContent = archiveError;
    message.classList.add('archive-error');
    archiveItems = [];
    archiveLoaded = false;
    renderArchive();
    return;
  }
  archiveItems = data || [];
  archiveLoaded = true;
  archiveError = '';
  message.classList.add('hidden');
  renderArchive();
}

function filteredArchive() {
  const query = $('#archive-search').value.trim().toLowerCase();
  const sort = $('#archive-sort').value;
  const result = archiveItems.filter((item) =>
    String(item.name).toLowerCase().includes(query) || String(item.year).includes(query));
  const comparators = {
    newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
    oldest: (a, b) => new Date(a.created_at) - new Date(b.created_at),
    'name-asc': (a, b) => a.name.localeCompare(b.name),
    'name-desc': (a, b) => b.name.localeCompare(a.name),
    'year-asc': (a, b) => a.year - b.year,
    'year-desc': (a, b) => b.year - a.year,
  };
  return result.sort(comparators[sort] || comparators.newest);
}

function renderArchive() {
  const list = $('#archive-list');
  if (!archiveLoaded || archiveError) {
    list.innerHTML = '';
    return;
  }
  const items = filteredArchive();
  if (!items.length) {
    $('#archive-message').textContent = archiveItems.length
      ? 'No maps match your search.'
      : 'No maps have been published yet. Create a map and publish it to the Data Bank.';
    $('#archive-message').classList.remove('hidden', 'archive-error');
    return;
  }
  $('#archive-message').classList.add('hidden');
  list.innerHTML = items.map((item) => {
    const owned = currentUser && item.created_by === currentUser.id;
    const date = item.created_at ? new Date(item.created_at).toLocaleDateString() : 'Date unavailable';
    return `<article class="archive-card" data-card-id="${escapeHtml(item.id)}">
      <div class="archive-card-art"><span>DH</span><i>✳</i><div class="art-contour"></div></div>
      <div class="archive-card-content"><div class="archive-card-meta"><span class="year-chip">${escapeHtml(item.year)}</span><span>${escapeHtml(date)}</span></div>
      <h2>${escapeHtml(item.name)}</h2><p>Historical GeoJSON map</p>
      <div class="archive-card-actions"><button class="button button-primary" data-action="view-map" data-id="${escapeHtml(item.id)}">View</button><button class="button button-quiet" data-action="download-map" data-id="${escapeHtml(item.id)}">Download GeoJSON</button>${owned ? `<button class="icon-button danger-quiet" data-action="delete-map" data-id="${escapeHtml(item.id)}" title="Delete your map" aria-label="Delete your map">×</button>` : ''}</div></div>
    </article>`;
  }).join('');
}

function downloadArchiveItem(item) {
  downloadGeoJSON(item.geojson, safeFilename(item.name, item.year));
}

function openArchiveItem(item) {
  let imported;
  try {
    imported = importFeatures(item.geojson);
  } catch (error) {
    toast(`This published map contains invalid GeoJSON: ${error.message}`, 'error');
    return;
  }
  if (features.length && !window.confirm(`Add “${item.name}” to the current workspace? Existing geometries will remain.`)) return;
  project.name = `${item.name} (${item.year})`;
  saveProject();
  switchPage('studio');
  addGeoJSON(imported, 'Published map added to the workspace.');
}

async function deleteArchiveItem(item) {
  if (!supabase || !currentUser || item.created_by !== currentUser.id) return;
  if (!window.confirm(`Permanently delete your published map “${item.name}”?`)) return;
  const { data, error } = await supabase.from('maps')
    .delete()
    .eq('id', item.id)
    .select('id')
    .single();
  if (error) {
    toast(`Map deletion failed: ${error.message}`, 'error');
    return;
  }
  if (!data?.id) {
    toast('Supabase did not confirm the deletion.', 'error');
    return;
  }
  toast('Map deleted successfully.');
  await loadArchive();
}

function setPanel(panel) {
  activePanel = panel;
  document.querySelectorAll('.panel-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.panel === panel);
  });
  renderPanel();
}

async function applyWaterMask() {
  const selected = currentFeature();
  if (!selected) {
    toast('Select a polygon layer first.', 'error');
    return;
  }
  const before = snapshot();
  const requestId = makeId();
  $('#modal-root').innerHTML = `<div class="processing-backdrop"><div class="processing-card"><span class="spinner"></span><span class="eyebrow">TURF.JS · WEB WORKER</span><h2>Water Mask</h2><p id="processing-message">Starting geometry processing…</p><div class="progress-track"><span id="processing-progress"></span></div><small id="processing-percent">0%</small></div></div>`;
  const instance = new Worker(new URL('./watermask.worker.js', import.meta.url), { type: 'module' });
  worker = instance;
  const result = await new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Water Mask timed out after 3 minutes.')), 180000);
    instance.onmessage = (event) => {
      if (event.data.requestId && event.data.requestId !== requestId) return;
      if (event.data.type === 'progress') {
        $('#processing-message').textContent = event.data.message;
        const percent = Math.max(0, Math.min(100, Number(event.data.percent) || 0));
        $('#processing-progress').style.width = `${percent}%`;
        $('#processing-percent').textContent = `${percent}%`;
      } else if (event.data.type === 'result') {
        clearTimeout(timer);
        resolve(event.data.feature);
      } else if (event.data.type === 'error') {
        clearTimeout(timer);
        reject(new Error(event.data.message));
      }
    };
    instance.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(event.message || 'Water Mask worker failed.'));
    };
    instance.postMessage({ type: 'apply', feature: selected, requestId });
  });
  instance.terminate();
  worker = null;
  closeModal();
  const normalized = normalizeFeature({
    ...result,
    properties: { ...selected.properties, ...result.properties, _id: selected.properties._id },
  });
  commitHistory(before);
  features = features.map((feature) => feature.properties._id === selectedId ? normalized : feature);
  updateAll();
  toast('Water Mask applied successfully.');
}

function waterMaskAction() {
  applyWaterMask().catch((error) => {
    worker?.terminate();
    worker = null;
    closeModal();
    console.error('Water Mask failed:', error);
    toast(`Water Mask failed: ${error.message}. The original geometry was kept.`, 'error');
  });
}

function bindEvents() {
  $('.brand').addEventListener('click', (event) => {
    event.preventDefault();
    switchPage('studio');
  });
  document.querySelectorAll('.tool-button[data-tool]').forEach((button) =>
    button.addEventListener('click', () => setTool(button.dataset.tool)));
  document.querySelectorAll('.panel-tab').forEach((button) =>
    button.addEventListener('click', () => setPanel(button.dataset.panel)));
  document.querySelectorAll('.nav-link').forEach((button) =>
    button.addEventListener('click', () => switchPage(button.dataset.page)));

  $('#snap-button').addEventListener('click', () => {
    snapEnabled = !snapEnabled;
    $('#snap-button').classList.toggle('snap-on', snapEnabled);
    $('#snap-button').setAttribute('aria-pressed', String(snapEnabled));
    $('#snap-button').querySelector('.toggle-dot').classList.toggle('on', snapEnabled);
    toast(`Snapping ${snapEnabled ? 'enabled' : 'disabled'}.`);
  });
  $('#snap-button').classList.add('snap-on');
  $('#snap-button .toggle-dot').classList.add('on');
  $('#fit-button').addEventListener('click', fitSelected);
  $('#undo-button').addEventListener('click', undo);
  $('#redo-button').addEventListener('click', redo);
  $('#clear-button').addEventListener('click', clearWorkspace);
  $('#import-button').addEventListener('click', importButtonClick);
  $('#geojson-file').addEventListener('change', handleImport);
  $('#export-button').addEventListener('click', openExportModal);
  $('#pen-undo').addEventListener('click', undo);
  $('#pen-redo').addEventListener('click', redo);
  $('#pen-finish').addEventListener('click', finishDrawing);
  $('#pen-cancel').addEventListener('click', cancelDrawing);
  $('#shortcuts-button').addEventListener('click', showShortcuts);
  $('#account-button').addEventListener('click', () => {
    if (!currentUser) {
      openAuthModal();
      return;
    }
    supabase.auth.signOut().then(({ error }) => {
      if (error) toast(`Sign out failed: ${error.message}`, 'error');
      else {
        currentUser = null;
        updateAccount();
        renderArchive();
        toast('Signed out.');
      }
    });
  });
  $('#databank-refresh').addEventListener('click', loadArchive);
  $('#archive-search').addEventListener('input', renderArchive);
  $('#archive-sort').addEventListener('change', renderArchive);

  $('#panel-content').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const id = button.dataset.id;
    const action = button.dataset.action;
    if (action === 'import') importButtonClick();
    if (action === 'select-layer') setSelected(id);
    if (action === 'fit-all') fitAll();
    if (action === 'duplicate') duplicateSelected();
    if (action === 'delete-selected' && selectedId) removeFeature(selectedId);
    if (action === 'watermask') waterMaskAction();
  });
  $('#panel-content').addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset.action === 'visibility') {
      const feature = features.find((item) => item.properties._id === target.dataset.id);
      if (!feature) return;
      commitHistory();
      feature.properties.visible = target.checked;
      updateAll();
    }
    if (target.dataset.action === 'rename') {
      const feature = features.find((item) => item.properties._id === target.dataset.id);
      const name = target.value.trim();
      if (!feature || !name) {
        target.value = feature?.properties.name || '';
        return;
      }
      commitHistory();
      feature.properties.name = name;
      updateAll();
    }
  });
  $('#panel-content').addEventListener('keydown', (event) => {
    if (event.target.id === 'project-name' && event.key === 'Enter') event.target.blur();
  });
  $('#panel-content').addEventListener('change', (event) => {
    if (event.target.id === 'project-name') {
      const name = event.target.value.trim();
      if (name) {
        project.name = name;
        saveProject();
        toast('Project name saved in this browser.');
      }
    }
  });
  $('#archive-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const item = archiveItems.find((archiveItem) => archiveItem.id === button.dataset.id);
    if (!item) return;
    if (button.dataset.action === 'view-map') openArchiveItem(item);
    if (button.dataset.action === 'download-map') downloadArchiveItem(item);
    if (button.dataset.action === 'delete-map') deleteArchiveItem(item);
  });
  $('#map-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      searchPlace(event.target.value.trim());
    }
  });

  document.addEventListener('keydown', (event) => {
    const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (event.key === 'Escape') {
      if ($('#modal-root').firstElementChild) closeModal();
      else if (activeTool === 'pen') cancelDrawing();
    }
    if (!isInput && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    } else if (!isInput && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    } else if (!isInput && activeTool === 'pen' && event.key === 'Enter') {
      event.preventDefault();
      finishDrawing();
    } else if (!isInput && activeTool === 'pen' && event.code === 'Space' && !event.repeat) {
      event.preventDefault();
      isSpacePanning = true;
      map.dragPan.enable();
      map.getCanvas().style.cursor = 'grab';
    }
  });
  document.addEventListener('keyup', (event) => {
    if (event.code === 'Space' && isSpacePanning) {
      isSpacePanning = false;
      if (activeTool === 'pen') {
        map.dragPan.disable();
        map.getCanvas().style.cursor = 'crosshair';
      }
    }
  });
  window.addEventListener('blur', () => {
    if (isSpacePanning && activeTool === 'pen') {
      isSpacePanning = false;
      map.dragPan.disable();
    }
  });
}

async function searchPlace(query) {
  if (!query) return;
  if (!maptilerKey) {
    toast('Place search needs a MapTiler key in VITE_MAPTILER_KEY.', 'error');
    return;
  }
  try {
    const url = new URL(`https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json`);
    url.searchParams.set('key', maptilerKey);
    url.searchParams.set('limit', '1');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`MapTiler search returned ${response.status}.`);
    const result = await response.json();
    const place = result.features?.[0];
    if (!place) throw new Error('No matching place was found.');
    if (place.bbox) map.fitBounds([[place.bbox[0], place.bbox[1]], [place.bbox[2], place.bbox[3]]], { padding: 60, maxZoom: 12 });
    else map.flyTo({ center: place.center, zoom: 8 });
  } catch (error) {
    toast(`Place search failed: ${error.message}`, 'error');
  }
}

async function initializeSupabaseAuth() {
  if (!supabase) return;
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('Supabase session lookup failed:', error);
    toast(`Could not load account session: ${error.message}`, 'error');
  }
  currentUser = data?.session?.user || null;
  updateAccount();
  supabase.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user || null;
    updateAccount();
    renderArchive();
  });
}

async function checkOceanDataset() {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}ne_10m_ocean.geojson`, { method: 'HEAD' });
    oceanDatasetAvailable = response.ok;
    oceanDatasetStatus = response.ok
      ? 'Ocean dataset ready · Natural Earth 1:10m'
      : 'Ocean dataset missing · add public/ne_10m_ocean.geojson';
  } catch {
    oceanDatasetAvailable = false;
    oceanDatasetStatus = 'Ocean dataset could not be checked.';
  }
  if (activePanel === 'operations') renderPanel();
}

bindEvents();
setPanel('layers');
initializeMap();
initializeSupabaseAuth();
checkOceanDataset();
updateAll();
