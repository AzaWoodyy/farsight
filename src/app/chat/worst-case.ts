import type { ChatCard, ChatUIMessage, ShownAnswer } from "@/lib/agent/chat-types";
import type { Conversation } from "./conversations";

export const DATA_MODES = ["demo", "worst", "empty", "one", "long"] as const;

export type DataMode = (typeof DATA_MODES)[number];

export const DATA_MODE_LABEL: Record<DataMode, string> = { demo: "Demo data", worst: "Worst case", empty: "Empty", one: "One", long: "200 messages" };

export const WORST_LOGIN = "bartholomew.fitzgerald@northwind-industries-holdings.example.com";

const DAY_MS = 86_400_000;
const MISSING_IMAGE = "https://static.wikia.nocookie.net/lolesports_gamepedia_en/images/0/00/Missing_On_Purpose.png";
const LONG_URL = "https://example.com/workspaces/acme/projects/q3-launch/docs/9f8e7d6c5b4a?tab=comments&filter=unresolved";

export function dataMode(): DataMode {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return "demo";

  const asked = new URLSearchParams(window.location.search).get("data");

  return DATA_MODES.find((mode) => mode === asked) ?? "demo";
}

let serial = 0;

const user = (text: string): ChatUIMessage => ({ id: `u${serial++}`, role: "user", parts: [{ type: "text", text }] });

const answer = (card: ChatCard | null, sources: ShownAnswer["sources"] = []): ChatUIMessage["parts"][number] => ({
  type: "data-answer",
  id: `c${serial++}`,
  data: { asked: "worst case", via: "pipeline", pending: false, card, sources, digest: null },
});

const reply = (...parts: ChatUIMessage["parts"]): ChatUIMessage => ({ id: `a${serial++}`, role: "assistant", parts });

const text = (value: string): ChatUIMessage["parts"][number] => ({ type: "text", text: value });

const COMPARISON: ChatCard = {
  title: "Aleksandra Wiśniewska-Kowalczyk vs Christopher Alexander Montgomery III — Mid-Season Invitational 2025, phase de groupes",
  subjects: [
    { name: "Aleksandra Wiśniewska-Kowalczyk", line: "Mid · Hanwha Life Esports Challengers, Nongshim RedForce Academy, Kwangdong Freecs", image: { src: MISSING_IMAGE, photo: true } },
    { name: "Christopher Alexander Montgomery III", line: null, image: null },
  ],
  stats: [
    { label: "Séries", value: "Hanwha Life Esports Challengers 12 – 11 Nongshim RedForce Academy" },
    { label: "Parties", value: "1 284 – 1 000 000" },
    { label: "Écart d’or moyen à 15 minutes", value: "-42,5" },
    { label: "Victoires", value: "0 %" },
  ],
  bars: null,
  icons: { "Aleksandra Wiśniewska-Kowalczyk": { src: MISSING_IMAGE, photo: true }, "Hanwha Life Esports Challengers": { src: MISSING_IMAGE } },
  table: {
    columns: ["joueur", "équipe", "parties", "avg gold difference at 15", "dégâts par minute", "% victoires"],
    numeric: [false, false, true, true, true, true],
    total: 3,
    rows: [
      ["Aleksandra Wiśniewska-Kowalczyk", "Hanwha Life Esports Challengers", 1284, 12345678.9, -42.5, "142 %"],
      ["Jo", null, 1, 0, null, "0 %"],
      ["bartholomew.fitzgerald@northwind-industries-holdings.example.com", "Đặng Thị Ngọc Hân", 0, null, 0.30000000000000004, "-3 %"],
    ],
  },
};

const POOL: ChatCard = {
  title: "J",
  subjects: [{ name: "Jo", line: "Senior Product Design Engineer, Platform Infrastructure", image: null }],
  stats: [{ label: "Parties", value: "1" }],
  icons: { "王秀英": { src: MISSING_IMAGE } },
  table: null,
  bars: [
    { label: "customer-feedback-from-enterprise-onboarding", value: 142, text: "1 284 p. · 142 %" },
    { label: "Đặng Thị Ngọc Hân", value: -3, text: "0 p. · -3 %" },
    { label: "王秀英", value: 0, text: "1 p. · 0 %" },
    { label: "🦊 Fox", value: 100, text: "12 345 678 p. · 100 %" },
    { label: "نور الهدى عبد الرحمن", value: 50, text: "5 p. · 50 %" },
  ],
};

const LISTING: ChatCard = {
  title: "Benachrichtigungseinstellungen",
  subjects: [],
  stats: [],
  bars: null,
  icons: {},
  table: {
    columns: ["rang", "joueur", "équipe"],
    numeric: [true, false, false],
    total: 1284,
    rows: Array.from({ length: 40 }, (_, i) => [i + 1, i % 3 === 0 ? "Konstantin Oberhauser-Wettstein" : i % 3 === 1 ? "J" : "Seán O'Brien-Ó Súilleabháin", i % 4 === 0 ? null : "Movistar KOI Fénix Academy"]),
  },
};

const SOURCES = Array.from({ length: 8 }, (_, i) => ({ label: `Leaguepedia — 2025 Mid-Season Invitational/Play-In/Scoreboards/Week ${i + 1}/Bracket Stage Day ${i + 1}`, url: `${LONG_URL}&page=${i}` }));

const WIDE_HTML =
  '<h2 class="kit-title">Benachrichtigungseinstellungen und Paramètres de confidentialité et de sécurité</h2>' +
  '<table class="kit-table" style="width:900px"><tr><th>IMG_20250914_183022_HDR_portrait_edited_edited.HEIC</th><th class="num">12345678.9</th></tr><tr><td>9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f</td><td class="num best">-42.5</td></tr></table>' +
  '<div class="kit-bars"><div class="kit-bar" style="--v:142%"><span>customer-feedback-from-enterprise-onboarding</span><i></i><b>142 %</b></div></div>' +
  "<script>document.body.textContent='script ran'</script><p class=\"kit-note\">&lt;script&gt;alert(1)&lt;/script&gt; &amp;amp; **bold**</p>";

function worst(now: number): Conversation[] {
  const messages: ChatUIMessage[] = [
    user(`Compare ${LONG_URL} et ${WORST_LOGIN}`),
    reply(
      answer(COMPARISON, SOURCES),
      text(`Aleksandra Wiśniewska-Kowalczyk mène sur ${LONG_URL}.\nLigne deux après un retour à la ligne. <script>alert(1)</script> &amp; **bold** IMG_20250914_183022_HDR_portrait_edited_edited.HEIC`),
    ),
    user("Jo"),
    reply(answer(POOL), text("J")),
    user("نور الهدى عبد الرحمن 👩🏽‍💻 Priya\nLine two"),
    reply({ type: "data-html", id: `h${serial++}`, data: { title: "Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf", html: WIDE_HTML } }, answer(LISTING, SOURCES.slice(0, 1)), text("12 days ago")),
    user("Senior Product Design Engineer, Platform Infrastructure"),
    reply(answer(null), text("Aucune donnée.")),
  ];

  const titled = (id: string, title: string, age: number): Conversation => ({ id, title, updatedAt: now - age, messages: [user(title || " "), reply(text("ok"))] });

  return [
    { id: "00000000-0000-4000-8000-000000000001", title: "Aleksandra Wiśniewska-Kowalczyk vs Christopher Alexander M…", updatedAt: now, messages },
    titled("00000000-0000-4000-8000-000000000002", "J", 1000),
    titled("00000000-0000-4000-8000-000000000003", "   ", 2000),
    titled("00000000-0000-4000-8000-000000000004", WORST_LOGIN, 3000),
    titled("00000000-0000-4000-8000-000000000005", "T1 vs Gen.G en LCK 2024", 12 * DAY_MS),
    titled("00000000-0000-4000-8000-000000000006", "T1 vs Gen.G en LCK 2024", 12 * DAY_MS + 1),
    titled("00000000-0000-4000-8000-000000000007", "🦊 Fox", 330 * DAY_MS),
    ...Array.from({ length: 23 }, (_, i) => titled(`00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, `Résultats de Chovy à tous les Worlds (${i + 1})`, 400 * DAY_MS + i)),
  ];
}

function long(now: number): Conversation[] {
  const messages = Array.from({ length: 100 }, (_, i) => [user(`Question ${i + 1} : meilleur KDA en LEC 2025 chez les supports ?`), reply(answer({ ...LISTING, title: `Meilleurs supports — KDA (LEC 2025) #${i + 1}` }), text("Labrov est en tête."))]).flat();

  return [{ id: "00000000-0000-4000-8000-000000000200", title: "200 messages", updatedAt: now, messages }];
}

export function stressConversations(mode: DataMode, now: number): Conversation[] | null {
  if (mode === "demo") return null;

  if (mode === "empty") return [];

  if (mode === "one") return [{ id: "00000000-0000-4000-8000-000000000100", title: "J", updatedAt: now, messages: [user("J")] }];

  return mode === "long" ? long(now) : worst(now);
}
