import L from './leaflet/leaflet.js';
import moment from 'moment';

import { DataHoverClearEvent, DataHoverEvent, LegacyGraphHoverClearEvent, LegacyGraphHoverEvent } from '@grafana/data';
import {MetricsPanelCtrl} from 'app/plugins/sdk';

import './leaflet/leaflet.css!';
import './partials/module.css!';


function log(msg) {
  // uncomment for debugging
  //console.log(msg);
}

function hasHeadingValue(heading) {
  return heading != null && isFinite(heading);
}

function normalizeHeading(heading) {
  if (!hasHeadingValue(heading)) {
    return null;
  }
  return ((heading % 360) + 360) % 360;
}

function headingMatchesTimestamp(headingPoint, targetTimestamp, toleranceMs = 1000) {
  if (!headingPoint || headingPoint[0] == null || headingPoint[1] == null || targetTimestamp == null) {
    return false;
  }
  return Math.abs(headingPoint[1] - targetTimestamp) <= toleranceMs;
}

function getNearestHeadingValue(headings, targetTimestamp, toleranceMs = 1000) {
  if (!headings || headings.length === 0 || targetTimestamp == null) {
    return null;
  }

  let min = 0;
  let max = headings.length - 1;

  while (min <= max) {
    const idx = Math.floor((min + max) / 2);
    const ts = headings[idx][1];
    if (ts === targetTimestamp) {
      return headings[idx][0];
    } else if (ts < targetTimestamp) {
      min = idx + 1;
    } else {
      max = idx - 1;
    }
  }

  let best = null;
  let bestDiff = Infinity;
  [max, min].forEach((idx) => {
    if (idx >= 0 && idx < headings.length) {
      const diff = Math.abs(headings[idx][1] - targetTimestamp);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = headings[idx][0];
      }
    }
  });

  return bestDiff <= toleranceMs ? best : null;
}

function getMapViewStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch (err) {
    // ignore localStorage access errors
  }
  return null;
}

function makeDirectionIcon(color, heading, isHover) {
  const normalizedHeading = normalizeHeading(heading);
  const hasHeading = normalizedHeading != null;
  const size = hasHeading ? (isHover ? 28 : 24) : (isHover ? 20 : 16);
  const anchor = Math.round(size / 2);
  const strokeWidth = isHover ? 2 : 1.5;

  let html = '';
  if (hasHeading) {
    html = `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;transform:rotate(${normalizedHeading}deg);">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
        <path d="M12 1 L19.5 22 L12 17.5 L4.5 22 Z" fill="${color}" stroke="white" stroke-width="${strokeWidth}" />
      </svg>
    </div>`;
  } else {
    html = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 0 1px rgba(0,0,0,0.35);"></div>`;
  }

  return L.divIcon({
    className: 'trackmap-direction-marker',
    html,
    iconSize: [size, size],
    iconAnchor: [anchor, anchor],
  });
}

const METERS_PER_NM = 1852;

function makeScaleControl(options) {
  const ScaleControl = L.Control.extend({
    options: L.extend({ position: 'bottomleft', maxWidth: 150 }, options),

    onAdd(map) {
      this._map = map;
      const container = L.DomUtil.create('div', 'leaflet-control-scale trackmap-scale');
      this._nmScale = L.DomUtil.create('div', 'leaflet-control-scale-line', container);
      this._mScale  = L.DomUtil.create('div', 'leaflet-control-scale-line', container);
      map.on('zoomend move', this._update, this);
      this._update();
      return container;
    },

    onRemove(map) {
      map.off('zoomend move', this._update, this);
    },

    _update() {
      const map = this._map;
      const y = map.getSize().y / 2;
      const maxMeters = map.distance(
        map.containerPointToLatLng([0, y]),
        map.containerPointToLatLng([this.options.maxWidth, y])
      );
      if (!isFinite(maxMeters) || maxMeters <= 0) { return; }

      // Nautical miles
      const nm = this._roundNum(maxMeters / METERS_PER_NM);
      this._setBar(this._nmScale, this._fmtNM(nm), (nm * METERS_PER_NM) / maxMeters);

      // Metric
      const m = this._roundNum(maxMeters);
      this._setBar(this._mScale, m < 1000 ? `${m} m` : `${m / 1000} km`, m / maxMeters);
    },

    _setBar(el, label, ratio) {
      el.style.width = `${Math.round(this.options.maxWidth * ratio)}px`;
      el.innerHTML = label;
    },

    _roundNum(num) {
      const pow10 = Math.pow(10, Math.floor(Math.log(num) / Math.LN10));
      const d = num / pow10;
      return pow10 * (d >= 10 ? 10 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1);
    },

    _fmtNM(nm) {
      // Avoid floating-point display artefacts (e.g. 0.30000000000000004)
      const clean = parseFloat(nm.toPrecision(4));
      return `${clean} nm`;
    },
  });

  return new ScaleControl(options);
}

function getAntimeridianMidpoints(start, end) {
  // See https://stackoverflow.com/a/65870755/369977
  if (Math.abs(start.lng - end.lng) <= 180.0){
    return null;
  }
  const start_dist_to_antimeridian = start.lng > 0 ? 180 - start.lng : 180 + start.lng;
  const end_dist_to_antimeridian = end.lng > 0 ? 180 - end.lng : 180 + end.lng;
  const lat_difference = Math.abs(start.lat - end.lat);
  const alpha_angle = Math.atan(lat_difference / (start_dist_to_antimeridian + end_dist_to_antimeridian)) * (180 / Math.PI) * (start.lng > 0 ? 1 : -1);
  const lat_diff_at_antimeridian = Math.tan(alpha_angle * Math.PI / 180) * start_dist_to_antimeridian;
  const intersection_lat = start.lat + lat_diff_at_antimeridian;
  const first_line_end = [intersection_lat, start.lng > 0 ? 180 : -180];
  const second_line_start = [intersection_lat, end.lng > 0 ? 180 : -180];

  return [L.latLng(first_line_end), L.latLng(second_line_start)];
}

export class TrackMapCtrl extends MetricsPanelCtrl {
  constructor($scope, $injector) {
    super($scope, $injector);

    log("constructor");

    _.defaults(this.panel, {
      maxDataPoints: 500,
      autoZoom: true,
      defaultZoom: null,
      scrollWheelZoom: false,
      defaultLayer: 'OpenStreetMap',
      showLayerChanger: true,
      showLastMarker: true,
      lineColor: 'red',
      pointColor: 'royalblue',
    });

    // Save layers globally in order to use them in options
    this.layers = {
      'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 18
      }),
      'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution: 'Map data: &copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
        maxZoom: 18
      }),
      'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Imagery &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        // This map doesn't have labels so we force a label-only layer on top of it
        forcedOverlay: L.tileLayer('https://stamen-tiles-{s}.a.ssl.fastly.net/toner-labels/{z}/{x}/{y}.png', {
          attribution: 'Labels by <a href="http://stamen.com">Stamen Design</a>, <a href="http://creativecommons.org/licenses/by/3.0">CC BY 3.0</a> &mdash; Map data &copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          subdomains: 'abcd',
          maxZoom: 18,
        })
      }),
      'Traficom S57 WMS': L.tileLayer.wms('https://julkinen.traficom.fi/s57/wms', {
        layers: 'cells',
        format: 'image/png',
        transparent: true,
        version: '1.1.1',
        attribution: '&copy; Traficom',
        maxZoom: 24,
      }),
      'Eniro Seamap': L.tileLayer('https://{s}.eniro.com/geowebcache/service/tms1.0.0/nautical/{z}/{x}/{y}.png', {
        subdomains: ['map01', 'map02', 'map03', 'map04'],
        attribution: '&copy; Kort & Matrikelstyrelsen',
        tms: true,
        maxZoom: 18,
      }),
      'Google Satellite': L.tileLayer('https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
        attribution: '&copy; Google',
        subdomains: ['0', '1', '2', '3'],
        maxZoom: 21,
      }),
      'Google Satellite Hybrid': L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
        attribution: '&copy; Google',
        subdomains: ['0', '1', '2', '3'],
        maxZoom: 21,
      }),
    };

    this.timeSrv = $injector.get('timeSrv');
    this.coords = [];
    this.coordSlices = [];
    this.leafMap = null;
    this.layerChanger = null;
    this.polylines = [];
    this.hoverMarker = null;
    this.hoverTarget = null;
    this.hoverIndex = null;
    this.lastMarker = null;
    this.last = null;
    this.setSizePromise = null;
    this._dataRetried = false;

    // Panel events
    this.events.on('panel-initialized', this.onInitialized.bind(this));
    this.events.on('init-edit-mode', this.onInitEditMode.bind(this));
    this.events.on('panel-teardown', this.onPanelTeardown.bind(this));
    this.events.on('data-received', this.onDataReceived.bind(this));
    this.events.on('data-snapshot-load', this.onDataSnapshotLoad.bind(this));
    this.events.on('render', this.onRender.bind(this));
    this.events.on('refresh', this.onRefresh.bind(this));

    // Global events
    this.dashboard.events.on(LegacyGraphHoverEvent.type, this.onPanelHover.bind(this), $scope);
    this.dashboard.events.on(LegacyGraphHoverClearEvent.type, this.onPanelClear.bind(this), $scope);
    try {
      this.dashboard.events.on(DataHoverEvent.type, this.onPanelHover.bind(this), $scope);
      this.dashboard.events.on(DataHoverClearEvent.type, this.onPanelClear.bind(this), $scope);
    } catch(err){ /* expected for Grafana v7.x.x */ }
  }

  getViewStorageKey() {
    const dashboardId = this.dashboard?.uid || this.dashboard?.id || 'unknown';
    return `trackmap:view:${dashboardId}:${this.panel.id}`;
  }

  getConfiguredDefaultZoom() {
    if (this.panel.defaultZoom == null || this.panel.defaultZoom === '') {
      return null;
    }

    const zoom = Number(this.panel.defaultZoom);
    if (!isFinite(zoom)) {
      return null;
    }

    return zoom;
  }

  saveCurrentMapView() {
    if (!this.leafMap) {
      return;
    }

    const center = this.leafMap.getCenter();
    const zoom = this.leafMap.getZoom();
    const storage = getMapViewStorage();
    if (!storage || !isFinite(center.lat) || !isFinite(center.lng) || !isFinite(zoom)) {
      return;
    }

    storage.setItem(this.getViewStorageKey(), JSON.stringify({
      lat: center.lat,
      lng: center.lng,
      zoom: zoom,
    }));
  }

  loadSavedMapView() {
    const storage = getMapViewStorage();
    if (!storage) {
      return null;
    }

    const raw = storage.getItem(this.getViewStorageKey());
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !isFinite(parsed.lat) || !isFinite(parsed.lng) || !isFinite(parsed.zoom)) {
        return null;
      }
      return parsed;
    } catch (err) {
      return null;
    }
  }

  onRefresh(){
    log("onRefresh")
    this.onPanelSizeChanged();
  }

  onRender(){
    log("onRender")

    // No specific event for panel size changing anymore
    // Render is called when the size changes so just call it here
    this.onPanelSizeChanged();

    // Wait until there is at least one GridLayer with fully loaded
    // tiles before calling renderingCompleted
    if (this.leafMap) {
      this.leafMap.eachLayer((l) => {
        if (l instanceof L.GridLayer){
          if (l.isLoading()) {
            l.once('load', this.renderingCompleted.bind(this));
          }
          else {
            this.renderingCompleted();
          }
        }
      });
    }
  }

  onInitialized(){
    log("onInitialized");
    this.render();
  }

  onInitEditMode() {
    log("onInitEditMode");
    this.addEditorTab('Options', 'public/plugins/pr0ps-trackmap-panel/partials/options.html', 2);
  }

  onPanelTeardown() {
    log("onPanelTeardown");
    this.$timeout.cancel(this.setSizePromise);
  }

  onPanelHover(evt) {
    log("onPanelHover");

    let target = 0;
    // Check if event has position (Legacy Hover event) or point (Data Hover event)
    if (evt.hasOwnProperty('pos')) {
      if (evt.pos?.x == null) {
        return;
      }
      target = Math.floor(evt.pos.x);
    } else {
      if (evt.point?.time == null) {
        return
      }
      target = Math.floor(evt.point.time);
    }

    if (this.coords.length === 0) {
      return;
    }

    // check if we are already showing the correct hoverMarker
    if (this.hoverTarget && this.hoverTarget === target) {
      return;
    }

    // check for initial show of the marker
    if (this.hoverTarget == null){
      this.hoverMarker.addTo(this.leafMap);
    }

    this.hoverTarget = target;

    // Find the currently selected time and move the hoverMarker to it
    // Note that an exact match isn't always going to work due to rounding so
    // we clean that up later (still more efficient)
    let min = 0;
    let max = this.coords.length - 1;
    let idx = null;
    let exact = false;
    while (min <= max) {
      idx = Math.floor((max + min) / 2);
      if (this.coords[idx].timestamp === this.hoverTarget) {
        exact = true;
        break;
      }
      else if (this.coords[idx].timestamp < this.hoverTarget) {
        min = idx + 1;
      }
      else {
        max = idx - 1;
      }
    }

    // Correct the case where we are +1 index off
    if (!exact && idx > 0 && this.coords[idx].timestamp > this.hoverTarget) {
      idx--;
    }
    this.hoverIndex = idx;
    this.hoverMarker.setIcon(makeDirectionIcon(this.panel.pointColor, this.coords[idx].heading, true));
    this.hoverMarker.setLatLng(this.coords[idx].position);
    this.render();
  }

  onPanelClear(evt) {
    log("onPanelClear");
    // clear the highlighted circle
    this.hoverTarget = null;
    this.hoverIndex = null;
    if (this.hoverMarker) {
      this.hoverMarker.removeFrom(this.leafMap);
    }
  }

  onPanelSizeChanged() {
    log("onPanelSizeChanged");
    // KLUDGE: This event is fired too soon - we need to delay doing the actual
    //         size invalidation until after the panel has actually been resized.
    this.$timeout.cancel(this.setSizePromise);
    let map = this.leafMap;
    this.setSizePromise = this.$timeout(function(){
      if (map) {
        log("Invalidating map size");
        map.invalidateSize(true);
      }}, 500
    );
  }

  applyScrollZoom() {
    let enabled = this.leafMap.scrollWheelZoom.enabled();
    if (enabled != this.panel.scrollWheelZoom){
      if (enabled){
        this.leafMap.scrollWheelZoom.disable();
      }
      else{
        this.leafMap.scrollWheelZoom.enable();
      }
    }
  }

  applyDefaultLayer() {
    let hadMap = Boolean(this.leafMap);
    this.setupMap();
    if (hadMap){
      // Re-add the default layer
      this.leafMap.eachLayer((layer) => {
        layer.removeFrom(this.leafMap);
      });
      this.layers[this.panel.defaultLayer].addTo(this.leafMap);

      // Hide/show the layer switcher
      this.leafMap.removeControl(this.layerChanger)
      if (this.panel.showLayerChanger){
        this.leafMap.addControl(this.layerChanger);
      }
    }
    this.addDataToMap();
  }

  setupMap() {
    log("setupMap");
    // Create the map or get it back in a clean state if it already exists
    if (this.leafMap) {
      this.polylines.forEach(p=>p.removeFrom(this.leafMap));
      this.removeLastMarker();
      this.onPanelClear();
      return;
    }

    // Create the map
    this.leafMap = L.map('trackmap-' + this.panel.id, {
      scrollWheelZoom: this.panel.scrollWheelZoom,
      zoomSnap: 0.5,
      zoomDelta: 1,
    });

    const savedView = this.loadSavedMapView();
    const defaultZoom = this.getConfiguredDefaultZoom();
    if (savedView) {
      // Use saved view as initial position to avoid jumping from [0, 0].
      // When autoZoom is on, this is temporary until data arrives and zoomToFit runs.
      this.leafMap.setView([savedView.lat, savedView.lng], savedView.zoom);
    } else {
      this.leafMap.setView([0, 0], defaultZoom != null ? defaultZoom : 1);
    }

    // Create the layer changer
    this.layerChanger = L.control.layers(this.layers)

    // Add layers to the control widget
    if (this.panel.showLayerChanger){
      this.leafMap.addControl(this.layerChanger);
    }

    // Add default layer to map
    this.layers[this.panel.defaultLayer].addTo(this.leafMap);

    // Hover marker
    this.hoverMarker = L.marker(L.latLng(0, 0), {
      icon: makeDirectionIcon(this.panel.pointColor, null, true),
      opacity: 1,
      zIndexOffset: 2000,
    });

    // Scale control – nautical miles (top) and metric (bottom)
    makeScaleControl({ position: 'bottomleft', maxWidth: 150 }).addTo(this.leafMap);

    // Events
    this.leafMap.on('baselayerchange', this.mapBaseLayerChange.bind(this));
    this.leafMap.on('boxzoomend', this.mapZoomToBox.bind(this));
    this.leafMap.on('moveend', this.saveCurrentMapView.bind(this));
    this.leafMap.on('zoomend', this.saveCurrentMapView.bind(this));
  }

  removeLastMarker() {
    if (this.lastMarker) {
      this.lastMarker.removeFrom(this.leafMap);
      this.lastMarker = null;
    }
  }

  updateLastMarker() {
    this.removeLastMarker();

    if (!this.panel.showLastMarker || this.last == null || !this.coords[this.last]) {
      return;
    }

    const coord = this.coords[this.last];
    this.lastMarker = L.marker(coord.position, {
      icon: makeDirectionIcon(this.panel.pointColor, coord.heading, false),
      zIndexOffset: 1000,
    }).addTo(this.leafMap);

    const lat = coord.lat_show != null ? coord.lat_show : coord.position.lat;
    const lon = coord.lon_show != null ? coord.lon_show : coord.position.lng;
    let tooltipLines = [
      `<b>Last Position</b>`,
      `Lat: ${lat.toFixed(6)}`,
      `Lon: ${lon.toFixed(6)}`,
    ];
    if (hasHeadingValue(coord.heading)) {
      tooltipLines.push(`Heading: ${normalizeHeading(coord.heading).toFixed(1)}\u00b0`);
    }
    const radius = this.calculateDataRadius();
    if (radius != null) {
      const nm = radius.radiusNM;
      const m = radius.radiusMeters;
      const metricStr = m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`;
      tooltipLines.push(`Data radius: ${parseFloat(nm.toPrecision(4))} nm (${metricStr})`);
    }
    this.lastMarker.bindTooltip(tooltipLines.join('<br>'), {
      direction: 'top',
      offset: [0, -12],
      className: 'trackmap-last-tooltip',
    });
  }

  refreshLastMarker() {
    this.updateLastMarker();
    this.render();
  }

  mapBaseLayerChange(e) {
    // If a tileLayer has a 'forcedOverlay' attribute, always enable/disable it
    // along with the layer
    if (this.leafMap.forcedOverlay) {
      this.leafMap.forcedOverlay.removeFrom(this.leafMap);
      this.leafMap.forcedOverlay = null;
    }
    let overlay = e.layer.options.forcedOverlay;
    if (overlay) {
      overlay.addTo(this.leafMap);
      overlay.setZIndex(e.layer.options.zIndex + 1);
      this.leafMap.forcedOverlay = overlay;
    }
  }

  mapZoomToBox(e) {
    log("mapZoomToBox");
    // Find time bounds of selected coordinates
    const bounds = this.coords.reduce(
      function(t, c) {
        if (e.boxZoomBounds.contains(c.position)) {
          t.from = Math.min(t.from, c.timestamp);
          t.to = Math.max(t.to, c.timestamp);
        }
        return t;
      },
      {from: Infinity, to: -Infinity}
    );

    // Set the global time range
    if (isFinite(bounds.from) && isFinite(bounds.to)) {
      // KLUDGE: Create moment objects here to avoid a TypeError that
      //         occurs when Grafana processes normal numbers
      this.timeSrv.setTime({
        from: moment.utc(bounds.from),
        to: moment.utc(bounds.to)
      });
    }
    this.render();
  }

  // Add the circles and polyline(s) to the map
  addDataToMap() {
    log("addDataToMap");

    this.polylines.length = 0;
    for (let i = 0; i < this.coordSlices.length - 1; i++) {
      const coordSlice = this.coords.slice(this.coordSlices[i], this.coordSlices[i+1])
      this.polylines.push(
        L.polyline(
          coordSlice.map(x => x.position, this), {
            color: this.panel.lineColor,
            weight: 3,
          }
        ).addTo(this.leafMap)
      );
    }
    this.updateLastMarker();

    // Reveal the map now that data and marker are in place
    const el = document.getElementById('trackmap-' + this.panel.id);
    if (el) {
      el.style.visibility = 'visible';
    }

    this.zoomToFit();
  }

  calculateDataRadius() {
    // Only use real data points (antimeridian midpoints lack lat_show/lon_show)
    const realCoords = this.coords.filter(c => c.lat_show != null && c.lon_show != null);
    if (realCoords.length === 0) {
      return null;
    }

    // Compute geographic centroid (mean lat/lon)
    let latSum = 0;
    let lonSum = 0;
    realCoords.forEach(c => {
      latSum += c.lat_show;
      lonSum += c.lon_show;
    });
    const center = L.latLng(latSum / realCoords.length, lonSum / realCoords.length);

    // Find maximum distance from centroid to any data point
    let radiusMeters = 0;
    realCoords.forEach(c => {
      const dist = center.distanceTo(c.position);
      if (dist > radiusMeters) {
        radiusMeters = dist;
      }
    });

    return {
      center,
      radiusMeters,
      radiusNM: radiusMeters / METERS_PER_NM,
    };
  }

  zoomToFit(){
    log("zoomToFit");
    if (this.panel.autoZoom && this.polylines.length>0){
      var bounds = this.polylines[0].getBounds();
      this.polylines.forEach(p => bounds.extend(p.getBounds()));
      const defaultZoom = this.getConfiguredDefaultZoom();

      if (bounds.isValid()){
        if (defaultZoom != null) {
          this.leafMap.fitBounds(bounds, { maxZoom: defaultZoom });
        } else {
          this.leafMap.fitBounds(bounds);
        }
      }
      // If bounds are invalid, keep current view position instead of
      // resetting to [0, 0] (initial view is already set by setupMap)
    }
    this.render();
  }

  refreshColors() {
    log("refreshColors");
    this.polylines.forEach(p => {
      p.setStyle({
        color: this.panel.lineColor
      })
    });
    if (this.hoverMarker && this.hoverIndex != null && this.coords[this.hoverIndex]) {
      this.hoverMarker.setIcon(makeDirectionIcon(this.panel.pointColor, this.coords[this.hoverIndex].heading, true));
    }
    this.updateLastMarker();
    this.render();
  }

  onDataReceived(data) {
    log("onDataReceived");

    if (!data || data.length === 0 || (data.length !== 2 && data.length !== 3)) {
      // No data or incorrect data - retry once after a short delay in case
      // the data source wasn't ready yet (e.g. on initial page load).
      if (!this._dataRetried) {
        this._dataRetried = true;
        this.$timeout(() => this.refresh(), 1000);
      }
      this.render();
      return;
    }
    this._dataRetried = false;

    this.setupMap();

    // Asumption is that there are an equal number of properly matched timestamps
    // TODO: proper joining by timestamp?
    this.coords.length = 0;
    this.coordSlices.length = 0;
    this.coordSlices.push(0)
    const lats = data[0].datapoints;
    const lons = data[1].datapoints;
    const headings = data.length === 3 ? data[2].datapoints.filter((p) => p && p[0] != null && p[1] != null) : null;
    const pointCount = Math.min(lats.length, lons.length);
    this.last = null;

    for (let i = 0; i < pointCount; i++) {
      if (lats[i][0] == null || lons[i][0] == null ||
          (lats[i][0] == 0 && lons[i][0] == 0) ||
          lats[i][1] !== lons[i][1]) {
        continue;
      }
      const pos = L.latLng(lats[i][0], lons[i][0])
      let heading = headings ? getNearestHeadingValue(headings, lats[i][1]) : null;

      if (this.coords.length > 0){
        // Deal with the line between last point and this one crossing the antimeridian:
        // Draw a line from the last point to the antimeridian and another from the anitimeridian
        // to the current point.
        const midpoints = getAntimeridianMidpoints(this.coords[this.coords.length-1].position, pos);
        if (midpoints != null){
          // Crossed the antimeridian, add the points to the coords array
          const lastTime = this.coords[this.coords.length-1].timestamp
          midpoints.forEach(p => {
            this.coords.push({
              position: p,
              timestamp: lastTime + ((lats[i][1] - lastTime)/2)
            })
          });
          // Note that we need to start drawing a new line between the added points
          this.coordSlices.push(this.coords.length - 1)
        }
      }

      this.coords.push({
        position: pos,
        timestamp: lats[i][1],
        lat_show: lats[i][0],
        lon_show: lons[i][0],
        heading: heading,
      });
      this.last = this.coords.length - 1;

    }
    this.coordSlices.push(this.coords.length)
    this.addDataToMap();
  }

  onDataSnapshotLoad(snapshotData) {
    log("onSnapshotLoad");
    this.onDataReceived(snapshotData);
  }
}

TrackMapCtrl.templateUrl = 'partials/module.html';
