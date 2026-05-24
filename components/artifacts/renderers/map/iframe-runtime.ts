import { EARTH_3D_RUNTIME } from "./earth3d-runtime"

export const INIT_SCRIPT = `
<script>
(function () {
    var CHANNEL_TOKEN = __MAP_CHANNEL_TOKEN__;
    var mapEl = document.getElementById('map');
    var earthMapEl = document.getElementById('earth-map');
    var earthLoadingEl = document.getElementById('earth-loading');
    var map = null;
    var earthMap = null;
    var earthMapLibraryPromise = null;
    var markerLibraryPromise = null;
    var earthElevationServicePromise = null;
    var earthGroundAltitudeCache = Object.create(null);
    var earthMapGeneration = 0;
    var earthReadyTimer = null;
    var earthActivationStartedAt = 0;
    var infoWindow = null;
    var currentArtifact = null;
    var runtimeSettings = null;
    var trafficLayer = null;
    var transitLayer = null;
    var bicyclingLayer = null;
    var streetViewService = null;
    var searchMarker = null;
    var searchMarker3D = null;
    var activeSearchPin = null;
    var selectedPointMarker = null;
    var selectedPointMarker3D = null;
    var activeSelectedPoint = null;
    var earthMarkerGeneration = 0;
    /** key → Marker3D(Interactive)Element for numbered artifact pins on Earth */
    var pinMarkers3D = {};
    /** Tracks whether the user has entered 3D in this session yet. The first
     *  entry gets the swoosh + landing offset; later toggles restore exactly
     *  where the user was so flicking between 2D/3D doesn't drift the centre. */
    var earthHasBeenActivatedOnce = false;
    var earthOrbitActive = false;
    var earthOrbitTimer = null;
	    var earthOrbitFrame = null;
	    var earthCameraAnimationFrame = null;
	    var earthCameraLockFrame = null;
	    var earthCameraLockSnapshot = null;
	    // Timer for the 3D→2D fade transition. While it's pending, a
	    // second deactivateEarthMap() call (e.g. a React re-render that
	    // re-sends set-settings with earth3d=false) must not slam the
	    // element away — otherwise the fade cancels mid-flight.
	    var earthDeactivateAnimationTimer = null;
	    var earthFadeTimer = null;
    // Whether the first gmp-steadychange has fired for the current 3D
	    // session. We tie the loading-overlay fade-out AND final camera apply
    // animation to it so the user only sees the animation once tiles
	    // have actually rendered.
    var earthFirstSteadyFired = false;
    // Carries the user's saved 3D camera pose (tilt/heading/range/center)
    // from sessionStorage into the next activateEarthMap. Lets a tab/page
    // switch and return restore the exact view the user was looking at.
    var pendingEarthCameraRestore = null;
	    // The final camera for the 2D→3D transition. Set when the gmp-map-3d
	    // element is created at tilt 0; consumed by the first gmp-steadychange
	    // event so the camera is applied only after the initial top-down view
	    // has actually rendered, not before.
	    var pendingEarthFlyToTarget = null;
	    var earthUserMovedCamera = false;
	    var toastTimer = null;
	    var renderReadyTimer = null;
	    var renderReadyGeneration = 0;
	    var lastCameraResetKey = null;
    var userMovedCamera = false;
    var suppressCameraTracking = false;
    var suppressCameraTimer = null;
    var suppressEarthCameraTracking = false;
    var suppressEarthCameraTimer = null;
    var cameraSaveTimer = null;
    var suppressMapClickUntil = 0;
    var pageCameraPersistenceInstalled = false;
		    var DEFAULT_EARTH_TILT = 60;
		    var MAX_EARTH_TILT = 75;
			    var EARTH_CAMERA_FOV = 45;
			    var EARTH_RANGE_ZOOM_FIT = 1;
			    var EARTH_MAX_ZOOM_FOR_RANGE = 22.5;
			    var EARTH_SCREEN_ANCHOR_Y = 0.86;
			    var EARTH_MAX_BACK_METERS = 120;
			    var EARTH_RADIUS_M = 6378137;
    var MIN_EARTH_RANGE = 8;
	    var MAX_EARTH_RANGE = 60000;
	    var EARTH_FADE_MS = 320;
		    var EARTH_ENTRY_ANIMATION_MS = 760;
		    var EARTH_FOCUS_TOPDOWN_MS = 420;
	    var EARTH_EXIT_ANIMATION_MS = 700;
    /** key → { marker, pin } for everything currently on the map */
    var markersByKey = {};
    var routeOverlays = [];
    var routeStrokeFrame = null;
    var routeOverlays3D = [];
    var earthRouteGeneration = 0;
    var polygonOverlays = [];
    var activeKey = null;
    var areaDrawMode = false;
    var areaDrawPoints = [];
    var areaDrawMarkers = [];
    var areaDrawLine = null;
    var areaDrawPolygon = null;
    var selectedAreaPolygon = null;
    var selectedAreaListeners = [];
    var selectedAreaUpdateTimer = null;
    var drawPanel = null;
    var readyTimer = null;

    window.__orchBoot = function __orchBoot() {
        try {
            window.addEventListener('message', onParentMessage);
            postReady();
            readyTimer = window.setInterval(postReady, 250);
        } catch (e) {
            showError('boot failed: ' + (e && e.message ? e.message : String(e)));
        }
    };

    function onParentMessage(e) {
        if (e.source !== parent) return;
        var data = e.data;
        if (!data || !data.__orchMap) return;
        if (data.__orchMapToken !== CHANNEL_TOKEN) return;
        try {
            if (data.__orchMap === 'init') {
                if (readyTimer) {
                    window.clearInterval(readyTimer);
                    readyTimer = null;
                }
                var initPayload = data.payload && data.payload.artifact ? data.payload : { artifact: data.payload, cameraResetKey: null };
                buildMap(initPayload.artifact, initPayload.cameraResetKey);
            } else if (data.__orchMap === 'set-settings') {
                applyRuntimeSettings(data.payload);
            } else if (data.__orchMap === 'show-search-target') {
                showSearchTarget(data.payload);
            } else if (data.__orchMap === 'run-action') {
                runMapAction(data.payload);
            } else if (data.__orchMap === 'check-street-view' && data.key && Array.isArray(data.position)) {
                checkStreetViewAvailability(data.key, data.position);
            } else if (data.__orchMap === 'fly-to-pin' && data.key && Array.isArray(data.position)) {
                var entry = markersByKey[data.key];
                if (entry && map) {
                    openPin(data.key, entry.pin, false);
                }
            } else if (data.__orchMap === 'clear-active') {
                // The React sheet's close button asks the iframe to drop the
                // active marker AND any transient selected-point or search
                // pin so nothing lingers on the map.
                clearActivePin(false);
                clearSelectedPointMarker();
                clearSearchMarker();
                saveSelectedPointState();
            }
        } catch (err) {
            showError('handler failed: ' + (err && err.message ? err.message : String(err)));
        }
    }

    function postReady() {
        postToParent({ __orchMap: 'ready' });
    }

    function postToParent(message) {
        try {
            message.__orchMapToken = CHANNEL_TOKEN;
            parent.postMessage(message, '*');
        } catch (_) {}
    }

    function suppressNextMapClick() {
        suppressMapClickUntil = Date.now() + 450;
    }

    function shouldSuppressMapClick() {
        return Date.now() < suppressMapClickUntil;
    }

    function stopMarkerClickEvent(event) {
        suppressNextMapClick();
        var domEvent = event && event.domEvent ? event.domEvent : event;
        if (domEvent) {
            if (typeof domEvent.preventDefault === 'function') domEvent.preventDefault();
            if (typeof domEvent.stopPropagation === 'function') domEvent.stopPropagation();
            if (typeof domEvent.stopImmediatePropagation === 'function') domEvent.stopImmediatePropagation();
        }
        if (event && typeof event.stop === 'function') event.stop();
    }

    function installCameraTracking() {
        if (!map) return;
        var markUserCamera = function () {
            if (suppressCameraTracking) return;
            userMovedCamera = true;
            updateCameraDataset();
            saveCameraStateSoon();
        };
        map.addListener('dragstart', markUserCamera);
        map.addListener('zoom_changed', markUserCamera);
        map.addListener('heading_changed', markUserCamera);
        map.addListener('tilt_changed', markUserCamera);
    }

    function releaseCameraTrackingSoon() {
        if (suppressCameraTimer) window.clearTimeout(suppressCameraTimer);
        suppressCameraTimer = window.setTimeout(function () {
            suppressCameraTracking = false;
            suppressCameraTimer = null;
            updateCameraDataset();
        }, 350);
    }

    function withProgrammaticCamera(callback) {
        suppressCameraTracking = true;
        try {
            callback();
        } finally {
            releaseCameraTrackingSoon();
        }
    }

    function releaseEarthCameraTrackingSoon(delay) {
        if (suppressEarthCameraTimer) window.clearTimeout(suppressEarthCameraTimer);
        suppressEarthCameraTimer = window.setTimeout(function () {
            suppressEarthCameraTracking = false;
            suppressEarthCameraTimer = null;
        }, typeof delay === 'number' && isFinite(delay) ? delay : 900);
    }

    function withProgrammaticEarthCamera(callback, delay) {
        suppressEarthCameraTracking = true;
        try {
            callback();
        } finally {
            releaseEarthCameraTrackingSoon(delay);
        }
    }

    function cameraStorageKey(key) {
        return 'orch:map-camera:' + encodeURIComponent(String(key || 'default'));
    }

    function selectedPointStorageKey(key) {
        return 'orch:map-selected:' + encodeURIComponent(String(key || 'default'));
    }

    function saveSelectedPointState() {
        if (!lastCameraResetKey) return;
        try {
            var key = selectedPointStorageKey(lastCameraResetKey);
            if (activeSelectedPoint && Array.isArray(activeSelectedPoint.position)) {
                window.sessionStorage.setItem(key, JSON.stringify({
                    kind: 'selected',
                    position: activeSelectedPoint.position,
                    label: activeSelectedPoint.label || null,
                    address: activeSelectedPoint.address || null
                }));
            } else if (activeSearchPin && Array.isArray(activeSearchPin.position)) {
                window.sessionStorage.setItem(key, JSON.stringify({
                    kind: 'search',
                    position: activeSearchPin.position,
                    label: activeSearchPin.label || null,
                    address: activeSearchPin.address || null,
                    placeId: activeSearchPin.placeId || null
                }));
            } else {
                window.sessionStorage.removeItem(key);
            }
        } catch (_) {}
    }

    function restoreSelectedPointState(key) {
        if (!key) return false;
        try {
            var raw = window.sessionStorage.getItem(selectedPointStorageKey(key));
            if (!raw) return false;
            var state = JSON.parse(raw);
            if (!state || !Array.isArray(state.position) || state.position.length !== 2) return false;
            if (state.kind === 'selected') {
                selectCoordinatePoint(state.position, false, { restoring: true, skipEarthFocus: true });
                return true;
            }
            return false;
        } catch (_) {
            return false;
        }
    }

    function saveCameraStateSoon() {
        if (!map || !lastCameraResetKey) return;
        if (cameraSaveTimer) window.clearTimeout(cameraSaveTimer);
        cameraSaveTimer = window.setTimeout(function () {
            cameraSaveTimer = null;
            saveCameraState();
        }, 150);
    }

    function saveCameraState() {
        if (!map || !lastCameraResetKey) return;
        try {
            if (runtimeSettings && runtimeSettings.earth3d && earthMap && earthMap.center) {
                var exitCamera = typeof earthExitCameraFor2D === 'function'
                    ? earthExitCameraFor2D()
                    : null;
                var earthLat = Number(earthMap.center.lat);
                var earthLng = Number(earthMap.center.lng);
                if (!isFinite(earthLat) || !isFinite(earthLng)) return;
                var earthRange = Number(earthMap.range);
                var focus = exitCamera && exitCamera.center
                    ? exitCamera.center
                    : { lat: earthLat, lng: earthLng, altitude: 0 };
                var baseRange = exitCamera && isFinite(Number(exitCamera.baseRange))
                    ? Number(exitCamera.baseRange)
                    : exitCamera && isFinite(Number(exitCamera.range))
                        ? Number(exitCamera.range)
                        : isFinite(earthRange) && typeof earthBaseRangeFromTiltedCamera === 'function'
                            ? earthBaseRangeFromTiltedCamera(earthRange, earthMap.tilt)
                            : NaN;
                var zoom2D = exitCamera && isFinite(Number(exitCamera.zoom))
                    ? Number(exitCamera.zoom)
                    : zoomForEarthRange(baseRange, focus.lat);
                window.sessionStorage.setItem(cameraStorageKey(lastCameraResetKey), JSON.stringify({
                    center: [focus.lng, focus.lat],
                    zoom: zoom2D,
                    baseRange: isFinite(baseRange) ? baseRange : undefined,
                    earthCenter: [earthLng, earthLat],
                    earthRange: isFinite(earthRange) ? earthRange : undefined,
                    altitude: isFinite(Number(earthMap.center.altitude)) ? Number(earthMap.center.altitude) : Number(focus.altitude) || 0,
                    tilt: typeof earthMap.tilt === 'number' ? earthMap.tilt : DEFAULT_EARTH_TILT,
                    heading: typeof earthMap.heading === 'number' ? earthMap.heading : 0
                }));
                return;
            }
            var center = map.getCenter();
            if (!center) return;
            window.sessionStorage.setItem(cameraStorageKey(lastCameraResetKey), JSON.stringify({
                center: [center.lng(), center.lat()],
                zoom: map.getZoom(),
                tilt: typeof map.getTilt === 'function' ? map.getTilt() : 0,
                heading: typeof map.getHeading === 'function' ? map.getHeading() : 0
            }));
        } catch (_) {}
    }

    function readCameraState(key) {
        if (!key) return null;
        try {
            var raw = window.sessionStorage.getItem(cameraStorageKey(key));
            if (!raw) return null;
            var state = JSON.parse(raw);
            if (!state || !Array.isArray(state.center) || state.center.length !== 2) return null;
            var lng = Number(state.center[0]);
            var lat = Number(state.center[1]);
            var zoom = Number(state.zoom);
            if (!isFinite(lng) || !isFinite(lat) || !isFinite(zoom)) return null;
            state.center = [lng, lat];
            state.zoom = zoom;
            return state;
        } catch (_) {
            return null;
        }
    }

    function earthCameraFromSavedState(state) {
        if (!state || !Array.isArray(state.center) || state.center.length !== 2) return null;
        var lng = Number(state.center[0]);
        var lat = Number(state.center[1]);
        var zoom = Number(state.zoom);
        if (!isFinite(lng) || !isFinite(lat) || !isFinite(zoom)) return null;
        var range = Number(state.range);
        var tilt = Number(state.tilt);
        var heading = Number(state.heading);
        if (!isFinite(tilt)) tilt = DEFAULT_EARTH_TILT;
        if (!isFinite(heading)) heading = 0;
        var earthLng = Array.isArray(state.earthCenter) ? Number(state.earthCenter[0]) : NaN;
        var earthLat = Array.isArray(state.earthCenter) ? Number(state.earthCenter[1]) : NaN;
        var earthRange = Number(state.earthRange);
        var baseRange = Number(state.baseRange);
        if (isFinite(earthLat) && isFinite(earthLng) && isFinite(earthRange) && earthRange > 0) {
            return {
                center: { lat: earthLat, lng: earthLng, altitude: Number(state.altitude) || 0 },
                focusCenter: { lat: lat, lng: lng, altitude: Number(state.altitude) || 0 },
                range: earthRange,
                baseRange: isFinite(baseRange) && baseRange > 0 ? baseRange : earthRange,
                zoom: zoom,
                tilt: clampNumber(tilt, 0, MAX_EARTH_TILT, DEFAULT_EARTH_TILT),
                heading: ((heading % 360) + 360) % 360,
                minAltitude: minCameraAltitudeForZoom(zoom)
            };
        }
        if (isFinite(range) && range > 0) {
            return {
                center: { lat: lat, lng: lng, altitude: Number(state.altitude) || 0 },
                focusCenter: { lat: lat, lng: lng, altitude: Number(state.altitude) || 0 },
                range: range,
                baseRange: range,
                zoom: zoom,
                tilt: clampNumber(tilt, 0, MAX_EARTH_TILT, DEFAULT_EARTH_TILT),
                heading: ((heading % 360) + 360) % 360,
                minAltitude: minCameraAltitudeForZoom(zoom)
            };
        }
        baseRange = earthRangeForZoom(zoom, lat);
        return {
            center: { lat: lat, lng: lng, altitude: 0 },
            focusCenter: { lat: lat, lng: lng, altitude: 0 },
            range: baseRange,
            baseRange: baseRange,
            zoom: zoom,
            tilt: clampNumber(tilt, 0, MAX_EARTH_TILT, DEFAULT_EARTH_TILT),
            heading: ((heading % 360) + 360) % 360,
            minAltitude: minCameraAltitudeForZoom(zoom)
        };
    }

    function restoreCameraState(key) {
        if (!map || !key) return false;
        try {
            var state = readCameraState(key);
            if (!state) return false;
            var lng = Number(state.center[0]);
            var lat = Number(state.center[1]);
            var zoom = Number(state.zoom);
            withProgrammaticCamera(function () {
                map.setCenter({ lat: lat, lng: lng });
                map.setZoom(zoom);
            });
            // Stash the 3D pose so the next activateEarthMap lands the user
            // back at the exact tilt/heading/range they left, not the
            // defaults from runtimeSettings.
	            var tilt = Number(state.tilt);
	            var heading = Number(state.heading);
	            if (isFinite(tilt) && tilt > 0) {
	                pendingEarthCameraRestore = state;
	            }
            updateCameraDataset();
            return true;
        } catch (_) {
            return false;
        }
    }

    function restoreCameraAfterPageResume() {
        if (!map || !lastCameraResetKey) return;
        var state = readCameraState(lastCameraResetKey);
        if (!state) return;
        if (runtimeSettings && runtimeSettings.earth3d && earthMap) {
            var earthCamera = earthCameraFromSavedState(state);
            if (!earthCamera) return;
            applyEarthCamera(earthCamera);
            userMovedCamera = true;
            updateCameraDataset();
            return;
        }
        if (restoreCameraState(lastCameraResetKey)) {
            userMovedCamera = true;
            updateCameraDataset();
        }
    }

    function installPageCameraPersistence() {
        if (pageCameraPersistenceInstalled) return;
        pageCameraPersistenceInstalled = true;
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') {
                saveCameraState();
                return;
            }
            if (document.visibilityState === 'visible') {
                window.setTimeout(restoreCameraAfterPageResume, 60);
            }
        });
        window.addEventListener('pagehide', saveCameraState);
        window.addEventListener('pageshow', function () {
            window.setTimeout(restoreCameraAfterPageResume, 60);
        });
    }

    function updateCameraDataset() {
        if (!map) return;
        try {
            document.body.dataset.cameraUserMoved = userMovedCamera ? 'true' : 'false';
            if (runtimeSettings && runtimeSettings.earth3d && earthMap) {
                document.body.dataset.cameraMode = 'earth3d';
                document.body.dataset.cameraZoom = '';
                // Use explicit isFinite checks so tilt=0 during the
                // 2D→3D animation isn't falsely reported as 60 from the
                // runtimeSettings fallback.
	                var rawTilt = typeof earthMap.tilt === 'number' && isFinite(earthMap.tilt) ? earthMap.tilt : (runtimeSettings.tilt || 0);
	                var rawHeading = typeof earthMap.heading === 'number' && isFinite(earthMap.heading) ? earthMap.heading : (runtimeSettings.heading || 0);
	                var rawRange = typeof earthMap.range === 'number' && isFinite(earthMap.range) ? earthMap.range : '';
	                document.body.dataset.cameraTilt = String(rawTilt);
	                document.body.dataset.cameraHeading = String(rawHeading);
	                document.body.dataset.cameraRange = String(rawRange);
                document.body.dataset.cameraLat = earthMap.center && typeof earthMap.center.lat === 'number' ? String(earthMap.center.lat) : '';
                document.body.dataset.cameraLng = earthMap.center && typeof earthMap.center.lng === 'number' ? String(earthMap.center.lng) : '';
                return;
            }
            var zoom = map.getZoom();
            var center = map.getCenter();
            document.body.dataset.cameraMode = '2d';
            document.body.dataset.cameraZoom = typeof zoom === 'number' ? String(zoom) : '';
            document.body.dataset.cameraTilt = typeof map.getTilt === 'function' ? String(map.getTilt() || 0) : '0';
            document.body.dataset.cameraHeading = typeof map.getHeading === 'function' ? String(map.getHeading() || 0) : '0';
            document.body.dataset.cameraRange = '';
            document.body.dataset.cameraLat = center ? String(center.lat()) : '';
            document.body.dataset.cameraLng = center ? String(center.lng()) : '';
        } catch (_) {}
    }

	    function buildMap(artifact, cameraResetKey) {
	        if (typeof google === 'undefined' || !google.maps) {
	            showError('Google Maps JS did not load. Check the API key + referrer restrictions in the GCP Cloud Console.');
	            return;
	        }
	        if (!artifact || !artifact.viewport) return;
	        var preserveEarthCameraForRender = runtimeSettings && runtimeSettings.earth3d && earthMap
	            ? snapshotEarthCamera()
	            : null;
	        if (preserveEarthCameraForRender) {
	            restoreEarthCameraAfterMarkerChange(preserveEarthCameraForRender, 1400);
	        }
	        currentArtifact = artifact;
        var nextCameraResetKey = String(cameraResetKey || 'default');
        if (lastCameraResetKey !== nextCameraResetKey) {
            lastCameraResetKey = nextCameraResetKey;
            userMovedCamera = false;
            cancelAreaDraw(true, false);
        }

        // First init only — if the artifact updates we'll re-pin without
        // re-creating the map (saves a JS-load + animation jank).
        if (!map) {
            suppressCameraTracking = true;
            map = new google.maps.Map(mapEl, {
                center: { lat: artifact.viewport.center[1], lng: artifact.viewport.center[0] },
                zoom: artifact.viewport.zoom,
                heading: artifact.viewport.bearing || 0,
                tilt: typeof artifact.viewport.pitch === 'number' ? artifact.viewport.pitch : 0,
                mapId: ${"__MAP_ID__"},
                renderingType: google.maps.RenderingType ? google.maps.RenderingType.VECTOR : 'VECTOR',
                mapTypeId: resolveMapTypeId(artifact),
                tiltInteractionEnabled: true,
                headingInteractionEnabled: true,
                isFractionalZoomEnabled: true,
                disableDefaultUI: true,
                zoomControl: false,
                mapTypeControl: false,
                streetViewControl: true,
                streetViewControlOptions: {
                    position: google.maps.ControlPosition.LEFT_BOTTOM
                },
                fullscreenControl: false,
                rotateControl: false,
                cameraControl: false,
                scaleControl: false,
                // Keep Google's POIs clickable, but intercept the click
                // below so the native Google info bubble never appears.
                clickableIcons: true,
                gestureHandling: 'greedy',
                keyboardShortcuts: true
            });
            // Keep a tiny InfoWindow only for route/polygon labels. Pin
            // details live in the parent React sheet so the popup can use
            // the app's design system instead of Google iframe internals.
            infoWindow = new google.maps.InfoWindow({ maxWidth: 340 });
            infoWindow.addListener('closeclick', function () {
                deactivateMarker();
                postPinCleared();
            });
            map.addListener('click', function (event) {
                if (shouldSuppressMapClick()) {
                    if (event && typeof event.stop === 'function') event.stop();
                    return;
                }
                if (areaDrawMode) {
                    if (event && event.placeId) {
                        if (typeof event.stop === 'function') event.stop();
                        return;
                    }
                    if (event && event.latLng) addAreaDrawPoint(event.latLng);
                    return;
                }
                if (event && event.placeId) {
                    if (typeof event.stop === 'function') event.stop();
                    if (infoWindow) infoWindow.close();
                    deactivateMarker();
                    clearSearchMarker();
                    clearSelectedPointMarker();
                    var poiPosition = event.latLng ? [event.latLng.lng(), event.latLng.lat()] : undefined;
                    postPlaceClicked(event.placeId, poiPosition, null);
                    return;
                }
                if (event && event.latLng) {
                    selectCoordinatePoint([event.latLng.lng(), event.latLng.lat()], true);
                    return;
                }
                clearActivePin(true);
            });
            map.addListener('dblclick', function (event) {
                if (!areaDrawMode) return;
                if (event && event.domEvent && typeof event.domEvent.preventDefault === 'function') {
                    event.domEvent.preventDefault();
                }
                finishAreaDraw();
            });
            map.addListener('zoom_changed', scheduleRouteStrokeUpdate);
            window.addEventListener('keydown', function (event) {
                if (!areaDrawMode) return;
                if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelAreaDraw(false, true);
                } else if (event.key === 'Enter') {
                    event.preventDefault();
                    finishAreaDraw();
                }
            });
            var panorama = map.getStreetView();
            panorama.addListener('visible_changed', function () {
                setStreetViewVisible(Boolean(panorama.getVisible()));
            });
            setStreetViewVisible(Boolean(panorama.getVisible()));
            installCameraTracking();
            installPageCameraPersistence();
            releaseCameraTrackingSoon();
        } else {
            map.setMapTypeId(resolveMapTypeId(artifact));
        }

        if (!userMovedCamera && restoreCameraState(nextCameraResetKey)) {
            userMovedCamera = true;
            updateCameraDataset();
        }

        // Wipe existing markers — simplest correct path for the common
        // case where the active set changes (day switch, new artifact).
        Object.keys(markersByKey).forEach(function (k) {
            clearMarker(markersByKey[k]);
        });
        markersByKey = {};
        clearEarthPinMarkers();
        resetEarthRouteOverlays();
        clearOverlays(routeOverlays);
        clearOverlays(polygonOverlays);
        clearSearchMarker();
        clearSelectedPointMarker();
        routeOverlays = [];
        polygonOverlays = [];

        var polygons = artifact.polygons || [];
        for (var g = 0; g < polygons.length; g++) {
            addPolygon(polygons[g]);
        }

        var routes = artifact.routes || [];
        for (var r = 0; r < routes.length; r++) {
            addRoute(routes[r]);
        }

        // Markers are numbered 1..N in the order pins appear in the
        // active set the parent sends us. The number ties the marker
        // to its sidebar card visually.
        var pins = artifact.pins || [];
        for (var i = 0; i < pins.length; i++) {
            addMarker(pins[i].id, pins[i], i + 1);
        }

        // Fit camera to the explicit day bounds when supplied; otherwise
        // frame every active overlay. Single-pin-only sets zoom to street
        // level for useful satellite detail.
        if (!userMovedCamera) {
            withProgrammaticCamera(function () {
                var explicitBounds = boundsFromBBox(artifact.fitBounds);
                var featureBounds = explicitBounds || boundsForArtifact(artifact);
                var hasOnlyOnePin = pins.length === 1 && routes.length === 0 && polygons.length === 0;
                if (hasOnlyOnePin) {
                    map.panTo({ lat: pins[0].position[1], lng: pins[0].position[0] });
                    map.setZoom(Math.max(map.getZoom() || 14, 16));
                } else if (featureBounds) {
                    // Very tight padding — pins almost touch the edge. Google
                    // honours the map's maxZoom (default 22) so this safely
                    // zooms in as far as the imagery supports while keeping
                    // every pin in frame.
                    map.fitBounds(featureBounds, { top: 96, right: 96, bottom: 96, left: 96 });
                }
            });
        }
        scheduleRouteStrokeUpdate();
        // Restore transient click-selected pins before the 3D marker sync.
        // Restoring after sync invalidated the async full-marker generation,
        // which could leave the "my location" artifact pin missing in 3D.
	        if (lastCameraResetKey) {
	            restoreSelectedPointState(lastCameraResetKey);
	        }
        if (runtimeSettings) applyRuntimeSettings(runtimeSettings);
        // Always (re)sync earth markers after the 2D set changes — when the
        // user is on the 3D map and an artifact updates without flipping the
        // earth3d flag, applyRuntimeSettings doesn't re-enter activateEarthMap.
	        if (runtimeSettings && runtimeSettings.earth3d && earthMap) {
	            syncEarthMarkers(preserveEarthCameraForRender ? { preserveCamera: preserveEarthCameraForRender } : undefined);
	            syncEarthRouteOverlays();
	            if (preserveEarthCameraForRender) {
	                restoreEarthCameraAfterMarkerChange(preserveEarthCameraForRender, 1400);
	            }
	        }
	        postMapRenderedSoon();
	    }

	    function postMapRenderedSoon() {
	        var generation = ++renderReadyGeneration;
	        if (renderReadyTimer) {
	            window.clearTimeout(renderReadyTimer);
	            renderReadyTimer = null;
	        }
	        var posted = false;
	        function done() {
	            if (generation !== renderReadyGeneration) return;
	            if (posted) return;
	            posted = true;
	            if (renderReadyTimer) {
	                window.clearTimeout(renderReadyTimer);
	                renderReadyTimer = null;
	            }
	            postToParent({ __orchMap: 'rendered' });
	        }
	        try {
	            google.maps.event.addListenerOnce(map, 'idle', function () {
	                renderReadyTimer = window.setTimeout(done, 80);
	            });
	        } catch (_) {}
	        renderReadyTimer = window.setTimeout(done, 600);
	    }

    function resolveMapTypeId(artifact) {
        if (runtimeSettings && runtimeSettings.basemap === 'roadmap') return 'roadmap';
        if (runtimeSettings && runtimeSettings.basemap === 'terrain') return 'terrain';
        if (runtimeSettings && runtimeSettings.basemap === 'satellite') {
            return runtimeSettings.satelliteLabels ? 'hybrid' : 'satellite';
        }
        return artifact && artifact.basemap === 'satellite-streets' ? 'hybrid' : 'satellite';
    }

    function clampNumber(value, min, max, fallback) {
        var parsed = Number(value);
        if (!isFinite(parsed)) parsed = fallback;
        return Math.max(min, Math.min(max, parsed));
    }

    function applyRuntimeSettings(nextSettings) {
        if (!nextSettings || typeof nextSettings !== 'object') return;
        var requestedTilt = Number(nextSettings.tilt);
        var earth3d = nextSettings.earth3d === true;
        if (!isFinite(requestedTilt)) requestedTilt = earth3d ? DEFAULT_EARTH_TILT : 0;
        var requestedHeading = Number(nextSettings.heading);
        if (!isFinite(requestedHeading)) requestedHeading = 0;
        requestedHeading = ((requestedHeading % 360) + 360) % 360;
        var previousTilt = runtimeSettings ? runtimeSettings.tilt : 0;
        var previousHeading = runtimeSettings ? runtimeSettings.heading : 0;
        var previousEarth3d = runtimeSettings ? runtimeSettings.earth3d : false;
        runtimeSettings = {
            basemap: nextSettings.basemap === 'roadmap' || nextSettings.basemap === 'terrain' ? nextSettings.basemap : 'satellite',
            satelliteLabels: nextSettings.satelliteLabels !== false,
            traffic: Boolean(nextSettings.traffic),
            transit: Boolean(nextSettings.transit),
            bicycling: Boolean(nextSettings.bicycling),
            earth3d: earth3d,
	            tilt: clampNumber(requestedTilt, 0, earth3d ? MAX_EARTH_TILT : 67.5, earth3d ? DEFAULT_EARTH_TILT : 0),
	            heading: requestedHeading
	        };
        if (!map) return;

        map.setMapTypeId(resolveMapTypeId(currentArtifact));
        ensureLayers();
        trafficLayer.setMap(!runtimeSettings.earth3d && runtimeSettings.traffic ? map : null);
        transitLayer.setMap(!runtimeSettings.earth3d && runtimeSettings.transit ? map : null);
        bicyclingLayer.setMap(!runtimeSettings.earth3d && runtimeSettings.bicycling ? map : null);

        if (runtimeSettings.earth3d) {
            if (!previousEarth3d) {
                userMovedCamera = true;
                updateCameraDataset();
                saveCameraStateSoon();
                if (typeof map.setTilt === 'function') map.setTilt(0);
                if (typeof map.setHeading === 'function') map.setHeading(0);
                suppressEarthCameraTracking = true;
                releaseEarthCameraTrackingSoon(1400);
            }
            if (!previousEarth3d || !earthMap || previousTilt !== runtimeSettings.tilt || previousHeading !== runtimeSettings.heading) {
	                // Crossfade only on real 2D→3D transitions
	                // (previousEarth3d=false). On tilt/heading-only changes we
	                // set the camera directly so the UI feels responsive.
                activateEarthMap({ animate: !previousEarth3d });
            }
        } else {
            stopEarthOrbit();
            if (previousEarth3d) {
                userMovedCamera = true;
                updateCameraDataset();
                saveCameraStateSoon();
            }
	            // 3D→2D uses a fade-out, then the gmp-map-3d tears down to
	            // reveal the already-synced 2D map underneath. Pure 2D state
	            // changes (tilt/heading slider while already in 2D) just snap.
            deactivateEarthMap(previousEarth3d ? { animate: true } : undefined);
            if (typeof map.setTilt === 'function') map.setTilt(runtimeSettings.tilt);
            if (typeof map.setHeading === 'function') {
                map.setHeading(runtimeSettings.tilt > 0 ? runtimeSettings.heading : 0);
            }
            if (runtimeSettings.tilt > 0 && (map.getZoom() || 0) < 17) map.setZoom(17);
        }

        if (previousTilt !== runtimeSettings.tilt || previousHeading !== runtimeSettings.heading || previousEarth3d !== runtimeSettings.earth3d) {
            updateCameraDataset();
        }
    }

${EARTH_3D_RUNTIME}

    function ensureLayers() {
        if (!trafficLayer) trafficLayer = new google.maps.TrafficLayer();
        if (!transitLayer) transitLayer = new google.maps.TransitLayer();
        if (!bicyclingLayer) bicyclingLayer = new google.maps.BicyclingLayer();
    }

    function runMapAction(action) {
        if (!map || !action || typeof action !== 'object') return;
        if (action.type === 'toggle-street-view') {
            toggleStreetViewAtCenter();
        } else if (action.type === 'open-street-view') {
            openStreetViewAtPosition(action.position);
        } else if (action.type === 'recenter') {
            recenterMap(action);
        } else if (action.type === 'clear-search') {
            clearSearchMarker();
            clearSelectedPointMarker();
            saveSelectedPointState();
            if (infoWindow) infoWindow.close();
        } else if (action.type === 'start-area-draw') {
            startAreaDraw();
        } else if (action.type === 'cancel-area-draw') {
            cancelAreaDraw(false, false);
        } else if (action.type === 'clear-area-selection') {
            cancelAreaDraw(true, false);
        } else if (action.type === 'undo-area-point') {
            undoAreaDrawPoint();
        } else if (action.type === 'finish-area-draw') {
            finishAreaDraw();
        } else if (action.type === 'set-area-selection') {
            cancelAreaDraw(false, false);
            if (action.selection && Array.isArray(action.selection.ring)) {
                drawSelectedArea(action.selection.ring);
            }
        } else if (action.type === 'orbit-around-center') {
            orbitEarthCameraAroundCenter();
        }
    }

	    function orbitEarthCameraAroundCenter() {
	        if (!earthMap) {
	            showToast('3D orbit not available here');
	            return;
	        }
        // Re-pressing the button stops the orbit instead of stacking a new one.
        if (earthOrbitActive) {
            stopEarthOrbit();
            return;
	        }
	        try { earthMap.stopCameraAnimation && earthMap.stopCameraAnimation(); } catch (_) {}
	        stopEarthCameraLock();
		        var durationMillis = 12000;
	        var startTime = performance && typeof performance.now === 'function' ? performance.now() : Date.now();
	        var startHeading = (typeof earthMap.heading === 'number' && isFinite(earthMap.heading)) ? earthMap.heading : 0;
	        function tick(now) {
	            if (!earthOrbitActive || !earthMap) return;
	            var elapsed = now - startTime;
	            var t = elapsed / durationMillis;
	            if (t >= 1) {
	                stopEarthOrbit();
                return;
            }
            try { earthMap.heading = (startHeading + 360 * t) % 360; } catch (_) {}
            earthOrbitFrame = window.requestAnimationFrame(tick);
        }
        earthOrbitActive = true;
        postToParent({ __orchMap: 'orbit-state', active: true });
        earthOrbitFrame = window.requestAnimationFrame(tick);
    }

    function stopEarthOrbit() {
        if (earthOrbitTimer) {
            window.clearTimeout(earthOrbitTimer);
            earthOrbitTimer = null;
        }
        if (earthOrbitFrame !== null) {
            window.cancelAnimationFrame(earthOrbitFrame);
            earthOrbitFrame = null;
        }
        if (earthOrbitActive) {
            earthOrbitActive = false;
            postToParent({ __orchMap: 'orbit-state', active: false });
        }
    }

    function recenterMap(action) {
        if (!action || !Array.isArray(action.position) || action.position.length !== 2) return;
        var lng = Number(action.position[0]);
        var lat = Number(action.position[1]);
        if (!isFinite(lng) || !isFinite(lat)) return;
        userMovedCamera = true;
        map.panTo({ lat: lat, lng: lng });
        var targetZoom = Number(action.zoom);
        if (!isFinite(targetZoom)) targetZoom = 16;
        var nextZoom = Math.max(map.getZoom() || 0, targetZoom);
        map.setZoom(nextZoom);
        updateCameraDataset();
        saveCameraStateSoon();
        // In Earth3D the user sees gmp-map-3d, not the hidden 2D map. Fly the
        // photorealistic camera to the same point so the recenter is visible.
        if (runtimeSettings && runtimeSettings.earth3d && earthMap) {
            resolveGroundAltitude(lat, lng).then(function (groundAltitude) {
                if (!runtimeSettings || !runtimeSettings.earth3d || !earthMap) return;
                var baseRange = earthRangeForZoom(nextZoom, lat);
                var endCamera = {
                    center: { lat: lat, lng: lng, altitude: groundAltitude },
                    range: baseRange,
                    baseRange: baseRange,
                    zoom: nextZoom,
                    minAltitude: minCameraAltitudeForZoom(nextZoom),
                    tilt: typeof earthMap.tilt === 'number' ? earthMap.tilt : DEFAULT_EARTH_TILT,
                    heading: typeof earthMap.heading === 'number' ? earthMap.heading : 0
                };
                animateEarthCameraTo(endCamera, 900);
            });
        }
    }

    function toggleStreetViewAtCenter() {
        if (!map) return;
        var panorama = map.getStreetView();
        if (panorama && panorama.getVisible()) {
            panorama.setVisible(false);
            setStreetViewVisible(false);
            return;
        }
        userMovedCamera = true;
        openStreetViewAtCenter();
    }

    function openStreetViewAtCenter() {
        if (!map) return;
        var center = map.getCenter();
        if (!center) return;
        openStreetViewNearLatLng(center);
    }

    function openStreetViewAtPosition(position) {
        if (!map) return;
        var latLng = latLngFromPosition(position);
        if (!latLng) return;
        openStreetViewNearLatLng(latLng);
    }

    function openStreetViewNearLatLng(latLng) {
        if (!map || !latLng) return;
        if (!streetViewService) streetViewService = new google.maps.StreetViewService();
        streetViewService.getPanorama({ location: latLng, radius: 120 }, function (data, status) {
            if (status === 'OK' && data && data.location && data.location.latLng) {
                var panorama = map.getStreetView();
                panorama.setPosition(data.location.latLng);
                panorama.setPov({ heading: map.getHeading() || 0, pitch: 0 });
                panorama.setVisible(true);
                setStreetViewVisible(true);
            } else {
                showToast('Street View is not available here');
            }
        });
    }

    function checkStreetViewAvailability(key, position) {
        var latLng = latLngFromPosition(position);
        if (!key || !latLng) {
            postStreetViewAvailability(key, false);
            return;
        }
        if (!streetViewService) streetViewService = new google.maps.StreetViewService();
        streetViewService.getPanorama({ location: latLng, radius: 120 }, function (data, status) {
            postStreetViewAvailability(key, status === 'OK' && !!(data && data.location && data.location.latLng));
        });
    }

    function latLngFromPosition(position) {
        if (!Array.isArray(position) || position.length !== 2) return null;
        var lng = Number(position[0]);
        var lat = Number(position[1]);
        if (!isFinite(lng) || !isFinite(lat)) return null;
        return { lat: lat, lng: lng };
    }

    function postStreetViewAvailability(key, available) {
        try {
            postToParent({ __orchMap: 'street-view-availability', key: key, available: Boolean(available) });
        } catch (_) {}
    }

    function setStreetViewVisible(visible) {
        document.body.dataset.streetViewVisible = visible ? 'true' : 'false';
        if (mapEl) mapEl.dataset.streetViewVisible = visible ? 'true' : 'false';
        try {
            postToParent({ __orchMap: 'street-view-visible', visible: Boolean(visible) });
        } catch (_) {}
    }

    function startAreaDraw() {
        if (!map) return;
        cancelAreaDraw(true, false);
        if (infoWindow) infoWindow.close();
        clearActivePin(false);
        clearSearchMarker();
        clearSelectedPointMarker();
        areaDrawMode = true;
        areaDrawPoints = [];
        document.body.dataset.areaDrawing = 'true';
        map.setOptions({
            clickableIcons: false,
            draggableCursor: 'crosshair',
            disableDoubleClickZoom: true
        });
        ensureDrawPanel();
        updateDrawPanel();
    }

    function cancelAreaDraw(clearSelection, notifyParent) {
        areaDrawMode = false;
        areaDrawPoints = [];
        document.body.dataset.areaDrawing = 'false';
        if (map) {
            map.setOptions({
                clickableIcons: true,
                draggableCursor: null,
                disableDoubleClickZoom: false
            });
        }
        clearAreaDrawPreview();
        removeDrawPanel();
        if (clearSelection) clearSelectedAreaPolygon();
        if (notifyParent) postAreaDrawCancelled(clearSelection);
    }

    function addAreaDrawPoint(latLng) {
        if (!latLng) return;
        var point = [latLng.lng(), latLng.lat()];
        areaDrawPoints.push(point);
        var index = areaDrawPoints.length - 1;
        var marker = new google.maps.Marker({
            map: map,
            position: latLng,
            clickable: true,
            draggable: true,
            cursor: 'move',
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 5,
                fillColor: '#1a73e8',
                fillOpacity: 1,
                strokeColor: '#ffffff',
                strokeWeight: 2
            }
        });
        marker.addListener('drag', function (event) {
            updateAreaDrawPoint(index, event && event.latLng);
        });
        marker.addListener('dragend', function (event) {
            updateAreaDrawPoint(index, event && event.latLng);
        });
        marker.addListener('click', function () {
            if (index === 0 && areaDrawPoints.length >= 3) finishAreaDraw();
        });
        areaDrawMarkers.push(marker);
        redrawAreaPreview();
        updateDrawPanel();
    }

    function updateAreaDrawPoint(index, latLng) {
        if (!areaDrawMode || !latLng || index < 0 || index >= areaDrawPoints.length) return;
        areaDrawPoints[index] = [latLng.lng(), latLng.lat()];
        redrawAreaPreview();
        updateDrawPanel();
    }

    function undoAreaDrawPoint() {
        if (!areaDrawMode) {
            showToast('Start drawing an area first');
            return;
        }
        if (areaDrawPoints.length === 0) {
            showToast('No points to undo');
            return;
        }
        areaDrawPoints.pop();
        var marker = areaDrawMarkers.pop();
        if (marker) marker.setMap(null);
        redrawAreaPreview();
        updateDrawPanel();
    }

    function redrawAreaPreview() {
        if (areaDrawLine) areaDrawLine.setMap(null);
        if (areaDrawPolygon) areaDrawPolygon.setMap(null);
        var path = areaDrawPoints.map(toLatLng).filter(Boolean);
        if (path.length >= 2) {
            areaDrawLine = new google.maps.Polyline({
                map: map,
                path: path,
                strokeColor: '#1a73e8',
                strokeOpacity: 0.95,
                strokeWeight: 3,
                clickable: false
            });
        } else {
            areaDrawLine = null;
        }
        if (path.length >= 3) {
            areaDrawPolygon = new google.maps.Polygon({
                map: map,
                paths: path,
                strokeColor: '#1a73e8',
                strokeOpacity: 0.95,
                strokeWeight: 2,
                fillColor: '#1a73e8',
                fillOpacity: 0.16,
                clickable: false
            });
        } else {
            areaDrawPolygon = null;
        }
    }

    function finishAreaDraw() {
        if (!areaDrawMode) return;
        if (areaDrawPoints.length < 3) {
            showToast('Add at least 3 points');
            return;
        }
        var ring = areaDrawPoints.slice();
        var selection = areaSelectionForRing(ring);
        if (!selection) {
            showToast('Area could not be selected');
            return;
        }
        cancelAreaDraw(false, false);
        drawSelectedArea(ring);
        postAreaSelected(selection);
    }

    function clearAreaDrawPreview() {
        for (var i = 0; i < areaDrawMarkers.length; i++) {
            if (areaDrawMarkers[i]) areaDrawMarkers[i].setMap(null);
        }
        areaDrawMarkers = [];
        if (areaDrawLine) areaDrawLine.setMap(null);
        if (areaDrawPolygon) areaDrawPolygon.setMap(null);
        areaDrawLine = null;
        areaDrawPolygon = null;
    }

    function drawSelectedArea(ring) {
        clearSelectedAreaPolygon();
        var path = ring.map(toLatLng).filter(Boolean);
        if (path.length < 3) return;
        selectedAreaPolygon = new google.maps.Polygon({
            map: map,
            paths: path,
            strokeColor: '#1a73e8',
            strokeOpacity: 0.95,
            strokeWeight: 2,
            fillColor: '#1a73e8',
            fillOpacity: 0.18,
            clickable: true,
            draggable: true,
            editable: true
        });
        attachSelectedAreaListeners(selectedAreaPolygon);
    }

    function clearSelectedAreaPolygon() {
        clearSelectedAreaListeners();
        if (selectedAreaUpdateTimer) {
            window.clearTimeout(selectedAreaUpdateTimer);
            selectedAreaUpdateTimer = null;
        }
        if (selectedAreaPolygon) selectedAreaPolygon.setMap(null);
        selectedAreaPolygon = null;
    }

    function attachSelectedAreaListeners(polygon) {
        if (!polygon) return;
        selectedAreaListeners.push(polygon.addListener('dragend', postSelectedAreaFromPolygon));
        var path = polygon.getPath && polygon.getPath();
        if (!path) return;
        selectedAreaListeners.push(path.addListener('set_at', scheduleSelectedAreaPost));
        selectedAreaListeners.push(path.addListener('insert_at', scheduleSelectedAreaPost));
        selectedAreaListeners.push(path.addListener('remove_at', scheduleSelectedAreaPost));
    }

    function clearSelectedAreaListeners() {
        for (var i = 0; i < selectedAreaListeners.length; i++) {
            if (selectedAreaListeners[i]) google.maps.event.removeListener(selectedAreaListeners[i]);
        }
        selectedAreaListeners = [];
    }

    function scheduleSelectedAreaPost() {
        if (selectedAreaUpdateTimer) window.clearTimeout(selectedAreaUpdateTimer);
        selectedAreaUpdateTimer = window.setTimeout(function () {
            selectedAreaUpdateTimer = null;
            postSelectedAreaFromPolygon();
        }, 40);
    }

    function postSelectedAreaFromPolygon() {
        var ring = ringFromSelectedAreaPolygon();
        var selection = areaSelectionForRing(ring);
        if (!selection) return;
        postAreaSelected(selection);
    }

    function ringFromSelectedAreaPolygon() {
        if (!selectedAreaPolygon || !selectedAreaPolygon.getPath) return [];
        var path = selectedAreaPolygon.getPath();
        var ring = [];
        for (var i = 0; i < path.getLength(); i++) {
            var point = path.getAt(i);
            ring.push([point.lng(), point.lat()]);
        }
        return ring;
    }

    function ensureDrawPanel() {
        if (drawPanel) return;
        drawPanel = document.createElement('div');
        drawPanel.className = 'orch-draw-panel';
        document.body.appendChild(drawPanel);
    }

    function updateDrawPanel() {
        if (!drawPanel) return;
        var count = areaDrawPoints.length;
        drawPanel.innerHTML =
            '<span>Area · ' + count + ' point' + (count === 1 ? '' : 's') + ' · drag points to adjust</span>' +
            '<button type="button" data-action="undo"' + (count < 1 ? ' disabled' : '') + '>Undo</button>' +
            '<button type="button" data-action="finish"' + (count < 3 ? ' disabled' : '') + '>Done</button>' +
            '<button type="button" data-action="cancel">Cancel</button>';
        var undo = drawPanel.querySelector('[data-action="undo"]');
        var finish = drawPanel.querySelector('[data-action="finish"]');
        var cancel = drawPanel.querySelector('[data-action="cancel"]');
        if (undo) undo.addEventListener('click', undoAreaDrawPoint);
        if (finish) finish.addEventListener('click', finishAreaDraw);
        if (cancel) cancel.addEventListener('click', function () { cancelAreaDraw(false, true); });
    }

    function removeDrawPanel() {
        if (drawPanel) drawPanel.remove();
        drawPanel = null;
    }

    function bboxForRing(ring) {
        if (!Array.isArray(ring) || ring.length < 3) return null;
        var west = Infinity;
        var south = Infinity;
        var east = -Infinity;
        var north = -Infinity;
        for (var i = 0; i < ring.length; i++) {
            var lng = Number(ring[i][0]);
            var lat = Number(ring[i][1]);
            if (!isFinite(lng) || !isFinite(lat)) return null;
            west = Math.min(west, lng);
            south = Math.min(south, lat);
            east = Math.max(east, lng);
            north = Math.max(north, lat);
        }
        return [west, south, east, north];
    }

    function areaSelectionForRing(ring) {
        var bbox = bboxForRing(ring);
        if (!bbox) return null;
        return {
            ring: ring.slice(),
            bbox: bbox,
            center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
            areaSqKm: polygonAreaSqKm(ring)
        };
    }

    function polygonAreaSqKm(ring) {
        if (!Array.isArray(ring) || ring.length < 3) return null;
        var meanLat = 0;
        for (var i = 0; i < ring.length; i++) meanLat += Number(ring[i][1]);
        meanLat = meanLat / ring.length;
        var metersPerLng = 111320 * Math.cos(meanLat * Math.PI / 180);
        var metersPerLat = 110540;
        var area = 0;
        for (var j = 0; j < ring.length; j++) {
            var a = ring[j];
            var b = ring[(j + 1) % ring.length];
            var ax = Number(a[0]) * metersPerLng;
            var ay = Number(a[1]) * metersPerLat;
            var bx = Number(b[0]) * metersPerLng;
            var by = Number(b[1]) * metersPerLat;
            area += ax * by - bx * ay;
        }
        var sqKm = Math.abs(area) / 2 / 1000000;
        return isFinite(sqKm) ? sqKm : null;
    }

    function postAreaSelected(area) {
        try {
            postToParent({ __orchMap: 'area-selected', area: area });
        } catch (_) {}
    }

    function postAreaDrawCancelled(clearSelection) {
        try {
            postToParent({ __orchMap: 'area-draw-cancelled', clearSelection: Boolean(clearSelection) });
        } catch (_) {}
    }

    function showSearchTarget(target) {
        if (!map || !target || !Array.isArray(target.position) || target.position.length !== 2) return;
        var lng = Number(target.position[0]);
        var lat = Number(target.position[1]);
        if (!isFinite(lng) || !isFinite(lat)) return;
        clearSearchMarker();
        clearSelectedPointMarker();

        var pin = {
            id: 'search-' + String(target.id || 'result'),
            position: [lng, lat],
            label: String(target.label || 'Search result'),
            address: target.address || undefined,
            rating: typeof target.rating === 'number' ? target.rating : undefined,
            userRatingCount: typeof target.userRatingCount === 'number' ? target.userRatingCount : undefined,
            photoUrl: target.photoUrl || undefined,
            description: target.description || undefined,
            notes: target.notes || undefined,
            openNow: typeof target.openNow === 'boolean' ? target.openNow : undefined,
            phoneNumber: target.phoneNumber || undefined,
            googleMapsUri: target.googleMapsUri || undefined,
            websiteUri: target.websiteUri || undefined,
            sourceUrl: target.sourceUrl || undefined,
            savedPlaceId: target.savedPlaceId || undefined,
            provider: target.provider || undefined,
            placeId: target.placeId || target.id || undefined
        };
        activeSearchPin = pin;
        var position = { lat: lat, lng: lng };
        var content = buildSearchPin();
        var AdvMarker = google.maps.marker && google.maps.marker.AdvancedMarkerElement;
        if (AdvMarker) {
            searchMarker = new AdvMarker({
                map: map,
                position: position,
                content: content,
                title: pin.label
            });
            content.addEventListener('click', function (ev) {
                ev.stopPropagation();
                if (areaDrawMode) return;
                openSearchPin(pin);
            });
        } else {
            searchMarker = new google.maps.Marker({
                map: map,
                position: position,
                title: pin.label
            });
            searchMarker.addListener('click', function () {
                if (areaDrawMode) return;
                openSearchPin(pin);
            });
        }
        focusMapPosition(position, 17);
        if (runtimeSettings && runtimeSettings.earth3d && earthMap) {
            focusEarthCamera(position, { minZoom: 17.5, maxZoom: 19.5, animateTiltFromTop: true });
        }
        syncEarthMarkers();
        openSearchPin(pin);
    }

    function buildSearchPin() {
        var el = document.createElement('div');
        el.className = 'orch-search-pin';
        return el;
    }

    function openSearchPin(pin) {
        if (!map) return;
        clearActivePin(false);
        if (infoWindow) infoWindow.close();
        var position = { lat: pin.position[1], lng: pin.position[0] };
        focusMapPosition(position, 17);
        if (runtimeSettings && runtimeSettings.earth3d && earthMap) {
            focusEarthCamera(position, { minZoom: 17.5, maxZoom: 19.5, animateTiltFromTop: true });
        }
        postPlaceClicked(pin.placeId || pin.id, pin.position, {
            label: pin.label || null,
            address: pin.address || null,
            rating: typeof pin.rating === 'number' ? pin.rating : null,
            userRatingCount: typeof pin.userRatingCount === 'number' ? pin.userRatingCount : null,
            photoUrl: pin.photoUrl || null,
            description: pin.description || null,
            notes: pin.notes || null,
            openNow: typeof pin.openNow === 'boolean' ? pin.openNow : null,
            phoneNumber: pin.phoneNumber || null,
            googleMapsUri: pin.googleMapsUri || null,
            websiteUri: pin.websiteUri || null,
            sourceUrl: pin.sourceUrl || null,
            savedPlaceId: pin.savedPlaceId || null,
            provider: pin.provider || null
        });
    }

    function clearSearchMarker() {
        earthMarkerGeneration++;
        activeSearchPin = null;
        if (searchMarker) {
            if (typeof searchMarker.setMap === 'function') searchMarker.setMap(null);
            else searchMarker.map = null;
        }
        searchMarker = null;
        removeEarthMarker(searchMarker3D);
        searchMarker3D = null;
    }

    function focusMapPosition(position, minZoom) {
        if (!map || !position) return;
        userMovedCamera = true;
        map.panTo(position);
        var z = map.getZoom() || 0;
        if (typeof minZoom === 'number' && isFinite(minZoom) && z < minZoom) map.setZoom(minZoom);
        updateCameraDataset();
        saveCameraStateSoon();
    }

	    function selectCoordinatePoint(position, notifyParent, options) {
	        if (!map || !Array.isArray(position) || position.length !== 2) return;
	        var lng = Number(position[0]);
	        var lat = Number(position[1]);
	        if (!isFinite(lng) || !isFinite(lat)) return;
	        var restoring = !!(options && options.restoring);
	        var fromEarthClick = !!(options && options.fromEarthClick);
	        var skipEarthFocus = !!(options && options.skipEarthFocus);
	        if (!restoring) {
	            userMovedCamera = true;
	            updateCameraDataset();
	            if (!fromEarthClick) saveCameraStateSoon();
	        }
        clearSearchMarker();
        clearSelectedPointMarker();
        var roundedLat = lat.toFixed(6);
        var roundedLng = lng.toFixed(6);
        var pin = {
            id: 'selected-' + roundedLat + ',' + roundedLng,
            position: [lng, lat],
            label: 'Selected point',
            address: roundedLat + ', ' + roundedLng
        };
        activeSelectedPoint = pin;
        var content = buildSelectedPointMarker();
        var AdvMarker = google.maps.marker && google.maps.marker.AdvancedMarkerElement;
        if (AdvMarker) {
            selectedPointMarker = new AdvMarker({
                map: map,
                position: { lat: lat, lng: lng },
                content: content,
                title: pin.label
            });
            content.addEventListener('click', function (ev) {
                ev.stopPropagation();
                if (areaDrawMode) return;
                openSelectedPoint(pin, true);
            });
        } else {
            selectedPointMarker = new google.maps.Marker({
                map: map,
                position: { lat: lat, lng: lng },
                title: pin.label,
                icon: selectedPointSymbol()
            });
            selectedPointMarker.addListener('click', function () {
                if (areaDrawMode) return;
                openSelectedPoint(pin, true);
            });
        }
        if (runtimeSettings && runtimeSettings.earth3d && earthMap) {
            syncSelectedEarthMarker(options && options.preserveEarthCamera ? { preserveCamera: options.preserveEarthCamera } : undefined);
        }
        if (runtimeSettings && runtimeSettings.earth3d && earthMap && !(options && options.fromEarthClick) && !skipEarthFocus) {
            focusEarthCamera({ lat: lat, lng: lng }, { minZoom: 16, preserveRange: true });
        }
        saveSelectedPointState();
        openSelectedPoint(pin, notifyParent);
    }

    function openSelectedPoint(pin, notifyParent) {
        if (!pin) return;
        clearActivePin(false);
        if (infoWindow) infoWindow.close();
        if (notifyParent === false) return;
        postPlaceClicked(pin.id, pin.position, {
            label: pin.label || null,
            address: pin.address || null,
            description: 'Punct selectat pe harta',
            provider: null
        });
    }

    function isSelectedPointId(value) {
        return typeof value === 'string' && /^selected--?\\d+(?:\\.\\d+)?,-?\\d+(?:\\.\\d+)?$/.test(value);
    }

    function clearSelectedPointMarker() {
        // Don't write the "no point" state to sessionStorage here — this is
        // called during renderArtifact cleanup too, and we want the
        // restoration on the next buildMap to still find the persisted
        // point. Explicit user clears (clear-search action, search-target
        // replacing the point) call saveSelectedPointState themselves.
        earthMarkerGeneration++;
        activeSelectedPoint = null;
        if (selectedPointMarker) {
            if (typeof selectedPointMarker.setMap === 'function') selectedPointMarker.setMap(null);
            else selectedPointMarker.map = null;
        }
        selectedPointMarker = null;
        removeEarthMarker(selectedPointMarker3D);
        selectedPointMarker3D = null;
    }

    function buildSelectedPointMarker() {
        var el = document.createElement('div');
        el.className = 'orch-selected-point';
        return el;
    }

    function selectedPointSymbol() {
        return {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 5,
            fillColor: '#ffffff',
            fillOpacity: 1,
            strokeColor: '#d93025',
            strokeWeight: 3
        };
    }

	    function syncEarthMarkers(options) {
	        var preserveCamera = options && options.preserveCamera ? options.preserveCamera : null;
	        if (preserveCamera) restoreEarthCameraAfterMarkerChange(preserveCamera, 1400);
	        var generation = ++earthMarkerGeneration;
	        removeEarthMarker(searchMarker3D);
	        removeEarthMarker(selectedPointMarker3D);
        clearEarthPinMarkers();
        searchMarker3D = null;
        selectedPointMarker3D = null;
        if (!runtimeSettings || !runtimeSettings.earth3d || !earthMap) return;
        Promise.all([getEarthMapLibrary(), getMarkerLibrary()]).then(function (libraries) {
            var maps3d = libraries[0];
            var markerLib = libraries[1];
            if (generation !== earthMarkerGeneration || !runtimeSettings || !runtimeSettings.earth3d || !earthMap) return;
            // Numbered artifact pins. We mirror what addMarker() does on the
            // 2D map so the visible set is identical when the user toggles
            // 3D — the previous code only created earth markers for the
            // search/selected pins, so 3D looked empty for itineraries.
            var keys = Object.keys(markersByKey);
            for (var i = 0; i < keys.length; i++) {
                var entry = markersByKey[keys[i]];
                if (!entry || !entry.pin) continue;
                var marker = createEarthNumberedMarker(
                    maps3d,
                    markerLib,
                    keys[i],
                    entry.pin,
                    entry.number
                );
                if (marker) {
                    appendEarthMarker(marker);
                    pinMarkers3D[keys[i]] = marker;
                }
            }
            if (activeSearchPin) {
                searchMarker3D = createEarthMarker(maps3d, markerLib, activeSearchPin, 'search');
                appendEarthMarker(searchMarker3D);
            }
            if (activeSelectedPoint) {
                selectedPointMarker3D = createEarthMarker(maps3d, markerLib, activeSelectedPoint, 'selected');
                appendEarthMarker(selectedPointMarker3D);
            }
            // Re-apply the active highlight on the 3D marker if one was active
            // on the 2D map when we switched in.
            if (activeKey && pinMarkers3D[activeKey]) {
                applyEarthMarkerActive(pinMarkers3D[activeKey], true);
            }
            if (preserveCamera) restoreEarthCameraAfterMarkerChange(preserveCamera);
        }).catch(function () {});
    }

	    function syncSelectedEarthMarker(options) {
	        var preserveCamera = options && options.preserveCamera ? options.preserveCamera : null;
	        if (preserveCamera) restoreEarthCameraAfterMarkerChange(preserveCamera, 1400);
	        var generation = earthMarkerGeneration;
	        removeEarthMarker(selectedPointMarker3D);
        selectedPointMarker3D = null;
        if (!runtimeSettings || !runtimeSettings.earth3d || !earthMap || !activeSelectedPoint) {
            if (preserveCamera) restoreEarthCameraAfterMarkerChange(preserveCamera);
            return;
        }
        Promise.all([getEarthMapLibrary(), getMarkerLibrary()]).then(function (libraries) {
            if (generation !== earthMarkerGeneration || !runtimeSettings || !runtimeSettings.earth3d || !earthMap || !activeSelectedPoint) return;
            selectedPointMarker3D = createEarthMarker(libraries[0], libraries[1], activeSelectedPoint, 'selected');
            appendEarthMarker(selectedPointMarker3D);
            if (preserveCamera) restoreEarthCameraAfterMarkerChange(preserveCamera);
        }).catch(function () {
            if (preserveCamera) restoreEarthCameraAfterMarkerChange(preserveCamera);
        });
    }

    function clearEarthPinMarkers() {
        var keys = Object.keys(pinMarkers3D);
        for (var i = 0; i < keys.length; i++) {
            removeEarthMarker(pinMarkers3D[keys[i]]);
        }
        pinMarkers3D = {};
    }

    function resetEarthRouteOverlays() {
        earthRouteGeneration++;
        clearEarthRouteOverlays();
    }

    function clearEarthRouteOverlays() {
        removeEarthMarker(routeOverlays3D);
        routeOverlays3D = [];
    }

    function syncEarthRouteOverlays() {
        var generation = ++earthRouteGeneration;
        clearEarthRouteOverlays();
        if (!runtimeSettings || !runtimeSettings.earth3d || !earthMap || !currentArtifact) return;
        getEarthMapLibrary().then(function (maps3d) {
            if (generation !== earthRouteGeneration || !runtimeSettings || !runtimeSettings.earth3d || !earthMap || !currentArtifact) return;
            var routes = currentArtifact.routes || [];
            for (var i = 0; i < routes.length; i++) {
                var routeLine = createEarthRoutePolyline(maps3d, routes[i], i);
                if (!routeLine) continue;
                appendEarthMarker(routeLine);
                routeOverlays3D.push(routeLine);
            }
        }).catch(function () {});
    }

    function createEarthRoutePolyline(maps3d, route, index) {
        if (!maps3d || !route || !Array.isArray(route.coordinates) || route.coordinates.length < 2) return null;
        var Ctor = maps3d.Polyline3DElement || (google.maps.maps3d && google.maps.maps3d.Polyline3DElement);
        if (!Ctor) return null;
        var path = [];
        for (var i = 0; i < route.coordinates.length; i++) {
            var coord = route.coordinates[i];
            if (!Array.isArray(coord) || coord.length !== 2) continue;
            var lng = Number(coord[0]);
            var lat = Number(coord[1]);
            if (!isFinite(lng) || !isFinite(lat)) continue;
            path.push({ lat: lat, lng: lng, altitude: 4 });
        }
        if (path.length < 2) return null;
        var weight = Math.max(1, Math.min(20, Number(route.width) || 4));
        var altitudeMode = maps3d.AltitudeMode && maps3d.AltitudeMode.RELATIVE_TO_GROUND
            ? maps3d.AltitudeMode.RELATIVE_TO_GROUND
            : 'RELATIVE_TO_GROUND';
		        var polyline = new Ctor({
		            strokeColor: route.color || '#2563eb',
		            strokeWidth: Math.max(7, weight + 4),
		            outerColor: '#ffffff',
		            outerWidth: 0.42,
		            altitudeMode: altitudeMode,
		            drawsOccludedSegments: true,
		            zIndex: 1800 + (Number(index) || 0)
		        });
        try { polyline.path = path; } catch (_) {}
        try { polyline.coordinates = path; } catch (_) {}
        return polyline;
    }

    function createEarthNumberedMarker(maps3d, markerLib, key, pin, number) {
        if (!maps3d || !pin || !Array.isArray(pin.position) || pin.position.length !== 2) return null;
        var lat = Number(pin.position[1]);
        var lng = Number(pin.position[0]);
        if (!isFinite(lat) || !isFinite(lng)) return null;
        // Equal height with the selected/search pin so all markers float
        // at the same level — different altitudes felt visually noisy.
        var position = { lat: lat, lng: lng, altitude: 20 };
        var altitudeMode = maps3d.AltitudeMode && maps3d.AltitudeMode.RELATIVE_TO_GROUND
            ? maps3d.AltitudeMode.RELATIVE_TO_GROUND
            : 'RELATIVE_TO_GROUND';
        var Ctor = maps3d.Marker3DInteractiveElement || maps3d.Marker3DElement;
        if (!Ctor) return null;
	        var numberedOptions = {
	            position: position,
		            altitudeMode: altitudeMode,
		            drawsWhenOccluded: true,
		            extruded: true,
		            sizePreserved: true,
            zIndex: 1000 + Math.min(99, Number(number) || 0)
        };
        if (pin.label) numberedOptions.label = pin.label;
        var marker = new Ctor(numberedOptions);
        marker.dataset && (marker.dataset.orchPinKey = key);
        var glyph = buildEarthNumberedPinElement(markerLib, pin, number);
        if (glyph) {
            marker.append(glyph);
        } else {
            var template = document.createElement('template');
            template.content.appendChild(buildEarthNumberedSvg(pin, number));
            marker.appendChild(template);
        }
        if (Ctor === maps3d.Marker3DInteractiveElement) {
            marker.addEventListener('gmp-click', function (event) {
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                if (event && typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
                if (areaDrawMode) return;
                openPin(key, pin, true);
            });
        }
        return marker;
    }

    function buildEarthNumberedPinElement(markerLib, pin, pinNumber) {
        var PinElement = markerLib && markerLib.PinElement
            ? markerLib.PinElement
            : (google.maps.marker && google.maps.marker.PinElement);
        if (!PinElement) return null;
        try {
            var color = pin.color || '#ef4444';
            return new PinElement({
                background: color,
                borderColor: '#ffffff',
                // glyphText (not the deprecated glyph property) takes a string and
                // renders it as the label inside the pin head.
                glyphText: String(pinNumber || ''),
                glyphColor: '#ffffff',
                scale: 1.25
            });
        } catch (_) {
            return null;
        }
    }

    function buildEarthNumberedSvg(pin, pinNumber) {
        var ns = 'http://www.w3.org/2000/svg';
        var color = pin.color || '#ef4444';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 36 36');
        svg.setAttribute('width', '36');
        svg.setAttribute('height', '36');
        svg.style.filter = 'drop-shadow(0 3px 8px rgba(0,0,0,0.42))';
        var circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('cx', '18');
        circle.setAttribute('cy', '18');
        circle.setAttribute('r', '14');
        circle.setAttribute('fill', color);
        circle.setAttribute('stroke', '#fff');
        circle.setAttribute('stroke-width', '3');
        svg.appendChild(circle);
        var text = document.createElementNS(ns, 'text');
        text.setAttribute('x', '18');
        text.setAttribute('y', '22.5');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, sans-serif');
        text.setAttribute('font-weight', '700');
        text.setAttribute('font-size', '14');
        text.setAttribute('fill', '#fff');
        text.textContent = String(pinNumber || '');
        svg.appendChild(text);
        return svg;
    }

    function applyEarthMarkerActive(marker, isActive) {
        if (!marker) return;
        try {
            // Subtle visual: bump altitude + zIndex so the active pin pops.
            if (marker.position && typeof marker.position === 'object') {
                var pos = marker.position;
                var alt = isActive ? 110 : 70;
                marker.position = {
                    lat: typeof pos.lat === 'function' ? pos.lat() : pos.lat,
                    lng: typeof pos.lng === 'function' ? pos.lng() : pos.lng,
                    altitude: alt
                };
            }
            if (typeof marker.zIndex === 'number') {
                marker.zIndex = isActive ? 1300 : marker.zIndex;
            }
        } catch (_) {}
    }

		    function appendEarthMarker(marker) {
		        if (!marker || !earthMap) return;
		        if (Array.isArray(marker)) {
		            for (var i = 0; i < marker.length; i++) appendEarthMarker(marker[i]);
		            return;
		        }
		        earthMap.append(marker);
		        if (earthCameraLockSnapshot) writeEarthCameraDirect(earthCameraLockSnapshot);
		    }

    function createEarthMarker(maps3d, markerLib, pin, variant) {
        if (!maps3d || !pin || !Array.isArray(pin.position)) return null;
        if (variant === 'selected') return createEarthSelectedMarker(maps3d, markerLib, pin);
        // Equal height with the numbered/user-location pins.
        var position = { lat: pin.position[1], lng: pin.position[0], altitude: 20 };
        var altitudeMode = maps3d.AltitudeMode && maps3d.AltitudeMode.RELATIVE_TO_GROUND ? maps3d.AltitudeMode.RELATIVE_TO_GROUND : 'RELATIVE_TO_GROUND';
        var marker;
        if (maps3d.Marker3DElement) {
	            var markerOptions = {
	                position: position,
		                altitudeMode: altitudeMode,
		                drawsWhenOccluded: true,
		                extruded: true,
		                sizePreserved: true,
                zIndex: variant === 'search' ? 1200 : 1100
            };
            // gmp-marker-3d rejects an empty-string label and throws. Only
            // include the option when we actually have text to show.
            if (variant !== 'selected' && pin.label) markerOptions.label = pin.label;
            marker = new maps3d.Marker3DElement(markerOptions);
            var pinElement = buildEarthPinElement(markerLib, variant);
            if (pinElement) {
                marker.append(pinElement);
            } else {
                var template = document.createElement('template');
                template.content.appendChild(buildEarthMarkerSvg(variant));
                marker.appendChild(template);
            }
            return marker;
        }
        if (maps3d.MarkerElement) {
	            marker = new maps3d.MarkerElement({
		                position: position,
		                title: pin.label || '',
		                altitudeMode: altitudeMode,
		                collisionBehavior: 'REQUIRED',
		                collisionPriority: variant === 'search' ? 1200 : 1100,
                anchorLeft: '-50%',
                anchorTop: variant === 'search' ? '-100%' : '-50%'
            });
            marker.appendChild(buildEarthMarkerDom(markerLib, variant));
            return marker;
        }
        marker = document.createElement('gmp-marker');
        marker.setAttribute('position', position.lat + ',' + position.lng + ',' + position.altitude);
        marker.setAttribute('title', pin.label || '');
        marker.setAttribute('altitude-mode', 'relative-to-ground');
        marker.setAttribute('extruded', '');
        marker.setAttribute('collision-behavior', 'REQUIRED');
        marker.appendChild(buildEarthMarkerDom(markerLib, variant));
        return marker;
    }

    function createEarthSelectedMarker(maps3d, markerLib, pin) {
        var lat = Number(pin.position[1]);
        var lng = Number(pin.position[0]);
        if (!isFinite(lat) || !isFinite(lng)) return null;
        // Equal height with the numbered/user-location pins so all
        // markers float at the same level — different altitudes felt
        // visually noisy.
        var altitude = 20;
        var altitudeMode = maps3d.AltitudeMode && maps3d.AltitudeMode.RELATIVE_TO_GROUND ? maps3d.AltitudeMode.RELATIVE_TO_GROUND : 'RELATIVE_TO_GROUND';
        var position = { lat: lat, lng: lng, altitude: altitude };

        // Prefer the interactive element so the marker is clickable, and
        // fall back to the plain Marker3DElement when not available. Use the
        // same PinElement path that the numbered artifact markers use — the
        // previous <template>/SVG path didn't render reliably on gmp-map-3d
        // which is why nothing appeared on click in 3D.
        var Ctor = maps3d.Marker3DInteractiveElement || maps3d.Marker3DElement;
        if (Ctor) {
            // Don't pass label at all — recent versions of gmp-marker-3d
            // reject an empty string ("Cannot set property 'label' to :
            // empty string is not an accepted value"), throwing inside the
            // constructor and silently aborting the marker creation. The
            // selected pin doesn't have a label anyway, so omit the option.
	            var marker3d = new Ctor({
		                position: position,
		                altitudeMode: altitudeMode,
		                drawsWhenOccluded: true,
		                extruded: true,
		                sizePreserved: true,
                zIndex: 1400
            });
            var pinEl = buildEarthPinElement(markerLib, 'selected');
            if (pinEl) {
                marker3d.append(pinEl);
            } else {
                var template = document.createElement('template');
                template.content.appendChild(buildEarthMarkerSvg('selected'));
                marker3d.appendChild(template);
            }
            if (Ctor === maps3d.Marker3DInteractiveElement) {
                marker3d.addEventListener('gmp-click', function (event) {
                    var preserveEarthCamera = snapshotEarthCamera();
                    if (typeof event.preventDefault === 'function') event.preventDefault();
                    if (typeof event.stopPropagation === 'function') event.stopPropagation();
                    if (areaDrawMode) return;
                    openSelectedPoint(pin, true);
                    restoreEarthCameraAfterMarkerChange(preserveEarthCamera);
                });
            }
            return marker3d;
        }

	        if (maps3d.MarkerElement) {
	            var marker = new maps3d.MarkerElement({
		                position: position,
		                title: pin.label || '',
		                altitudeMode: altitudeMode,
		                collisionBehavior: 'REQUIRED',
		                collisionPriority: 1400,
                anchorLeft: '-50%',
                anchorTop: '-100%'
            });
            marker.appendChild(buildEarthMarkerDom(markerLib, 'selected'));
            return marker;
        }

        var fallbackMarker = document.createElement('gmp-marker');
        fallbackMarker.setAttribute('position', position.lat + ',' + position.lng + ',' + position.altitude);
        fallbackMarker.setAttribute('title', pin.label || '');
        fallbackMarker.setAttribute('altitude-mode', 'relative-to-ground');
        fallbackMarker.setAttribute('extruded', '');
        fallbackMarker.setAttribute('collision-behavior', 'REQUIRED');
        fallbackMarker.appendChild(buildEarthMarkerDom(markerLib, 'selected'));
        return fallbackMarker;
    }

    function buildEarthPinElement(markerLib, variant) {
        var PinElement = markerLib && markerLib.PinElement ? markerLib.PinElement : (google.maps.marker && google.maps.marker.PinElement);
        if (!PinElement) return null;
        try {
            // Important: omit glyph/glyphText entirely for selected/search.
            // Passing an empty string made the pin render as a transparent
            // shell on gmp-map-3d — which is why the red drop pin was
            // invisible in 3D on click.
            var pin = new PinElement(
                variant === 'search'
                    ? {
                        background: '#ea4335',
                        borderColor: '#ffffff',
                        scale: 1.4
                    }
                    : {
                        background: '#d93025',
                        borderColor: '#ffffff',
                        scale: 1.25
                    }
            );
            return pin;
        } catch (_) {
            return null;
        }
    }

    function buildEarthMarkerDom(markerLib, variant) {
        var pin = buildEarthPinElement(markerLib, variant);
        if (pin && pin.element) return pin.element;
        if (pin && typeof Node !== 'undefined' && pin instanceof Node) return pin;
        return variant === 'search' ? buildSearchPin() : buildEarthSelectedMarkerDom();
    }

    function buildEarthSelectedMarkerDom() {
        var el = document.createElement('div');
        el.className = 'orch-earth-selected-pin';
        return el;
    }

    function buildEarthMarkerSvg(variant) {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 36 36');
        svg.setAttribute('width', '36');
        svg.setAttribute('height', '36');
        svg.style.filter = 'drop-shadow(0 3px 8px rgba(0,0,0,0.42))';
        if (variant === 'search') {
            var path = document.createElementNS(ns, 'path');
            path.setAttribute('d', 'M18 2c-7 0-12 5.2-12 12 0 8.5 12 20 12 20s12-11.5 12-20C30 7.2 25 2 18 2z');
            path.setAttribute('fill', '#ea4335');
            path.setAttribute('stroke', '#fff');
            path.setAttribute('stroke-width', '3');
            svg.appendChild(path);
            var dot = document.createElementNS(ns, 'circle');
            dot.setAttribute('cx', '18');
            dot.setAttribute('cy', '14');
            dot.setAttribute('r', '4.5');
            dot.setAttribute('fill', '#fff');
            svg.appendChild(dot);
        } else {
            var selectedPath = document.createElementNS(ns, 'path');
            selectedPath.setAttribute('d', 'M18 2c-7 0-12 5.2-12 12 0 8.5 12 20 12 20s12-11.5 12-20C30 7.2 25 2 18 2z');
            selectedPath.setAttribute('fill', '#d93025');
            selectedPath.setAttribute('stroke', '#fff');
            selectedPath.setAttribute('stroke-width', '3');
            svg.appendChild(selectedPath);
            var selectedDot = document.createElementNS(ns, 'circle');
            selectedDot.setAttribute('cx', '18');
            selectedDot.setAttribute('cy', '14');
            selectedDot.setAttribute('r', '4.8');
            selectedDot.setAttribute('fill', '#fff');
            svg.appendChild(selectedDot);
        }
        return svg;
    }

    function removeEarthMarker(marker) {
        if (!marker) return;
        if (Array.isArray(marker)) {
            for (var i = 0; i < marker.length; i++) removeEarthMarker(marker[i]);
            return;
        }
        try {
            if (typeof marker.remove === 'function') marker.remove();
            else if (marker.parentNode) marker.parentNode.removeChild(marker);
        } catch (_) {}
    }

    function addMarker(key, pin, number) {
        if (!pin || !Array.isArray(pin.position) || pin.position.length !== 2) return;
        var content = buildDot(pin, number);
        var AdvMarker = google.maps.marker && google.maps.marker.AdvancedMarkerElement;
        var marker;
        var lastHandledAt = 0;
        function handleMarkerClick(ev) {
            stopMarkerClickEvent(ev);
            var now = Date.now();
            if (now - lastHandledAt < 80) return;
            lastHandledAt = now;
            if (areaDrawMode) return;
            openPin(key, pin, true);
        }
        if (AdvMarker) {
            marker = new AdvMarker({
                map: map,
                position: { lat: pin.position[1], lng: pin.position[0] },
                content: content,
                title: pin.label || ''
            });
            content.addEventListener('click', handleMarkerClick);
            if (typeof marker.addEventListener === 'function') marker.addEventListener('gmp-click', handleMarkerClick);
        } else {
            marker = new google.maps.Marker({
                map: map,
                position: { lat: pin.position[1], lng: pin.position[0] },
                title: pin.label || ''
            });
            marker.addListener('click', handleMarkerClick);
        }
        markersByKey[key] = { marker: marker, pin: pin, content: content, number: number };
    }

    function clearMarker(entry) {
        if (!entry || !entry.marker) return;
        if (typeof entry.marker.setMap === 'function') entry.marker.setMap(null);
        else entry.marker.map = null;
    }

    function clearOverlays(overlays) {
        for (var i = 0; i < overlays.length; i++) {
            if (overlays[i] && typeof overlays[i].setMap === 'function') overlays[i].setMap(null);
        }
    }

    function routeZoomScale() {
        var zoom = map && typeof map.getZoom === 'function' ? Number(map.getZoom()) : 14;
        if (!isFinite(zoom)) return 1;
        if (zoom <= 8) return 0.55;
        if (zoom >= 14) return 1;
        return 0.55 + ((zoom - 8) / 6) * 0.45;
    }

    function routeStrokeMetrics(route, dashed) {
        var base = Math.max(1, Math.min(20, Number(route && route.width) || 4));
        var scale = routeZoomScale();
        var core = Math.max(1.4, Math.min(20, base * scale));
        var haloPad = dashed ? Math.max(2, 4 * scale) : Math.max(2.5, 5 * scale);
        var shadowPad = Math.max(3, 8 * scale);
        return {
            core: core,
            halo: core + haloPad,
            shadow: core + shadowPad,
            dashScale: Math.max(2, core * 0.55),
            dashRepeat: Math.max(10, Math.round(14 * scale)) + 'px'
        };
    }

    function routeDashIcons(color, metrics) {
        return [{
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                fillColor: color,
                fillOpacity: 1,
                strokeColor: color,
                strokeOpacity: 1,
                strokeWeight: 0,
                scale: metrics.dashScale
            },
            offset: '0',
            repeat: metrics.dashRepeat
        }];
    }

    function attachRouteStyle(polyline, route, role, dashed, color) {
        if (!polyline) return polyline;
        polyline.__orchRouteStyle = { route: route, role: role, dashed: dashed, color: color };
        updateRoutePolylineStroke(polyline);
        return polyline;
    }

    function updateRoutePolylineStroke(polyline) {
        if (!polyline || typeof polyline.setOptions !== 'function' || !polyline.__orchRouteStyle) return;
        var meta = polyline.__orchRouteStyle;
        var metrics = routeStrokeMetrics(meta.route, meta.dashed);
        if (meta.role === 'shadow') {
            polyline.setOptions({ strokeWeight: metrics.shadow });
        } else if (meta.role === 'halo') {
            polyline.setOptions({ strokeWeight: metrics.halo });
        } else {
            var options = { strokeWeight: metrics.core };
            if (meta.dashed) options.icons = routeDashIcons(meta.color, metrics);
            polyline.setOptions(options);
        }
    }

    function updateRouteStrokeWeights() {
        for (var i = 0; i < routeOverlays.length; i++) {
            updateRoutePolylineStroke(routeOverlays[i]);
        }
    }

    function scheduleRouteStrokeUpdate() {
        if (routeStrokeFrame !== null) return;
        routeStrokeFrame = window.requestAnimationFrame(function () {
            routeStrokeFrame = null;
            updateRouteStrokeWeights();
        });
    }

    function addRoute(route) {
        if (!route || !Array.isArray(route.coordinates) || route.coordinates.length < 2) return;
        var path = route.coordinates.map(toLatLng).filter(Boolean);
        if (path.length < 2) return;
        var dashed = route.style === 'dashed';
        var color = route.color || '#2563eb';
        var metrics = routeStrokeMetrics(route, dashed);
        var clickable = Boolean(route.label);
        var zBase = dashed ? 220 : 240;
        var routeLines = [];

        if (!dashed) {
            routeLines.push(attachRouteStyle(new google.maps.Polyline({
                map: map,
                path: path,
                strokeColor: '#0f172a',
                strokeOpacity: 0.18,
                strokeWeight: metrics.shadow,
                clickable: false,
                zIndex: zBase
            }), route, 'shadow', dashed, color));
        }

        routeLines.push(attachRouteStyle(new google.maps.Polyline({
            map: map,
            path: path,
            strokeColor: '#ffffff',
            strokeOpacity: dashed ? 0.78 : 0.94,
            strokeWeight: metrics.halo,
            clickable: false,
            zIndex: zBase + 1
        }), route, 'halo', dashed, color));

        var line = attachRouteStyle(new google.maps.Polyline({
            map: map,
            path: path,
            strokeColor: color,
            strokeOpacity: dashed ? 0 : 0.98,
            strokeWeight: metrics.core,
            icons: dashed ? routeDashIcons(color, metrics) : undefined,
            clickable: clickable,
            zIndex: zBase + 2
        }), route, 'core', dashed, color);
        if (route.label) {
            line.addListener('click', function (ev) {
                openOverlayLabel(route.label, ev.latLng);
            });
        }
        routeLines.push(line);
        routeOverlays.push.apply(routeOverlays, routeLines);
    }

    function addPolygon(poly) {
        if (!poly || !Array.isArray(poly.rings) || poly.rings.length === 0) return;
        var paths = [];
        for (var i = 0; i < poly.rings.length; i++) {
            var ring = poly.rings[i];
            if (!Array.isArray(ring) || ring.length < 3) continue;
            var path = ring.map(toLatLng).filter(Boolean);
            if (path.length >= 3) paths.push(path);
        }
        if (paths.length === 0) return;
        var color = poly.color || '#16a34a';
        var polygon = new google.maps.Polygon({
            map: map,
            paths: paths,
            strokeColor: color,
            strokeOpacity: 0.9,
            strokeWeight: 2,
            fillColor: color,
            fillOpacity: typeof poly.fillOpacity === 'number' ? poly.fillOpacity : 0.18,
            clickable: Boolean(poly.label)
        });
        if (poly.label) {
            polygon.addListener('click', function (ev) {
                openOverlayLabel(poly.label, ev.latLng);
            });
        }
        polygonOverlays.push(polygon);
    }

    function openOverlayLabel(label, latLng) {
        if (!label || !infoWindow) return;
        deactivateMarker();
        postPinCleared();
        infoWindow.setContent('<div class="orch-iw"><div class="orch-iw-body"><div class="orch-iw-title">' + escapeHtml(label) + '</div></div></div>');
        infoWindow.setPosition(latLng);
        infoWindow.open({ map: map });
    }

    function toLatLng(coord) {
        if (!Array.isArray(coord) || coord.length !== 2) return null;
        var lng = Number(coord[0]);
        var lat = Number(coord[1]);
        if (!isFinite(lng) || !isFinite(lat)) return null;
        return { lat: lat, lng: lng };
    }

    function boundsFromBBox(bbox) {
        if (!Array.isArray(bbox) || bbox.length !== 4) return null;
        var west = Number(bbox[0]);
        var south = Number(bbox[1]);
        var east = Number(bbox[2]);
        var north = Number(bbox[3]);
        if (![west, south, east, north].every(isFinite)) return null;
        var bounds = new google.maps.LatLngBounds();
        bounds.extend({ lat: south, lng: west });
        bounds.extend({ lat: north, lng: east });
        return bounds;
    }

    function boundsForArtifact(artifact) {
        var bounds = new google.maps.LatLngBounds();
        var count = 0;
        function extend(coord) {
            var ll = toLatLng(coord);
            if (!ll) return;
            bounds.extend(ll);
            count++;
        }
        var pins = artifact.pins || [];
        for (var i = 0; i < pins.length; i++) extend(pins[i].position);
        var routes = artifact.routes || [];
        for (var r = 0; r < routes.length; r++) {
            var coords = routes[r].coordinates || [];
            for (var c = 0; c < coords.length; c++) extend(coords[c]);
        }
        var polygons = artifact.polygons || [];
        for (var p = 0; p < polygons.length; p++) {
            var rings = polygons[p].rings || [];
            for (var g = 0; g < rings.length; g++) {
                for (var k = 0; k < rings[g].length; k++) extend(rings[g][k]);
            }
        }
        return count > 0 ? bounds : null;
    }

    function buildDot(pin, number) {
        var color = pin.color || '#ef4444';
        var el = document.createElement('div');
        el.className = 'orch-dot';
        el.style.background = color;
        el.textContent = String(number);
        return el;
    }

    function openPin(key, pin, notifyParent, options) {
        if (!map) return;
        var fromEarthClick = !!(options && options.fromEarthClick);
        var preserveEarthCamera = fromEarthClick ? snapshotEarthCamera() : null;
        // Pan to the pin and ensure we're zoomed in enough to read the
        // surrounding context. If the user is already close, leave
        // their zoom alone — over-zooming on every click feels jarring.
        // Skip the camera move entirely when the click came from the 3D
        // map: the user already sees the pin where they tapped, and
        // re-centring on it felt like the map was fighting them.
        if (!fromEarthClick) {
            withProgrammaticCamera(function () {
                map.panTo({ lat: pin.position[1], lng: pin.position[0] });
                var z = map.getZoom() || 14;
                if (z < 17) map.setZoom(17);
            });
        }
        if (infoWindow) infoWindow.close();
        activateMarker(key);
        if (preserveEarthCamera) restoreEarthCameraAfterMarkerChange(preserveEarthCamera);
        // When the 3D map is the one the user is actually looking at, the
        // 2D pan above is invisible. Move the Earth camera too — but only
        // for non-3D-click sources (sidebar selection, postMessage, etc).
        if (!fromEarthClick && runtimeSettings && runtimeSettings.earth3d && earthMap) {
            focusEarthCamera(
                { lat: pin.position[1], lng: pin.position[0] },
                { minZoom: 17, preserveRange: false }
            );
        }
        if (notifyParent === false) return;
        postPinClicked(key, pin);
    }

    function postPinClicked(key, pin) {
        try {
            postToParent({ __orchMap: 'pin-clicked', key: key, position: pin.position });
        } catch (_) {}
    }

    function postPlaceClicked(placeId, position, fallback) {
        try {
            postToParent({ __orchMap: 'place-clicked', placeId: placeId, position: position, fallback: fallback });
        } catch (_) {}
    }

    function clearActivePin(notifyParent) {
        if (infoWindow) infoWindow.close();
        deactivateMarker();
        if (notifyParent === false) return;
        postPinCleared();
    }

    function postPinCleared() {
        try {
            postToParent({ __orchMap: 'pin-cleared' });
        } catch (_) {}
    }

    function activateMarker(key) {
        deactivateMarker();
        var entry = markersByKey[key];
        if (entry && entry.content) entry.content.classList.add('is-active');
        if (pinMarkers3D[key]) applyEarthMarkerActive(pinMarkers3D[key], true);
        activeKey = key;
    }
    function deactivateMarker() {
        if (activeKey && markersByKey[activeKey]) {
            markersByKey[activeKey].content.classList.remove('is-active');
        }
        if (activeKey && pinMarkers3D[activeKey]) {
            applyEarthMarkerActive(pinMarkers3D[activeKey], false);
        }
        activeKey = null;
    }

    function showToast(message) {
        var existing = document.querySelector('.orch-map-toast');
        if (existing) existing.remove();
        if (toastTimer) window.clearTimeout(toastTimer);
        var toast = document.createElement('div');
        toast.className = 'orch-map-toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        toastTimer = window.setTimeout(function () {
            toast.remove();
            toastTimer = null;
        }, 1800);
    }

    function showError(msg) {
        mapEl.innerHTML = '';
        var box = document.createElement('div');
        box.className = 'orch-iframe-error';
        box.innerHTML = '<b>Map failed to load</b>' + escapeHtml(msg);
        mapEl.appendChild(box);
        try {
            postToParent({ __orchMap: 'error', message: msg });
        } catch (_) {}
    }

    function showEarthError(msg) {
        showToast('3D unavailable here; staying in 2D.');
        try {
            postToParent({ __orchMap: 'earth3d-unavailable', message: msg });
            postToParent({ __orchMap: 'error', message: msg });
        } catch (_) {}
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }
})();
</script>
<script async src="https://maps.googleapis.com/maps/api/js?key=__API_KEY__&libraries=marker&v=beta&loading=async&callback=__orchBoot"></script>
`
