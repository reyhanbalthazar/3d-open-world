"use client";

// Port of https://threejs.org/examples/#webgl_animation_walk (MIT, three.js authors).

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { SunLight } from "three/addons/lights/SunLight.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GUI } from "three/addons/libs/lil-gui.module.min.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { connectMultiplayer, type ConnectionStatus } from "@/lib/multiplayer";
import type { AnimName as ActionName } from "@/lib/protocol";
import { Radar } from "@/lib/radar";
import { CLIP_INDEX, RemotePlayers } from "@/lib/remote-players";
import { MAP_HALF, MAP_SIZE, PLAYER_RADIUS, yawFromQuaternion } from "@/lib/world";

const RADAR_SIZE = 176;
const WALL_HEIGHT = 1.2;
const WALL_THICKNESS = 0.4;

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting to game server…",
  online: "Online",
  offline: "Offline: game server unreachable, retrying…",
};

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
  const radarRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [playerCount, setPlayerCount] = useState(1);

  useEffect(() => {
    const container = containerRef.current;
    const radarCanvas = radarRef.current;
    if (!container || !radarCanvas) return;

    let disposed = false;
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
      moved: new THREE.Vector3(),
      position: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      rotate: new THREE.Quaternion(),
      current: "Idle" as ActionName,
      fadeDuration: 0.5,
      runVelocity: 5,
      walkVelocity: 1.8,
      rotateSpeed: 0.05,
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

    // OrbitControls turns Shift + left drag into a pan (disabled above), so the camera
    // froze while running. Re-dispatch the press without Shift so it rotates instead.
    function onCanvasPointerDown(event: PointerEvent) {
      if (!event.shiftKey || event.button !== 0) return;
      event.stopImmediatePropagation();
      renderer.domElement.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: event.bubbles,
          cancelable: event.cancelable,
          composed: event.composed,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary,
          button: event.button,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: false,
        }),
      );
    }
    renderer.domElement.addEventListener("pointerdown", onCanvasPointerDown, { capture: true });

    // Spawn at a random spot near the origin so players don't stand inside each other.
    controls.position.set(THREE.MathUtils.randFloatSpread(6), 0, THREE.MathUtils.randFloatSpread(6));
    group.position.copy(controls.position);
    camera.position.add(controls.position);
    orbitControls.target.copy(controls.position).add(controls.up);
    orbitControls.update();

    const radar = new Radar(radarCanvas, RADAR_SIZE);
    const viewDirection = new THREE.Vector3();

    // MULTIPLAYER

    const remotes = new RemotePlayers(scene);
    const updatePlayerCount = () => setPlayerCount(remotes.count + 1);

    const net = connectMultiplayer({
      onWelcome(_id, players) {
        remotes.clear();
        for (const { id, ...state } of players) remotes.upsert(id, state);
        updatePlayerCount();
      },
      onState(id, state) {
        remotes.upsert(id, state);
        updatePlayerCount();
      },
      onLeave(id) {
        remotes.remove(id);
        updatePlayerCount();
      },
      onStatus(next) {
        setStatus(next);
        if (next !== "online") {
          remotes.clear();
          updatePlayerCount();
        }
      },
    });

    // Low walls just outside the square map, so the boundary is visible.
    function addWalls() {
      const material = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.6, metalness: 0.1 });
      const length = MAP_SIZE + WALL_THICKNESS * 2;
      const offset = MAP_HALF + WALL_THICKNESS / 2;

      const sides: Array<[x: number, z: number, rotated: boolean]> = [
        [0, offset, false],
        [0, -offset, false],
        [offset, 0, true],
        [-offset, 0, true],
      ];

      for (const [x, z, rotated] of sides) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS), material);
        wall.position.set(x, WALL_HEIGHT / 2, z);
        if (rotated) wall.rotation.y = PI90;
        wall.castShadow = true;
        wall.receiveShadow = true;
        scene.add(wall);
      }
    }

    addWalls();

    function addFloor() {
      // a little wider than the map so the walls don't stand on the edge of the world
      const size = MAP_SIZE + 20;
      // same tile size as the original 50 m floor with 16 repeats
      const repeat = size / (50 / 16);

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

      const floor = new THREE.Mesh(g, mat);
      floor.receiveShadow = true;
      scene.add(floor);

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
          Idle: mixer.clipAction(animations[CLIP_INDEX.Idle]),
          Walk: mixer.clipAction(animations[CLIP_INDEX.Walk]),
          Run: mixer.clipAction(animations[CLIP_INDEX.Run]),
        };

        for (const m of Object.keys(actions) as ActionName[]) {
          actions[m].enabled = true;
          actions[m].setEffectiveTimeScale(1);
          if (m !== "Idle") actions[m].setEffectiveWeight(0);
        }

        actions.Idle.play();

        remotes.setTemplate(gltf);
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

        // stay inside the square map; the camera follows by however far the player really moved
        const limit = MAP_HALF - PLAYER_RADIUS;
        const moved = controls.moved.copy(position);
        position.add(ease);
        position.x = THREE.MathUtils.clamp(position.x, -limit, limit);
        position.z = THREE.MathUtils.clamp(position.z, -limit, limit);
        camera.position.add(moved.subVectors(position, moved));

        group.position.copy(position);
        group.quaternion.rotateTowards(rotate, controls.rotateSpeed);

        orbitControls.target.copy(position).add(up);
      }

      if (mixer) mixer.update(delta);

      orbitControls.update();
    }

    function createPanel() {
      panel = new GUI({ width: RADAR_SIZE });
      // the radar owns the top-right corner, so tuck the panel underneath it
      panel.domElement.style.top = `${RADAR_SIZE + 24}px`;
      panel.domElement.style.right = "12px";
      panel.close();

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
      remotes.update(delta);

      const yaw = yawFromQuaternion(group.quaternion);

      net.sendState({
        x: controls.position.x,
        z: controls.position.z,
        yaw,
        anim: controls.current,
      });

      renderer.render(scene, camera);

      viewDirection.subVectors(orbitControls.target, camera.position);
      radar.draw(
        { x: controls.position.x, z: controls.position.z, yaw, color: "#ffffff" },
        viewDirection.x,
        viewDirection.z,
        remotes.markers(),
      );
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
      renderer.domElement.removeEventListener("pointerdown", onCanvasPointerDown, { capture: true });

      renderer.setAnimationLoop(null);
      net.close();
      remotes.clear();
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
      <canvas
        ref={radarRef}
        aria-label="Radar map"
        className="pointer-events-none absolute top-3 right-3 rounded-xl border border-white/15 bg-black/55 shadow-lg backdrop-blur-sm"
        style={{ width: RADAR_SIZE, height: RADAR_SIZE }}
      />
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
        <br />
        <span className={status === "online" ? "text-emerald-300" : "text-amber-300"}>
          {STATUS_TEXT[status]}
          {status === "online" && ` · ${playerCount} ${playerCount === 1 ? "player" : "players"}`}
        </span>
      </div>
    </div>
  );
}
