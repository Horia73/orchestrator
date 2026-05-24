export const EARTH_3D_RUNTIME = `
    function deactivateEarthMap(options) {
        var animate = !!(options && options.animate);
        var skipCameraSync = !!(options && options.skipCameraSync);
        if (animate && earthMap) {
            animateEarthMapExit();
            return;
        }
        if (earthDeactivateAnimationTimer && !skipCameraSync) return;
        pendingEarthFlyToTarget = null;
        if (earthDeactivateAnimationTimer) {
            window.clearTimeout(earthDeactivateAnimationTimer);
            earthDeactivateAnimationTimer = null;
        }
        if (earthFadeTimer) {
            window.clearTimeout(earthFadeTimer);
            earthFadeTimer = null;
        }
        stopEarthCameraLock();
        stopEarthCameraAnimation();
        if (earthMap) {
            try { earthMap.stopCameraAnimation && earthMap.stopCameraAnimation(); } catch (_) {}
        }
        if (!skipCameraSync && earthMap && document.body.classList.contains('is-earth3d')) {
            syncMapForEarthExit();
            saveCameraStateSoon();
        }
        if (earthMap) {
            try { earthMap.remove(); } catch (_) {}
            earthMap = null;
        }
        clearEarthPinMarkers();
        resetEarthRouteOverlays();
        searchMarker3D = null;
        selectedPointMarker3D = null;
        earthFirstSteadyFired = false;
        earthUserMovedCamera = false;
        if (earthMapEl) earthMapEl.textContent = '';
        document.body.classList.remove('is-earth3d');
        document.body.classList.remove('earth3d-ready');
        document.body.classList.remove('earth3d-fading-out');
        if (earthReadyTimer) {
            window.clearTimeout(earthReadyTimer);
            earthReadyTimer = null;
        }
        earthActivationStartedAt = 0;
        if (earthMapEl) earthMapEl.setAttribute('aria-hidden', 'true');
        if (earthLoadingEl) earthLoadingEl.setAttribute('aria-hidden', 'true');
    }

    function animateEarthMapExit() {
        if (!earthMap || !document.body.classList.contains('is-earth3d')) {
            deactivateEarthMap({ skipCameraSync: true });
            return;
        }
        if (earthDeactivateAnimationTimer) return;
        pendingEarthFlyToTarget = null;
        suppressEarthCameraTracking = true;
        releaseEarthCameraTrackingSoon(EARTH_EXIT_ANIMATION_MS + EARTH_FADE_MS + 600);
        var exitCamera = earthExitCameraFor2D();
        syncMapForEarthExit(exitCamera);
        saveCameraStateSoon();
        if (earthLoadingEl) earthLoadingEl.setAttribute('aria-hidden', 'true');
        if (exitCamera) {
            // Keep heading fixed during the 3D exit. Rotating while the camera is
            // still tilted changes the screen anchor geometry and makes the focus
            // appear to land on a different point.
            animateEarthCameraTo({
                center: exitCamera.center,
                range: exitCamera.range,
                tilt: 0,
                heading: exitCamera.heading
            }, EARTH_EXIT_ANIMATION_MS);
        } else {
            var current = snapshotEarthCamera();
            if (current) {
                animateEarthCameraTo({
                    center: current.center,
                    range: earthBaseRangeFromTiltedCamera(current.range, current.tilt) || current.range,
                    tilt: 0,
                    heading: current.heading
                }, EARTH_EXIT_ANIMATION_MS);
            }
        }
        earthDeactivateAnimationTimer = window.setTimeout(function () {
            document.body.classList.add('earth3d-fading-out');
            document.body.classList.remove('earth3d-ready');
            earthFadeTimer = window.setTimeout(function () {
                earthFadeTimer = null;
                deactivateEarthMap({ skipCameraSync: true });
            }, EARTH_FADE_MS + 80);
        }, Math.max(0, EARTH_EXIT_ANIMATION_MS));
    }

    function activateEarthMap(options) {
        if (!earthMapEl || !currentArtifact || !map) return;
        var animateFlyTo = !!(options && options.animate);
        var generation = ++earthMapGeneration;
        earthHasBeenActivatedOnce = true;
	        earthUserMovedCamera = false;
	        document.body.classList.add('is-earth3d');
	        document.body.classList.remove('earth3d-ready');
	        document.body.classList.remove('earth3d-fading-out');
	        earthMapEl.setAttribute('aria-hidden', 'false');
        if (earthLoadingEl) earthLoadingEl.setAttribute('aria-hidden', 'false');
        earthActivationStartedAt = Date.now();
        currentEarthCamera().then(function (targetCamera) {
            if (generation !== earthMapGeneration || !runtimeSettings || !runtimeSettings.earth3d) return;
            if (!targetCamera) return;
            // If we restored a 3D pose from a previous tab/page visit, return
            // to that exact view instead of the defaults.
            if (pendingEarthCameraRestore) {
                var restore = pendingEarthCameraRestore;
                pendingEarthCameraRestore = null;
                targetCamera = earthCameraFromSavedState(restore) || targetCamera;
            }
            targetCamera = normalizeEarthCamera(targetCamera) || targetCamera;
            // While the camera moves programmatically, ignore the camera-change
            // events so we don't mark the move as "user moved".
            suppressEarthCameraTracking = true;
	        releaseEarthCameraTrackingSoon(animateFlyTo ? EARTH_FADE_MS + 1200 : 1800);
            if (earthMap) {
                try { earthMap.stopCameraAnimation && earthMap.stopCameraAnimation(); } catch (_) {}
                applyEarthCamera(targetCamera);
                syncEarthMarkers();
                syncEarthRouteOverlays();
                markEarthMapReadySoon();
                return;
            }
            earthMapEl.textContent = '';
            // Start at the exact 2D pose, wait for a real 3D frame, then run the
            // same camera animation a manual tilt would use.
            var initialCamera = animateFlyTo
                ? {
                    center: targetCamera.focusCenter || { lat: Number(targetCamera.center.lat), lng: Number(targetCamera.center.lng), altitude: Number(targetCamera.center.altitude) || 0 },
                    range: targetCamera.baseRange || targetCamera.range,
                    zoom: targetCamera.zoom,
                    minAltitude: targetCamera.minAltitude,
                    tilt: 0,
                    heading: 0
                }
                : targetCamera;
            getEarthMapLibrary().then(function (maps3d) {
                if (generation !== earthMapGeneration || !runtimeSettings || !runtimeSettings.earth3d) return;
                var mode = maps3d.MapMode && maps3d.MapMode.HYBRID ? maps3d.MapMode.HYBRID : 'HYBRID';
                earthMap = new maps3d.Map3DElement({
                    center: initialCamera.center,
                    range: initialCamera.range,
                    tilt: initialCamera.tilt,
                    heading: initialCamera.heading,
                    fov: EARTH_CAMERA_FOV,
                    minAltitude: initialCamera.minAltitude || minCameraAltitudeForZoom(initialCamera.zoom),
                    mode: mode,
		                mapId: ${"__MAP_ID__"},
		                minTilt: 0,
	                maxTilt: MAX_EARTH_TILT,
	                defaultUIHidden: true,
                    gestureHandling: maps3d.GestureHandling && maps3d.GestureHandling.GREEDY ? maps3d.GestureHandling.GREEDY : undefined
                });
                earthMap.addEventListener('gmp-error', function (event) {
                    var message = event && event.error && event.error.message ? event.error.message : 'Earth 3D failed to render in this area.';
                    showEarthError(message);
                    deactivateEarthMap();
                });
                earthMap.addEventListener('gmp-map-id-error', function () {
                    showEarthError('Earth 3D Map ID failed. Check the Google Cloud Map ID configuration.');
                    deactivateEarthMap();
                });
                earthMap.addEventListener('gmp-steadychange', function () {
                    updateCameraDataset();
                    handleEarthFirstSteady();
                });
                earthMap.addEventListener('gmp-centerchange', handleEarthPositionCameraChange);
                earthMap.addEventListener('gmp-rangechange', handleEarthPositionCameraChange);
                earthMap.addEventListener('gmp-tiltchange', handleEarthOrientationCameraChange);
                earthMap.addEventListener('gmp-headingchange', handleEarthOrientationCameraChange);
                earthMap.addEventListener('gmp-click', handleEarthMapClick, { capture: true });
                if (animateFlyTo) {
                    pendingEarthFlyToTarget = {
                        center: targetCamera.center,
                        focusCenter: targetCamera.focusCenter,
                        range: targetCamera.range,
                        baseRange: targetCamera.baseRange,
                        zoom: targetCamera.zoom,
                        minAltitude: targetCamera.minAltitude,
                        tilt: targetCamera.tilt,
                        heading: targetCamera.heading
                    };
                    earthMap.center = initialCamera.center;
                    earthMap.range = initialCamera.range;
                    earthMap.tilt = 0;
                    earthMap.heading = 0;
                }
                earthMapEl.appendChild(earthMap);
                updateCameraDataset();
                syncEarthMarkers();
                syncEarthRouteOverlays();
                scheduleEarthReadyFallback(generation);
            }).catch(function (error) {
                showEarthError('Earth 3D failed to load: ' + (error && error.message ? error.message : String(error)));
                deactivateEarthMap();
            });
        }).catch(function (error) {
            showEarthError('Earth 3D camera failed: ' + (error && error.message ? error.message : String(error)));
            deactivateEarthMap();
        });
    }

    function markEarthMapReadySoon() {
        if (!runtimeSettings || !runtimeSettings.earth3d || !earthMap) return;
        if (earthReadyTimer) window.clearTimeout(earthReadyTimer);
        earthReadyTimer = window.setTimeout(function () {
            earthReadyTimer = null;
            if (!runtimeSettings || !runtimeSettings.earth3d || !earthMap) return;
            document.body.classList.add('earth3d-ready');
            if (earthLoadingEl) earthLoadingEl.setAttribute('aria-hidden', 'true');
        }, 0);
    }

    function handleEarthFirstSteady() {
        if (!runtimeSettings || !runtimeSettings.earth3d || !earthMap) return;
        if (earthFirstSteadyFired) return;
        earthFirstSteadyFired = true;
        if (pendingEarthFlyToTarget) {
            var fly = pendingEarthFlyToTarget;
            pendingEarthFlyToTarget = null;
            applyEarthCamera({
                center: fly.focusCenter || fly.center,
                range: fly.baseRange || fly.range,
                tilt: 0,
                heading: 0
            });
            window.setTimeout(function () {
                if (!runtimeSettings || !runtimeSettings.earth3d || !earthMap) return;
                document.body.classList.add('earth3d-ready');
                if (earthLoadingEl) earthLoadingEl.setAttribute('aria-hidden', 'true');
                animateEarthCameraEntry(fly);
            }, 80);
        } else {
            document.body.classList.add('earth3d-ready');
            if (earthLoadingEl) earthLoadingEl.setAttribute('aria-hidden', 'true');
        }
    }

    function scheduleEarthReadyFallback(generation) {
        // Safety net: if gmp-steadychange never fires (rare — usually
        // tile-load errors), reveal the map and run the animation anyway
        // so the user isn't stuck on a loading overlay forever.
        window.setTimeout(function () {
            if (generation !== earthMapGeneration) return;
            handleEarthFirstSteady();
        }, 1200);
    }

    function getEarthMapLibrary() {
        if (!earthMapLibraryPromise) earthMapLibraryPromise = google.maps.importLibrary('maps3d');
        return earthMapLibraryPromise;
    }

    function getMarkerLibrary() {
        if (!markerLibraryPromise) markerLibraryPromise = google.maps.importLibrary('marker');
        return markerLibraryPromise;
    }

    function earthGroundAltitudeKey(lat, lng) {
        return Number(lat).toFixed(5) + ',' + Number(lng).toFixed(5);
    }

    function getEarthElevationService() {
        if (!earthElevationServicePromise) {
            earthElevationServicePromise = google.maps.importLibrary('elevation').then(function (lib) {
                var Service = lib && lib.ElevationService ? lib.ElevationService : google.maps.ElevationService;
                return Service ? new Service() : null;
            }).catch(function () {
                return google.maps.ElevationService ? new google.maps.ElevationService() : null;
            });
        }
        return earthElevationServicePromise;
    }

    function resolveGroundAltitude(lat, lng) {
        lat = Number(lat);
        lng = Number(lng);
        if (!isFinite(lat) || !isFinite(lng)) return Promise.resolve(0);
        var key = earthGroundAltitudeKey(lat, lng);
        if (Object.prototype.hasOwnProperty.call(earthGroundAltitudeCache, key)) {
            return Promise.resolve(earthGroundAltitudeCache[key]);
        }
        return getEarthElevationService().then(function (elevator) {
            if (!elevator || typeof elevator.getElevationForLocations !== 'function') return 0;
            return elevator.getElevationForLocations({
                locations: [{ lat: lat, lng: lng }]
            });
        }).then(function (response) {
            var result = response && response.results && response.results[0];
            var altitude = result ? Number(result.elevation) : 0;
            if (!isFinite(altitude)) altitude = 0;
            earthGroundAltitudeCache[key] = altitude;
            return altitude;
        }).catch(function () {
            return 0;
        });
    }

    function currentEarthCamera() {
        var center = map && map.getCenter ? map.getCenter() : null;
        var lat = center ? center.lat() : currentArtifact.viewport.center[1];
        var lng = center ? center.lng() : currentArtifact.viewport.center[0];
	        if (!isFinite(lat)) lat = center ? center.lat() : currentArtifact.viewport.center[1];
	        if (!isFinite(lng)) lng = center ? center.lng() : currentArtifact.viewport.center[0];
	        var zoom = map && map.getZoom ? map.getZoom() : currentArtifact.viewport.zoom;
	        var requestedTilt = runtimeSettings
	            ? clampNumber(runtimeSettings.tilt, 0, MAX_EARTH_TILT, DEFAULT_EARTH_TILT)
	            : DEFAULT_EARTH_TILT;
	        var heading = runtimeSettings ? runtimeSettings.heading : 0;
	        // 2D→3D is always anchored to the current screen center, not to a
	        // previously selected/search pin that happens to be on the map.
	        return resolveGroundAltitude(lat, lng).then(function (groundAltitude) {
	            return computeAnchored2DTo3DCamera({
	                center2D: { lat: lat, lng: lng, altitude: groundAltitude },
	                zoom: zoom,
	                viewportHeight: earthViewportReferencePixels(),
	                heading: heading,
	                desiredTilt: requestedTilt,
	                fov: EARTH_CAMERA_FOV,
	                anchorY: EARTH_SCREEN_ANCHOR_Y,
	                zoomFit: EARTH_RANGE_ZOOM_FIT,
	                maxBackMeters: EARTH_MAX_BACK_METERS,
	                groundAltitude: groundAltitude
	            });
	        });
    }

    function computeAnchored2DTo3DCamera(input) {
        var center2D = input.center2D;
        var lat = Number(center2D.lat);
        var lng = Number(center2D.lng);
        var zoom = Number(input.zoom);
        var viewportHeight = Number(input.viewportHeight);
        if (!isFinite(lat) || !isFinite(lng)) return null;
        if (!isFinite(zoom)) zoom = 16;
        if (!isFinite(viewportHeight) || viewportHeight <= 0) viewportHeight = earthViewportReferencePixels();
        var heading = ((Number(input.heading) || 0) % 360 + 360) % 360;
        var desiredTilt = clampNumber(input.desiredTilt, 0, MAX_EARTH_TILT, DEFAULT_EARTH_TILT);
        var fov = clampNumber(input.fov, 5, 80, EARTH_CAMERA_FOV);
        var anchorY = clampNumber(input.anchorY, 0.5, 0.95, EARTH_SCREEN_ANCHOR_Y);
        var zoomFit = clampNumber(input.zoomFit, 0.75, 1.5, 1);
        var groundAltitude = Number(input.groundAltitude);
        if (!isFinite(groundAltitude)) groundAltitude = Number(center2D.altitude);
        if (!isFinite(groundAltitude)) groundAltitude = 0;
        var visibleMeters = earthVisibleMetersForZoom(zoom, lat, viewportHeight) * zoomFit;
        var rawBaseRange = visibleMeters / (2 * Math.tan(fov * Math.PI / 360));
        var minAltitude = minCameraAltitudeForZoom(zoom);
        var h = Math.max(
            MIN_EARTH_RANGE,
            Math.min(MAX_EARTH_RANGE, Math.max(rawBaseRange, minAltitude))
        );
        var defaultMaxBackMeters = clampNumber(visibleMeters * 0.35, 50, 260, 120);
        var maxBackMeters = Number(input.maxBackMeters);
        if (!isFinite(maxBackMeters)) maxBackMeters = defaultMaxBackMeters;
        maxBackMeters = clampNumber(maxBackMeters, 40, 600, defaultMaxBackMeters);
        var alphaDeg = (0.5 - anchorY) * fov;
        var maxTiltByBack = Math.atan(maxBackMeters / Math.max(1, h)) * 180 / Math.PI - alphaDeg;
        var safeTilt = clampNumber(Math.min(desiredTilt, maxTiltByBack), 0, MAX_EARTH_TILT, 0);
        var theta = safeTilt * Math.PI / 180;
        var alpha = alphaDeg * Math.PI / 180;
        var dCenter = h * Math.tan(theta);
        var targetAngle = clampNumber(theta + alpha, 0, 85 * Math.PI / 180, 0);
        var dTarget = h * Math.tan(targetAngle);
        var centerShift = dCenter - dTarget;
        var finalCenter = moveLatLng(center2D, heading, centerShift);
        var finalRange = safeTilt <= 0.01 ? h : h / Math.max(0.25, Math.cos(theta));
        return {
            center: { lat: finalCenter.lat, lng: finalCenter.lng, altitude: groundAltitude },
            focusCenter: { lat: lat, lng: lng, altitude: groundAltitude },
            range: Math.min(MAX_EARTH_RANGE, Math.max(MIN_EARTH_RANGE, finalRange)),
            baseRange: h,
            zoom: zoom,
            minAltitude: minAltitude,
            tilt: safeTilt,
            heading: heading,
            fov: fov,
            debug: {
                rawBaseRange: rawBaseRange,
                h: h,
                minAltitude: minAltitude,
                groundAltitude: groundAltitude,
                visibleMeters: visibleMeters,
                dCenter: dCenter,
                dTarget: dTarget,
                centerShift: centerShift,
                maxBackMeters: maxBackMeters
            }
        };
    }

    function moveLatLng(point, headingDeg, distanceMeters) {
        var lat = Number(point.lat);
        var lng = Number(point.lng);
        var meters = Number(distanceMeters);
        if (!isFinite(lat) || !isFinite(lng) || !isFinite(meters) || Math.abs(meters) < 0.001) {
            return { lat: lat, lng: lng, altitude: Number(point.altitude) || 0 };
        }
        var bearing = headingDeg * Math.PI / 180;
        var lat1 = lat * Math.PI / 180;
        var lng1 = lng * Math.PI / 180;
        var dr = meters / EARTH_RADIUS_M;
        var lat2 = Math.asin(
            Math.sin(lat1) * Math.cos(dr) +
            Math.cos(lat1) * Math.sin(dr) * Math.cos(bearing)
        );
        var lng2 = lng1 + Math.atan2(
            Math.sin(bearing) * Math.sin(dr) * Math.cos(lat1),
            Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2)
        );
        return {
            lat: lat2 * 180 / Math.PI,
            lng: lng2 * 180 / Math.PI,
            altitude: Number(point.altitude) || 0
        };
    }

    function normalizeEarthCamera(camera) {
        if (!camera || !camera.center) return null;
        var lat = Number(camera.center.lat);
        var lng = Number(camera.center.lng);
        if (!isFinite(lat) || !isFinite(lng)) return null;
        var hasBaseRange = camera.baseRange !== undefined && camera.baseRange !== null && isFinite(Number(camera.baseRange));
        var rawRange = clampNumber(camera.range, MIN_EARTH_RANGE, MAX_EARTH_RANGE, MIN_EARTH_RANGE);
        var baseRange = hasBaseRange ? clampNumber(camera.baseRange, MIN_EARTH_RANGE, MAX_EARTH_RANGE, rawRange) : rawRange;
        var zoom = Number(camera.zoom);
        if (!isFinite(zoom) && hasBaseRange) zoom = zoomForEarthRange(baseRange, lat);
        if (!isFinite(zoom)) zoom = NaN;
        var tilt = clampNumber(camera.tilt, 0, MAX_EARTH_TILT, DEFAULT_EARTH_TILT);
        var range = rawRange;
        var altitude = Number(camera.center.altitude) || 0;
        var minAltitude = Number(camera.minAltitude);
        if (!isFinite(minAltitude)) minAltitude = minCameraAltitudeForZoom(zoom);
        var focusCenter = null;
        if (camera.focusCenter) {
            var focusLat = Number(camera.focusCenter.lat);
            var focusLng = Number(camera.focusCenter.lng);
            if (isFinite(focusLat) && isFinite(focusLng)) {
                focusCenter = { lat: focusLat, lng: focusLng, altitude: Number(camera.focusCenter.altitude) || 0 };
            }
        }
        var normalized = {
            center: { lat: lat, lng: lng, altitude: altitude },
            focusCenter: focusCenter,
            range: range,
            minAltitude: minAltitude,
            tilt: tilt,
            heading: ((Number(camera.heading) || 0) % 360 + 360) % 360
        };
        if (hasBaseRange) {
            normalized.baseRange = baseRange;
        }
        if (isFinite(zoom)) {
            normalized.zoom = zoom;
        }
        return normalized;
    }

    function snapshotEarthCamera() {
        if (!earthMap || !earthMap.center) return null;
        return normalizeEarthCamera({
            center: earthMap.center,
            range: earthMap.range,
            tilt: earthMap.tilt,
            heading: earthMap.heading
        });
    }

    function applyEarthCamera(camera) {
        if (!earthMap || !camera) return;
        var nextCamera = normalizeEarthCamera(camera);
        if (!nextCamera) return;
        withProgrammaticEarthCamera(function () {
            writeEarthCameraDirect(nextCamera);
        }, 1200);
    }

    function writeEarthCameraDirect(camera) {
        if (!earthMap || !camera) return;
        var nextCamera = normalizeEarthCamera(camera);
        if (!nextCamera) return;
        earthMap.range = nextCamera.range;
        setEarthMapTiltBounds(nextCamera.range, nextCamera.zoom, nextCamera.minAltitude);
        earthMap.tilt = nextCamera.tilt;
        earthMap.heading = nextCamera.heading;
        earthMap.center = nextCamera.center;
        if (typeof earthMap.fov === 'number') earthMap.fov = EARTH_CAMERA_FOV;
        updateCameraDataset();
    }

    function stopEarthCameraAnimation() {
        if (earthCameraAnimationFrame !== null) {
            window.cancelAnimationFrame(earthCameraAnimationFrame);
            earthCameraAnimationFrame = null;
        }
        if (earthMap) {
            try { earthMap.stopCameraAnimation && earthMap.stopCameraAnimation(); } catch (_) {}
        }
    }

    function stopEarthCameraLock() {
        if (earthCameraLockFrame !== null) {
            window.cancelAnimationFrame(earthCameraLockFrame);
            earthCameraLockFrame = null;
        }
        earthCameraLockSnapshot = null;
    }

    function animateEarthCameraTo(camera, durationMillis) {
        if (!earthMap || !camera) return;
        var nextCamera = normalizeEarthCamera(camera);
        if (!nextCamera) return;
	        var duration = typeof durationMillis === 'number' && isFinite(durationMillis)
	            ? Math.max(0, durationMillis)
	            : EARTH_ENTRY_ANIMATION_MS;
        stopEarthCameraLock();
	        stopEarthCameraAnimation();
        if (duration <= 0) {
            applyEarthCamera(nextCamera);
            return;
        }
        var startCamera = snapshotEarthCamera() || nextCamera;
        if (!isFinite(Number(startCamera.range)) || Number(startCamera.range) <= 0) {
            startCamera.range = nextCamera.range;
        }
        var startHeading = Number(startCamera.heading) || 0;
        var endHeading = Number(nextCamera.heading) || 0;
        var headingDelta = ((endHeading - startHeading + 540) % 360) - 180;
        var startedAt = performance && typeof performance.now === 'function' ? performance.now() : Date.now();
        suppressEarthCameraTracking = true;
        releaseEarthCameraTrackingSoon(duration + 800);
        function ease(t) {
            return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        }
        function lerp(a, b, t) {
            return a + (b - a) * t;
        }
        function writeCamera(progress) {
            if (!earthMap) return;
            var t = ease(progress);
            var tilt = clampNumber(lerp(startCamera.tilt, nextCamera.tilt, t), 0, MAX_EARTH_TILT, 0);
            var range = lerp(startCamera.range, nextCamera.range, t);
            earthMap.center = {
                lat: lerp(startCamera.center.lat, nextCamera.center.lat, t),
                lng: lerp(startCamera.center.lng, nextCamera.center.lng, t),
                altitude: lerp(startCamera.center.altitude || 0, nextCamera.center.altitude || 0, t)
            };
            earthMap.range = range;
            setEarthMapTiltBounds(range, nextCamera.zoom, nextCamera.minAltitude);
            earthMap.tilt = tilt;
            earthMap.heading = (startHeading + headingDelta * t + 360) % 360;
            if (typeof earthMap.fov === 'number') earthMap.fov = EARTH_CAMERA_FOV;
            updateCameraDataset();
        }
        function tick(now) {
            if (!earthMap) {
                earthCameraAnimationFrame = null;
                return;
            }
            var elapsed = now - startedAt;
            var progress = Math.max(0, Math.min(1, elapsed / duration));
            writeCamera(progress);
            if (progress < 1) {
                earthCameraAnimationFrame = window.requestAnimationFrame(tick);
                return;
            }
            earthCameraAnimationFrame = null;
            applyEarthCamera(nextCamera);
        }
        writeCamera(0);
        earthCameraAnimationFrame = window.requestAnimationFrame(tick);
    }

    function animateEarthCameraEntry(camera) {
        var finalCamera = normalizeEarthCamera(camera);
        if (!finalCamera) return;
        animateEarthCameraTo(finalCamera, EARTH_ENTRY_ANIMATION_MS);
    }

    function restoreEarthCameraAfterMarkerChange(camera, durationMillis) {
        if (!camera) return;
        var snapshot = normalizeEarthCamera(camera);
        if (!snapshot) return;
        var duration = typeof durationMillis === 'number' && isFinite(durationMillis)
            ? Math.max(120, durationMillis)
            : 900;
        var startedAt = performance && typeof performance.now === 'function' ? performance.now() : Date.now();
        var endsAt = startedAt + duration;
        stopEarthCameraLock();
        earthCameraLockSnapshot = snapshot;
        suppressEarthCameraTracking = true;
        if (earthMap) {
            try { earthMap.stopCameraAnimation && earthMap.stopCameraAnimation(); } catch (_) {}
        }
        function restore(now) {
            if (!earthMap || !runtimeSettings || !runtimeSettings.earth3d) return;
            suppressEarthCameraTracking = true;
            writeEarthCameraDirect(snapshot);
            var currentNow = typeof now === 'number' && isFinite(now)
                ? now
                : (performance && typeof performance.now === 'function' ? performance.now() : Date.now());
            if (currentNow < endsAt) {
                earthCameraLockFrame = window.requestAnimationFrame(restore);
                return;
            }
            earthCameraLockFrame = null;
            earthCameraLockSnapshot = null;
            releaseEarthCameraTrackingSoon(600);
        }
        restore(startedAt);
    }

    function focusEarthCamera(position, options) {
        if (!earthMap || !position) return;
        stopEarthCameraLock();
        var lng = Number(position.lng);
        var lat = Number(position.lat);
        if (!isFinite(lng) || !isFinite(lat)) return;
        var zoom = map && map.getZoom ? map.getZoom() : currentArtifact && currentArtifact.viewport ? currentArtifact.viewport.zoom : 16;
        var minZoom = options && typeof options.minZoom === 'number' ? options.minZoom : null;
        if (minZoom !== null && isFinite(minZoom)) zoom = Math.max(Number(zoom) || minZoom, minZoom);
        var maxZoom = options && typeof options.maxZoom === 'number' ? options.maxZoom : null;
        if (maxZoom !== null && isFinite(maxZoom)) zoom = Math.min(Number(zoom) || maxZoom, maxZoom);
        var generation = earthMapGeneration;
        resolveGroundAltitude(lat, lng).then(function (groundAltitude) {
            if (generation !== earthMapGeneration || !earthMap || !runtimeSettings || !runtimeSettings.earth3d) return;
            // Preserve the user's current tilt/heading. Re-applying runtimeSettings
	            // defaults snapped them back to the default tilt/0° every time they picked a pin or
            // "my location", which felt like the map was fighting them.
            var currentTilt = typeof earthMap.tilt === 'number' && isFinite(earthMap.tilt)
                ? earthMap.tilt
	                : (runtimeSettings ? clampNumber(runtimeSettings.tilt, 0, MAX_EARTH_TILT, DEFAULT_EARTH_TILT) : DEFAULT_EARTH_TILT);
            var currentHeading = typeof earthMap.heading === 'number' && isFinite(earthMap.heading)
                ? earthMap.heading
                : (runtimeSettings ? runtimeSettings.heading : 0);
            var preserveRange = options && options.preserveRange && isFinite(Number(earthMap.range));
            var cameraRange = preserveRange ? Number(earthMap.range) : earthRangeForZoom(zoom, lat);
            var animateTiltFromTop = !!(options && options.animateTiltFromTop) && !preserveRange;
            if (animateTiltFromTop) {
                var desiredTilt = runtimeSettings
                    ? clampNumber(runtimeSettings.tilt, 0, MAX_EARTH_TILT, DEFAULT_EARTH_TILT)
                    : currentTilt;
                var targetCamera = computeAnchored2DTo3DCamera({
                    center2D: { lat: lat, lng: lng, altitude: groundAltitude },
                    zoom: zoom,
                    viewportHeight: earthViewportReferencePixels(),
                    heading: currentHeading,
                    desiredTilt: desiredTilt,
                    fov: EARTH_CAMERA_FOV,
                    anchorY: EARTH_SCREEN_ANCHOR_Y,
                    zoomFit: EARTH_RANGE_ZOOM_FIT,
                    maxBackMeters: EARTH_MAX_BACK_METERS,
                    groundAltitude: groundAltitude
                });
                if (targetCamera) {
                    var topDownCamera = {
                        center: targetCamera.focusCenter || { lat: lat, lng: lng, altitude: groundAltitude },
                        range: targetCamera.baseRange || cameraRange,
                        baseRange: targetCamera.baseRange || cameraRange,
                        zoom: zoom,
                        minAltitude: targetCamera.minAltitude,
                        tilt: 0,
                        heading: currentHeading
                    };
                    animateEarthCameraTo(topDownCamera, EARTH_FOCUS_TOPDOWN_MS);
                    window.setTimeout(function () {
                        if (generation !== earthMapGeneration || !earthMap || !runtimeSettings || !runtimeSettings.earth3d) return;
                        animateEarthCameraTo(targetCamera, EARTH_ENTRY_ANIMATION_MS);
                        markEarthMapReadySoon();
                    }, EARTH_FOCUS_TOPDOWN_MS + 40);
                    return;
                }
            }
            var camera = {
                center: { lat: lat, lng: lng, altitude: groundAltitude },
                range: cameraRange,
                tilt: currentTilt,
                heading: currentHeading
            };
            if (!preserveRange) camera.baseRange = cameraRange;
            if (options && options.offsetForDetails) {
                camera.center = earthDetailOffsetCenter(lat, lng, camera.range, camera.heading);
                camera.center.altitude = groundAltitude;
            }
            applyEarthCamera(camera);
            markEarthMapReadySoon();
        });
    }

    function earthDetailOffsetCenter(lat, lng, range, heading) {
        var meters = Math.max(55, Math.min(130, Number(range) * 0.55));
        var bearing = ((Number(heading) || 0) + 270) * Math.PI / 180;
        var latRad = lat * Math.PI / 180;
        var metersPerLng = 111320 * Math.max(0.2, Math.cos(latRad));
        return {
            lat: lat + (Math.cos(bearing) * meters) / 110540,
            lng: lng + (Math.sin(bearing) * meters) / metersPerLng,
            altitude: 0
        };
    }

	    function handleEarthCameraChange(invalidateAnchoredFocus) {
	        if (!runtimeSettings || !runtimeSettings.earth3d || !earthMap) return;
	        syncEarthTiltBoundsToRange();
	        if (suppressEarthCameraTracking || earthOrbitActive) {
	            updateCameraDataset();
	            return;
	        }
	        userMovedCamera = true;
	        if (invalidateAnchoredFocus) earthUserMovedCamera = true;
	        updateCameraDataset();
	        saveCameraStateSoon();
	    }

        function handleEarthPositionCameraChange() {
            handleEarthCameraChange(true);
        }

        function handleEarthOrientationCameraChange() {
            handleEarthCameraChange(false);
        }

    function handleEarthMapClick(event) {
        if (!event || areaDrawMode) return;
        var pointPosition = earthEventPosition(event.position);
        var cameraBeforeClick = snapshotEarthCamera();
        var earthUserMovedBeforeClick = earthUserMovedCamera;
        suppressEarthCameraTracking = true;
        releaseEarthCameraTrackingSoon(1200);
        function restoreMarkerClickCameraState() {
            earthUserMovedCamera = earthUserMovedBeforeClick;
        }
        // Marker3DInteractiveElement clicks can bubble to the map-level
        // gmp-click handler. In that path Maps may expose our synthetic
        // selected-point id as event.placeId; never send it upstream as a
        // Google Place ID.
        if (event.placeId && isSelectedPointId(event.placeId)) {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (typeof event.stopPropagation === 'function') event.stopPropagation();
            if (activeSelectedPoint) openSelectedPoint(activeSelectedPoint, true);
            else if (pointPosition) selectCoordinatePoint([pointPosition.lng, pointPosition.lat], true, { fromEarthClick: true, preserveEarthCamera: cameraBeforeClick });
            restoreEarthCameraAfterMarkerChange(cameraBeforeClick);
            restoreMarkerClickCameraState();
            window.setTimeout(restoreMarkerClickCameraState, 120);
            return;
        }
        // POI / place clicks take priority — this is what the 2D handler
        // does too. Earlier the position branch always won, so clicking a
        // restaurant in 3D dropped a red dot instead of opening the place
        // card that the 2D map shows.
        if (event.placeId) {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (typeof event.stopPropagation === 'function') event.stopPropagation();
            clearSearchMarker();
            clearSelectedPointMarker();
            postPlaceClicked(event.placeId, pointPosition ? [pointPosition.lng, pointPosition.lat] : undefined, null);
            restoreMarkerClickCameraState();
            window.setTimeout(restoreMarkerClickCameraState, 120);
            return;
        }
        if (pointPosition) {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (typeof event.stopPropagation === 'function') event.stopPropagation();
            restoreEarthCameraAfterMarkerChange(cameraBeforeClick, 1400);
            selectCoordinatePoint([pointPosition.lng, pointPosition.lat], true, { fromEarthClick: true, preserveEarthCamera: cameraBeforeClick });
            restoreEarthCameraAfterMarkerChange(cameraBeforeClick, 1400);
            restoreMarkerClickCameraState();
            window.setTimeout(restoreMarkerClickCameraState, 120);
            return;
        }
        restoreMarkerClickCameraState();
    }

    function earthEventPosition(position) {
        if (!position) return null;
        var rawLat = typeof position.lat === 'function' ? position.lat() : position.lat;
        var rawLng = typeof position.lng === 'function' ? position.lng() : position.lng;
        var lat = Number(rawLat);
        var lng = Number(rawLng);
        if (!isFinite(lat) || !isFinite(lng)) return null;
        return { lat: lat, lng: lng };
    }

    function earthRangeForZoom(zoom, latitude) {
        var z = Number(zoom);
        if (!isFinite(z)) z = 16;
        z = Math.max(3, Math.min(EARTH_MAX_ZOOM_FOR_RANGE, z));
        var lat = Number(latitude);
        if (!isFinite(lat)) {
            var center = map && map.getCenter ? map.getCenter() : null;
            lat = center ? center.lat() : currentArtifact && currentArtifact.viewport ? currentArtifact.viewport.center[1] : 0;
        }
        var framePx = earthViewportReferencePixels();
        var visibleMeters = earthVisibleMetersForZoom(z, lat, framePx) * EARTH_RANGE_ZOOM_FIT;
        var range = visibleMeters / (2 * Math.tan(EARTH_CAMERA_FOV * Math.PI / 360));
        return Math.max(MIN_EARTH_RANGE, Math.min(MAX_EARTH_RANGE, range));
    }

    function earthVisibleMetersForZoom(zoom, latitude, viewportHeight) {
        var z = Number(zoom);
        if (!isFinite(z)) z = 16;
        z = Math.max(3, Math.min(EARTH_MAX_ZOOM_FOR_RANGE, z));
        var lat = Number(latitude);
        if (!isFinite(lat)) lat = 0;
        var height = Number(viewportHeight);
        if (!isFinite(height) || height <= 0) height = earthViewportReferencePixels();
        var metersPerPx = 156543.03392 * Math.max(0.18, Math.cos(lat * Math.PI / 180)) / Math.pow(2, z);
        return metersPerPx * height;
    }

    function zoomForEarthRange(range, latitude) {
        var r = Number(range);
        if (!isFinite(r) || r <= 0) return NaN;
        var lat = Number(latitude);
        if (!isFinite(lat)) lat = earthMap && earthMap.center ? Number(earthMap.center.lat) : 0;
        if (!isFinite(lat)) lat = 0;
        var framePx = earthViewportReferencePixels();
        var numerator = 156543.03392 * Math.max(0.18, Math.cos(lat * Math.PI / 180));
        var denominator = 2 * Math.tan(EARTH_CAMERA_FOV * Math.PI / 360);
        function predictedRange(zoom) {
            var metersPerPx = numerator / Math.pow(2, zoom);
            return Math.max(
                MIN_EARTH_RANGE,
                Math.min(
                    MAX_EARTH_RANGE,
                    (metersPerPx * framePx * EARTH_RANGE_ZOOM_FIT) / denominator
                )
            );
        }
        var low = 3;
        var high = EARTH_MAX_ZOOM_FOR_RANGE;
        for (var i = 0; i < 28; i++) {
            var mid = (low + high) / 2;
            if (predictedRange(mid) > r) low = mid;
            else high = mid;
        }
        return Math.max(3, Math.min(EARTH_MAX_ZOOM_FOR_RANGE, (low + high) / 2));
    }

    function minCameraAltitudeForZoom(zoom) {
        var z = Number(zoom);
        if (!isFinite(z)) return 60;
        if (z >= 22.25) return 10;
        if (z >= 22) return 12;
        if (z >= 21.5) return 14;
        if (z >= 21) return 16;
        if (z >= 20) return 22;
        if (z >= 19) return 34;
        if (z >= 18) return 50;
        return 75;
    }

    function setEarthMapTiltBounds(range, zoom, minAltitude) {
        if (!earthMap) return MAX_EARTH_TILT;
        try { earthMap.minTilt = 0; } catch (_) {}
        try { earthMap.maxTilt = MAX_EARTH_TILT; } catch (_) {}
        var nextMinAltitude = Number(minAltitude);
        if (!isFinite(nextMinAltitude)) {
            var z = Number(zoom);
            if (!isFinite(z)) z = zoomForEarthRange(range);
            nextMinAltitude = minCameraAltitudeForZoom(z);
        }
        try { earthMap.minAltitude = nextMinAltitude; } catch (_) {}
        return MAX_EARTH_TILT;
    }

    function syncEarthTiltBoundsToRange() {
        if (!earthMap) return;
        setEarthMapTiltBounds(earthMap.range);
    }

    function earthBaseRangeFromTiltedCamera(range, tilt) {
        var r = Number(range);
        if (!isFinite(r) || r <= 0) return NaN;
        var t = clampNumber(tilt, 0, MAX_EARTH_TILT, 0) * Math.PI / 180;
        var baseRange = r * Math.max(0.25, Math.cos(t));
        return Math.max(MIN_EARTH_RANGE, Math.min(MAX_EARTH_RANGE, baseRange));
    }

    function earthFocusCenterFromAnchoredCamera(camera, forcedAnchorY) {
        if (!camera || !camera.center) return null;
        var lat = Number(camera.center.lat);
        var lng = Number(camera.center.lng);
        if (!isFinite(lat) || !isFinite(lng)) return null;
        var tilt = clampNumber(camera.tilt, 0, MAX_EARTH_TILT, 0);
        var heading = ((Number(camera.heading) || 0) % 360 + 360) % 360;
        var center = {
            lat: lat,
            lng: lng,
            altitude: Number(camera.center.altitude) || 0
        };
        if (tilt <= 0.01) return center;
        var baseRange = earthBaseRangeFromTiltedCamera(camera.range, tilt);
        if (!isFinite(baseRange)) return center;
        var anchorY = isFinite(Number(forcedAnchorY))
            ? Number(forcedAnchorY)
            : EARTH_SCREEN_ANCHOR_Y;
        anchorY = clampNumber(anchorY, 0.5, 0.95, EARTH_SCREEN_ANCHOR_Y);
        var fov = clampNumber(EARTH_CAMERA_FOV, 5, 80, 45);
        var alphaDeg = (0.5 - anchorY) * fov;
        var theta = tilt * Math.PI / 180;
        var alpha = alphaDeg * Math.PI / 180;
        var dCenter = baseRange * Math.tan(theta);
        var targetAngle = clampNumber(theta + alpha, 0, 85 * Math.PI / 180, 0);
        var dTarget = baseRange * Math.tan(targetAngle);
        var centerShift = dCenter - dTarget;
        return moveLatLng(center, heading, -centerShift);
    }

    function earthExitCameraFor2D() {
        if (!earthMap || !earthMap.center) return null;
        var tilt = typeof earthMap.tilt === 'number' && isFinite(earthMap.tilt)
            ? earthMap.tilt
            : 0;
        var heading = typeof earthMap.heading === 'number' && isFinite(earthMap.heading)
            ? ((earthMap.heading % 360) + 360) % 360
            : 0;
        var range = Number(earthMap.range);
        if (!isFinite(range) || range <= 0) return null;
        var anchorYForExit = earthUserMovedCamera ? 0.5 : EARTH_SCREEN_ANCHOR_Y;
        var focus = earthFocusCenterFromAnchoredCamera({
            center: earthMap.center,
            range: range,
            tilt: tilt,
            heading: heading
        }, anchorYForExit);
        if (!focus) return null;
        var baseRange = earthBaseRangeFromTiltedCamera(range, tilt);
        if (!isFinite(baseRange)) baseRange = range;
        var zoom = zoomForEarthRange(baseRange, focus.lat);
        return {
            center: {
                lat: focus.lat,
                lng: focus.lng,
                altitude: Number(focus.altitude) || 0
            },
            range: baseRange,
            baseRange: baseRange,
            zoom: zoom,
            minAltitude: minCameraAltitudeForZoom(zoom),
            tilt: 0,
            heading: heading
        };
    }

    function syncMapForEarthExit(exitCamera) {
        if (!map) return;
        var camera = exitCamera || earthExitCameraFor2D();
        if (!camera || !camera.center) {
            syncMapToEarthCamera();
            return;
        }
        var lat = Number(camera.center.lat);
        var lng = Number(camera.center.lng);
        if (!isFinite(lat) || !isFinite(lng)) return;
        var zoom = Number(camera.zoom);
        if (!isFinite(zoom)) {
            zoom = zoomForEarthRange(camera.baseRange || camera.range, lat);
        }
        var heading = Number(camera.heading);
        if (!isFinite(heading)) heading = 0;
        var center = { lat: lat, lng: lng };
        withProgrammaticCamera(function () {
            if (typeof map.moveCamera === 'function') {
                var cameraOptions = {
                    center: center,
                    tilt: 0,
                    heading: heading
                };
                if (isFinite(zoom)) cameraOptions.zoom = zoom;
                map.moveCamera(cameraOptions);
                return;
            }
            if (typeof map.setTilt === 'function') map.setTilt(0);
            if (typeof map.setHeading === 'function') map.setHeading(heading);
            map.setCenter(center);
            if (isFinite(zoom)) map.setZoom(zoom);
        });
        updateCameraDataset();
    }

    function earthViewportReferencePixels() {
        // FOV in the formula is the vertical FOV, so the camera range that
        // matches the 2D viewport is determined by viewport HEIGHT in pixels.
        // Using max(width,height) here drifts the zoom whenever the map isn't
        // square (almost always), which is what made 2D→3D feel "off".
        var height = earthMapEl ? earthMapEl.clientHeight : 0;
        if (!isFinite(height) || height <= 0) {
            var width = earthMapEl ? earthMapEl.clientWidth : 0;
            height = width || 640;
        }
        return Math.max(360, Math.min(1600, height));
    }

    function syncMapToEarthCamera() {
        if (!map || !earthMap || !earthMap.center) return;
        var lat = Number(earthMap.center.lat);
        var lng = Number(earthMap.center.lng);
        if (!isFinite(lat) || !isFinite(lng)) return;
        var zoom = zoomForEarthRange(earthMap.range, lat);
        withProgrammaticCamera(function () {
            map.setCenter({ lat: lat, lng: lng });
            if (isFinite(zoom)) map.setZoom(zoom);
        });
        updateCameraDataset();
    }
`
