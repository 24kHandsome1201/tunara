// Force files instead of Vite's small-asset data URLs. The desktop CSP keeps
// `img-src` intentionally free of `data:`, so an inlined SVG would render as
// an empty mascot while larger files happened to work.
import catUrl from "@/assets/mascots/cat.svg?no-inline";
import dogUrl from "@/assets/mascots/dog.svg?no-inline";
import foxUrl from "@/assets/mascots/fox.svg?no-inline";
import frogUrl from "@/assets/mascots/frog.svg?no-inline";
import hamsterUrl from "@/assets/mascots/hamster.svg?no-inline";
import koalaUrl from "@/assets/mascots/koala.svg?no-inline";
import pandaUrl from "@/assets/mascots/panda.svg?no-inline";
import penguinUrl from "@/assets/mascots/penguin.svg?no-inline";
import rabbitUrl from "@/assets/mascots/rabbit.svg?no-inline";
import lionUrl from "@/assets/mascots/lion.svg?no-inline";
import bearUrl from "@/assets/mascots/bear.svg?no-inline";
import owlUrl from "@/assets/mascots/owl.svg?no-inline";
import hedgehogUrl from "@/assets/mascots/hedgehog.svg?no-inline";
import raccoonUrl from "@/assets/mascots/raccoon.svg?no-inline";
import slothUrl from "@/assets/mascots/sloth.svg?no-inline";
import otterUrl from "@/assets/mascots/otter.svg?no-inline";
import { SESSION_MASCOT_IDS, type SessionMascotId } from "@/modules/session/session-mascot";

const MASCOT_URLS: Record<SessionMascotId, string> = {
  cat: catUrl,
  dog: dogUrl,
  fox: foxUrl,
  panda: pandaUrl,
  hamster: hamsterUrl,
  frog: frogUrl,
  koala: koalaUrl,
  penguin: penguinUrl,
  rabbit: rabbitUrl,
  lion: lionUrl,
  bear: bearUrl,
  owl: owlUrl,
  hedgehog: hedgehogUrl,
  raccoon: raccoonUrl,
  sloth: slothUrl,
  otter: otterUrl,
};

export const SESSION_MASCOTS = SESSION_MASCOT_IDS.map((id) => ({
  id,
  url: MASCOT_URLS[id],
  labelKey: `mascot.${id}`,
}));

export function SessionMascotIcon({ id, size = 24 }: { id: SessionMascotId; size?: number }) {
  return (
    <img
      src={MASCOT_URLS[id]}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={size}
      height={size}
      style={{ width: size, height: size, display: "block", objectFit: "contain", flexShrink: 0, userSelect: "none" }}
    />
  );
}
