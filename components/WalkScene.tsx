"use client";

// Port of https://threejs.org/examples/#webgl_animation_walk (MIT, three.js authors).

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { SunLight } from "three/addons/lights/SunLight.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GUI } from "three/addons/libs/lil-gui.module.min.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import JoinModal from "@/components/JoinModal";
import type { MixamoAnimationName } from "@/lib/animation-catalog";
import {
  createActions,
  createFootPins,
  instantiateCharacter,
  loadCharacterModel,
  mixamoWeight,
  type CharacterActions,
} from "@/lib/character-models";
import { DEFAULT_CHARACTER, type CharacterId } from "@/lib/characters";
import { connectMultiplayer, type ConnectionStatus } from "@/lib/multiplayer";
import { addNature, createGround } from "@/lib/nature";
import { loadSavedProfile, saveProfile, type SavedProfile } from "@/lib/profile";
import type { JoinErrorReason, LocomotionName as ActionName } from "@/lib/protocol";
import { Radar } from "@/lib/radar";
import { RemotePlayers } from "@/lib/remote-players";
import { createMonument, MONUMENT_OBSTACLES, MONUMENT_POSITION } from "@/lib/monument";
import { createSky, HORIZON_COLOR } from "@/lib/sky";
import { CLEARING_RADIUS, generateTerrainLayout } from "@/lib/terrain-layout";
import { MAP_HALF, MAP_SIZE, PLAYER_RADIUS, yawFromQuaternion } from "@/lib/world";

const RADAR_SIZE = 176;
// seconds to blend into and back out of a move like the sword slash
const MOVE_FADE = 0.2;
const SUN_COLOR = 0xfff0d6;
const SUN_DIRECTION = new THREE.Vector3(0.6, 0.7, 0.35).normalize();
// ground beyond the map edge, far enough that its end is always lost in the fog
const GROUND_MARGIN = 50;

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

// What the join screen can ask of the running scene.
interface SceneApi {
  preview(character: CharacterId): void;
  join(name: string, character: CharacterId): void;
}

export default function WalkScene() {
  const containerRef = useRef<HTMLDivElement>(null);
  const radarRef = useRef<HTMLCanvasElement>(null);
  const sceneApiRef = useRef<SceneApi | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [playerCount, setPlayerCount] = useState(0);
  const [takenNames, setTakenNames] = useState<string[]>([]);
  // the join screen appears once the first character preview has loaded
  const [sceneReady, setSceneReady] = useState(false);
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<JoinErrorReason | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const radarCanvas = radarRef.current;
    if (!container || !radarCanvas) return;

    let disposed = false;
    // movement keys do nothing until the join screen is done
    let joined = false;
    let profile: SavedProfile | undefined;
    let model: THREE.Object3D | undefined;
    let skeleton: THREE.SkeletonHelper | undefined;
    let mixer: THREE.AnimationMixer | undefined;
    let actions: CharacterActions | undefined;
    let feet: ReturnType<typeof createFootPins> | undefined;
    // the move playing right now (e.g. "Slash"), if any
    let move: MixamoAnimationName | null = null;
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
    scene.background = new THREE.Color(HORIZON_COLOR);
    scene.fog = new THREE.Fog(HORIZON_COLOR, 18, 50);

    const group = new THREE.Group();
    group.rotation.y = PI;
    scene.add(group);

    // warm afternoon sun, high and off to the side of the spawn view
    const sunLight = new SunLight(SUN_COLOR, 2.6);
    sunLight.position.copy(SUN_DIRECTION).multiplyScalar(10);
    sunLight.castShadow = true;
    sunLight.shadow.camera.far = 20;
    scene.add(sunLight);

    // soft fill: sky blue from above, grass green bounced from below
    scene.add(new THREE.HemisphereLight(0xd6ecff, 0x7aa63f, 2.2));

    const sky = createSky(SUN_DIRECTION);
    scene.add(sky.object);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    // keeps the pack's saturated colours instead of washing them out like ACES does
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(renderer.domElement);

    // name tags above other players
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.domElement.className = "pointer-events-none absolute inset-0";
    container.appendChild(labelRenderer.domElement);

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

    // Spawn at a random spot on the south side of the central clearing, so players don't stand
    // inside each other and the first thing they see is the monument's gate and tower.
    controls.position.set(THREE.MathUtils.randFloatSpread(8), 0, -THREE.MathUtils.randFloat(8.5, 10.5));
    group.position.copy(controls.position);
    camera.position.add(controls.position);
    orbitControls.target.copy(controls.position).add(controls.up);
    orbitControls.update();

    const terrain = generateTerrainLayout();
    const obstacles = [...terrain.obstacles, ...MONUMENT_OBSTACLES];
    const radar = new Radar(radarCanvas, RADAR_SIZE, terrain.obstacles, MONUMENT_POSITION);
    const viewDirection = new THREE.Vector3();

    // MULTIPLAYER

    const remotes = new RemotePlayers(scene);
    const refreshPlayers = () => {
      setPlayerCount(remotes.count + (joined ? 1 : 0));
      setTakenNames(remotes.names());
    };

    const net = connectMultiplayer({
      onWelcome(players) {
        remotes.clear();
        for (const player of players) remotes.add(player);
        refreshPlayers();
      },
      onJoined() {
        joined = true;
        if (profile) saveProfile(profile);
        setJoined(true);
        setJoining(false);
        refreshPlayers();
      },
      onJoinError(reason) {
        setJoinError(reason);
        setJoining(false);
      },
      onPlayerJoined(player) {
        remotes.add(player);
        refreshPlayers();
      },
      onState(id, state) {
        remotes.upsert(id, state);
      },
      onLeave(id) {
        remotes.remove(id);
        refreshPlayers();
      },
      onStatus(next) {
        setStatus(next);
        if (next !== "online") {
          remotes.clear();
          refreshPlayers();
        }
      },
    });

    sceneApiRef.current = {
      preview(character) {
        void showCharacter(character);
      },
      join(name, character) {
        profile = { name, character };
        setJoining(true);
        setJoinError(null);
        void showCharacter(character);
        net.join(name, character);
      },
    };

    // TERRAIN: grass ground, a forest border hiding the map edge, and trees, rocks, bushes,
    // flowers and grass inside, laid out the same way for every player

    scene.add(
      createGround(MAP_SIZE + GROUND_MARGIN * 2, terrain.paths, CLEARING_RADIUS, renderer.capabilities.getMaxAnisotropy()),
    );
    void addNature(scene, terrain.placements, () => disposed);

    const monument = createMonument();
    scene.add(monument.object);

    // Swaps the local player's model; used for the join screen preview and the final pick.
    // Quaternius characters already face +Z, so unlike the original Soldier the model needs no flip.
    let characterRequest = 0;
    async function showCharacter(character: CharacterId, onProgress?: (fraction: number) => void) {
      const request = ++characterRequest;
      const gltf = await loadCharacterModel(character, onProgress);
      // unmounted, or another character was picked while this one downloaded
      if (disposed || request !== characterRequest) return;

      if (model) {
        mixer?.stopAllAction();
        mixer?.uncacheRoot(model);
        group.remove(model);
      }
      if (skeleton) {
        scene.remove(skeleton);
        skeleton.dispose();
      }

      model = instantiateCharacter(gltf);
      group.add(model);

      skeleton = new THREE.SkeletonHelper(model);
      skeleton.setColors(new THREE.Color(0xe000ff), new THREE.Color(0x00e0ff));
      skeleton.visible = settings.show_skeleton;
      scene.add(skeleton);

      mixer = new THREE.AnimationMixer(model);
      actions = createActions(mixer, gltf.animations);
      feet = createFootPins(model);

      for (const m of ["Idle", "Walk", "Run"] as const) {
        actions[m].enabled = true;
        actions[m].setEffectiveTimeScale(1);
        if (m !== "Idle") actions[m].setEffectiveWeight(0);
      }

      controls.current = "Idle";
      move = null;
      actions.Idle.play();
    }

    // A move (Space: sword slash) plays once, cross-fading from whatever the legs were doing...
    function startMove(name: MixamoAnimationName) {
      const action = actions?.[name];
      if (!actions || !action || move) return;
      move = name;
      action.reset().play();
      action.crossFadeFrom(actions[controls.current], MOVE_FADE, false);
    }

    // ...and just before it ends, hands back to standing, walking or running, whichever the keys say now
    function endMove() {
      const action = move && actions?.[move];
      move = null;
      if (!actions || !action) return;
      const next = actions[controls.current];
      next.reset().play();
      next.crossFadeFrom(action, MOVE_FADE, false);
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

      // change animation (during a move, only note what to hand back to)

      if (actions && move) {
        controls.current = play;
        const action = actions[move]!;
        if (!action.isRunning() || action.time >= action.getClip().duration - MOVE_FADE) endMove();
      } else if (actions && controls.current != play) {
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

        // stay out of tree trunks and rocks and inside the square map;
        // the camera follows by however far the player really moved
        const limit = MAP_HALF - PLAYER_RADIUS;
        const moved = controls.moved.copy(position);
        position.add(ease);
        for (const obstacle of obstacles) {
          const dx = position.x - obstacle.x;
          const dz = position.z - obstacle.z;
          const reach = obstacle.radius + PLAYER_RADIUS;
          const distance = Math.hypot(dx, dz);
          if (distance >= reach || distance === 0) continue;
          // slide along the obstacle instead of stopping dead
          position.x = obstacle.x + (dx / distance) * reach;
          position.z = obstacle.z + (dz / distance) * reach;
        }
        position.x = THREE.MathUtils.clamp(position.x, -limit, limit);
        position.z = THREE.MathUtils.clamp(position.z, -limit, limit);
        camera.position.add(moved.subVectors(position, moved));

        group.position.copy(position);
        group.quaternion.rotateTowards(rotate, controls.rotateSpeed);

        orbitControls.target.copy(position).add(up);
      }

      if (mixer) mixer.update(delta);
      if (actions) feet?.update(mixamoWeight(actions));

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
      if (!joined) return;
      const key = controls.key;
      switch (event.code) {
        case "ArrowUp": case "KeyW": case "KeyZ": key[0] = -1; break;
        case "ArrowDown": case "KeyS": key[0] = 1; break;
        case "ArrowLeft": case "KeyA": case "KeyQ": key[1] = -1; break;
        case "ArrowRight": case "KeyD": key[1] = 1; break;
        case "ShiftLeft": case "ShiftRight": key[2] = 1; break;
        case "Space":
          // keep Space from scrolling the page or pressing a focused button
          event.preventDefault();
          if (!event.repeat) startMove("Slash");
          break;
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
      labelRenderer.setSize(window.innerWidth, window.innerHeight);
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
        anim: move ?? controls.current,
      });

      sky.follow(camera);
      monument.update(timer.getElapsed());
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);

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

    createPanel();

    // preview the character picked last time, then let the join screen appear
    showCharacter(loadSavedProfile()?.character ?? DEFAULT_CHARACTER, (fraction) => {
      if (!disposed) setLoadProgress(fraction);
    })
      .catch((error) => {
        console.error("Could not load the character model", error);
        if (!disposed) setLoadFailed(true);
      })
      .finally(() => {
        if (!disposed) setSceneReady(true);
      });

    return () => {
      disposed = true;
      sceneApiRef.current = null;

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
      skeleton?.dispose();

      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
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
        {/* dark backing keeps the text readable over bright sky and foliage */}
        <div className="inline-block rounded-lg bg-black/45 px-3 py-1.5 backdrop-blur-sm">
        <a
          className="pointer-events-auto text-red-400"
          href="https://threejs.org"
          target="_blank"
          rel="noopener"
        >
          three.js
        </a>{" "}
        - Skeletal Animation Walking (model by{" "}
        <a
          className="pointer-events-auto text-red-400"
          href="https://quaternius.com/"
          target="_blank"
          rel="noopener"
        >
          Quaternius
        </a>
        )
        <br />
        WASD / arrows to move, Shift to run, Space to slash, drag to orbit the camera
        <br />
        <span className={status === "online" ? "text-emerald-300" : "text-amber-300"}>
          {STATUS_TEXT[status]}
          {status === "online" && ` · ${playerCount} ${playerCount === 1 ? "player" : "players"}`}
        </span>
        </div>
      </div>
      {!sceneReady && (
        <p className="absolute inset-x-0 bottom-8 text-center text-sm text-white/80">
          Loading character…{loadProgress !== null && ` ${Math.round(loadProgress * 100)}%`}
        </p>
      )}
      {loadFailed && !joined && (
        <p className="absolute inset-x-0 top-24 text-center text-sm text-rose-200">
          Could not load the character. Check your connection, then refresh the page.
        </p>
      )}
      {sceneReady && !joined && (
        <JoinModal
          status={status}
          takenNames={takenNames}
          joining={joining}
          serverError={joinError}
          onPreview={(character) => sceneApiRef.current?.preview(character)}
          onSubmit={(name, character) => sceneApiRef.current?.join(name, character)}
        />
      )}
    </div>
  );
}
