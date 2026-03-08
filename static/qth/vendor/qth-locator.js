/*
 * Based on qth-locator by jleh
 * Source: https://github.com/jleh/qth-locator
 * License: MIT (see LICENSE-qth-locator.txt)
 */
(function () {
  'use strict';

  function clampPrecision(precision) {
    var safe = Number(precision) || 6;
    if (safe < 2) {
      safe = 2;
    }
    if (safe > 10) {
      safe = 10;
    }
    if (safe % 2 !== 0) {
      safe -= 1;
    }
    return safe;
  }

  function fromLatLon(lat, lon, precision) {
    var safePrecision = clampPrecision(precision);
    var lonWork = lon + 180;
    var latWork = lat + 90;
    var locator = '';

    for (var i = 0; i < safePrecision / 2; i += 1) {
      if (i === 0) {
        var fieldLon = Math.floor(lonWork / 20);
        var fieldLat = Math.floor(latWork / 10);
        locator += String.fromCharCode(65 + fieldLon) + String.fromCharCode(65 + fieldLat);
        lonWork -= fieldLon * 20;
        latWork -= fieldLat * 10;
      } else if (i === 1) {
        var squareLon = Math.floor(lonWork / 2);
        var squareLat = Math.floor(latWork / 1);
        locator += String(squareLon) + String(squareLat);
        lonWork -= squareLon * 2;
        latWork -= squareLat;
      } else if (i === 2) {
        var subLon = Math.floor(lonWork / (2 / 24));
        var subLat = Math.floor(latWork / (1 / 24));
        locator += String.fromCharCode(97 + subLon) + String.fromCharCode(97 + subLat);
        lonWork -= subLon * (2 / 24);
        latWork -= subLat * (1 / 24);
      } else if (i === 3) {
        var extLon = Math.floor(lonWork / (2 / 24 / 10));
        var extLat = Math.floor(latWork / (1 / 24 / 10));
        locator += String(extLon) + String(extLat);
        lonWork -= extLon * (2 / 24 / 10);
        latWork -= extLat * (1 / 24 / 10);
      } else if (i === 4) {
        var ultraLon = Math.floor(lonWork / (2 / 24 / 10 / 24));
        var ultraLat = Math.floor(latWork / (1 / 24 / 10 / 24));
        locator += String.fromCharCode(97 + ultraLon) + String.fromCharCode(97 + ultraLat);
      }
    }

    return locator;
  }

  window.QTHLocator = {
    fromLatLon: fromLatLon,
    clampPrecision: clampPrecision
  };
})();
