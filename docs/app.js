// ================================
// CWA Outage Viewer
// DEMCO line-level outage viewer + Cleco outage locations
// ================================

// Start conservative. zoom=10 works and keeps the DEMCO data manageable.
// Later we can experiment with zoom=14/16/20 if we want finer street detail.
const DATA_ZOOM = 10;

const DEMCO_BASE_URL =
  `https://cache.sienatech.com/apex/siena_ords/webmaps/lines/DEMCO/base?zoom=${DATA_ZOOM}`;

const DEMCO_TEMP_URL =
  `https://cache.sienatech.com/apex/siena_ords/webmaps/lines/DEMCO/temp?zoom=${DATA_ZOOM}`;

// Cleco blocks browser-side cross-origin fetches from GitHub Pages, so the
// GitHub Action caches this API response into docs/data/cleco_outages.json.
const CLECO_OUTAGES_URL = "data/cleco_outages.json";

const REFRESH_MS = 5 * 60 * 1000;

// Map centered over SE Louisiana / DEMCO + Cleco area.
const map = L.map("map", {
  preferCanvas: true
}).setView([30.55, -90.75], 9);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const demcoBaseLayerGroup = L.featureGroup().addTo(map);
const demcoTempLayerGroup = L.featureGroup().addTo(map);
const clecoLayerGroup = L.featureGroup().addTo(map);

const els = {
  statusText: document.getElementById("statusText"),
  lastUpdated: document.getElementById("lastUpdated"),
  demcoBaseCount: document.getElementById("demcoBaseCount"),
  demcoTempCount: document.getElementById("demcoTempCount"),
  clecoIncidentCount: document.getElementById("clecoIncidentCount"),
  clecoAffectedCount: document.getElementById("clecoAffectedCount"),
  dataZoom: document.getElementById("dataZoom"),
  toggleDemcoBase: document.getElementById("toggleDemcoBase"),
  toggleDemcoTemp: document.getElementById("toggleDemcoTemp"),
  toggleCleco: document.getElementById("toggleCleco"),
  refreshBtn: document.getElementById("refreshBtn")
};

els.dataZoom.textContent = DATA_ZOOM;

// Google encoded polyline decoder.
// Returns Leaflet-friendly [lat, lng] pairs.
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
  const response = await fetch(`${url}${cacheBust}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function formatNumber(value) {
  const numericValue = Number(value || 0);
  return numericValue.toLocaleString();
}

function formatClecoTime(value) {
  if (!value) return "Unknown";
  return String(value).replace(/^0/, "");
}

function getSettledValue(result, fallback, label, warnings) {
  if (result.status === "fulfilled") {
    return result.value;
  }

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
  const affectedAreas = Array.isArray(incident.affectedAreas)
    ? incident.affectedAreas
    : [];

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

function drawDemcoBaseLines(lines) {
  demcoBaseLayerGroup.clearLayers();

  for (const line of lines) {
    if (!line.g) continue;

    const latlngs = decodePolyline(line.g);

    const polyline = L.polyline(latlngs, {
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

    // Wider red line underneath makes outage segments pop.
    const glow = L.polyline(latlngs, {
      color: "#991b1b",
      weight: 7,
      opacity: 0.55,
      interactive: false
    });

    const redLine = L.polyline(latlngs, {
      color: "#ef4444",
      weight: 4,
      opacity: 0.95,
      interactive: true
    });

    redLine.bindPopup(demcoPopupHtml(line, "outage/temp line"));

    glow.addTo(demcoTempLayerGroup);
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

function fitToOutagesIfAvailable() {
  const featureGroups = [
    demcoTempLayerGroup,
    clecoLayerGroup,
    demcoBaseLayerGroup
  ];

  for (const group of featureGroups) {
    const bounds = group.getBounds?.();
    if (bounds && bounds.isValid()) {
      map.fitBounds(bounds.pad(0.35));
      return;
    }
  }
}

async function loadData({ fitMap = false } = {}) {
  els.statusText.textContent = "Loading outage data...";

  const warnings = [];

  const [demcoBaseResult, demcoTempResult, clecoResult] = await Promise.allSettled([
    fetchJson(DEMCO_BASE_URL),
    fetchJson(DEMCO_TEMP_URL),
    fetchJson(CLECO_OUTAGES_URL)
  ]);

  const demcoBaseData = getSettledValue(
    demcoBaseResult,
    { lines: [] },
    "DEMCO base",
    warnings
  );
  const demcoTempData = getSettledValue(
    demcoTempResult,
    { lines: [] },
    "DEMCO outage",
    warnings
  );
  const clecoData = getSettledValue(
    clecoResult,
    { data: [] },
    "Cleco cached outages",
    warnings
  );

  const demcoBaseLines = Array.isArray(demcoBaseData.lines)
    ? demcoBaseData.lines
    : [];
  const demcoTempLines = Array.isArray(demcoTempData.lines)
    ? demcoTempData.lines
    : [];
  const clecoIncidents = getClecoIncidents(clecoData);
  const clecoAffected = clecoIncidents.reduce(
    (total, incident) => total + Number(incident.affectedCount || 0),
    0
  );

  drawDemcoBaseLines(demcoBaseLines);
  drawDemcoTempLines(demcoTempLines);
  drawClecoOutages(clecoIncidents);

  els.demcoBaseCount.textContent = demcoBaseLines.length.toLocaleString();
  els.demcoTempCount.textContent = demcoTempLines.length.toLocaleString();
  els.clecoIncidentCount.textContent = clecoIncidents.length.toLocaleString();
  els.clecoAffectedCount.textContent = clecoAffected.toLocaleString();

  const now = new Date();
  els.lastUpdated.textContent = `Last update: ${now.toLocaleString()}`;

  const status =
    `Loaded. DEMCO outage lines: ${demcoTempLines.length}; ` +
    `Cleco incidents: ${clecoIncidents.length}.`;

  els.statusText.textContent = warnings.length
    ? `${status} Missing: ${warnings.join(", ")}.`
    : status;

  if (fitMap) {
    fitToOutagesIfAvailable();
  }
}

function wireLayerToggle(checkbox, layerGroup) {
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      layerGroup.addTo(map);
    } else {
      map.removeLayer(layerGroup);
    }
  });
}

wireLayerToggle(els.toggleDemcoBase, demcoBaseLayerGroup);
wireLayerToggle(els.toggleDemcoTemp, demcoTempLayerGroup);
wireLayerToggle(els.toggleCleco, clecoLayerGroup);

els.refreshBtn.addEventListener("click", () => {
  loadData({ fitMap: true });
});

loadData({ fitMap: true });
setInterval(() => loadData({ fitMap: false }), REFRESH_MS);
