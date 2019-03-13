import L from './leaflet/leaflet.js';
import moment from 'moment';

import appEvents from 'app/core/app_events';
import {MetricsPanelCtrl} from 'app/plugins/sdk';

import './leaflet/leaflet.css!';
import './partials/module.css!';

const panelDefaults = {
  maxDataPoints: 500,
  autoZoom: true,
  lineColor: 'red',
  pointColor: 'royalblue',
}

function log(msg) {
  // uncomment for debugging
  //console.log(msg);
}

export class TrackMapCtrl extends MetricsPanelCtrl {
  constructor($scope, $injector) {
    super($scope, $injector);

    log("constructor");

    _.defaults(this.panel, panelDefaults);

    this.timeSrv = $injector.get('timeSrv');
    this.coords = [];
    this.leafMap = null;
    this.polyline = null;
    this.hoverMarker = null;
    this.hoverTarget = null;
    this.setSizePromise = null;
	this.marker = null;
	this.last = null;
	this.refresh = 0;
	this.layerGroup = null;
    // Panel events
    this.events.on('panel-initialized', this.onInitialized.bind(this));
    this.events.on('view-mode-changed', this.onViewModeChanged.bind(this));
    this.events.on('init-edit-mode', this.onInitEditMode.bind(this));
    this.events.on('panel-teardown', this.onPanelTeardown.bind(this));
    this.events.on('panel-size-changed', this.onPanelSizeChanged.bind(this));
    this.events.on('data-received', this.onDataReceived.bind(this));
    this.events.on('data-snapshot-load', this.onDataSnapshotLoad.bind(this));

    // Global events
    appEvents.on('graph-hover', this.onPanelHover.bind(this));
    appEvents.on('graph-hover-clear', this.onPanelClear.bind(this));
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
    if (this.coords.length === 0) {
      return;
    }

    // check if we are already showing the correct hoverMarker
    let target = Math.floor(evt.pos.x);
    if (this.hoverTarget && this.hoverTarget === target) {
      return;
    }

    // check for initial show of the marker
    if (this.hoverTarget == null){
      this.hoverMarker.bringToFront()
                      .setStyle({
                        fillColor: this.panel.pointColor,
                        color: 'white'
                      });
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
    this.hoverMarker.setLatLng(this.coords[idx].position).bindPopup(
			'<b>' + "Target" + '</b>' + '<br \>' + "Lat: " + this.coords[idx].lat_show + ", Lon: " + this.coords[idx].lon_show + '<br \>' + moment(this.coords[idx].timestamp).lang("fi").format('DoM.YYYY, HH:mm:ss'));
  }

  onPanelClear(evt) {
    log("onPanelClear");
    // clear the highlighted circle
    this.hoverTarget = null;
  }

  onViewModeChanged(){
    log("onViewModeChanged");
    // KLUDGE: When the view mode is changed, panel resize events are not
    //         emitted even if the panel was resized. Work around this by telling
    //         the panel it's been resized whenever the view mode changes.
    this.onPanelSizeChanged();
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

  setupMap() {
    log("setupMap");
    // Create the map or get it back in a clean state if it already exists
    if (this.leafMap) {
      if (this.polyline) {
        this.polyline.removeFrom(this.leafMap);
      }
      this.onPanelClear();
      return;
    }

    // Create the map
    this.leafMap = L.map('trackmap-' + this.panel.id, {
      scrollWheelZoom: false,
      zoomSnap: 0.5,
      zoomDelta: 1,
	  maxZoom: 18,
    });

    // Define layers and add them to the control widget
    L.control.layers({  
      'OpenStreetMap Sea': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: 'OpenStreetMap with Seamarks',
        maxZoom: 18,
		forcedOverlay: L.tileLayer('http://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
        })
      }),
      'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: 'OpenStreetMap',
        maxZoom: 18
      }),
      'OpenTopoMap Sea': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution: 'OpenTopoMap with Seamarks',
        maxZoom: 18,
		forcedOverlay: L.tileLayer('http://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
        })
      }),
      'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution: 'OpenTopoMap',
        maxZoom: 18
      }),
      'Carto Dark Sea': L.tileLayer('https://cartodb-basemaps-{s}.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png', {
        attribution: 'Carto Dark with Seamarks',
        maxZoom: 18,
		forcedOverlay: L.tileLayer('http://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
        })
      }),
      'Carto Dark': L.tileLayer('https://cartodb-basemaps-{s}.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png', {
        attribution: 'Carto Dark',
        maxZoom: 18
      }),
      'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'SatelliteMap',
        // This map doesn't have labels so we force a label-only layer on top of it
        forcedOverlay: L.tileLayer('https://stamen-tiles-{s}.a.ssl.fastly.net/toner-labels/{z}/{x}/{y}.png', {
        maxZoom: 18
        })
      })
    }).addTo(this.leafMap);

    // Dummy hovermarker
    this.hoverMarker = L.circleMarker(L.latLng(0, 0), {
      color: 'none',
      fillColor: 'none',
      fillOpacity: 1,
      weight: 2,
      radius: 7
    }).addTo(this.leafMap);

    // Events
    this.leafMap.on('baselayerchange', this.mapBaseLayerChange.bind(this));
    this.leafMap.on('boxzoomend', this.mapZoomToBox.bind(this));
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
  }

  // Add the circles and polyline to the map
  addDataToMap() {
    log("addDataToMap");
    this.polyline = L.polyline(
      this.coords.map(x => x.position, this), {
        color: this.panel.lineColor,
        weight: 4,
      }
    ).addTo(this.leafMap);
    if (this.refresh == 0) {
		this.zoomToFit();
		this.layerGroup = L.layerGroup().addTo(this.leafMap);
		this.refresh = 1;
	}

  }	
  
  addDataToMap_last() {
	this.layerGroup.clearLayers();

	var boatIcon = L.icon({
		iconUrl: 'public/plugins/pr0ps-trackmap-panel/leaflet/images/boat.png',
		iconSize: [70, 34], // size of the icon
	});
	var normalIcon = L.icon({
              iconUrl: 'public/plugins/pr0ps-trackmap-panel/leaflet/images/marker-icon.png',
              iconSize: [6, 10] // size of the icon
    });
    
	var boatName = "Target";
	this.marker = L.marker(this.coords[this.last].position, {
		icon: boatIcon
		}).addTo(this.layerGroup).bindPopup(
			'<b>' + boatName + '</b>' + '<br \>' + "Lat: " + this.coords[this.last].lat_show + ", Lon: " + this.coords[this.last].lon_show + '<br \>' + moment(this.coords[this.last].timestamp).lang("fi").format('DoM.YYYY, HH:mm:ss'));
  }

  zoomToFit(){
    log("zoomToFit");
    if (this.panel.autoZoom){
      this.leafMap.fitBounds(this.polyline.getBounds());
    }
    this.render();
  }

  refreshColors() {
    log("refreshColors");
    if (this.polyline) {
      this.polyline.setStyle({
        color: this.panel.lineColor
      });
    }
    this.render();
  }

  onDataReceived(data) {
    log("onDataReceived");
    this.setupMap();

    if (data.length === 0 || data.length !== 2) {
      // No data or incorrect data, show a world map and abort
      this.leafMap.setView([0, 0], 1);
      return;
    }

    // Asumption is that there are an equal number of properly matched timestamps
    // TODO: proper joining by timestamp?
    this.coords.length = 0;
    const lats = data[0].datapoints;
    const lons = data[1].datapoints;
	this.last = lats.length - 1; //new
    for (let i = 0; i < lats.length; i++) {
      if (lats[i][0] == null || lons[i][0] == null ||
          lats[i][1] !== lats[i][1]) {
        continue;
      }

      this.coords.push({
        position: L.latLng(lats[i][0], lons[i][0]),
        timestamp: lats[i][1],
		lat_show: lats[i][0],
		lon_show: lons[i][0]
      });
    }
    this.addDataToMap();
	this.addDataToMap_last();
  }

  onDataSnapshotLoad(snapshotData) {
    log("onSnapshotLoad");
    this.onDataReceived(snapshotData);
  }
}

TrackMapCtrl.templateUrl = 'partials/module.html';
