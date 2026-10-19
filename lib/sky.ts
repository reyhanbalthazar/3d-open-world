import * as THREE from "three";
import { seededRandom } from "./terrain-layout";

// Painted-looking sky: a blue gradient with soft clouds and a warm glow around the sun, and two
// rings of hazy mountains on the horizon. Everything follows the camera, so it is always "far".

// horizon colour doubles as the fog colour, so fogged scenery melts into the sky
export const HORIZON_COLOR = 0xd3e8ef;
const TOP_COLOR = 0x4fa6e0;
const SUN_COLOR = 0xfff1c9;
// must fit inside the camera's far plane
const DOME_RADIUS = 95;

const vertexShader = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 sunColor;
  uniform vec3 sunDirection;
  varying vec3 vDirection;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
      value += amplitude * noise(p);
      p *= 2.0;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec3 direction = normalize(vDirection);
    float height = max(direction.y, 0.0);
    vec3 color = mix(horizonColor, topColor, pow(height, 0.55));

    // clouds on a flat layer overhead, thinning out towards the horizon
    if (direction.y > 0.01) {
      vec2 layer = direction.xz / direction.y * 0.55;
      float cloud = smoothstep(0.52, 0.78, fbm(layer + vec2(4.0, 1.5)));
      color = mix(color, vec3(1.0), cloud * 0.8 * smoothstep(0.01, 0.3, direction.y));
    }

    float sun = max(dot(direction, sunDirection), 0.0);
    color += sunColor * (pow(sun, 200.0) * 0.8 + pow(sun, 8.0) * 0.25);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// A jagged ring of mountains, coloured from the horizon at the foot to a deeper blue-green on top.
function mountainRing(radius: number, minHeight: number, maxHeight: number, foot: THREE.Color, peak: THREE.Color, seed: number) {
  const random = seededRandom(seed);
  const segments = 120;
  const phases = [random() * 6.3, random() * 6.3, random() * 6.3];
  const positions: number[] = [];
  const colors: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const ridge =
      0.5 +
      0.25 * Math.sin(angle * 3 + phases[0]) +
      0.15 * Math.sin(angle * 7 + phases[1]) +
      0.1 * Math.sin(angle * 13 + phases[2]);
    const height = minHeight + (maxHeight - minHeight) * Math.min(1, Math.max(0, ridge + (random() - 0.5) * 0.15));
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    positions.push(x, -4, z, x, height, z);
    colors.push(foot.r, foot.g, foot.b, peak.r, peak.g, peak.b);
  }

  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);

  return new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide, depthWrite: false }),
  );
}

export function createSky(sunDirection: THREE.Vector3) {
  const sky = new THREE.Group();

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(DOME_RADIUS, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(TOP_COLOR) },
        horizonColor: { value: new THREE.Color(HORIZON_COLOR) },
        sunColor: { value: new THREE.Color(SUN_COLOR) },
        sunDirection: { value: sunDirection.clone().normalize() },
      },
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );

  const horizon = new THREE.Color(HORIZON_COLOR);
  const far = mountainRing(88, 10, 24, horizon, new THREE.Color(0x9fc3d4), 11);
  const near = mountainRing(80, 5, 13, horizon, new THREE.Color(0x8fb8b0), 23);

  // drawn first and never hide anything: they are only background
  for (const [order, mesh] of [dome, far, near].entries()) {
    mesh.renderOrder = -10 + order;
    mesh.frustumCulled = false;
    sky.add(mesh);
  }

  return {
    object: sky,
    // keep the sky centred on the camera so the player can never reach it
    follow(camera: THREE.Camera) {
      sky.position.set(camera.position.x, 0, camera.position.z);
    },
  };
}
