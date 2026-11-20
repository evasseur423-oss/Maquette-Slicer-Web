/**
 * Dedicated Web Worker for High-Precision 3D Geometric Slicing
 * Maquette Slicer Studio (100% Web Standalone Version)
 *
 * Offloads heavy 3D triangle-plane intersections, bidirectional segment chaining,
 * polygon winding/hole classification, and Douglas-Peucker simplification
 * to a background thread so the browser UI remains 60fps responsive.
 */

import { SlicerEngine } from './slicer.js';

self.onmessage = (event) => {
  const { jobId, triangles, options } = event.data || {};
  if (!triangles || !Array.isArray(triangles)) {
    self.postMessage({
      type: 'error',
      jobId,
      error: 'Données géométriques (triangles) manquantes pour le Web Worker.'
    });
    return;
  }

  try {
    const result = SlicerEngine.sliceTriangles(triangles, {
      ...options,
      onProgress: (ratio, currentLayer, totalLayers) => {
        self.postMessage({
          type: 'progress',
          jobId,
          progress: ratio,
          currentLayer,
          totalLayers,
          message: `Tranchage géométrique : strate ${currentLayer}/${totalLayers}...`
        });
      }
    });

    self.postMessage({
      type: 'result',
      jobId,
      result
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      jobId,
      error: err && err.message ? err.message : 'Erreur lors du calcul géométrique dans le Web Worker.'
    });
  }
};
