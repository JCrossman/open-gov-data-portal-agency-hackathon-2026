import test from "node:test";
import assert from "node:assert/strict";
import { prepareGeoJsonMap } from "./mapping.js";

test("prepareGeoJsonMap summarizes polygon GeoJSON and chooses a choropleth field", async () => {
  const geojson = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { province: "Ontario", value: 10 },
        geometry: {
          type: "Polygon",
          coordinates: [[[-80, 43], [-79, 43], [-79, 44], [-80, 44], [-80, 43]]],
        },
      },
      {
        type: "Feature",
        properties: { province: "Quebec", value: 12 },
        geometry: {
          type: "Polygon",
          coordinates: [[[-72, 46], [-71, 46], [-71, 47], [-72, 47], [-72, 46]]],
        },
      },
    ],
  };

  const url = `data:application/geo+json,${encodeURIComponent(JSON.stringify(geojson))}`;
  const result = await prepareGeoJsonMap({ resourceUrl: url });

  assert.equal(result.map.mapType, "choropleth");
  assert.deepEqual(result.map.geometryTypes, ["Polygon"]);
  assert.equal(result.map.labelField, "province");
  assert.equal(result.map.valueField, "value");
  assert.deepEqual(result.map.boundingBox, [-80, 43, -71, 47]);
  assert.equal(result.map.featureCount, 2);
});

test("prepareGeoJsonMap summarizes point GeoJSON as a point map", async () => {
  const geojson = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Station A", reading: 4.2 },
        geometry: {
          type: "Point",
          coordinates: [-75.7, 45.4],
        },
      },
      {
        type: "Feature",
        properties: { name: "Station B", reading: 3.8 },
        geometry: {
          type: "Point",
          coordinates: [-73.6, 45.5],
        },
      },
    ],
  };

  const url = `data:application/geo+json,${encodeURIComponent(JSON.stringify(geojson))}`;
  const result = await prepareGeoJsonMap({ resourceUrl: url, maxFeatures: 1 });

  assert.equal(result.map.mapType, "point");
  assert.equal(result.map.labelField, "name");
  assert.equal(result.map.valueField, "reading");
  assert.equal(result.map.returnedFeatureCount, 1);
  assert.match(result.map.reasoning, /point map/i);
});
