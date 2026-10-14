/**
 * three.js presentation.
 *
 * The 3D view is rendered into an off-screen 256x128 target (optionally a
 * multiple of it) that stores VGA colour *indices*, exactly like the
 * original's off-screen buffer. A final pass composes the 320x200 screen
 * from the cockpit panel, the 3D view at (32,16) and the HUD overlay, and
 * looks every pixel up in the current 256-colour palette, so palette
 * changes behave like writes to the VGA DAC.
 */
import * as THREE from 'three';

const VIEW_W = 256, VIEW_H = 128;
const MAX_VERTS = 24000;

export class Renderer {
  constructor(canvas, { scale = 1 } = {}) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: false });
    this.gl.setPixelRatio(1);
    this.gl.autoClear = false;
    this.scale = scale;

    this.paletteData = new Uint8Array(256 * 4);
    this.palette = new THREE.DataTexture(this.paletteData, 256, 1, THREE.RGBAFormat);
    this.palette.magFilter = this.palette.minFilter = THREE.NearestFilter;
    this.palette.needsUpdate = true;

    this.screen = new Uint8Array(320 * 200);          // indexed 320x200 (panel, full-screen pictures)
    this.screenTex = indexTexture(this.screen, 320, 200);
    this.overlay = new Uint8Array(VIEW_W * VIEW_H);    // indexed HUD layer over the 3D view, 0 = clear
    this.overlayTex = indexTexture(this.overlay, VIEW_W, VIEW_H);

    this.makeViewTarget();
    this.makeViewScene();
    this.makeComposite();
    this.mode = 0;          // 0 screen only, 1 3D view + HUD layer, 2 front-end buffer, 3 3D + buffer
    this.quarters = 0xf;    // attract mode shows only some quarters of the view each frame
  }

  setScale(scale) {
    if (scale === this.scale) return;
    this.scale = scale;
    this.rt.dispose();
    this.makeViewTarget();
    this.compositeMat.uniforms.view.value = this.shown.texture;
    this.copyMat.uniforms.src.value = this.rt.texture;
  }

  makeViewTarget() {
    const opts = {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    };
    this.rt = new THREE.WebGLRenderTarget(VIEW_W * this.scale, VIEW_H * this.scale, opts);
    this.shown = new THREE.WebGLRenderTarget(VIEW_W * this.scale, VIEW_H * this.scale, opts);
  }

  makeViewScene() {
    this.viewScene = new THREE.Scene();
    // Original projection: sx = 128 + 100*X/(Z+400), sy = 64 - 100*Y/(Z+400).
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(64 / 100));
    this.camera = new THREE.PerspectiveCamera(fov, 2, 10, 20000);
    this.camera.position.set(0, 0, 400);
    this.camera.lookAt(0, 0, 0);

    // sky rows 0..63 use colours 0x80+row/2, rows 64..127 the arena ground colour
    this.bgMat = new THREE.ShaderMaterial({
      uniforms: { ground: { value: 0 }, sky: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform float ground, sky; varying vec2 vUv;
        void main(){ float row = floor((1.0 - vUv.y) * 128.0);
          float ci = sky < 0.5 ? 0.0 : row < 64.0 ? 128.0 + floor(row / 2.0) : ground;
          gl_FragColor = vec4(ci / 255.0, 0.0, 0.0, 1.0); }`,
      depthTest: false, depthWrite: false,
    });
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMat);
    bg.frustumCulled = false; bg.renderOrder = -1;
    this.viewScene.add(bg);

    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX_VERTS * 3);
    this.ci = new Float32Array(MAX_VERTS);
    this.disc = new Float32Array(MAX_VERTS * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('ci', new THREE.BufferAttribute(this.ci, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('disc', new THREE.BufferAttribute(this.disc, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      vertexShader: `attribute float ci; attribute vec3 disc; varying float vCi; varying vec3 vDisc;
        void main(){ vCi = ci; vDisc = disc; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying float vCi; varying vec3 vDisc;
        void main(){ if (vDisc.z > 0.5 && dot(vDisc.xy, vDisc.xy) > 1.0) discard;
          gl_FragColor = vec4((vCi + 0.25) / 255.0, 0.0, 0.0, 1.0); }`,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.viewScene.add(this.mesh);
  }

  makeComposite() {
    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        screen: { value: this.screenTex }, view: { value: this.shown.texture },
        overlay: { value: this.overlayTex }, palette: { value: this.palette },
        mode: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D screen, view, overlay, palette; uniform float mode; varying vec2 vUv;
        vec4 pal(float i){ return texture2D(palette, vec2((floor(i + 0.5) + 0.5) / 256.0, 0.5)); }
        void main(){
          vec2 p = vec2(vUv.x * 320.0, (1.0 - vUv.y) * 200.0);
          float ci = texture2D(screen, vec2(vUv.x, 1.0 - vUv.y)).r * 255.0;
          if (mode > 0.5 && p.x >= 32.0 && p.x < 288.0 && p.y >= 16.0 && p.y < 144.0) {
            vec2 q = vec2((p.x - 32.0) / 256.0, (p.y - 16.0) / 128.0);
            float o = texture2D(overlay, q).r * 255.0;
            float v = texture2D(view, vec2(q.x, 1.0 - q.y)).r * 255.0;
            ci = (mode > 1.5 && mode < 2.5) ? o : (o > 0.5 ? o : v);
          }
          gl_FragColor = pal(ci);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.compositeScene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMat);
    quad.frustumCulled = false;
    this.compositeScene.add(quad);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // copies quarters of the freshly rendered view into the displayed view
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { src: { value: this.rt.texture } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D src; varying vec2 vUv; void main(){ gl_FragColor = texture2D(src, vUv); }',
      depthTest: false, depthWrite: false,
    });
    this.copyScene = new THREE.Scene();
    const cq = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMat);
    cq.frustumCulled = false;
    this.copyScene.add(cq);
  }

  /** dac: Uint8Array(768) of 6-bit VGA values */
  setPalette(dac) {
    for (let i = 0; i < 256; i++) {
      this.paletteData[i * 4] = dac[i * 3] * 255 / 63;
      this.paletteData[i * 4 + 1] = dac[i * 3 + 1] * 255 / 63;
      this.paletteData[i * 4 + 2] = dac[i * 3 + 2] * 255 / 63;
      this.paletteData[i * 4 + 3] = 255;
    }
    this.palette.needsUpdate = true;
  }

  /** Fill the dynamic mesh from SceneBuilder primitives (painter's order). */
  setPrimitives(prims, groundColour, background = 'sky') {
    this.bgMat.uniforms.ground.value = groundColour;
    this.bgMat.uniforms.sky.value = background === 'sky' ? 1 : 0;
    this.dirty = true;
    let n = 0;
    const put = (x, y, z, c, dx = 0, dy = 0, d = 0) => {
      if (n >= MAX_VERTS) return;
      this.pos[n * 3] = x; this.pos[n * 3 + 1] = y; this.pos[n * 3 + 2] = -z;
      this.ci[n] = c;
      this.disc[n * 3] = dx; this.disc[n * 3 + 1] = dy; this.disc[n * 3 + 2] = d;
      n++;
    };
    for (const p of prims) {
      if (p.kind === 'poly') {
        const pts = p.pts;
        for (let i = 1; i + 1 < pts.length; i++) {
          put(pts[0][0], pts[0][1], pts[0][2], p.colour);
          put(pts[i][0], pts[i][1], pts[i][2], p.colour);
          put(pts[i + 1][0], pts[i + 1][1], pts[i + 1][2], p.colour);
        }
      } else {
        const { x, y, z, r, colour } = p;
        put(x - r, y - r, z, colour, -1, -1, 1); put(x + r, y - r, z, colour, 1, -1, 1); put(x + r, y + r, z, colour, 1, 1, 1);
        put(x - r, y - r, z, colour, -1, -1, 1); put(x + r, y + r, z, colour, 1, 1, 1); put(x - r, y + r, z, colour, -1, 1, 1);
      }
    }
    this.geo.setDrawRange(0, n);
    for (const k of ['position', 'ci', 'disc']) this.geo.attributes[k].needsUpdate = true;
  }

  /** Draw a frame. */
  present() {
    const gl = this.gl;
    if ((this.mode === 1 || this.mode === 3) && this.dirty) {
      this.dirty = false;
      gl.setRenderTarget(this.rt);
      gl.render(this.viewScene, this.camera);
      gl.setRenderTarget(this.shown);
      const w = this.shown.width / 2, h = this.shown.height / 2;
      gl.setScissorTest(true);
      for (let q = 0; q < 4; q++) {
        if (!(this.quarters & (1 << q))) continue;
        // bit0 top-left, bit1 top-right, bit2 bottom-left, bit3 bottom-right
        this.shown.scissor.set((q & 1) * w, (q & 2) ? 0 : h, w, h);
        this.shown.scissorTest = true;
        gl.render(this.copyScene, this.orthoCam);
      }
      this.shown.scissorTest = false;
      gl.setScissorTest(false);
    }
    this.screenTex.needsUpdate = true;
    this.overlayTex.needsUpdate = true;
    this.compositeMat.uniforms.mode.value = this.mode;
    gl.setRenderTarget(null);
    gl.render(this.compositeScene, this.orthoCam);
  }

  resize(width, height) { this.gl.setSize(width, height, false); }
}

function indexTexture(data, w, h) {
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.unpackAlignment = 1;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}
