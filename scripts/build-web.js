/**
 * Static Web Build & Bundler Script for Maquette Slicer Studio (100% Browser Edition)
 *
 * 1. Populates ./vendor/ with standalone browser libraries (Three.js, Leaflet, JSZip, jsPDF).
 * 2. Compiles ./src/app.bundle.js (an IIFE browser bundle containing Three.js + addons + all src/js modules)
 *    so that index.html works BOTH when served over HTTP/HTTPS AND when opened directly via file:// (double-click)
 *    without CORS module blocking!
 * 3. Outputs the complete standalone static website into ./dist/ (index.html, src/, vendor/, icons).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(ROOT_DIR, 'vendor');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

function copyFileSyncMakeDir(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Fichier source introuvable : ${src}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function syncVendorAssets() {
  console.log('[1/3] Synchronisation des bibliothèques navigateur dans ./vendor/ ...');

  const nm = path.join(ROOT_DIR, 'node_modules');
  if (!fs.existsSync(nm)) {
    if (fs.existsSync(VENDOR_DIR)) {
      console.log('      ./vendor/ déjà présent, conservation des fichiers vendor existants.');
      return;
    }
    throw new Error('Ni node_modules ni vendor trouvés.');
  }

  const threeFiles = [
    'build/three.module.js',
    'examples/jsm/controls/OrbitControls.js',
    'examples/jsm/loaders/STLLoader.js',
    'examples/jsm/loaders/OBJLoader.js',
    'examples/jsm/loaders/GLTFLoader.js',
    'examples/jsm/loaders/FBXLoader.js',
    'examples/jsm/utils/BufferGeometryUtils.js',
    'examples/jsm/libs/fflate.module.js',
    'examples/jsm/curves/NURBSCurve.js',
    'examples/jsm/curves/NURBSUtils.js'
  ];

  for (const rel of threeFiles) {
    copyFileSyncMakeDir(
      path.join(nm, 'three', rel),
      path.join(VENDOR_DIR, 'three', rel)
    );
  }

  copyFileSyncMakeDir(
    path.join(nm, 'leaflet', 'dist', 'leaflet.css'),
    path.join(VENDOR_DIR, 'leaflet', 'leaflet.css')
  );
  copyFileSyncMakeDir(
    path.join(nm, 'leaflet', 'dist', 'leaflet.js'),
    path.join(VENDOR_DIR, 'leaflet', 'leaflet.js')
  );
  copyDirRecursive(
    path.join(nm, 'leaflet', 'dist', 'images'),
    path.join(VENDOR_DIR, 'leaflet', 'images')
  );

  copyFileSyncMakeDir(
    path.join(nm, 'jszip', 'dist', 'jszip.min.js'),
    path.join(VENDOR_DIR, 'jszip', 'jszip.min.js')
  );

  copyFileSyncMakeDir(
    path.join(nm, 'jspdf', 'dist', 'jspdf.umd.min.js'),
    path.join(VENDOR_DIR, 'jspdf', 'jspdf.umd.min.js')
  );
  copyFileSyncMakeDir(
    path.join(nm, 'jspdf', 'dist', 'jspdf.es.min.js'),
    path.join(VENDOR_DIR, 'jspdf', 'jspdf.es.min.js')
  );
}

/**
 * Resolve module specifier to canonical bundle ID
 */
function resolveModuleId(specifier, importerFile) {
  if (specifier === 'three') {
    return 'vendor/three/build/three.module.js';
  }
  if (specifier.startsWith('three/addons/')) {
    return 'vendor/three/examples/jsm/' + specifier.slice('three/addons/'.length);
  }
  const importerDir = path.posix.dirname(importerFile.replace(/\\/g, '/'));
  return path.posix.normalize(path.posix.join(importerDir, specifier));
}

/**
 * Transform an ES module file into a bundled CommonJS-like factory body
 */
function transformEsmModule(code, modId) {
  const exportedBindings = [];

  // 1. Replace: import * as NAME from 'SPEC';
  code = code.replace(
    /^\s*import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
    (_, name, spec) => {
      const targetId = resolveModuleId(spec, modId);
      return `const ${name} = __require(${JSON.stringify(targetId)});`;
    }
  );

  // 2. Replace: import { ... } from 'SPEC'; (single or multi-line)
  code = code.replace(
    /^\s*import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?/gm,
    (_, list, spec) => {
      const targetId = resolveModuleId(spec, modId);
      const items = list
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(item => {
          const parts = item.split(/\s+as\s+/);
          return parts.length === 2
            ? `${parts[0].trim()}: ${parts[1].trim()}`
            : parts[0].trim();
        });
      return `const { ${items.join(', ')} } = __require(${JSON.stringify(targetId)});`;
    }
  );

  // 3. Replace: export class/function/var/let/const NAME
  code = code.replace(
    /^\s*export\s+(class|function|var|let|const)\s+([A-Za-z0-9_$]+)/gm,
    (_, kw, name) => {
      exportedBindings.push({ local: name, exported: name });
      return `${kw} ${name}`;
    }
  );

  // 4. Replace: export { A, B as C, ... };
  code = code.replace(
    /^\s*export\s*\{([\s\S]*?)\}\s*;?/gm,
    (_, list) => {
      list
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(item => {
          const parts = item.split(/\s+as\s+/);
          if (parts.length === 2) {
            exportedBindings.push({ local: parts[0].trim(), exported: parts[1].trim() });
          } else {
            exportedBindings.push({ local: parts[0].trim(), exported: parts[0].trim() });
          }
        });
      return '';
    }
  );

  const assignLines = exportedBindings
    .map(b => `__exports.${b.exported} = ${b.local};`)
    .join('\n');

  return `${code}\n${assignLines}`;
}

function buildBrowserBundle() {
  console.log('[2/3] Compilation du bundle autonome ./src/app.bundle.js (compatible HTTP & file://) ...');

  const modulesList = [
    'vendor/three/build/three.module.js',
    'vendor/three/examples/jsm/controls/OrbitControls.js',
    'vendor/three/examples/jsm/utils/BufferGeometryUtils.js',
    'vendor/three/examples/jsm/libs/fflate.module.js',
    'vendor/three/examples/jsm/curves/NURBSUtils.js',
    'vendor/three/examples/jsm/curves/NURBSCurve.js',
    'vendor/three/examples/jsm/loaders/STLLoader.js',
    'vendor/three/examples/jsm/loaders/OBJLoader.js',
    'vendor/three/examples/jsm/loaders/GLTFLoader.js',
    'vendor/three/examples/jsm/loaders/FBXLoader.js',
    'src/js/geometry/polygon.js',
    'src/js/geometry/slicer.js',
    'src/js/geometry/samples.js',
    'src/js/view3d/materials.js',
    'src/js/view3d/viewport.js',
    'src/js/view2d/sheetPacker.js',
    'src/js/view2d/sheetRenderer.js',
    'src/js/view2d/sheetEditor.js',
    'src/js/export/svgExporter.js',
    'src/js/export/dxfExporter.js',
    'src/js/export/pdfExporter.js',
    'src/js/export/zipExporter.js',
    'src/js/topo/elevationProvider.js',
    'src/js/topo/mapController.js',
    'src/js/app.js'
  ];

  const chunks = [];
  chunks.push(`/**
 * Maquette Slicer Studio - Autonomous Browser Bundle (100% Web)
 * Compatible with static HTTP/HTTPS hosting AND direct local file:// execution.
 */
(function() {
  "use strict";
  const __factories = Object.create(null);
  const __cache = Object.create(null);

  function __define(id, factory) {
    __factories[id] = factory;
  }

  function __require(id) {
    if (__cache[id]) return __cache[id];
    const factory = __factories[id];
    if (!factory) {
      throw new Error("Module introuvable dans le bundle : " + id);
    }
    const exportsObj = Object.create(null);
    __cache[id] = exportsObj;
    factory(exportsObj, __require);
    return exportsObj;
  }
`);

  for (const modId of modulesList) {
    const absPath = path.join(ROOT_DIR, modId);
    const rawCode = fs.readFileSync(absPath, 'utf8');
    const transformed = transformEsmModule(rawCode, modId);

    // Syntax check each transformed module
    new Function('__exports', '__require', transformed);

    chunks.push(`  // ==================== MODULE: ${modId} ====================`);
    chunks.push(`  __define(${JSON.stringify(modId)}, function(__exports, __require) {\n${transformed}\n  });\n`);
  }

  chunks.push(`  // Bootstrap main entry point
  __require("src/js/app.js");
})();
`);

  const bundlePath = path.join(ROOT_DIR, 'src', 'app.bundle.js');
  fs.writeFileSync(bundlePath, chunks.join('\n'), 'utf8');
}

function buildStaticSite() {
  console.log('[3/3] Génération du build web statique autonome dans ./dist/ ...');

  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const rootAssets = ['index.html', 'icon.svg', 'icon.png', 'icon.ico'];
  for (const file of rootAssets) {
    const src = path.join(ROOT_DIR, file);
    if (fs.existsSync(src)) {
      copyFileSyncMakeDir(src, path.join(DIST_DIR, file));
    }
  }

  copyDirRecursive(path.join(ROOT_DIR, 'src'), path.join(DIST_DIR, 'src'));
  copyDirRecursive(VENDOR_DIR, path.join(DIST_DIR, 'vendor'));

  console.log('Build web statique terminé avec succès dans : ' + DIST_DIR);
}

syncVendorAssets();
buildBrowserBundle();
buildStaticSite();
