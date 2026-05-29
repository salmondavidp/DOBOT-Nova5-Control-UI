import * as THREE from "three";
import { OrbitControls } from "/vendor/three/controls/OrbitControls.js";
import { GLTFLoader } from "/vendor/three/loaders/GLTFLoader.js";
import { mergeGeometries } from "/vendor/three/utils/BufferGeometryUtils.js";

const MODEL_URL = "/models/dobot-nova5.gltf";
const MERGE_NODE_NAMES = ["BASE_ASM", "J1_ASM", "J2_ASM", "J3_ASM", "J4_ASM", "J5_ASM", "J6_ASM"];
const JOINT_NODE_NAMES = ["J1_ASM", "J2_ASM", "J3_ASM", "J4_ASM", "J5_ASM", "J6_ASM"];
const JOINT_SIGNS = [1, -1, -1, 1, -1, 1];
const QUALITY_STORAGE_KEY = "dobot.robotCadQuality";
const QUALITY_LEVELS = {
  low: { label: "Low", pixelRatio: 0.55, maxFps: 12 },
  balanced: { label: "Balanced", pixelRatio: 0.8, maxFps: 24 },
  high: { label: "High", pixelRatio: 1.1, maxFps: 45 },
  native: { label: "Native", pixelRatio: () => Math.min(window.devicePixelRatio || 1, 2), maxFps: 60 },
};

let viewer = null;
let latestState = {
  angles: null,
  pose: null,
  modeName: "Unknown",
};

function formatNumber(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "-";
}

function loadRenderQuality() {
  try {
    const saved = window.localStorage?.getItem(QUALITY_STORAGE_KEY);
    return QUALITY_LEVELS[saved] ? saved : "low";
  } catch (error) {
    return "low";
  }
}

function qualityPixelRatio(name) {
  const level = QUALITY_LEVELS[name] || QUALITY_LEVELS.balanced;
  return typeof level.pixelRatio === "function" ? level.pixelRatio() : level.pixelRatio;
}

function qualityMaxFps(name) {
  return (QUALITY_LEVELS[name] || QUALITY_LEVELS.balanced).maxFps;
}

function poseText(pose) {
  return Array.isArray(pose) && pose.length >= 3
    ? `TCP  X ${formatNumber(pose[0], 3)}   Y ${formatNumber(pose[1], 3)}   Z ${formatNumber(pose[2], 3)}`
    : "TCP pose unavailable";
}

function jointText(angles, startIndex, endIndex) {
  const values = Array.isArray(angles) && angles.length >= 6 ? angles : [0, 0, 0, 0, 0, 0];
  const parts = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    parts.push(`J${index + 1} ${formatNumber(values[index], 1)}`);
  }
  return parts.join("   ");
}

function makeAxisLabel(text, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = "700 28px Space Mono, monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "rgba(5, 9, 15, 0.78)";
  context.strokeStyle = color;
  context.lineWidth = 4;
  context.roundRect(20, 10, 88, 44, 10);
  context.fill();
  context.stroke();
  context.fillStyle = color;
  context.fillText(text, 64, 33);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  }));
  sprite.scale.set(170, 85, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function makeAxisLine(points, color) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.92,
    depthTest: false,
  });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 9;
  return line;
}

function axisWorldToLocal(parent, axis) {
  const quaternion = new THREE.Quaternion();
  parent.getWorldQuaternion(quaternion);
  return axis.clone().applyQuaternion(quaternion.invert()).normalize();
}

function safeAxisBetween(a, b, fallback) {
  const axis = b.clone().sub(a);
  return axis.lengthSq() > 1e-6 ? axis.normalize() : fallback.clone().normalize();
}

function disposeMaterial(material, disposedTextures, disposedMaterials) {
  if (!material || disposedMaterials.has(material)) {
    return;
  }

  Object.keys(material).forEach((key) => {
    const value = material[key];
    if (value?.isTexture && !disposedTextures.has(value)) {
      value.dispose();
      disposedTextures.add(value);
    }
  });

  material.dispose();
  disposedMaterials.add(material);
}

class DobotCadLiveView {
  constructor() {
    this.container = document.getElementById("robot-cad-viewer");
    this.canvas = document.getElementById("robot-cad-canvas");
    this.qualitySelect = document.getElementById("cad-quality-select");
    this.status = document.getElementById("robot-cad-status");
    this.poseLabel = document.getElementById("cad-pose-label");
    this.jointLabel = document.getElementById("cad-joint-label");
    this.jointLabel2 = document.getElementById("cad-joint-label-2");
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.model = null;
    this.pivots = [];
    this.baseQuaternions = [];
    this.jointAxes = [];
    this.resizeObserver = null;
    this.frameRequested = false;
    this.pendingRenderTimer = null;
    this.lastRenderAt = 0;
    this.renderQuality = this.qualitySelect ? loadRenderQuality() : "low";
    this.optimizationStats = {
      mergedAssemblies: 0,
      hiddenMeshes: 0,
      disposedMeshes: 0,
      quality: this.renderQuality,
      pixelRatio: qualityPixelRatio(this.renderQuality),
      maxFps: qualityMaxFps(this.renderQuality),
    };
  }

  async init() {
    if (!this.container || !this.canvas) {
      return;
    }

    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 10000);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: true,
      powerPreference: "low-power",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.applyRenderQuality();
    this.bindQualitySelect();
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.enablePan = false;
    this.controls.addEventListener("change", () => this.requestRender());

    this.addLights();
    this.addFloor();
    this.addAxisGuide();
    this.observeSize();

    try {
      await this.loadModel();
      this.setStatus("", "loaded");
      this.update(latestState.angles, latestState.pose, latestState.modeName);
    } catch (error) {
      this.setStatus(`CAD model failed: ${error.message}`, "error");
      throw error;
    }

    this.requestRender();
  }

  addLights() {
    this.scene.add(new THREE.HemisphereLight(0xddeeff, 0x1b2433, 1.8));

    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(520, 800, 640);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x55ddff, 1.2);
    rim.position.set(-620, 340, -520);
    this.scene.add(rim);
  }

  addFloor() {
    const grid = new THREE.GridHelper(1400, 14, 0x1a8fff, 0x31415a);
    grid.material.transparent = true;
    grid.material.opacity = 0.24;
    grid.position.y = -8;
    this.scene.add(grid);

    const baseShadow = new THREE.Mesh(
      new THREE.CircleGeometry(420, 64),
      new THREE.MeshBasicMaterial({
        color: 0x0b1728,
        transparent: true,
        opacity: 0.36,
        depthWrite: false,
      }),
    );
    baseShadow.rotation.x = -Math.PI / 2;
    baseShadow.position.y = -7;
    this.scene.add(baseShadow);
  }

  addAxisGuide() {
    const group = new THREE.Group();
    group.name = "CAD_XY_AXIS_GUIDE";
    group.position.y = -5.5;

    const xColor = 0xff5a6f;
    const yColor = 0x00e5c3;
    group.add(makeAxisLine([
      new THREE.Vector3(-460, 0, 0),
      new THREE.Vector3(460, 0, 0),
    ], xColor));
    group.add(makeAxisLine([
      new THREE.Vector3(0, 0, -460),
      new THREE.Vector3(0, 0, 460),
    ], yColor));

    const xLabel = makeAxisLabel("+X", "#ff5a6f");
    xLabel.position.set(310, 40, 36);
    group.add(xLabel);

    const yLabel = makeAxisLabel("+Y", "#00e5c3");
    yLabel.position.set(36, 40, 310);
    group.add(yLabel);

    this.scene.add(group);
  }

  observeSize() {
    const resize = () => this.resize();
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(this.container);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", () => this.requestRender());
    this.resize();
  }

  resize() {
    if (!this.renderer || !this.camera || !this.container) {
      return;
    }
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(260, Math.floor(rect.height));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.requestRender();
  }

  bindQualitySelect() {
    if (!this.qualitySelect) {
      return;
    }
    this.qualitySelect.value = this.renderQuality;
    this.qualitySelect.addEventListener("change", () => {
      this.renderQuality = QUALITY_LEVELS[this.qualitySelect.value] ? this.qualitySelect.value : "balanced";
      try {
        window.localStorage?.setItem(QUALITY_STORAGE_KEY, this.renderQuality);
      } catch (error) {
        // Storage can be unavailable in private or embedded browser contexts.
      }
      this.applyRenderQuality();
    });
  }

  applyRenderQuality() {
    if (!this.renderer) {
      return;
    }
    const pixelRatio = qualityPixelRatio(this.renderQuality);
    this.renderer.setPixelRatio(pixelRatio);
    this.optimizationStats.quality = this.renderQuality;
    this.optimizationStats.pixelRatio = pixelRatio;
    this.optimizationStats.maxFps = qualityMaxFps(this.renderQuality);
    this.resize();
    this.requestRender();
  }

  async loadModel() {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(MODEL_URL);
    this.model = gltf.scene;
    this.model.name = "DOBOT_NOVA5_CAD";
    this.scene.add(this.model);
    this.model.updateMatrixWorld(true);

    this.model.traverse((node) => {
      if (!node.isMesh) {
        return;
      }
      node.castShadow = false;
      node.receiveShadow = true;
      if (node.material) {
        node.material.side = THREE.DoubleSide;
        node.material.roughness = 0.72;
        node.material.metalness = 0.08;
      }
    });

    this.optimizeAssemblies();
    this.setupJoints();
    this.fitCamera();
  }

  optimizeAssemblies() {
    const disposedMaterials = new Set();
    const disposedTextures = new Set();

    MERGE_NODE_NAMES.forEach((name) => {
      const root = this.model.getObjectByName(name);
      if (!root) {
        return;
      }

      const meshes = [];
      root.traverse((node) => {
        if (node.isMesh && node.geometry && node.geometry.getAttribute("position")) {
          meshes.push(node);
        }
      });

      if (meshes.length < 2) {
        return;
      }

      root.updateWorldMatrix(true, true);
      const rootInverse = root.matrixWorld.clone().invert();
      const geometries = meshes.map((mesh) => {
        const geometry = mesh.geometry.clone();
        Object.keys(geometry.attributes).forEach((attributeName) => {
          if (!["position", "normal"].includes(attributeName)) {
            geometry.deleteAttribute(attributeName);
          }
        });
        if (!geometry.getAttribute("normal")) {
          geometry.computeVertexNormals();
        }
        const transform = rootInverse.clone().multiply(mesh.matrixWorld);
        geometry.applyMatrix4(transform);
        return geometry;
      });

      const merged = mergeGeometries(geometries, false);
      geometries.forEach((geometry) => geometry.dispose());
      if (!merged) {
        return;
      }

      const material = new THREE.MeshStandardMaterial({
        color: 0xf3f6fa,
        roughness: 0.72,
        metalness: 0.08,
        side: THREE.DoubleSide,
      });
      const mergedMesh = new THREE.Mesh(merged, material);
      mergedMesh.name = `${name}_MERGED`;
      root.add(mergedMesh);
      meshes.forEach((mesh) => {
        if (mesh.parent) {
          mesh.parent.remove(mesh);
        }
        if (mesh.geometry) {
          mesh.geometry.dispose();
        }
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.forEach((meshMaterial) => disposeMaterial(meshMaterial, disposedTextures, disposedMaterials));
      });
      this.optimizationStats.mergedAssemblies += 1;
      this.optimizationStats.hiddenMeshes += meshes.length;
      this.optimizationStats.disposedMeshes += meshes.length;
    });
  }

  setupJoints() {
    const nodes = JOINT_NODE_NAMES.map((name) => this.model.getObjectByName(name));
    const missing = JOINT_NODE_NAMES.filter((_, index) => !nodes[index]);
    if (missing.length) {
      throw new Error(`missing ${missing.join(", ")}`);
    }

    this.model.updateMatrixWorld(true);
    const worldPositions = nodes.map((node) => {
      const position = new THREE.Vector3();
      node.getWorldPosition(position);
      return position;
    });

    this.pivots = nodes.map((node, index) => {
      const pivot = new THREE.Group();
      pivot.name = `LIVE_${JOINT_NODE_NAMES[index]}_PIVOT`;
      pivot.position.copy(worldPositions[index]);
      this.scene.add(pivot);
      pivot.updateMatrixWorld(true);
      pivot.attach(node);
      return pivot;
    });

    for (let index = 0; index < this.pivots.length - 1; index += 1) {
      this.pivots[index].attach(this.pivots[index + 1]);
    }

    this.scene.updateMatrixWorld(true);
    const xAxis = new THREE.Vector3(1, 0, 0);
    const yAxis = new THREE.Vector3(0, 1, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);
    const j4Axis = safeAxisBetween(worldPositions[2], worldPositions[3], yAxis);
    const j6Axis = safeAxisBetween(worldPositions[4], worldPositions[5], zAxis);

    const axesWorld = [yAxis, zAxis, zAxis, zAxis, yAxis, zAxis];
    this.jointAxes = this.pivots.map((pivot, index) => axisWorldToLocal(pivot.parent || this.scene, axesWorld[index]));
    this.baseQuaternions = this.pivots.map((pivot) => pivot.quaternion.clone());
  }

  fitCamera() {
    const box = new THREE.Box3().setFromObject(this.model);
    this.pivots.forEach((pivot) => box.expandByObject(pivot));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const distance = maxDim * 1.42;

    this.camera.position.set(center.x + distance * 0.78, center.y + distance * 0.48, center.z + distance * 0.82);
    this.camera.near = Math.max(0.1, maxDim / 1000);
    this.camera.far = maxDim * 8;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.requestRender();
  }

  setStatus(message, state = "") {
    if (!this.status) {
      return;
    }
    this.status.textContent = message;
    this.status.hidden = message.trim() === "";
    this.status.classList.toggle("loaded", state === "loaded");
    this.status.classList.toggle("error", state === "error");
  }

  applyState(angles, pose, modeName = "Unknown", options = {}) {
    if (this.poseLabel) {
      this.poseLabel.textContent = options.poseLabel || poseText(pose);
    }
    if (this.jointLabel) {
      this.jointLabel.textContent = `Mode ${modeName || "Unknown"}   ${jointText(angles, 0, 2)}`;
    }
    if (this.jointLabel2) {
      this.jointLabel2.textContent = jointText(angles, 3, 5);
    }

    if (!this.pivots.length) {
      return;
    }

    const values = Array.isArray(angles) && angles.length >= 6 ? angles : [0, 0, 0, 0, 0, 0];
    this.pivots.forEach((pivot, index) => {
      const value = Number(values[index]);
      const radians = THREE.MathUtils.degToRad((Number.isFinite(value) ? value : 0) * JOINT_SIGNS[index]);
      const delta = new THREE.Quaternion().setFromAxisAngle(this.jointAxes[index], radians);
      pivot.quaternion.copy(this.baseQuaternions[index]).multiply(delta);
    });

    this.requestRender();
  }

  update(angles, pose, modeName = "Unknown") {
    latestState = { angles, pose, modeName };
    this.applyState(angles, pose, modeName);
  }

  isVisible() {
    if (!this.container) {
      return false;
    }
    const rect = this.container.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && document.visibilityState !== "hidden";
  }

  requestRender() {
    if (this.frameRequested) {
      return;
    }
    const maxFps = qualityMaxFps(this.renderQuality);
    const minInterval = 1000 / maxFps;
    const elapsed = performance.now() - this.lastRenderAt;
    if (elapsed < minInterval) {
      if (!this.pendingRenderTimer) {
        this.pendingRenderTimer = window.setTimeout(() => {
          this.pendingRenderTimer = null;
          this.queueRenderFrame();
        }, minInterval - elapsed);
      }
      return;
    }
    this.queueRenderFrame();
  }

  queueRenderFrame() {
    if (this.frameRequested) {
      return;
    }
    this.frameRequested = true;
    window.requestAnimationFrame(() => this.renderNow());
  }

  renderNow() {
    this.frameRequested = false;
    if (!this.renderer || !this.scene || !this.camera) {
      return;
    }
    if (!this.isVisible()) {
      return;
    }
    this.renderer.render(this.scene, this.camera);
    this.lastRenderAt = performance.now();
    this.optimizationStats.lastRenderCalls = this.renderer.info.render.calls;
    this.optimizationStats.lastRenderTriangles = this.renderer.info.render.triangles;
    const bufferSize = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.optimizationStats.lastRenderWidth = bufferSize.x;
    this.optimizationStats.lastRenderHeight = bufferSize.y;
  }
}

window.dobotRobotCad = {
  update(angles, pose, modeName) {
    latestState = { angles, pose, modeName };
    if (viewer) {
      viewer.update(angles, pose, modeName);
    }
  },
  requestRender() {
    viewer?.requestRender();
  },
  stats() {
    return viewer?.optimizationStats || null;
  },
};

async function start() {
  viewer = new DobotCadLiveView();
  try {
    await viewer.init();
  } catch (error) {
    console.error(error);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
