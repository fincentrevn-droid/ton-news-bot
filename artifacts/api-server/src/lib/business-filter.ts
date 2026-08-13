const BUSINESS_KEYWORDS = [
  // Ukraine: business, taxes and regulation
  "бізнес", "підприєм", "фоп", "тов", "подат", "пдв", "єсв", "акциз",
  "декларац", "звітн", "податкова накладна", "ліценз", "дозвіл", "штраф",
  "митн", "експорт", "імпорт", "держпідтрим", "грант", "кредит", "іпотек",
  "бронюван", "працевлашт", "ринок праці", "зарплат", "ваканс",
  "реєстр", "регуля", "закон", "законопроєкт", "постанова", "наказ",
  "тендер", "закупів", "приватизац", "дерегуляц", "єдиний податок",

  // Economy and markets with a direct business impact
  "економ", "ввп", "бюджет", "дефіцит", "держборг", "інфляц", "дефляц",
  "обліков", "процентн", "центробанк", "нбу", "валют", "курс гривні", "гривн",
  "банк", "кредитув", "інвест", "капітал", "торгівл", "виробництв",
  "промислов", "агро", "логіст", "перевезен", "енерг", "електроенерг",
  "нафт", "газ", "тариф", "ціни виробників", "санкц", "мито",
  "євросоюз", "єс ", "єврокоміс", "відновлен", "страхуван",

  // Global economy
  "business", "economy", "economic", "gdp", "inflation", "deflation",
  "interest rate", "monetary policy", "central bank", "federal reserve", "fomc",
  "ecb", "trade", "tariff", "sanction", "export", "import", "investment",
  "recession", "employment", "labor market", "supply chain", "logistics",
  "energy", "oil", "gas", "commodity", "regulation", "tax", "customs",
];

const HARD_BLOCK_PATTERNS = [
  // The repurposed channel is not a crypto channel.
  /\b(bitcoin|ethereum|toncoin|memecoin|airdrop|blockchain|crypto|defi|nft)\b/i,
  /(біткоїн|біткойн|ефіріум|тонкоїн|криптовалют|крипторин|криптоактив|аірдроп)/iu,
  // Topics that do not belong in a business/economy feed.
  /(футбол|баскетбол|теніс|\bufc\b|чемпіонат|спортсмен|матч|гол у ворота)/iu,
  /(шоу-бізнес|гороскоп|серіал|кінотеатр|прем'єра фільму|зіркове весілля)/iu,
  /(вбивство|пограбування|дтп|кримінальна хроніка)/iu,
];

const PROMO_PATTERNS = [
  /(реєструйтеся|зареєструйтеся|запрошуємо на|долучайтеся до вебінару)/iu,
  /(вебінар|майстер-клас|безкоштовний курс|промокод|розіграш|квитки вже у продажу)/iu,
  /(партнерський матеріал|рекламна інтеграція|на правах реклами)/iu,
];

export function scoreBusinessRelevance(text: string): number {
  const normalized = text.toLowerCase();
  return BUSINESS_KEYWORDS.reduce(
    (score, keyword) => score + (normalized.includes(keyword) ? 1 : 0),
    0,
  );
}

export function isHardBlockedSource(text: string): boolean {
  return [...HARD_BLOCK_PATTERNS, ...PROMO_PATTERNS].some((pattern) => pattern.test(text));
}

/**
 * Legal, tax and regulatory claims are too risky to republish from media.
 * They remain eligible only when the configured source is marked as primary.
 */
export function hasHighRiskRegulatoryClaim(text: string): boolean {
  return /(подат\p{L}*|пдв|єсв|акциз\p{L}*|декларац\p{L}*|звітн\p{L}*|штраф\p{L}*|пен[іяі]\p{L}*|закон\p{L}*|законопроєкт\p{L}*|постанова\p{L}*|наказ\p{L}*|ліценз\p{L}*|дозвіл\p{L}*|митн\p{L}*|мито|тариф\p{L}*|бронюван\p{L}*|обов'яз\p{L}*|набуває чинності|граничн\p{L}* строк\p{L}*)/iu.test(text);
}

const DUPLICATE_STOP_WORDS = new Set([
  "авжеж", "адже", "або", "але", "без", "був", "була", "були", "буде",
  "для", "його", "її", "між", "над", "під", "про", "при", "також", "того",
  "уже", "через", "щодо", "який", "яка", "які", "this", "that", "with", "from",
  "have", "will", "into", "about", "after", "before", "their", "they", "were",
]);

function meaningfulTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length >= 4 && !DUPLICATE_STOP_WORDS.has(token))
      .slice(0, 160) ?? [],
  );
}

/** Detect near-duplicate coverage of the same story across different sources. */
export function areLikelyDuplicate(left: string, right: string): boolean {
  const a = meaningfulTokens(left);
  const b = meaningfulTokens(right);
  if (a.size < 5 || b.size < 5) return false;

  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared++;
  }

  return shared >= 5 && shared / Math.min(a.size, b.size) >= 0.62;
}

export const MIN_BUSINESS_RELEVANCE_SCORE = 2;
