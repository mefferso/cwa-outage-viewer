// ================================
// DEMCO Outage Viewer - V1
// ================================

// Start conservative. zoom=10 works and keeps the data manageable.
// Later we can experiment with zoom=14/16/20 if we want finer street detail.
const DATA_ZOOM = 10;

const DEMCO_BASE_URL =
  `https://cache.sienatech.com/apex/siena_ords/webmaps/lines/DEMCO/base?zoom=${DATA_ZOOM}`;

const DEMCO_TEMP_URL =
  `https://cache.sienatech.com/apex/siena_ords/webmaps/lines/DEMCO/temp?zoom=${DATA_ZOOM}`;

const REFRESH_MS = 5 * 60 * 1000;

// Map centered over SE Louisiana / DEMCO-ish area.
const map = L.map("map", {
  preferCanvas: true
}).setView([30.55, -90.75], 9);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const baseLayerGroup = L.layerGroup().addTo(map);
const tempLayerGroup = L.layerGroup().addTo(map);

const els = {
  statusText: document.getElementById("statusText"),
  lastUpdated: document.getElementById("lastUpdated"),
  baseCount: document.getElementById("baseCount"),
  tempCount: document.getElementById("tempCount"),
  dataZoom: document.getElementById("dataZoom"),
  toggleBase: document.getElementById("toggleBase"),
  toggleTemp: document.getElementById("toggleTemp"),
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
  const response = await fetch(url, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function popupHtml(line, layerName) {
  return `
    <strong>DEMCO ${layerName}</strong><br>
    Feature ID: ${line.f || "unknown"}<br>
    e: ${line.e ?? "unknown"}<br>
    t: ${line.t || "unknown"}
  `;
}

function drawBaseLines(lines) {
  baseLayerGroup.clearLayers();

  for (const line of lines) {
    if (!line.g) continue;

    const latlngs = decodePolyline(line.g);

    const polyline = L.polyline(latlngs, {
      color: "#22c55e",
      weight: 2,
      opacity: 0.55,
      interactive: true
    });

    polyline.bindPopup(popupHtml(line, "base line"));
    polyline.addTo(baseLayerGroup);
  }
}

function drawTempLines(lines) {
  tempLayerGroup.clearLayers();

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

    redLine.bindPopup(popupHtml(line, "outage/temp line"));

    glow.addTo(tempLayerGroup);
    redLine.addTo(tempLayerGroup);
  }
}

function fitToOutagesIfAvailable() {
  const tempBounds = tempLayerGroup.getBounds?.();

  if (tempBounds && tempBounds.isValid()) {
    map.fitBounds(tempBounds.pad(0.35));
    return;
  }

  const baseBounds = baseLayerGroup.getBounds?.();

  if (baseBounds && baseBounds.isValid()) {
    map.fitBounds(baseBounds.pad(0.1));
  }
}

async function loadData({ fitMap = false } = {}) {
  try {
    els.statusText.textContent = "Loading DEMCO data...";

    const [baseData, tempData] = await Promise.all([
      fetchJson(DEMCO_BASE_URL),
      fetchJson(DEMCO_TEMP_URL)
    ]);

    const baseLines = Array.isArray(baseData.lines) ? baseData.lines : [];
    const tempLines = Array.isArray(tempData.lines) ? tempData.lines : [];

    drawBaseLines(baseLines);
    drawTempLines(tempLines);

    els.baseCount.textContent = baseLines.length.toLocaleString();
    els.tempCount.textContent = tempLines.length.toLocaleString();

    const now = new Date();
    els.lastUpdated.textContent = `Last update: ${now.toLocaleString()}`;

    els.statusText.textContent =
      tempLines.length > 0
        ? `Loaded. ${tempLines.length} outage line(s).`
        : "Loaded. No temp outage lines.";

    if (fitMap) {
      fitToOutagesIfAvailable();
    }
  } catch (error) {
    console.error(error);

    els.statusText.textContent = "Error loading outage data";
    els.lastUpdated.textContent = error.message;

    alert(
      "Could not load DEMCO outage data.\n\n" +
      "If this works in the DEMCO page but not here, it may be a CORS/browser security issue. " +
      "That is fixable with a GitHub Action data-cache step."
    );
  }
}

els.toggleBase.addEventListener("change", () => {
  if (els.toggleBase.checked) {
    baseLayerGroup.addTo(map);
  } else {
    map.removeLayer(baseLayerGroup);
  }
});

els.toggleTemp.addEventListener("change", () => {
  if (els.toggleTemp.checked) {
    tempLayerGroup.addTo(map);
  } else {
    map.removeLayer(tempLayerGroup);
  }
});

els.refreshBtn.addEventListener("click", () => {
  loadData({ fitMap: true });
});

loadData({ fitMap: true });
setInterval(() => loadData({ fitMap: false }), REFRESH_MS);
