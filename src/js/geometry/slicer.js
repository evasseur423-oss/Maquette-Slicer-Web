/**
 * High-Precision Geometric Slicing Engine for Architectural Physical Models
 * Maquette Slicer Studio (100% Web / Browser Edition)
 */

import { PolygonUtils } from './polygon.js';

export class SlicerEngine {
  static _activeWorker = null;
  static _jobCounter = 0;

  /**
   * Slice a 3D Mesh / Group synchronously on the current thread.
   * @param {Object} object3D - Loaded Three.js mesh or group
   * @param {Object} options
   * @returns {Object} Slicing result
   */
  static sliceModel(object3D, options = {}) {
    const triangles = this.extractTriangles(object3D);
    if (triangles.length === 0) {
      throw new Error("Aucun triangle valide trouvé dans le maillage 3D.");
    }
    return this.sliceTriangles(triangles, options);
  }

  /**
   * Slice a 3D Mesh / Group asynchronously using a Web Worker (with non-blocking chunked fallback).
   * Prevents browser UI thread freezing during heavy mesh slicing.
   *
   * @param {Object} object3D - Loaded Three.js mesh or group
   * @param {Object} options
   * @param {Function} [options.onProgress] - Progress callback (ratio 0..1, message)
   * @returns {Promise<Object>} Slicing result
   */
  static async sliceModelAsync(object3D, options = {}) {
    const { onProgress = null, ...workerSafeOptions } = options;

    if (onProgress) {
      onProgress(0.05, "Extraction des triangles du maillage 3D...");
    }

    const triangles = this.extractTriangles(object3D);
    if (triangles.length === 0) {
      throw new Error("Aucun triangle valide trouvé dans le maillage 3D.");
    }

    // Attempt execution in dedicated Web Worker
    if (typeof Worker !== 'undefined') {
      try {
        return await this._runInWorker(triangles, workerSafeOptions, onProgress);
      } catch (workerErr) {
        if (workerErr && workerErr.superseded) {
          throw workerErr;
        }
        console.warn("Web Worker fallback to async main-thread slicing:", workerErr);
      }
    }

    // Fallback: non-blocking chunked async slicing on main thread
    return await this.sliceTrianglesAsync(triangles, options);
  }

  /**
   * Create a standalone Web Worker from an inline Blob URL so it works
   * both over HTTP/HTTPS and when index.html is opened directly via file://.
   */
  static _createSlicerWorker() {
    const workerSource = [
      `const PolygonUtils = ${PolygonUtils.toString()};`,
      `const SlicerEngine = ${SlicerEngine.toString()};`,
      `self.onmessage = function(event) {
        const data = event.data || {};
        const jobId = data.jobId;
        const triangles = data.triangles;
        const options = data.options || {};
        if (!triangles || !Array.isArray(triangles)) {
          self.postMessage({
            type: 'error',
            jobId: jobId,
            error: 'Données géométriques (triangles) manquantes pour le Web Worker.'
          });
          return;
        }
        try {
          const result = SlicerEngine.sliceTriangles(triangles, Object.assign({}, options, {
            onProgress: function(ratio, currentLayer, totalLayers) {
              self.postMessage({
                type: 'progress',
                jobId: jobId,
                progress: ratio,
                currentLayer: currentLayer,
                totalLayers: totalLayers,
                message: 'Tranchage géométrique : strate ' + currentLayer + '/' + totalLayers + '...'
              });
            }
          }));
          self.postMessage({
            type: 'result',
            jobId: jobId,
            result: result
          });
        } catch (err) {
          self.postMessage({
            type: 'error',
            jobId: jobId,
            error: (err && err.message) ? err.message : 'Erreur lors du calcul géométrique dans le Web Worker.'
          });
        }
      };`
    ].join('\n\n');

    const blob = new Blob([workerSource], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    const worker = new Worker(blobUrl);
    return { worker, blobUrl };
  }

  /**
   * Execute geometric slicing inside a dedicated Web Worker.
   */
  static _runInWorker(triangles, options, onProgress) {
    // Terminate previous running worker if a newer slicing request supersedes it
    if (this._activeWorker) {
      this._activeWorker.terminate();
      if (this._activeBlobUrl) {
        URL.revokeObjectURL(this._activeBlobUrl);
        this._activeBlobUrl = null;
      }
      if (this._activeReject) {
        const supersedeErr = new Error("Calcul remplacé par une nouvelle requête.");
        supersedeErr.superseded = true;
        this._activeReject(supersedeErr);
      }
      this._activeWorker = null;
      this._activeReject = null;
    }

    const jobId = ++this._jobCounter;

    return new Promise((resolve, reject) => {
      let worker;
      let blobUrl;
      try {
        const created = this._createSlicerWorker();
        worker = created.worker;
        blobUrl = created.blobUrl;
      } catch (err) {
        reject(err);
        return;
      }

      this._activeWorker = worker;
      this._activeBlobUrl = blobUrl;
      this._activeReject = reject;

      const cleanup = () => {
        if (this._activeWorker === worker) {
          this._activeWorker = null;
          this._activeBlobUrl = null;
          this._activeReject = null;
        }
        worker.terminate();
        if (blobUrl) {
          URL.revokeObjectURL(blobUrl);
        }
      };

      worker.onmessage = (event) => {
        const data = event.data || {};
        if (data.jobId !== jobId) return;

        if (data.type === 'progress') {
          if (onProgress) {
            onProgress(data.progress, data.message);
          }
        } else if (data.type === 'result') {
          cleanup();
          resolve(data.result);
        } else if (data.type === 'error') {
          cleanup();
          reject(new Error(data.error || "Erreur dans le Web Worker de tranchage."));
        }
      };

      worker.onerror = (err) => {
        cleanup();
        reject(new Error(err?.message || "Impossible d'exécuter le Web Worker de tranchage."));
      };

      worker.postMessage({
        jobId,
        triangles,
        options
      });
    });
  }

  /**
   * Slice pre-extracted 3D triangles synchronously (pure geometry, Worker-compatible).
   * @param {Array<Array<[number, number, number]>>} triangles
   * @param {Object} options
   * @returns {Object} Slicing result
   */
  static sliceTriangles(triangles, options = {}) {
    const {
      sourceUnit = 'm',
      scale = 200,
      materialThickness = 1.5,
      stepMode = 'material', // 'material' | 'contour'
      contourStepM = 1.0,
      baseMode = 'none', // 'none' (Relief pur), 'single' (1 plaque), 'pedestal' (complet)
      onProgress = null
    } = options;

    if (!triangles || triangles.length === 0) {
      throw new Error("Aucun triangle valide trouvé dans le maillage 3D.");
    }

    // 1. Unit conversion factor to millimeters
    let unitToMm = 1000; // default meters -> mm
    if (sourceUnit === 'cm') unitToMm = 10;
    if (sourceUnit === 'mm') unitToMm = 1;

    // 2. Compute original mesh bounds in raw units
    const rawBounds = this.computeTrianglesBounds(triangles);
    const rawWidth = rawBounds.maxX - rawBounds.minX;
    const rawHeight = rawBounds.maxY - rawBounds.minY;
    const rawDepth = rawBounds.maxZ - rawBounds.minZ;

    // Real world source dimensions (in source units, e.g. meters)
    const sourceDimensions = {
      x: rawWidth,
      y: rawHeight,
      z: rawDepth
    };

    // Real dimensions in millimeters
    const realMm = {
      x: rawWidth * unitToMm,
      y: rawHeight * unitToMm,
      z: rawDepth * unitToMm
    };

    // Real dimensions in meters
    const realMeters = {
      x: realMm.x / 1000,
      y: realMm.y / 1000,
      z: realMm.z / 1000
    };

    // Real height represented by one layer in meters
    let layerRealHeightM = (materialThickness * scale) / 1000;
    if (stepMode === 'contour' && contourStepM > 0) {
      layerRealHeightM = contourStepM;
    }

    // Target physical model dimensions in millimeters
    const physicalDimensionsMm = {
      x: realMm.x / scale,
      y: realMm.y / scale,
      z: realMm.z / scale
    };

    // Number of strata (layers)
    let totalLayers = Math.max(1, Math.round(realMeters.y / layerRealHeightM));
    // Hard cap for performance safety
    if (totalLayers > 150) totalLayers = 150;

    // Update physical height to match strata stack
    const physicalTotalHeightMm = totalLayers * materialThickness;
    physicalDimensionsMm.y = physicalTotalHeightMm;

    // Target physical model dimensions in centimeters
    const physicalDimensionsCm = {
      x: physicalDimensionsMm.x / 10,
      y: physicalTotalHeightMm / 10,
      z: physicalDimensionsMm.z / 10
    };

    // 3. Transform triangles to Physical Model Millimeters:
    // Centered horizontally around (0, 0), and resting on the ground plane (minY = 0)
    const scaleFactorToPhys = (1 / scale) * unitToMm;
    const centerX = (rawBounds.minX + rawBounds.maxX) / 2;
    const centerZ = (rawBounds.minZ + rawBounds.maxZ) / 2;
    const minY = rawBounds.minY;

    // In source unit space, each layer represents rawStep
    const rawStep = (layerRealHeightM * 1000) / unitToMm;

    // 4. Slice each stratum
    const layers = [];

    for (let layerIdx = 0; layerIdx < totalLayers; layerIdx++) {
      const layer = this._sliceSingleLayer({
        triangles,
        layerIdx,
        minY,
        rawStep,
        materialThickness,
        layerRealHeightM,
        centerX,
        centerZ,
        scaleFactorToPhys
      });

      layers.push(layer);

      if (onProgress) {
        onProgress((layerIdx + 1) / totalLayers, layerIdx + 1, totalLayers);
      }
    }

    return this._finalizeLayers({
      layers,
      baseMode,
      materialThickness,
      layerRealHeightM,
      sourceDimensions,
      sourceUnit,
      scale,
      stepMode,
      physicalDimensionsMm,
      physicalDimensionsCm,
      triangleCount: triangles.length
    });
  }

  /**
   * Non-blocking async fallback for slicing triangles on main thread without freezing UI.
   */
  static async sliceTrianglesAsync(triangles, options = {}) {
    const {
      sourceUnit = 'm',
      scale = 200,
      materialThickness = 1.5,
      stepMode = 'material',
      contourStepM = 1.0,
      baseMode = 'none',
      onProgress = null
    } = options;

    let unitToMm = 1000;
    if (sourceUnit === 'cm') unitToMm = 10;
    if (sourceUnit === 'mm') unitToMm = 1;

    const rawBounds = this.computeTrianglesBounds(triangles);
    const rawWidth = rawBounds.maxX - rawBounds.minX;
    const rawHeight = rawBounds.maxY - rawBounds.minY;
    const rawDepth = rawBounds.maxZ - rawBounds.minZ;

    const sourceDimensions = { x: rawWidth, y: rawHeight, z: rawDepth };
    const realMm = { x: rawWidth * unitToMm, y: rawHeight * unitToMm, z: rawDepth * unitToMm };
    const realMeters = { x: realMm.x / 1000, y: realMm.y / 1000, z: realMm.z / 1000 };

    let layerRealHeightM = (materialThickness * scale) / 1000;
    if (stepMode === 'contour' && contourStepM > 0) {
      layerRealHeightM = contourStepM;
    }

    const physicalDimensionsMm = {
      x: realMm.x / scale,
      y: realMm.y / scale,
      z: realMm.z / scale
    };

    let totalLayers = Math.max(1, Math.round(realMeters.y / layerRealHeightM));
    if (totalLayers > 150) totalLayers = 150;

    const physicalTotalHeightMm = totalLayers * materialThickness;
    physicalDimensionsMm.y = physicalTotalHeightMm;

    const physicalDimensionsCm = {
      x: physicalDimensionsMm.x / 10,
      y: physicalTotalHeightMm / 10,
      z: physicalDimensionsMm.z / 10
    };

    const scaleFactorToPhys = (1 / scale) * unitToMm;
    const centerX = (rawBounds.minX + rawBounds.maxX) / 2;
    const centerZ = (rawBounds.minZ + rawBounds.maxZ) / 2;
    const minY = rawBounds.minY;
    const rawStep = (layerRealHeightM * 1000) / unitToMm;

    const layers = [];
    const batchSize = 5;

    for (let layerIdx = 0; layerIdx < totalLayers; layerIdx++) {
      const layer = this._sliceSingleLayer({
        triangles,
        layerIdx,
        minY,
        rawStep,
        materialThickness,
        layerRealHeightM,
        centerX,
        centerZ,
        scaleFactorToPhys
      });

      layers.push(layer);

      if (onProgress) {
        onProgress(
          (layerIdx + 1) / totalLayers,
          `Tranchage géométrique : strate ${layerIdx + 1}/${totalLayers}...`
        );
      }

      if ((layerIdx + 1) % batchSize === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    return this._finalizeLayers({
      layers,
      baseMode,
      materialThickness,
      layerRealHeightM,
      sourceDimensions,
      sourceUnit,
      scale,
      stepMode,
      physicalDimensionsMm,
      physicalDimensionsCm,
      triangleCount: triangles.length
    });
  }

  /**
   * Compute a single horizontal stratum intersection and polygon grouping.
   */
  static _sliceSingleLayer({
    triangles,
    layerIdx,
    minY,
    rawStep,
    materialThickness,
    layerRealHeightM,
    centerX,
    centerZ,
    scaleFactorToPhys
  }) {
    const rawCutY = minY + (layerIdx + 0.5) * rawStep;
    const elevationBaseMm = layerIdx * materialThickness;
    const realElevationM = layerIdx * layerRealHeightM;

    const rawSegments = this.intersectTrianglesWithPlane(triangles, rawCutY);

    const physSegments = [];
    for (const seg of rawSegments) {
      physSegments.push([
        [
          (seg[0][0] - centerX) * scaleFactorToPhys,
          (seg[0][1] - centerZ) * scaleFactorToPhys
        ],
        [
          (seg[1][0] - centerX) * scaleFactorToPhys,
          (seg[1][1] - centerZ) * scaleFactorToPhys
        ]
      ]);
    }

    const rings = this.chainSegments(physSegments, 0.08);
    const rawPolygons = PolygonUtils.groupIslandsAndHoles(rings);

    const polygons = rawPolygons.map(poly => ({
      outer: PolygonUtils.simplify(poly.outer, 0.04),
      holes: poly.holes.map(h => PolygonUtils.simplify(h, 0.04)),
      area: poly.area,
      bounds: poly.bounds,
      centroid: poly.centroid
    }));

    return {
      index: layerIdx,
      number: layerIdx + 1,
      elevationMm: elevationBaseMm,
      elevationTopMm: (layerIdx + 1) * materialThickness,
      yCut: elevationBaseMm + materialThickness / 2,
      realElevationM: realElevationM,
      polygons: polygons,
      guidePolygons: []
    };
  }

  /**
   * Apply base trimming ('none' | 'single' | 'pedestal') and build N+1 alignment guides.
   */
  static _finalizeLayers({
    layers,
    baseMode,
    materialThickness,
    layerRealHeightM,
    sourceDimensions,
    sourceUnit,
    scale,
    stepMode,
    physicalDimensionsMm,
    physicalDimensionsCm,
    triangleCount
  }) {
    let finalLayers = layers;
    if (baseMode !== 'pedestal' && layers.length > 1) {
      const bboxArea = physicalDimensionsMm.x * physicalDimensionsMm.z;
      let identicalBaseCount = 0;
      for (let i = 0; i < layers.length - 1; i++) {
        const l = layers[i];
        if (l.polygons.length === 1 && l.polygons[0].holes.length === 0) {
          const poly = l.polygons[0];
          if (poly.outer.length <= 6 && poly.area >= bboxArea * 0.95) {
            identicalBaseCount++;
            continue;
          }
        }
        break;
      }

      if (identicalBaseCount > 0) {
        if (baseMode === 'none') {
          if (identicalBaseCount < finalLayers.length) {
            finalLayers = finalLayers.slice(identicalBaseCount);
          }
        } else if (baseMode === 'single') {
          if (identicalBaseCount > 1) {
            finalLayers = finalLayers.slice(identicalBaseCount - 1);
          }
        }
      }
    }

    for (let i = 0; i < finalLayers.length; i++) {
      finalLayers[i].index = i;
      finalLayers[i].number = i + 1;
      finalLayers[i].elevationMm = i * materialThickness;
      finalLayers[i].elevationTopMm = (i + 1) * materialThickness;
      finalLayers[i].yCut = finalLayers[i].elevationMm + materialThickness / 2;
    }

    const finalPhysicalHeightMm = finalLayers.length * materialThickness;
    physicalDimensionsMm.y = finalPhysicalHeightMm;
    physicalDimensionsCm.y = finalPhysicalHeightMm / 10;

    for (let i = 0; i < finalLayers.length - 1; i++) {
      const nextLayer = finalLayers[i + 1];
      finalLayers[i].guidePolygons = nextLayer.polygons.map(p => ({
        outer: [...p.outer],
        holes: p.holes.map(h => [...h])
      }));
    }

    return {
      success: true,
      summary: {
        totalLayers: finalLayers.length,
        sourceDimensions,
        sourceUnit,
        scale,
        scaleRatio: `1:${scale}`,
        materialThicknessMm: materialThickness,
        stepMode,
        contourStepM: layerRealHeightM,
        baseMode,
        physicalDimensionsMm,
        physicalDimensionsCm,
        layerRealHeightM,
        triangleCount
      },
      layers: finalLayers,
      physicalBoundsMm: {
        width: physicalDimensionsMm.x,
        height: physicalDimensionsMm.y,
        depth: physicalDimensionsMm.z
      }
    };
  }

  /**
   * Extract all triangles in world coordinates from a Three.js Mesh or Group.
   * Uses direct matrix4 element math so SlicerEngine has zero runtime dependency on Three.js inside Web Workers.
   */
  static extractTriangles(object3D) {
    const triangles = [];
    if (!object3D) return triangles;

    if (typeof object3D.updateMatrixWorld === 'function') {
      object3D.updateMatrixWorld(true);
    }

    const transformVertex = (posAttr, idx, e) => {
      const x = posAttr.getX(idx);
      const y = posAttr.getY(idx);
      const z = posAttr.getZ(idx);
      const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15] || 1);
      return [
        (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
        (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
        (e[2] * x + e[6] * y + e[10] * z + e[14]) * w
      ];
    };

    object3D.traverse((child) => {
      if (child.isMesh && child.geometry) {
        const geom = child.geometry;
        const positionAttr = geom.attributes.position;
        if (!positionAttr) return;

        const indexAttr = geom.index;
        const e = child.matrixWorld ? child.matrixWorld.elements : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

        if (indexAttr) {
          const count = indexAttr.count;
          for (let i = 0; i < count; i += 3) {
            const iA = indexAttr.getX(i);
            const iB = indexAttr.getX(i + 1);
            const iC = indexAttr.getX(i + 2);

            triangles.push([
              transformVertex(positionAttr, iA, e),
              transformVertex(positionAttr, iB, e),
              transformVertex(positionAttr, iC, e)
            ]);
          }
        } else {
          const count = positionAttr.count;
          for (let i = 0; i < count; i += 3) {
            triangles.push([
              transformVertex(positionAttr, i, e),
              transformVertex(positionAttr, i + 1, e),
              transformVertex(positionAttr, i + 2, e)
            ]);
          }
        }
      }
    });

    return triangles;
  }

  /**
   * Compute 3D bounding box for an array of triangles.
   */
  static computeTrianglesBounds(triangles) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < triangles.length; i++) {
      const tri = triangles[i];
      for (let j = 0; j < 3; j++) {
        const [x, y, z] = tri[j];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }

    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  /**
   * Intersect an array of 3D triangles with horizontal plane Y = yCut.
   * Produces directed 2D segments [ [x1, z1], [x2, z2] ].
   */
  static intersectTrianglesWithPlane(triangles, yCut) {
    const segments = [];

    for (let i = 0; i < triangles.length; i++) {
      const [v0, v1, v2] = triangles[i];

      // Quick bounding check
      const y0 = v0[1], y1 = v1[1], y2 = v2[1];
      const minY = Math.min(y0, y1, y2);
      const maxY = Math.max(y0, y1, y2);

      if (yCut < minY || yCut > maxY) {
        continue;
      }

      // Check intersections on 3 edges
      const edgeHits = [];

      function checkEdge(A, B) {
        const Ay = A[1], By = B[1];
        if ((Ay <= yCut && By > yCut) || (By <= yCut && Ay > yCut)) {
          const t = (yCut - Ay) / (By - Ay);
          const px = A[0] + t * (B[0] - A[0]);
          const pz = A[2] + t * (B[2] - A[2]);
          edgeHits.push([px, pz]);
        }
      }

      checkEdge(v0, v1);
      checkEdge(v1, v2);
      checkEdge(v2, v0);

      if (edgeHits.length >= 2) {
        const p1 = edgeHits[0];
        const p2 = edgeHits[1];

        const dx = p2[0] - p1[0];
        const dz = p2[1] - p1[1];
        if (dx * dx + dz * dz > 1e-8) {
          const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
          const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
          const nx = e1y * e2z - e1z * e2y;
          const nz = e1x * e2y - e1y * e2x;

          const dirX = -nz;
          const dirZ = nx;

          const dot = dx * dirX + dz * dirZ;
          if (dot >= 0) {
            segments.push([p1, p2]);
          } else {
            segments.push([p2, p1]);
          }
        }
      }
    }

    return segments;
  }

  /**
   * Chain segments into closed polygon rings using bidirectional spatial hashing.
   * Handles non-manifold, flipped triangles, and open contours robustly.
   * @param {Array<[[number, number], [number, number]]>} segments
   * @param {number} tolerance
   * @returns {Array<Array<[number, number]>>}
   */
  static chainSegments(segments, tolerance = 0.08) {
    if (!segments || segments.length === 0) return [];

    const tolSq = tolerance * tolerance;
    const cellSize = tolerance * 4;

    function getCellKey(x, z) {
      return `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`;
    }

    const hash = new Map();
    const used = new Array(segments.length).fill(false);

    for (let i = 0; i < segments.length; i++) {
      const [p0, p1] = segments[i];
      const k0 = getCellKey(p0[0], p0[1]);
      const k1 = getCellKey(p1[0], p1[1]);

      if (!hash.has(k0)) hash.set(k0, []);
      hash.get(k0).push({ segIdx: i, end: 0 });

      if (!hash.has(k1)) hash.set(k1, []);
      hash.get(k1).push({ segIdx: i, end: 1 });
    }

    function findNextSegment(currentEnd) {
      const cx = currentEnd[0];
      const cz = currentEnd[1];
      const baseCellX = Math.floor(cx / cellSize);
      const baseCellZ = Math.floor(cz / cellSize);

      let bestMatch = null;
      let bestDistSq = Infinity;

      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = `${baseCellX + dx},${baseCellZ + dz}`;
          const list = hash.get(key);
          if (list) {
            for (let k = 0; k < list.length; k++) {
              const item = list[k];
              if (!used[item.segIdx]) {
                const seg = segments[item.segIdx];
                const pt = item.end === 0 ? seg[0] : seg[1];
                const dX = pt[0] - cx;
                const dZ = pt[1] - cz;
                const distSq = dX * dX + dZ * dZ;

                if (distSq < tolSq * 9 && distSq < bestDistSq) {
                  bestDistSq = distSq;
                  bestMatch = item;
                }
              }
            }
          }
        }
      }

      return bestMatch;
    }

    const rings = [];

    for (let i = 0; i < segments.length; i++) {
      if (used[i]) continue;

      used[i] = true;
      const ring = [segments[i][0], segments[i][1]];
      let currentEnd = segments[i][1];
      const ringStart = segments[i][0];

      let maxIterations = segments.length;
      while (maxIterations-- > 0) {
        const dX = currentEnd[0] - ringStart[0];
        const dZ = currentEnd[1] - ringStart[1];
        if (ring.length >= 3 && (dX * dX + dZ * dZ) < tolSq * 4) {
          break;
        }

        const match = findNextSegment(currentEnd);
        if (match) {
          used[match.segIdx] = true;
          const nextSeg = segments[match.segIdx];
          const nextPt = match.end === 0 ? nextSeg[1] : nextSeg[0];
          ring.push(nextPt);
          currentEnd = nextPt;
        } else {
          if (ring.length >= 4 && (dX * dX + dZ * dZ) < tolSq * 16) {
            ring.push([ringStart[0], ringStart[1]]);
          }
          break;
        }
      }

      if (ring.length >= 3) {
        rings.push(ring);
      }
    }

    return rings;
  }
}
