// Line-art renderer: renders part IDs + shading into a target, then extracts
// clean ink outlines in a full-screen pass (like a hand-drawn mannequin sketch).
import * as THREE from 'three';

THREE.ColorManagement.enabled = false;

const ID_VERT = /* glsl */`
  varying vec3 vN;
  void main() {
    vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const ID_FRAG = /* glsl */`
  uniform vec3 idColor;
  varying vec3 vN;
  void main() {
    vec3 n = normalize(vN);
    if (!gl_FrontFacing) n = -n;
    vec3 L = normalize(vec3(-0.45, 0.65, 0.62));
    float s = clamp(dot(n, L) * 0.5 + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(idColor.rg, s, 1.0);
  }
`;

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const COMPOSITE_FRAG = /* glsl */`
  uniform sampler2D tId;
  uniform sampler2D tDepth;
  uniform vec2 resolution;
  uniform float lineWidth;   // half width in pixels
  uniform float inkWidth;
  uniform vec3 lineColor;
  uniform vec3 fillColor;
  uniform vec3 bgColor;
  uniform float bgAlpha;
  uniform float shadeStrength;
  uniform float toon;
  uniform float selId;
  uniform float hoverId;
  uniform vec3 selColor;
  uniform float genderFlags[5];
  uniform float genderColor;
  varying vec2 vUv;

  float decodeId(vec4 c) { return floor(c.r * 255.0 + 0.5) + floor(c.g * 255.0 + 0.5) * 256.0; }

  void main() {
    vec2 px = 1.0 / resolution;
    vec4 c = texture2D(tId, vUv);
    float id = decodeId(c);
    float minEdge = 100.0;
    float minInk = id == 1.0 ? 0.0 : 100.0;
    float reach = max(lineWidth, inkWidth) + 1.0;
    const int R = 9;
    for (int y = -R; y <= R; y++) {
      for (int x = -R; x <= R; x++) {
        vec2 o = vec2(float(x), float(y));
        float d = length(o);
        if (d > reach) continue;
        float nid = decodeId(texture2D(tId, vUv + o * px));
        if (nid == 1.0) { minInk = min(minInk, d); continue; }
        if (id != 1.0 && nid != id) minEdge = min(minEdge, d);
      }
    }
    float edgeA = 1.0 - smoothstep(lineWidth - 0.5, lineWidth + 0.5, minEdge - 0.5);
    float inkA = 1.0 - smoothstep(inkWidth - 0.5, inkWidth + 0.5, max(minInk - 0.5, 0.0));
    float la = max(edgeA, inkA);

    vec3 base;
    float baseA;
    if (id == 0.0) {
      base = bgColor; baseA = bgAlpha;
    } else {
      float s = c.b;
      int figureIndex = int(clamp(floor(id / 100.0), 0.0, 4.0));
      vec3 tint = mix(vec3(1.0, 0.78, 0.86), vec3(0.66, 0.83, 1.0), genderFlags[figureIndex]);
      if (toon > 0.5) s = smoothstep(0.38, 0.42, s);
      base = fillColor * mix(vec3(1.0), tint, genderColor) * mix(1.0 - shadeStrength, 1.0, s);
      if (id == 1.0) {
        base = fillColor;
      }
      if (id == selId) base = mix(base, selColor, 0.38);
      else if (id == hoverId) base = mix(base, selColor, 0.16);
      baseA = 1.0;
    }
    float a = baseA + (1.0 - baseA) * la;
    vec3 rgb = (base * baseA * (1.0 - la) + lineColor * la) / max(a, 1e-4);
    gl_FragColor = vec4(rgb, a);
    gl_FragDepth = texture2D(tDepth, vUv).r;
  }
`;

function idToColor(id) {
  return new THREE.Vector3((id & 255) / 255, ((id >> 8) & 255) / 255, 0);
}

export class LineArtRenderer {
  constructor(renderer, mannequin) {
    this.renderer = renderer;
    this.mannequin = mannequin;
    this.style = {
      lineWidth: 1.6,       // css px (half width)
      inkRatio: 0.55,
      lineColor: '#1b1b1f',
      fillColor: '#ffffff',
      bgColor: '#ffffff',
      shade: 0.0,
      toon: false,
      genderColor: true,
    };
    this.selId = -1;
    this.hoverId = -1;

    // per-mesh ID materials
    for (const m of [...mannequin.parts]) {
      m.material = this._idMat(m.userData.id);
    }
    const inkMat = this._idMat(1);
    for (const ink of mannequin.inks) ink.material = inkMat;

    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tId: { value: null },
        tDepth: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
        lineWidth: { value: 1.5 },
        inkWidth: { value: 0.8 },
        lineColor: { value: new THREE.Color() },
        fillColor: { value: new THREE.Color() },
        bgColor: { value: new THREE.Color() },
        bgAlpha: { value: 1 },
        shadeStrength: { value: 0 },
        toon: { value: 0 },
        selId: { value: -1 },
        hoverId: { value: -1 },
        selColor: { value: new THREE.Color('#5aa9ff') },
        genderFlags: { value: [0, 0, 0, 0, 0] },
        genderColor: { value: 0.65 },
      },
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.AlwaysDepth,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMat);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);

    this.scene = new THREE.Scene();
    this.scene.add(mannequin.group);

    this.target = this._makeTarget(2, 2);
  }

  addFigure(mannequin, offset) {
    for (const part of mannequin.parts) {
      part.userData.id += offset;
      part.material = this._idMat(part.userData.id);
    }
    for (const ink of mannequin.inks) ink.material = this._idMat(1);
    this.scene.add(mannequin.group);
  }

  _idMat(id) {
    return new THREE.ShaderMaterial({
      vertexShader: ID_VERT,
      fragmentShader: ID_FRAG,
      uniforms: { idColor: { value: idToColor(id) } },
      side: THREE.DoubleSide,
    });
  }

  _makeTarget(w, h) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
    });
    rt.depthTexture = new THREE.DepthTexture(w, h);
    rt.depthTexture.type = THREE.UnsignedIntType;
    return rt;
  }

  setSize(w, h) {
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
  }

  _applyUniforms(pixelScale, { selection = true, bgAlpha = 1 } = {}) {
    const u = this.compositeMat.uniforms;
    const st = this.style;
    u.lineWidth.value = Math.max(0.75, st.lineWidth * pixelScale * 0.75);
    u.inkWidth.value = Math.max(0.5, st.lineWidth * st.inkRatio * pixelScale * 0.75);
    u.lineColor.value.set(st.lineColor);
    u.fillColor.value.set(st.fillColor);
    u.bgColor.value.set(st.bgColor);
    u.bgAlpha.value = bgAlpha;
    u.shadeStrength.value = st.shade;
    u.toon.value = st.toon ? 1 : 0;
    u.genderFlags.value = Array.from({ length: 5 }, (_, i) => (this.figures || [this.mannequin])[i]?.gender === 'male' ? 1 : 0);
    u.genderColor.value = st.genderColor ? 0.65 : 0;
    u.selId.value = selection ? this.selId : -1;
    u.hoverId.value = selection ? this.hoverId : -1;
  }

  // Render the ID pass + composite to the given output target (null = screen)
  render(camera, output = null, opts = {}) {
    const r = this.renderer;
    const target = opts.idTarget || this.target;
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    r.render(this.scene, camera);
    r.setClearColor(prevClear, prevAlpha);

    const u = this.compositeMat.uniforms;
    u.tId.value = target.texture;
    u.tDepth.value = target.depthTexture;
    u.resolution.value.set(target.width, target.height);
    this._applyUniforms(opts.pixelScale ?? 1, opts);
    r.setRenderTarget(output);
    if (output) { r.setClearColor(0x000000, 0); }
    r.clear(true, true, true);
    r.render(this.quadScene, this.quadCam);
    if (output) r.setClearColor(prevClear, prevAlpha);
  }

  // Compute a camera crop (setViewOffset) that frames the figure in a square
  frameCamera(camera, padding = 0.08, aspect = 1, onlyFigure = null) {
    const pts = (this.figures || [this.mannequin]).filter(m => onlyFigure ? m === onlyFigure : m.group.visible).flatMap(m => m.worldPoints(3));
    camera.clearViewOffset();
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const v = new THREE.Vector3();
    for (const p of pts) {
      v.copy(p).project(camera);
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    }
    const fullH = 2000, fullW = 2000 * camera.aspect;
    // NDC -> pixel
    const x0 = (minX * 0.5 + 0.5) * fullW, x1 = (maxX * 0.5 + 0.5) * fullW;
    const y0 = (1 - (maxY * 0.5 + 0.5)) * fullH, y1 = (1 - (minY * 0.5 + 0.5)) * fullH;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let w = x1 - x0, h = y1 - y0;
    // fit to requested aspect with padding
    const pad = 1 + padding * 2;
    let H = Math.max(h, w / aspect) * pad;
    let W = H * aspect;
    camera.setViewOffset(fullW, fullH, cx - W / 2, cy - H / 2, W, H);
    camera.updateProjectionMatrix();
  }

  // Render an image of the figure. Returns a canvas.
  renderImage(camera, { width = 1024, height = 1024, padding = 0.08, transparent = false, frame = true, lineScale = 1, onlyFigure = null } = {}) {
    const r = this.renderer;
    const cam = camera.clone();
    const figures = this.figures || [this.mannequin], visibility = figures.map(figure => figure.group.visible);
    let idT, outT;
    if (onlyFigure) figures.forEach(figure => { figure.group.visible = figure === onlyFigure; });
    try {
      if (frame) this.frameCamera(cam, padding, width / height, onlyFigure);
      else { cam.aspect = width / height; cam.updateProjectionMatrix(); }
      idT = this._makeTarget(width, height);
      outT = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType });
      const pixelScale = (Math.min(width, height) / 512) * lineScale;
      this.render(cam, outT, { idTarget: idT, pixelScale, selection: false, bgAlpha: transparent ? 0 : 1 });
      const buf = new Uint8Array(width * height * 4);
      r.readRenderTargetPixels(outT, 0, 0, width, height, buf);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(width, height);
      for (let y = 0; y < height; y++) {
        const src = (height - 1 - y) * width * 4;
        img.data.set(buf.subarray(src, src + width * 4), y * width * 4);
      }
      ctx.putImageData(img, 0, 0);
      return canvas;
    } finally {
      idT?.dispose(); idT?.depthTexture.dispose(); outT?.dispose();
      r.setRenderTarget(null);
      if (onlyFigure) figures.forEach((figure, index) => { figure.group.visible = visibility[index]; });
    }
  }
}
