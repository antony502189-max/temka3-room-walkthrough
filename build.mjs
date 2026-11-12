#!/usr/bin/env node
/**
 * Build a self-contained room walkthrough.
 *
 * Usage, from the viewer project:
 *   node scripts/build.mjs
 * or:
 *   node /absolute/path/build.mjs --project /absolute/path/viewer
 *
 * Inputs: src/main.js, src/index.html, src/style.css,
 *         assets/room_web.glb, assets/navigation.json.
 * Template slots (exactly once each): <!--ROOM_STYLE-->, <!--ROOM_DATA-->,
 * <!--ROOM_SCRIPT-->.
 *
 * Runtime data elements:
 *   #room-model       application/octet-stream, base64 GLB
 *   #room-navigation  application/json, navigation configuration
 *
 * Outputs:
 *   dist/index.html
 *   artifacts/room-walkthrough.html          (identical bytes)
 *   artifacts/THIRD_PARTY_NOTICES.txt         (also embedded in HTML)
 *   artifacts/build-manifest.json
 *
 * esbuild and three are resolved from the selected project, not this file's
 * temporary location. No network access is used by this build script.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

function parseArguments(argv) {
  let project = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--project') {
      if (!argv[index + 1]) throw new Error('--project needs a directory');
      project = argv[++index];
    } else if (value === '--help' || value === '-h') {
      process.stdout.write('Usage: node build.mjs [--project /absolute/path/viewer]\n');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return path.resolve(project);
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function readRequired(filename) {
  const stat = await fs.stat(filename);
  if (!stat.isFile()) throw new Error(`Expected a file: ${filename}`);
  return fs.readFile(filename);
}

function oneSlot(template, slot, replacement) {
  const count = template.split(slot).length - 1;
  if (count !== 1) throw new Error(`Template must contain ${slot} exactly once; found ${count}`);
  // A function replacement preserves literal $&, $', $` and $$ in bundled JS.
  return template.replace(slot, () => replacement);
}

function isSelfContainedResource(value) {
  return value.startsWith('data:') || value.startsWith('#');
}

function inspectTemplate(template, css) {
  // These attributes cause resource loading. Normal <a href> links do not.
  const resourceTags = /<(script|link|img|iframe|video|audio|source|object|embed)\b[^>]*>/gi;
  const attributes = /\b(?:src|href|poster|data)\s*=\s*(["'])(.*?)\1/gi;
  for (const match of template.matchAll(resourceTags)) {
    const tag = match[0];
    for (const attribute of tag.matchAll(attributes)) {
      if (!isSelfContainedResource(attribute[2])) {
        throw new Error(`Template contains a sidecar/external resource: ${attribute[2]}`);
      }
    }
    if (/\bsrcset\s*=/i.test(tag)) {
      throw new Error('Template srcset is not supported; embed the image directly');
    }
  }
  if (/@import\b/i.test(css)) throw new Error('CSS @import would create an external dependency');
  for (const match of css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    if (!isSelfContainedResource(match[2].trim())) {
      throw new Error(`CSS contains a sidecar/external resource: ${match[2]}`);
    }
  }
}

function inspectGlb(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF') {
    throw new Error('Model is not a GLB');
  }
  if (bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error('Invalid GLB version or byte length');
  }
  const jsonLength = bytes.readUInt32LE(12);
  const jsonType = bytes.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a || 20 + jsonLength > bytes.length) {
    throw new Error('GLB has no valid first JSON chunk');
  }
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  for (const section of ['buffers', 'images']) {
    for (const resource of gltf[section] ?? []) {
      if (resource.uri && !resource.uri.startsWith('data:')) {
        throw new Error(`GLB has an external ${section} URI: ${resource.uri}`);
      }
    }
  }
  const decoderExtensions = [
    'KHR_draco_mesh_compression', 'KHR_texture_basisu',
    'EXT_meshopt_compression', 'KHR_meshopt_compression',
  ];
  const used = new Set([...(gltf.extensionsUsed ?? []), ...(gltf.extensionsRequired ?? [])]);
  for (const extension of decoderExtensions) {
    if (used.has(extension)) {
      throw new Error(`${extension} requires an explicitly bundled decoder; current input is expected to be uncompressed GLB`);
    }
  }
  if (!gltf.meshes?.length) throw new Error('GLB contains no meshes');
  return {
    byteLength: bytes.length,
    sha256: sha256(bytes),
    meshes: gltf.meshes.length,
    nodes: gltf.nodes?.length ?? 0,
    materials: gltf.materials?.length ?? 0,
    images: gltf.images?.length ?? 0,
    externalUris: [],
    decoderExtensions: [],
  };
}

async function findPackageRoot(resolvedFile, expectedName) {
  let directory = path.dirname(resolvedFile);
  for (;;) {
    const packagePath = path.join(directory, 'package.json');
    try {
      const metadata = JSON.parse(await fs.readFile(packagePath, 'utf8'));
      if (!expectedName || metadata.name === expectedName) return { directory, metadata };
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot find package.json for ${expectedName ?? resolvedFile}`);
    directory = parent;
  }
}

async function packageLicense(packageRoot) {
  for (const filename of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING', 'COPYING.txt']) {
    try {
      const text = await fs.readFile(path.join(packageRoot.directory, filename), 'utf8');
      return `${packageRoot.metadata.name} ${packageRoot.metadata.version}\n${'='.repeat(60)}\n${text.trim()}\n`;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Cannot locate the license for bundled dependency ${packageRoot.metadata.name}`);
}

async function collectNotices(projectRoot, metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const absolute = path.isAbsolute(input) ? input : path.resolve(projectRoot, input);
    if (!absolute.split(path.sep).includes('node_modules')) continue;
    const root = await findPackageRoot(absolute);
    packages.set(root.directory, root);
  }
  const ordered = [...packages.values()].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  const licenses = await Promise.all(ordered.map(packageLicense));
  if (!ordered.some((item) => item.metadata.name === 'three')) {
    throw new Error('The build did not include Three.js; check src/main.js imports');
  }
  return {
    text: `THIRD-PARTY NOTICES\n\n${licenses.join('\n')}`,
    packages: ordered.map(({ metadata }) => ({ name: metadata.name, version: metadata.version, license: metadata.license ?? null })),
  };
}

async function atomicWrite(filename, bytes) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.building-${process.pid}`;
  try {
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function main() {
  const projectRoot = parseArguments(process.argv.slice(2));
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  const esbuild = projectRequire('esbuild');
  const input = {
    entry: path.join(projectRoot, 'src/main.js'),
    template: path.join(projectRoot, 'src/index.html'),
    style: path.join(projectRoot, 'src/style.css'),
    model: path.join(projectRoot, 'assets/room_web.glb'),
    navigation: path.join(projectRoot, 'assets/navigation.json'),
  };
  const [entryBytes, templateBytes, cssBytes, glbBytes, navigationBytes] = await Promise.all(
    Object.values(input).map(readRequired),
  );
  const template = templateBytes.toString('utf8');
  const css = cssBytes.toString('utf8');
  inspectTemplate(template, css);
  const model = inspectGlb(glbBytes);
  const navigation = JSON.parse(navigationBytes.toString('utf8'));
  if (!navigation || typeof navigation !== 'object' || Array.isArray(navigation)) {
    throw new Error('Navigation must be a JSON object');
  }
  const result = await esbuild.build({
    absWorkingDir: projectRoot,
    entryPoints: [input.entry],
    outfile: path.join(projectRoot, 'dist/viewer.bundle.js'),
    bundle: true,
    write: false,
    metafile: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    charset: 'utf8',
    legalComments: 'inline',
    sourcemap: false,
    treeShaking: true,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const output = result.outputFiles.filter((file) => file.path.endsWith('.js'));
  if (output.length !== 1 || result.outputFiles.length !== 1) {
    throw new Error('Bundle produced sidecar assets; make all resources inline before delivery');
  }
  const externalImports = Object.values(result.metafile.outputs)
    .flatMap((file) => file.imports ?? []).filter((item) => item.external);
  if (externalImports.length) throw new Error(`Bundle has external imports: ${JSON.stringify(externalImports)}`);
  const notices = await collectNotices(projectRoot, result.metafile);
  const js = output[0].text.replace(/<\/script/gi, '<\\/script');
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  const safeNavigation = JSON.stringify(navigation)
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const data = `<script id="room-model" type="application/octet-stream">${glbBytes.toString('base64')}</script>\n`
    + `<script id="room-navigation" type="application/json">${safeNavigation}</script>`;
  let html = oneSlot(template, '<!--ROOM_STYLE-->', `<style>${safeCss}</style>`);
  html = oneSlot(html, '<!--ROOM_DATA-->', data);
  html = oneSlot(html, '<!--ROOM_SCRIPT-->', `<script>${js}</script>`);
  if (!/<\/html\s*>/i.test(html)) throw new Error('Template needs a closing html tag');
  html = html.replace(/<\/html\s*>/i, () => `<!--\n${notices.text.replace(/-->/g, '-- >')}\n-->\n</html>`);
  if (/<!--ROOM_(?:STYLE|DATA|SCRIPT)-->/i.test(html)) throw new Error('Unresolved build template slot');
  const htmlBytes = Buffer.from(html, 'utf8');
  const htmlHash = sha256(htmlBytes);
  const manifest = {
    schemaVersion: 1,
    builtAtUtc: new Date().toISOString(),
    status: 'built_static_checks_passed_browser_verification_separate',
    generator: { name: 'esbuild', version: esbuild.version },
    packages: notices.packages,
    input: {
      model,
      navigation: { byteLength: navigationBytes.length, sha256: sha256(navigationBytes) },
      sourceEntrySha256: sha256(entryBytes),
    },
    output: {
      htmlBytes: htmlBytes.length,
      htmlSha256: htmlHash,
      identicalHtmlFiles: ['dist/index.html', 'artifacts/room-walkthrough.html', 'docs/index.html'],
      bundleBytes: output[0].contents.length,
      externalImports: [],
      inlineModel: true,
      inlineCss: true,
      inlineJavaScript: true,
      inlineNavigation: true,
      embeddedThirdPartyNotices: true,
    },
    verificationLimits: [
      'Static checks do not prove runtime network behavior or file:// browser compatibility.',
      'Test final HTML in an actual browser with network disabled; test movement and collision separately.',
    ],
  };
  await atomicWrite(path.join(projectRoot, 'dist/index.html'), htmlBytes);
  await atomicWrite(path.join(projectRoot, 'docs/index.html'), htmlBytes);
  await atomicWrite(path.join(projectRoot, 'docs/.nojekyll'), '');
  await atomicWrite(path.join(projectRoot, 'artifacts/room-walkthrough.html'), htmlBytes);
  await atomicWrite(path.join(projectRoot, 'artifacts/THIRD_PARTY_NOTICES.txt'), notices.text);
  await atomicWrite(path.join(projectRoot, 'artifacts/build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(JSON.stringify({
    status: manifest.status,
    outputs: manifest.output.identicalHtmlFiles.map((file) => path.join(projectRoot, file)),
    htmlBytes: htmlBytes.length,
    htmlSha256: htmlHash,
    modelBytes: model.byteLength,
    packages: notices.packages,
  }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write(`Offline build failed: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
