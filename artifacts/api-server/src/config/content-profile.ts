export type ContentProfileId = "business" | "crypto";

export interface SourceSeed {
  name: string;
  url: string;
  type: "telegram_channel" | "rss";
  isPrimary: boolean;
  category: string;
}

export interface ContentProfile {
  id: ContentProfileId;
  instanceKey: string;
  channelName: string;
  dashboardSubtitle: string;
  channelSignature: string;
  botDescription: string;
  defaultSources: SourceSeed[];
  scheduleDefaults: {
    enabled: boolean;
    intervalHours: number;
    maxPostsPerDay: number;
    autoPublish: boolean;
    postingTimezone: string;
    postingStartTime: string;
    postingEndTime: string;
    nightPauseEnabled: boolean;
    nightPauseStart: string;
    nightPauseEnd: string;
    minPostsPerDay: number;
    targetPostsPerDay: number;
    minMinutesBetweenPosts: number;
    maxMinutesBetweenPosts: number;
    randomDelayEnabled: boolean;
    randomDelayMinutes: number;
  };
  settingsDefaults: {
    openaiModel: string;
    maxAiCallsPerDay: number;
    maxPostsPerDay: number;
    minPostsPerDay: number;
    maxRewritePerPost: number;
    maxTokensPerPost: number;
    maxSourcePostsPerChannel: number;
    lookbackHours: number;
    enableCostGuard: boolean;
    autoPublish: boolean;
    postingRequiresApproval: boolean;
    enableSecondarySourcesi: boolean;
  };
}

export const BUSINESS_SOURCES: SourceSeed[] = [
  { name: "Державна податкова служба", url: "@tax_gov_ua", type: "telegram_channel", isPrimary: true, category: "Податки" },
  { name: "Національний банк України", url: "@nbu_ua", type: "telegram_channel", isPrimary: true, category: "Економіка" },
  { name: "Міністерство економіки України", url: "@mineconomdevUA", type: "telegram_channel", isPrimary: true, category: "Бізнес" },
  { name: "Міністерство фінансів України", url: "@MOF_ua", type: "telegram_channel", isPrimary: true, category: "Фінанси" },
  { name: "Уряд online", url: "@uriad24", type: "telegram_channel", isPrimary: true, category: "Регулювання" },
  { name: "Дія", url: "@diia_gov", type: "telegram_channel", isPrimary: true, category: "Держпослуги" },
  { name: "Економічна правда", url: "@epravda", type: "telegram_channel", isPrimary: false, category: "Бізнес-медіа" },
  { name: "Forbes Ukraine", url: "@Forbes_Ukraine_official", type: "telegram_channel", isPrimary: false, category: "Бізнес-медіа" },
  { name: "Опендатамедіа", url: "@OpendatabotChannel", type: "telegram_channel", isPrimary: false, category: "Бізнес-дані" },
  { name: "European Central Bank", url: "https://www.ecb.europa.eu/rss/press.html", type: "rss", isPrimary: true, category: "Світова економіка" },
  { name: "Federal Reserve Monetary Policy", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", type: "rss", isPrimary: true, category: "Світова економіка" },
];

export const CRYPTO_SOURCES: SourceSeed[] = [
  { name: "TON Blockchain", url: "@ton_blockchain", type: "telegram_channel", isPrimary: true, category: "TON" },
  { name: "TON Community", url: "@toncoin", type: "telegram_channel", isPrimary: true, category: "TON" },
  { name: "Pavel Durov", url: "@durov", type: "telegram_channel", isPrimary: true, category: "Telegram" },
  { name: "Telegram", url: "@telegram", type: "telegram_channel", isPrimary: true, category: "Telegram" },
  { name: "The Open Network", url: "@the_open_network", type: "telegram_channel", isPrimary: true, category: "TON" },
  { name: "Cryptwit", url: "@cryptwit", type: "telegram_channel", isPrimary: false, category: "Крипторынок" },
  { name: "TON Insider", url: "@TON_ins", type: "telegram_channel", isPrimary: false, category: "TON" },
  { name: "TON Всезнайка", url: "@ton_vseznayka", type: "telegram_channel", isPrimary: false, category: "TON" },
  { name: "Give Me TON", url: "@givemetonru", type: "telegram_channel", isPrimary: false, category: "TON" },
  { name: "InvestKingy", url: "@investkingyru", type: "telegram_channel", isPrimary: false, category: "Крипторынок" },
];

const PROFILE_DEFAULTS: Record<ContentProfileId, Omit<ContentProfile, "instanceKey" | "channelName" | "dashboardSubtitle" | "channelSignature"> & {
  channelName: string;
  dashboardSubtitle: string;
  channelSignature: string;
}> = {
  business: {
    id: "business",
    channelName: "ЦФЮК | Бізнес",
    dashboardSubtitle: "Автопостинг бізнес-новин у Telegram",
    channelSignature: "@fincentre_business",
    botDescription: "Автопостинг перевірених новин про бізнес та економіку.",
    defaultSources: BUSINESS_SOURCES,
    scheduleDefaults: {
      enabled: false,
      intervalHours: 4,
      maxPostsPerDay: 6,
      autoPublish: false,
      postingTimezone: "Europe/Kyiv",
      postingStartTime: "09:00",
      postingEndTime: "21:30",
      nightPauseEnabled: true,
      nightPauseStart: "22:00",
      nightPauseEnd: "08:30",
      minPostsPerDay: 4,
      targetPostsPerDay: 5,
      minMinutesBetweenPosts: 120,
      maxMinutesBetweenPosts: 240,
      randomDelayEnabled: true,
      randomDelayMinutes: 40,
    },
    settingsDefaults: {
      openaiModel: "gpt-5.6-luna",
      maxAiCallsPerDay: 40,
      maxPostsPerDay: 6,
      minPostsPerDay: 4,
      maxRewritePerPost: 1,
      maxTokensPerPost: 900,
      maxSourcePostsPerChannel: 20,
      lookbackHours: 24,
      enableCostGuard: true,
      autoPublish: false,
      postingRequiresApproval: true,
      enableSecondarySourcesi: true,
    },
  },
  crypto: {
    id: "crypto",
    channelName: "TONKOFF",
    dashboardSubtitle: "Автопостинг крипто-новостей в Telegram",
    channelSignature: "@tonkoff_crypto",
    botDescription: "Автопостинг важных и интересных новостей о крипторынке, TON и Telegram.",
    defaultSources: CRYPTO_SOURCES,
    scheduleDefaults: {
      enabled: false,
      intervalHours: 3,
      maxPostsPerDay: 8,
      autoPublish: false,
      postingTimezone: "Europe/Kyiv",
      postingStartTime: "09:00",
      postingEndTime: "23:30",
      nightPauseEnabled: true,
      nightPauseStart: "00:00",
      nightPauseEnd: "08:30",
      minPostsPerDay: 6,
      targetPostsPerDay: 7,
      minMinutesBetweenPosts: 75,
      maxMinutesBetweenPosts: 180,
      randomDelayEnabled: true,
      randomDelayMinutes: 25,
    },
    settingsDefaults: {
      openaiModel: "gpt-5.6-luna",
      maxAiCallsPerDay: 50,
      maxPostsPerDay: 8,
      minPostsPerDay: 6,
      maxRewritePerPost: 1,
      maxTokensPerPost: 1100,
      maxSourcePostsPerChannel: 20,
      lookbackHours: 24,
      enableCostGuard: true,
      autoPublish: false,
      postingRequiresApproval: true,
      enableSecondarySourcesi: false,
    },
  },
};

function readProfileId(): ContentProfileId {
  const value = (process.env.CONTENT_PROFILE ?? "business").trim().toLowerCase();
  if (value === "business" || value === "crypto") return value;
  throw new Error(`Unsupported CONTENT_PROFILE="${value}". Use "business" or "crypto".`);
}

function readSignature(fallback: string): string {
  const value = (process.env.CHANNEL_SIGNATURE ?? fallback).trim();
  if (!/^@[A-Za-z0-9_]{5,32}$/.test(value)) {
    throw new Error("CHANNEL_SIGNATURE must be a Telegram handle such as @channel_name");
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be "true" or "false"`);
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function getContentProfile(): ContentProfile {
  const id = readProfileId();
  const defaults = PROFILE_DEFAULTS[id];
  return {
    ...defaults,
    instanceKey: (process.env.BOT_INSTANCE_ID ?? id).trim(),
    channelName: (process.env.CHANNEL_DISPLAY_NAME ?? defaults.channelName).trim(),
    dashboardSubtitle: (process.env.CHANNEL_SUBTITLE ?? defaults.dashboardSubtitle).trim(),
    channelSignature: readSignature(defaults.channelSignature),
    scheduleDefaults: {
      ...defaults.scheduleDefaults,
      enabled: readBoolean("SCHEDULE_ENABLED", defaults.scheduleDefaults.enabled),
      autoPublish: readBoolean("AUTO_PUBLISH", defaults.scheduleDefaults.autoPublish),
      maxPostsPerDay: readPositiveInteger("MAX_AUTO_POSTS_PER_DAY", defaults.scheduleDefaults.maxPostsPerDay),
      postingTimezone: process.env.POSTING_TIMEZONE ?? defaults.scheduleDefaults.postingTimezone,
      postingStartTime: process.env.POSTING_START_TIME ?? defaults.scheduleDefaults.postingStartTime,
      postingEndTime: process.env.POSTING_END_TIME ?? defaults.scheduleDefaults.postingEndTime,
      nightPauseEnabled: readBoolean("NIGHT_PAUSE_ENABLED", defaults.scheduleDefaults.nightPauseEnabled),
      nightPauseStart: process.env.NIGHT_PAUSE_START ?? defaults.scheduleDefaults.nightPauseStart,
      nightPauseEnd: process.env.NIGHT_PAUSE_END ?? defaults.scheduleDefaults.nightPauseEnd,
      minPostsPerDay: readPositiveInteger("MIN_AUTO_POSTS_PER_DAY", defaults.scheduleDefaults.minPostsPerDay),
      targetPostsPerDay: readPositiveInteger("TARGET_AUTO_POSTS_PER_DAY", defaults.scheduleDefaults.targetPostsPerDay),
      minMinutesBetweenPosts: readPositiveInteger("MIN_MINUTES_BETWEEN_POSTS", defaults.scheduleDefaults.minMinutesBetweenPosts),
      maxMinutesBetweenPosts: readPositiveInteger("MAX_MINUTES_BETWEEN_POSTS", defaults.scheduleDefaults.maxMinutesBetweenPosts),
      randomDelayEnabled: readBoolean("POSTING_RANDOM_DELAY_ENABLED", defaults.scheduleDefaults.randomDelayEnabled),
      randomDelayMinutes: readPositiveInteger("POSTING_RANDOM_DELAY_MINUTES", defaults.scheduleDefaults.randomDelayMinutes),
    },
    settingsDefaults: {
      ...defaults.settingsDefaults,
      openaiModel: process.env.OPENAI_MODEL ?? defaults.settingsDefaults.openaiModel,
      maxAiCallsPerDay: readPositiveInteger("MAX_AI_CALLS_PER_DAY", defaults.settingsDefaults.maxAiCallsPerDay),
      maxPostsPerDay: readPositiveInteger("MAX_POSTS_PER_DAY", defaults.settingsDefaults.maxPostsPerDay),
      minPostsPerDay: readPositiveInteger("MIN_POSTS_PER_DAY", defaults.settingsDefaults.minPostsPerDay),
      maxRewritePerPost: readPositiveInteger("MAX_REWRITE_PER_POST", defaults.settingsDefaults.maxRewritePerPost),
      maxTokensPerPost: readPositiveInteger("MAX_TOKENS_PER_POST", defaults.settingsDefaults.maxTokensPerPost),
      maxSourcePostsPerChannel: readPositiveInteger("MAX_SOURCE_POSTS_PER_CHANNEL", defaults.settingsDefaults.maxSourcePostsPerChannel),
      lookbackHours: readPositiveInteger("LOOKBACK_HOURS", defaults.settingsDefaults.lookbackHours),
      enableCostGuard: readBoolean("ENABLE_COST_GUARD", defaults.settingsDefaults.enableCostGuard),
      autoPublish: readBoolean("AUTO_PUBLISH", defaults.settingsDefaults.autoPublish),
      postingRequiresApproval: readBoolean("POSTING_REQUIRES_APPROVAL", defaults.settingsDefaults.postingRequiresApproval),
      enableSecondarySourcesi: readBoolean("ENABLE_SECONDARY_SOURCES", defaults.settingsDefaults.enableSecondarySourcesi),
    },
  };
}
