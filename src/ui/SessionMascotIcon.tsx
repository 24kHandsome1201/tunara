import catUrl from "@/assets/mascots/cat.svg";
import dogUrl from "@/assets/mascots/dog.svg";
import foxUrl from "@/assets/mascots/fox.svg";
import frogUrl from "@/assets/mascots/frog.svg";
import hamsterUrl from "@/assets/mascots/hamster.svg";
import koalaUrl from "@/assets/mascots/koala.svg";
import pandaUrl from "@/assets/mascots/panda.svg";
import penguinUrl from "@/assets/mascots/penguin.svg";
import rabbitUrl from "@/assets/mascots/rabbit.svg";
import lionUrl from "@/assets/mascots/lion.svg";
import bearUrl from "@/assets/mascots/bear.svg";
import owlUrl from "@/assets/mascots/owl.svg";
import hedgehogUrl from "@/assets/mascots/hedgehog.svg";
import raccoonUrl from "@/assets/mascots/raccoon.svg";
import slothUrl from "@/assets/mascots/sloth.svg";
import otterUrl from "@/assets/mascots/otter.svg";
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
