import type * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

// "+10" rising from what the player just broke: what it added to their Hunting Score.

// metres above the ground where it appears
const HEIGHT = 1.4;
const DURATION_MS = 1300;
// how far it floats up, in pixels
const RISE = 48;

export function showScorePopup(scene: THREE.Scene, x: number, z: number, points: number) {
  const text = document.createElement("span");
  text.className = "block font-sans text-2xl font-extrabold text-amber-300 tabular-nums";
  // readable over bright sky and foliage
  text.style.textShadow = "0 1px 2px rgb(0 0 0 / 0.85), 0 0 10px rgb(0 0 0 / 0.4)";
  text.textContent = `+${points}`;
  const element = document.createElement("div");
  element.append(text);

  const popup = new CSS2DObject(element);
  popup.position.set(x, HEIGHT, z);
  scene.add(popup);

  // the renderer places the outer element; the text inside pops in, floats up and fades
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const keyframes: Keyframe[] = still
    ? [{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }]
    : [
        { opacity: 0, transform: "translateY(8px) scale(0.6)" },
        { opacity: 1, transform: "translateY(0) scale(1.15)", offset: 0.12 },
        { opacity: 1, transform: `translateY(${-RISE * 0.6}px) scale(1)`, offset: 0.6 },
        { opacity: 0, transform: `translateY(${-RISE}px) scale(1)` },
      ];
  const animation = text.animate(keyframes, { duration: DURATION_MS, easing: "ease-out", fill: "forwards" });
  animation.onfinish = () => popup.removeFromParent();
}
