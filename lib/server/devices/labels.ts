import "server-only";

/**
 * Device labels shown to other devices on the network ("Blue Fox", 04 §3.2) and coarse
 * platform names ("iPhone · Safari"). A tiny internal parser (DV1-7): only a few broad
 * families are needed, and nothing finer is stored.
 */

const ADJECTIVES = [
  "Amber", "Blue", "Brave", "Bright", "Calm", "Clever", "Coral", "Crimson", "Gentle", "Golden", "Green", "Happy",
  "Indigo", "Jolly", "Lucky", "Mellow", "Misty", "Olive", "Quiet", "Rapid", "Silver", "Sunny", "Swift", "Teal",
  "Violet", "Witty",
];
const ANIMALS = [
  "Badger", "Bear", "Crane", "Dolphin", "Eagle", "Falcon", "Fox", "Gecko", "Hare", "Heron", "Koala", "Lynx", "Moose",
  "Otter", "Owl", "Panda", "Puffin", "Raven", "Robin", "Seal", "Swan", "Tiger", "Turtle", "Whale", "Wolf", "Yak",
];

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))] as T;
}

export function generateDeviceLabel(random: () => number = Math.random): string {
  return `${pick(ADJECTIVES, random)} ${pick(ANIMALS, random)}`;
}

const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F؜​-‏‪-‮⁠-⁩﻿]/g;

/**
 * A user-chosen label, shown to everyone on the network: no invisible or bidi characters.
 * Also cleans account display names (Phase 4, §17.5.5), which may be up to 60 characters.
 */
export function cleanLabel(input: string, maxLength = 40): string {
  return input
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

const OS_RULES: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Macintosh|Mac OS X/, "Mac"],
  [/Linux/, "Linux"],
];
const BROWSER_RULES: [RegExp, string][] = [
  [/Edg(A|iOS)?\//, "Edge"],
  [/OPR\//, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/CriOS\/|Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

function first(rules: [RegExp, string][], ua: string): string | null {
  return rules.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
}

export function platformFromUserAgent(userAgent: string | null): string {
  if (!userAgent) return "";
  const ua = userAgent.slice(0, 512);
  return [first(OS_RULES, ua), first(BROWSER_RULES, ua)].filter(Boolean).join(" · ").slice(0, 60);
}

export function userAgentFamily(userAgent: string | null): string {
  return (userAgent && first(BROWSER_RULES, userAgent.slice(0, 512))) || "Other";
}
