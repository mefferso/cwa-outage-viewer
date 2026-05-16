// ================================
// CWA Outage Viewer
// DEMCO line-level outage viewer + Entergy red/green raster line tiles + Cleco/Entergy outage locations
// ================================

const DATA_ZOOM = 10;

const DEMCO_BASE_URL =
  `https://cache.sienatech.com/apex/siena_ords/webmaps/lines/DEMCO/base?zoom=${DATA_ZOOM}`;

const DEMCO_TEMP_URL =
  `https://cache.sienatech.com/apex/siena_ords/webmaps/lines/DEMCO/temp?zoom=${DATA_ZOOM}`;

// Entergy red/green line tiles are public PNG raster tiles using quadkey filenames.
// These are visual-only tiles, not queryable conductor/feeder/circuit geometry.
const ENTERGY_RED_GREEN_TILE_URL =
  "https://entergy-prod-red-green-external.s3-us-west-2.amazonaws.com/phase1/red_green/current";

// Cleco and Entergy are cached by GitHub Actions to avoid browser/CORS foolishness.
const CLECO_OUTAGES_URL = "data/cleco_outages.json";
const ENTERGY_CLUSTERS_URL = "data/entergy_clusters.json";
const ENTERGY_COUNTY_URL = "data/entergy_county.json";

const REFRESH_MS = 5 * 60 * 1000;

const INITIAL_MAP_CENTER = [30.55, -90.75];
const INITIAL_MAP_ZOOM = 7;

const map = L.map("map", {
  preferCanvas: true
}).setView(INITIAL_MAP_CENTER, INITIAL_MAP_ZOOM);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

function tileXYToQuadKey(x, y, z) {
  let quadKey = "";

  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);

    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;

    quadKey += digit.toString();
  }

  return quadKey;
}

const EntergyRedGreenTileLayer = L.TileLayer.extend({
  getTileUrl(coords) {
    const quadKey = tileXYToQuadKey(coords.x, coords.y, coords.z);
    return `${ENTERGY_RED_GREEN_TILE_URL}/${quadKey}.png`;
  }
});

const entergyRedGreenTileLayer = new EntergyRedGreenTileLayer("", {
  minZoom: 5,
  maxZoom: 18,
  maxNativeZoom: 18,
  opacity: 0.78,
  zIndex: 250,
  attribution: "Entergy red/green line tiles"
}).addTo(map);

const demcoBaseLayerGroup = L.featureGroup().addTo(map);
const demcoTempLayerGroup = L.featureGroup().addTo(map);
const clecoLayerGroup = L.featureGroup().addTo(map);
const entergyLayerGroup = L.featureGroup().addTo(map);

const els = {
  statusText: document.getElementById("statusText"),
  lastUpdated: document.getElementById("lastUpdated"),
  demcoBaseCount: document.getElementById("demcoBaseCount"),
  demcoTempCount: document.getElementById("demcoTempCount"),
  clecoIncidentCount: document.getElementById("clecoIncidentCount"),
  clecoAffectedCount: document.getElementById("clecoAffectedCount"),
  entergyClusterCount: document.getElementById("entergyClusterCount"),
  entergyAffectedCount: document.getElementById("entergyAffectedCount"),
  dataZoom: document.getElementById("dataZoom"),
  toggleDemcoBase: document.getElementById("toggleDemcoBase"),
  toggleDemcoTemp: document.getElementById("toggleDemcoTemp"),
  toggleEntergyLines: document.getElementById("toggleEntergyLines"),
  toggleCleco: document.getElementById("toggleCleco"),
  toggleEntergy: document.getElementById("toggleEntergy"),
  refreshBtn: document.getElementById("refreshBtn")
};

els.dataZoom.textContent = DATA_ZOOM;

function decodePolyline(encoded, precision = 5) {
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates = [];
  const factor = Math.pow(10, precision);

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = null;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += deltaLat;

    result = 0;
    shift = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += deltaLng;

    coordinates.push([lat / factor, lng / factor]);
  }

  return coordinates;
}

async function fetchJson(url) {
  const cacheBust = url.includes("?") ? `&v=${Date.now()}` : `?v=${Date.now()}`;
  const response = await fetch(`${url}${cacheBust}`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatClecoTime(value) {
  if (!value) return "Unknown";
  return String(value).replace(/^0/, "");
}

function getSettledValue(result, fallback, label, warnings) {
  if (result.status === "fulfilled") return result.value;
  console.warn(`${label} failed to load`, result.reason);
  warnings.push(label);
  return fallback;
}

function getClecoIncidents(payload) {
  if (!payload || !Array.isArray(payload.data)) return [];

  return payload.data.filter((incident) => {
    const lat = Number(incident.lat);
    const lon = Number(incident.lon);
    return Number.isFinite(lat) && Number.isFinite(lon);
  });
}

function getEntergyClusters(payload) {
  if (!payload || !Array.isArray(payload.features)) return [];

  return payload.features.filter((feature) => {
    const geom = feature.geometry || {};
    return Number.isFinite(Number(geom.x)) && Number.isFinite(Number(geom.y));
  });
}

function getEntergyCountyAffected(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((total, row) => total + Number(row.customersAffected || 0), 0);
}

function demcoPopupHtml(line, layerName) {
  return `
    <strong>DEMCO ${layerName}</strong><br>
    Feature ID: ${line.f || "unknown"}<br>
    e: ${line.e ?? "unknown"}<br>
    t: ${line.t || "unknown"}
  `;
}

function clecoPopupHtml(incident) {
  const affected = Number(incident.affectedCount || 0);
  const affectedAreas = Array.isArray(incident.affectedAreas) ? incident.affectedAreas : [];
  const areaText = affectedAreas
    .map((area) => {
      const zip = area.zipCode || area.zipcode || "";
      const location = area.location || "Unknown area";
      return zip ? `${location} (${zip})` : location;
    })
    .join("<br>");

  return `
    <strong>Cleco outage location</strong><br>
    Location: ${incident.location || "Unknown"}<br>
    Customers affected: ${formatNumber(affected)}<br>
    Start: ${formatClecoTime(incident.startTime)}<br>
    Estimated restoration: ${formatClecoTime(incident.restorationTime)}<br>
    Last updated: ${formatClecoTime(incident.lastUpdateTime)}<br>
    Incident ID: ${incident.incidentId || "unknown"}
    ${areaText ? `<hr><strong>Affected area(s)</strong><br>${areaText}` : ""}
  `;
}

function entergyPopupHtml(feature) {
  const attrs = feature.attributes || {};
  const clusterCount = attrs.clustercount ?? "unknown";
  const people = attrs.numpeople ?? 0;
  const id = attrs.id || attrs.objectid || "unknown";

  return `
    <strong>Entergy outage cluster</strong><br>
    Customers affected: ${formatNumber(people)}<br>
    Cluster count: ${formatNumber(clusterCount)}<br>
    Feature ID: ${id}
  `;
}

function drawDemcoBaseLines(lines) {
  demcoBaseLayerGroup.clearLayers();

  for (const line of lines) {
    if (!line.g) continue;
    const polyline = L.polyline(decodePolyline(line.g), {
      color: "#22c55e",
      weight: 2,
      opacity: 0.55,
      interactive: true
    });
    polyline.bindPopup(demcoPopupHtml(line, "base line"));
    polyline.addTo(demcoBaseLayerGroup);
  }
}

function drawDemcoTempLines(lines) {
  demcoTempLayerGroup.clearLayers();

  for (const line of lines) {
    if (!line.g) continue;
    const latlngs = decodePolyline(line.g);

    L.polyline(latlngs, {
      color: "#991b1b",
      weight: 7,
      opacity: 0.55,
      interactive: false
    }).addTo(demcoTempLayerGroup);

    const redLine = L.polyline(latlngs, {
      color: "#ef4444",
      weight: 4,
      opacity: 0.95,
      interactive: true
    });
    redLine.bindPopup(demcoPopupHtml(line, "outage/temp line"));
    redLine.addTo(demcoTempLayerGroup);
  }
}

function getClecoRadius(affectedCount) {
  const affected = Number(affectedCount || 0);
  if (affected <= 1) return 7;
  if (affected <= 5) return 9;
  if (affected <= 25) return 12;
  if (affected <= 100) return 16;
  return 22;
}

function getEntergyRadius(numPeople, clusterCount) {
  const affected = Number(numPeople || 0);
  const clusters = Number(clusterCount || 0);
  const base = Math.max(affected, clusters);
  if (base <= 1) return 7;
  if (base <= 10) return 10;
  if (base <= 50) return 14;
  if (base <= 250) return 19;
  return 26;
}

function drawClecoOutages(incidents) {
  clecoLayerGroup.clearLayers();

  for (const incident of incidents) {
    const lat = Number(incident.lat);
    const lon = Number(incident.lon);
    const affected = Number(incident.affectedCount || 0);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const marker = L.circleMarker([lat, lon], {
      radius: getClecoRadius(affected),
      color: "#7f1d1d",
      weight: 2,
      fillColor: affected > 1 ? "#f97316" : "#ef4444",
      fillOpacity: 0.85,
      opacity: 0.95
    });
    marker.bindPopup(clecoPopupHtml(incident));
    marker.addTo(clecoLayerGroup);
  }
}

function drawEntergyClusters(features) {
  entergyLayerGroup.clearLayers();

  for (const feature of features) {
    const geom = feature.geometry || {};
    const attrs = feature.attributes || {};
    const lon = Number(geom.x);
    const lat = Number(geom.y);
    const affected = Number(attrs.numpeople || 0);
    const clusterCount = Number(attrs.clustercount || 0);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const marker = L.circleMarker([lat, lon], {
      radius: getEntergyRadius(affected, clusterCount),
      color: "#581c87",
      weight: 2,
      fillColor: "#a855f7",
      fillOpacity: 0.78,
      opacity: 0.95
    });
    marker.bindPopup(entergyPopupHtml(feature));
    marker.addTo(entergyLayerGroup);
  }
}

async function loadData() {
  els.statusText.textContent = "Loading outage data...";
  const warnings = [];

  const [demcoBaseResult, demcoTempResult, clecoResult, entergyClusterResult, entergyCountyResult] =
    await Promise.allSettled([
      fetchJson(DEMCO_BASE_URL),
      fetchJson(DEMCO_TEMP_URL),
      fetchJson(CLECO_OUTAGES_URL),
      fetchJson(ENTERGY_CLUSTERS_URL),
      fetchJson(ENTERGY_COUNTY_URL)
    ]);

  const demcoBaseData = getSettledValue(demcoBaseResult, { lines: [] }, "DEMCO base", warnings);
  const demcoTempData = getSettledValue(demcoTempResult, { lines: [] }, "DEMCO outage", warnings);
  const clecoData = getSettledValue(clecoResult, { data: [] }, "Cleco cached outages", warnings);
  const entergyClusterData = getSettledValue(entergyClusterResult, { features: [] }, "Entergy clusters", warnings);
  const entergyCountyData = getSettledValue(entergyCountyResult, { data: [] }, "Entergy county summary", warnings);

  const demcoBaseLines = Array.isArray(demcoBaseData.lines) ? demcoBaseData.lines : [];
  const demcoTempLines = Array.isArray(demcoTempData.lines) ? demcoTempData.lines : [];
  const clecoIncidents = getClecoIncidents(clecoData);
  const clecoAffected = clecoIncidents.reduce(
    (total, incident) => total + Number(incident.affectedCount || 0),
    0
  );
  const entergyClusters = getEntergyClusters(entergyClusterData);
  const entergyAffected = getEntergyCountyAffected(entergyCountyData);

  drawDemcoBaseLines(demcoBaseLines);
  drawDemcoTempLines(demcoTempLines);
  drawClecoOutages(clecoIncidents);
  drawEntergyClusters(entergyClusters);

  els.demcoBaseCount.textContent = demcoBaseLines.length.toLocaleString();
  els.demcoTempCount.textContent = demcoTempLines.length.toLocaleString();
  els.clecoIncidentCount.textContent = clecoIncidents.length.toLocaleString();
  els.clecoAffectedCount.textContent = clecoAffected.toLocaleString();
  els.entergyClusterCount.textContent = entergyClusters.length.toLocaleString();
  els.entergyAffectedCount.textContent = entergyAffected.toLocaleString();

  const now = new Date();
  els.lastUpdated.textContent = `Last update: ${now.toLocaleString()}`;

  const status =
    `Loaded. DEMCO outage lines: ${demcoTempLines.length}; ` +
    `Cleco incidents: ${clecoIncidents.length}; ` +
    `Entergy clusters: ${entergyClusters.length}.`;

  els.statusText.textContent = warnings.length
    ? `${status} Missing: ${warnings.join(", ")}.`
    : status;
}

function wireLayerToggle(checkbox, layerGroup) {
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) layerGroup.addTo(map);
    else map.removeLayer(layerGroup);
  });
}

wireLayerToggle(els.toggleDemcoBase, demcoBaseLayerGroup);
wireLayerToggle(els.toggleDemcoTemp, demcoTempLayerGroup);
wireLayerToggle(els.toggleEntergyLines, entergyRedGreenTileLayer);
wireLayerToggle(els.toggleCleco, clecoLayerGroup);
wireLayerToggle(els.toggleEntergy, entergyLayerGroup);

els.refreshBtn.addEventListener("click", () => {
  loadData();
});

loadData();
setInterval(loadData, REFRESH_MS);
