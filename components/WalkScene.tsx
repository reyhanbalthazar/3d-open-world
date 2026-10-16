"use client";

// Port of https://threejs.org/examples/#webgl_animation_walk (MIT, three.js authors).

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { SunLight } from "three/addons/lights/SunLight.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GUI } from "three/addons/libs/lil-gui.module.min.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";

type ActionName = "Idle" | "Walk" | "Run";

const PI = Math.PI;
const PI90 = Math.PI / 2;

function unwrapRad(r: number) {
  return Math.atan2(Math.sin(r), Math.cos(r));
}

function setWeight(action: THREE.AnimationAction, weight: number) {
  action.enabled = true;
  action.setEffectiveTimeScale(1);
  action.setEffectiveWeight(weight);
}

export default function WalkScene() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let floor: THREE.Mesh | undefined;
    let skeleton: THREE.SkeletonHelper | undefined;
    let mixer: THREE.AnimationMixer | undefined;
    let actions: Record<ActionName, THREE.AnimationAction> | undefined;
    let panel: GUI | undefined;

    const settings = {
      show_skeleton: false,
      fixe_transition: true,
    };

    const controls = {
      key: [0, 0, 0],
      ease: new THREE.Vector3(),
      position: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      rotate: new THREE.Quaternion(),
      current: "Idle" as ActionName,
      fadeDuration: 0.5,
      runVelocity: 5,
      walkVelocity: 1.8,
      rotateSpeed: 0.05,
      floorDecale: 0,
    };

    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 2, -5);

    const timer = new THREE.Timer();
    timer.connect(document);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x5e5d5d);
    scene.fog = new THREE.Fog(0x5e5d5d, 2, 20);

    const group = new THREE.Group();
    scene.add(group);

    const sunLight = new SunLight(0xffffff, 5);
    sunLight.position.set(-2, 5, -3);
    sunLight.castShadow = true;
    sunLight.shadow.camera.far = 20;
    scene.add(sunLight);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.5;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(renderer.domElement);

    const orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.target.set(0, 1, 0);
    orbitControls.enableDamping = true;
    orbitControls.enablePan = false;
    orbitControls.maxPolarAngle = PI90 - 0.05;
    orbitControls.update();

    function addFloor() {
      const size = 50;
      const repeat = 16;

      const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

      const floorT = new THREE.TextureLoader().load("/textures/floors/FloorsCheckerboard_S_Diffuse.jpg");
      floorT.colorSpace = THREE.SRGBColorSpace;
      floorT.repeat.set(repeat, repeat);
      floorT.wrapS = floorT.wrapT = THREE.RepeatWrapping;
      floorT.anisotropy = maxAnisotropy;

      const floorN = new THREE.TextureLoader().load("/textures/floors/FloorsCheckerboard_S_Normal.jpg");
      floorN.repeat.set(repeat, repeat);
      floorN.wrapS = floorN.wrapT = THREE.RepeatWrapping;
      floorN.anisotropy = maxAnisotropy;

      const mat = new THREE.MeshStandardMaterial({
        map: floorT,
        normalMap: floorN,
        normalScale: new THREE.Vector2(0.5, 0.5),
        color: 0x404040,
        depthWrite: false,
        roughness: 0.85,
      });

      const g = new THREE.PlaneGeometry(size, size, 50, 50);
      g.rotateX(-PI90);

      floor = new THREE.Mesh(g, mat);
      floor.receiveShadow = true;
      scene.add(floor);

      controls.floorDecale = (size / repeat) * 4;

      const bulbGeometry = new THREE.SphereGeometry(0.05, 16, 8);
      const bulbLight = new THREE.PointLight(0xffee88, 2, 500, 2);

      const bulbMat = new THREE.MeshStandardMaterial({ emissive: 0xffffee, emissiveIntensity: 1, color: 0x000000 });
      bulbLight.add(new THREE.Mesh(bulbGeometry, bulbMat));
      bulbLight.position.set(1, 0.1, -3);
      bulbLight.castShadow = true;
      floor.add(bulbLight);
    }

    function loadModel() {
      new GLTFLoader().load("/models/gltf/Soldier.glb", (gltf) => {
        if (disposed) return;

        const model = gltf.scene;
        group.add(model);
        model.rotation.y = PI;
        group.rotation.y = PI;

        model.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          const material = object.material as THREE.MeshStandardMaterial;

          if (object.name == "vanguard_Mesh") {
            object.castShadow = true;
            object.receiveShadow = true;
            material.metalness = 1.0;
            material.roughness = 0.2;
            material.color.set(1, 1, 1);
            material.metalnessMap = material.map;
          } else {
            material.metalness = 1;
            material.roughness = 0;
            material.transparent = true;
            material.opacity = 0.8;
            material.color.set(1, 1, 1);
          }
        });

        skeleton = new THREE.SkeletonHelper(model);
        skeleton.setColors(new THREE.Color(0xe000ff), new THREE.Color(0x00e0ff));
        skeleton.visible = false;
        scene.add(skeleton);

        createPanel();

        const animations = gltf.animations;

        mixer = new THREE.AnimationMixer(model);

        actions = {
          Idle: mixer.clipAction(animations[0]),
          Walk: mixer.clipAction(animations[3]),
          Run: mixer.clipAction(animations[1]),
        };

        for (const m of Object.keys(actions) as ActionName[]) {
          actions[m].enabled = true;
          actions[m].setEffectiveTimeScale(1);
          if (m !== "Idle") actions[m].setEffectiveWeight(0);
        }

        actions.Idle.play();
      });
    }

    function updateCharacter(delta: number) {
      const fade = controls.fadeDuration;
      const key = controls.key;
      const up = controls.up;
      const ease = controls.ease;
      const rotate = controls.rotate;
      const position = controls.position;
      const azimuth = orbitControls.getAzimuthalAngle();

      const active = key[0] === 0 && key[1] === 0 ? false : true;
      const play: ActionName = active ? (key[2] ? "Run" : "Walk") : "Idle";

      // change animation

      if (actions && controls.current != play) {
        const current = actions[play];
        const old = actions[controls.current];
        controls.current = play;

        if (settings.fixe_transition) {
          current.reset();
          current.weight = 1.0;
          current.stopFading();
          old.stopFading();
          // synchro if not idle
          if (play !== "Idle") current.time = old.time * (current.getClip().duration / old.getClip().duration);
          old._scheduleFading(fade, old.getEffectiveWeight(), 0);
          current._scheduleFading(fade, current.getEffectiveWeight(), 1);
          current.play();
        } else {
          setWeight(current, 1.0);
          old.fadeOut(fade);
          current.reset().fadeIn(fade).play();
        }
      }

      // move object

      if (controls.current !== "Idle") {
        // run/walk velocity
        const velocity = controls.current == "Run" ? controls.runVelocity : controls.walkVelocity;

        // direction with key
        ease.set(key[1], 0, key[0]).multiplyScalar(velocity * delta);

        // calculate camera direction
        const angle = unwrapRad(Math.atan2(ease.x, ease.z) + azimuth);
        rotate.setFromAxisAngle(up, angle);

        // apply camera angle on ease
        controls.ease.applyAxisAngle(up, azimuth);

        position.add(ease);
        camera.position.add(ease);

        group.position.copy(position);
        group.quaternion.rotateTowards(rotate, controls.rotateSpeed);

        orbitControls.target.copy(position).add(up);

        // Move the floor without any limit
        if (floor) {
          const dx = position.x - floor.position.x;
          const dz = position.z - floor.position.z;
          if (Math.abs(dx) > controls.floorDecale) floor.position.x += dx;
          if (Math.abs(dz) > controls.floorDecale) floor.position.z += dz;
        }
      }

      if (mixer) mixer.update(delta);

      orbitControls.update();
    }

    function createPanel() {
      panel = new GUI({ width: 310 });

      panel.add(settings, "show_skeleton").onChange((b: boolean) => {
        if (skeleton) skeleton.visible = b;
      });

      panel.add(settings, "fixe_transition");
    }

    function onKeyDown(event: KeyboardEvent) {
      const key = controls.key;
      switch (event.code) {
        case "ArrowUp": case "KeyW": case "KeyZ": key[0] = -1; break;
        case "ArrowDown": case "KeyS": key[0] = 1; break;
        case "ArrowLeft": case "KeyA": case "KeyQ": key[1] = -1; break;
        case "ArrowRight": case "KeyD": key[1] = 1; break;
        case "ShiftLeft": case "ShiftRight": key[2] = 1; break;
      }
    }

    function onKeyUp(event: KeyboardEvent) {
      const key = controls.key;
      switch (event.code) {
        case "ArrowUp": case "KeyW": case "KeyZ": key[0] = key[0] < 0 ? 0 : key[0]; break;
        case "ArrowDown": case "KeyS": key[0] = key[0] > 0 ? 0 : key[0]; break;
        case "ArrowLeft": case "KeyA": case "KeyQ": key[1] = key[1] < 0 ? 0 : key[1]; break;
        case "ArrowRight": case "KeyD": key[1] = key[1] > 0 ? 0 : key[1]; break;
        case "ShiftLeft": case "ShiftRight": key[2] = 0; break;
      }
    }

    function onWindowResize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    }

    function animate() {
      timer.update();

      const delta = timer.getDelta();

      updateCharacter(delta);

      renderer.render(scene, camera);
    }

    // EVENTS

    window.addEventListener("resize", onWindowResize);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);

    renderer.setAnimationLoop(animate);

    // DEMO

    new HDRLoader().setPath("/textures/equirectangular/").load("lobe.hdr", (texture) => {
      if (disposed) {
        texture.dispose();
        return;
      }

      texture.mapping = THREE.EquirectangularReflectionMapping;
      scene.environment = texture;
      scene.environmentIntensity = 1.5;

      loadModel();
      addFloor();
    });

    return () => {
      disposed = true;

      window.removeEventListener("resize", onWindowResize);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);

      renderer.setAnimationLoop(null);
      panel?.destroy();
      orbitControls.dispose();
      timer.dispose();
      mixer?.stopAllAction();

      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) {
            for (const value of Object.values(material)) {
              if (value instanceof THREE.Texture) value.dispose();
            }
            material.dispose();
          }
        }
      });
      scene.environment?.dispose();
      skeleton?.dispose();

      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#5e5d5d]">
      <div ref={containerRef} />
      <div className="pointer-events-none absolute inset-x-0 top-0 p-2.5 text-center font-mono text-[13px] leading-snug text-white select-none">
        <a
          className="pointer-events-auto text-[#f00]"
          href="https://threejs.org"
          target="_blank"
          rel="noopener"
        >
          three.js
        </a>{" "}
        - Skeletal Animation Walking (model from{" "}
        <a
          className="pointer-events-auto text-[#f00]"
          href="https://www.mixamo.com/"
          target="_blank"
          rel="noopener"
        >
          mixamo.com
        </a>
        )
        <br />
        WASD / arrows to move, Shift to run, drag to orbit the camera
      </div>
    </div>
  );
}
