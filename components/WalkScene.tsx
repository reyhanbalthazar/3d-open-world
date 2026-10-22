"use client";

// Port of https://threejs.org/examples/#webgl_animation_walk (MIT, three.js authors).

// @refresh reset
// The whole game (world, connection, key handling) lives in one effect, and Fast Refresh keeps an
// existing effect running when the code changes. Without this, an open tab in development keeps
// running old game code under new UI; with it, every edit remounts the game (back to the join screen).

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { SunLight } from "three/addons/lights/SunLight.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GUI } from "three/addons/libs/lil-gui.module.min.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import HuntingScore from "@/components/HuntingScore";
import JoinModal from "@/components/JoinModal";
import { MIXAMO_ANIMATIONS, type MixamoAnimationName } from "@/lib/animation-catalog";
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
import { BreakableWorld } from "@/lib/breakables";
import { Debris } from "@/lib/effects";
import { addNature, createGround } from "@/lib/nature";
import { loadSavedProfile, saveProfile, type SavedProfile } from "@/lib/profile";
import {
  MAX_BREAKS_PER_SWING,
  POINTS,
  TOOL_NAMES,
  TOOLS,
  type JoinErrorReason,
  type LocomotionName as ActionName,
  type PlayerState,
  type ToolName,
} from "@/lib/protocol";
import { Radar } from "@/lib/radar";
import { RemotePlayers, type Standing } from "@/lib/remote-players";
import { showScorePopup } from "@/lib/score-popups";
import { createMonument, MONUMENT_OBSTACLES, MONUMENT_POSITION } from "@/lib/monument";
import { createSky, HORIZON_COLOR } from "@/lib/sky";
import { CLEARING_RADIUS, generateTerrainLayout } from "@/lib/terrain-layout";
import { attachTools, showTool, TOOL_LABELS, TOOL_TARGETS } from "@/lib/tools";
import { MAP_HALF, MAP_SIZE, PLAYER_RADIUS, yawFromQuaternion } from "@/lib/world";

const RADAR_SIZE = 176;
// our arrow on the radar and our dot on the scoreboard (other players get a colour of their own)
const SELF_COLOR = "#ffffff";
// seconds to blend into and back out of a move like the sword slash
const MOVE_FADE = 0.2;
// when the swing lands, measured from the animation by scripts/bake-mixamo-animations.ts
const SLASH_IMPACT_TIME = MIXAMO_ANIMATIONS.find((animation) => animation.name === "Slash")!.impactTime;
// a swing reaches things within 70 degrees either side of where the character faces
const SWING_ARC_COS = Math.cos(THREE.MathUtils.degToRad(70));
// blows a tree takes before it falls
const AXE_BLOWS_TO_FELL = 3;
// number keys pick a tool; pressing the same one again puts it away
const TOOL_KEYS: Record<string, ToolName> = {
  Digit1: "hammer",
  Numpad1: "hammer",
  Digit2: "axe",
  Numpad2: "axe",
  Digit3: "sickle",
  Numpad3: "sickle",
};
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
  const [heldTool, setHeldTool] = useState<ToolName | null>(null);
  const [scoreboard, setScoreboard] = useState<{ self: Standing; others: Standing[] } | null>(null);

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
    // whether the current move's swing has already landed
    let moveLanded = false;
    let tools: Record<ToolName, THREE.Object3D> | undefined;
    let tool: ToolName | null = null;
    // what E takes out again
    let lastTool: ToolName = "hammer";
    // our id on the game server, to recognise our own breaks when the server echoes them
    let selfId: string | null = null;
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

    // TOOLS: the server decides what is broken; a swing only asks it
    const debris = new Debris(scene);

    // At the moment the swing lands, the tool in hand works on what is in front of us: the hammer
    // breaks the nearest rock, the axe chops the nearest tree (it falls on the last blow) and the
    // sickle cuts every plant within reach. It shows on our screen straight away; the server
    // confirms it for everyone (or puts things back).
    function toolBlow(held: ToolName) {
      const { breaks, reach } = TOOLS[held];
      const { x, z } = controls.position;
      const targets = world.inFront(breaks, x, z, yawFromQuaternion(group.quaternion), reach, SWING_ARC_COS);
      if (targets.length === 0) return;

      const ids = held === "sickle" ? targets.slice(0, MAX_BREAKS_PER_SWING).map((target) => target.id) : [targets[0].id];
      if (held === "axe" && world.hit(ids[0], x, z) < AXE_BLOWS_TO_FELL) return;
      for (const id of ids) world.break(id, { x, z }, true);
      net.breakThings(ids, currentState());
    }

    // "+N" over what we broke, once the server has counted it
    function popPoints(ids: number[]) {
      const targets = ids.flatMap((id) => world.get(id) ?? []);
      if (targets.length === 0) return;
      let points = 0;
      let x = 0;
      let z = 0;
      for (const target of targets) {
        points += POINTS[target.kind];
        x += target.x;
        z += target.z;
      }
      showScorePopup(scene, x / targets.length, z / targets.length, points);
    }

    // MULTIPLAYER

    const remotes = new RemotePlayers(scene);
    // our Hunting Score, as the server last counted it
    let score = 0;
    const refreshPlayers = () => {
      setPlayerCount(remotes.count + (joined ? 1 : 0));
      setTakenNames(remotes.names());
      if (joined && selfId && profile) {
        setScoreboard({ self: { id: selfId, name: profile.name, color: SELF_COLOR, score }, others: remotes.standings() });
      }
    };

    const net = connectMultiplayer({
      onWelcome(players, broken) {
        remotes.clear();
        for (const player of players) remotes.add(player);
        refreshPlayers();
        // match what the server says is broken, e.g. after a reconnect
        world.sync(broken);
      },
      onBroken(ids, by, total) {
        // what we broke ourselves is already broken on our screen
        const mine = by === selfId;
        const from = mine ? controls.position : remotes.positionOf(by);
        for (const id of ids) world.break(id, from, true);
        if (mine) {
          score = total;
          popPoints(ids);
        } else {
          remotes.setScore(by, total);
        }
        refreshPlayers();
      },
      onRestored(ids) {
        for (const id of ids) world.restore(id, true);
      },
      onJoined(id, points, token) {
        selfId = id;
        joined = true;
        score = points;
        // the token brings our score back if we reload the page and join under the same name
        if (profile) saveProfile({ ...profile, token });
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
        // someone coming back under the same name gets their score back with the token saved last time
        net.join(name, character, loadSavedProfile()?.token);
      },
    };

    // TERRAIN: grass ground, a forest border hiding the map edge, and trees, rocks, bushes,
    // flowers and grass inside, laid out the same way for every player

    scene.add(
      createGround(MAP_SIZE + GROUND_MARGIN * 2, terrain.paths, CLEARING_RADIUS, renderer.capabilities.getMaxAnisotropy()),
    );
    const nature = addNature(scene, terrain.placements, () => disposed);
    const world = new BreakableWorld(scene, nature, terrain.breakables, terrain.obstacles, debris);

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
      tools = attachTools(model);
      showTool(tools, tool);

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
      moveLanded = false;
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

    // Puts a tool in the hand, or puts it away (null).
    function holdTool(next: ToolName | null) {
      tool = next;
      if (next) lastTool = next;
      if (tools) showTool(tools, next);
      setHeldTool(next);
    }

    function currentState(): PlayerState {
      return {
        x: controls.position.x,
        z: controls.position.z,
        yaw: yawFromQuaternion(group.quaternion),
        anim: move ?? controls.current,
        tool,
      };
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
        // the swing lands: with a tool in hand, that is when it works on what is in front of us
        if (!moveLanded && action.time >= SLASH_IMPACT_TIME) {
          moveLanded = true;
          if (tool) toolBlow(tool);
        }
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
          if (obstacle.disabled) continue;
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
      const keyTool = TOOL_KEYS[event.code];
      if (keyTool) {
        if (!event.repeat) holdTool(tool === keyTool ? null : keyTool);
        return;
      }
      const key = controls.key;
      switch (event.code) {
        case "ArrowUp": case "KeyW": case "KeyZ": key[0] = -1; break;
        case "ArrowDown": case "KeyS": key[0] = 1; break;
        case "ArrowLeft": case "KeyA": case "KeyQ": key[1] = -1; break;
        case "ArrowRight": case "KeyD": key[1] = 1; break;
        case "ShiftLeft": case "ShiftRight": key[2] = 1; break;
        case "KeyE":
          // puts the tool away, or takes the last one out again
          if (!event.repeat) holdTool(tool ? null : lastTool);
          break;
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

      net.sendState(currentState());

      sky.follow(camera);
      monument.update(timer.getElapsed());
      world.update(delta);
      debris.update(delta);
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);

      viewDirection.subVectors(orbitControls.target, camera.position);
      radar.draw(
        { x: controls.position.x, z: controls.position.z, yaw, color: SELF_COLOR },
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
      world.dispose();
      debris.dispose();

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
        WASD / arrows to move, Shift to run, 1-3 for tools, Space to swing, drag to orbit the camera
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
      {joined && scoreboard && <HuntingScore self={scoreboard.self} others={scoreboard.others} />}
      {joined && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex flex-col items-center gap-2 select-none">
          <p className="rounded-full bg-black/45 px-3 py-1 font-mono text-[12px] text-white/85 backdrop-blur-sm">
            {heldTool
              ? `Space: swing the ${TOOL_LABELS[heldTool].toLowerCase()} at ${TOOL_TARGETS[heldTool].toLowerCase()} · E: put it away`
              : "Press 1-3 to take out a tool"}
          </p>
          <ul className="flex gap-2" aria-label="Tools">
            {TOOL_NAMES.map((name, index) => (
              <li
                key={name}
                aria-current={heldTool === name}
                className={`flex min-w-[96px] flex-col items-center rounded-xl border px-3 py-1.5 backdrop-blur-sm transition-colors ${
                  heldTool === name ? "border-amber-200 bg-amber-500/90 text-zinc-950" : "border-white/15 bg-black/50 text-white/85"
                }`}
              >
                <span className="font-mono text-[11px] opacity-70">{index + 1}</span>
                <span className="text-sm font-semibold">{TOOL_LABELS[name]}</span>
                <span className="text-[11px] opacity-75">
                  {TOOL_TARGETS[name]} · +{POINTS[TOOLS[name].breaks]}
                </span>
              </li>
            ))}
          </ul>
        </div>
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
