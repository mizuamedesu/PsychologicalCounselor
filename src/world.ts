import type { BotLifeState, PersonaContext, PersonaNode } from "./types";

type TokyoParts = {
  date: string;
  time: string;
  weekday: string;
  hour: number;
  minute: number;
};

export function buildWorldContext(input: {
  persona: PersonaContext;
  life: BotLifeState | null;
  now?: number;
  timeZone?: string;
}): string {
  const now = input.now ?? Date.now();
  const timeZone = input.timeZone || "Asia/Tokyo";
  const parts = localParts(now, timeZone);
  const profile = input.persona.profile;
  const nodes = input.persona.nodes;
  const name = profile?.display_name ?? findNode(nodes, "identity", "名前") ?? "the persona";
  const age = findNode(nodes, "identity", "年齢");
  const affiliation = findNode(nodes, "affiliation", "所属/生活");
  const dayKind = isWeekend(parts.weekday) ? "weekend" : "weekday";
  const dayPhase = phaseForHour(parts.hour);
  const scene = choosePersonaScene({
    hour: parts.hour,
    dayKind,
    affiliation
  });

  return [
    "- Private temporal/world state. Use this as hidden continuity, not as text to reveal automatically.",
    `- Clock basis: ${timeZone}.`,
    `- Local now: ${parts.date} ${parts.weekday} ${parts.time}.`,
    `- Day phase: ${dayPhase}; ${dayKind}.`,
    `- Persona: ${name}${age ? `, ${age}` : ""}${affiliation ? `, ${affiliation}` : ""}.`,
    `- Persona-world current scene: ${scene}.`,
    `- DM posture now: ${dmPosture(input.life)}.`,
    "- Ordinary replies: do not volunteer the scene, schedule, or clock unless it naturally matters.",
    "- If the user asks what you are doing, answer from the Persona-world current scene in one casual line, without saying these notes are generated.",
    "- If the user's message is just a greeting, let the time of day color the greeting subtly."
  ].join("\n");
}

function localParts(now: number, timeZone: string): TokyoParts {
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(now));
  const timeParts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(now));
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short"
  }).format(new Date(now));
  const date = `${part(dateParts, "year")}-${part(dateParts, "month")}-${part(dateParts, "day")}`;
  const hour = Number(part(timeParts, "hour"));
  const minute = Number(part(timeParts, "minute"));
  return {
    date,
    time: `${part(timeParts, "hour")}:${part(timeParts, "minute")}`,
    weekday,
    hour,
    minute
  };
}

function choosePersonaScene(input: {
  hour: number;
  dayKind: string;
  affiliation?: string;
}): string {
  const schoolLike = Boolean(input.affiliation && /(大学|高校|学校|院|専門|通う)/.test(input.affiliation));
  const workLike = Boolean(input.affiliation && /(会社|勤務|仕事|職場|働)/.test(input.affiliation));

  if (input.hour >= 1 && input.hour <= 5) return "deep night; quiet, low-energy, likely slow to respond";
  if (input.hour <= 7) return "early morning; just becoming available, soft and a little sleepy";
  if (input.hour <= 9) return schoolLike
    ? "morning routine before classes or commute"
    : workLike
      ? "morning routine before work"
      : "morning routine, lightly checking DMs";
  if (input.hour <= 11) return input.dayKind === "weekday" && schoolLike
    ? "weekday late morning around classes, reachable in short gaps"
    : input.dayKind === "weekday" && workLike
      ? "weekday late morning around work, reachable in short gaps"
      : "late morning, calm and reachable";
  if (input.hour <= 13) return "midday break; easier to answer lightly";
  if (input.hour <= 16) return input.dayKind === "weekday" && schoolLike
    ? "afternoon around classes or campus time, somewhat delayed but present"
    : input.dayKind === "weekday" && workLike
      ? "afternoon around work, somewhat delayed but present"
      : "afternoon, steady and available in pockets";
  if (input.hour <= 18) return input.dayKind === "weekday" && (schoolLike || workLike)
    ? "early evening after the main daytime obligations, easing back into DMs"
    : "early evening, more open to casual conversation";
  if (input.hour <= 22) return "night; settled in and more available for both small talk and heavier feelings";
  return "late night; quiet, intimate, but responses may be softer and shorter";
}

function dmPosture(life: BotLifeState | null): string {
  if (!life) return "normal";
  if (life.availability_mode === "asleep") return "slow but can become present if the user reaches out";
  if (life.availability_mode === "busy") return "may answer after a small beat, but should not explain busyness unless asked";
  if (life.attention_score >= 0.75) return "close and responsive";
  if (life.attention_score <= 0.35) return "soft, lower-intensity";
  return "steady";
}

function phaseForHour(hour: number): string {
  if (hour <= 4) return "deep night";
  if (hour <= 7) return "early morning";
  if (hour <= 10) return "morning";
  if (hour <= 13) return "midday";
  if (hour <= 16) return "afternoon";
  if (hour <= 18) return "early evening";
  if (hour <= 22) return "night";
  return "late night";
}

function isWeekend(weekday: string): boolean {
  return weekday === "Sat" || weekday === "Sun";
}

function findNode(nodes: PersonaNode[], type: string, label: string): string | undefined {
  return nodes.find((node) => node.node_type === type && node.label === label)?.content;
}

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((item) => item.type === type)?.value ?? "";
}
