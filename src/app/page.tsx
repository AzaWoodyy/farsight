import { AgentConsole } from "./agent-console";

const BANNER = String.raw`┌─────────────────────────────────────────┐
│  lol-esports-agent                v0.1  │
│  question > graphe > sql > tableau      │
└─────────────────────────────────────────┘`;

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:py-14">
      <pre aria-hidden className="hidden overflow-hidden text-xs leading-tight text-muted md:block">
        {BANNER}
      </pre>
      <h1 className="mt-4 text-lg font-semibold md:sr-only">lol-esports-agent</h1>
      <p className="mt-3 max-w-2xl text-sm text-muted">
        Pose une question sur l&apos;esport League of Legends. Chaque étape du graphe
        (compréhension, requête, garde-fou, exécution, auto-correction, mise en forme) s&apos;affiche
        en direct. Données : cache local de Leaguepedia (Worlds 2011 → aujourd&apos;hui).
      </p>
      <AgentConsole />
      <footer className="mt-16 border-t border-dashed border-line pt-4 text-xs text-muted">
        Données{" "}
        <a className="underline" href="https://lol.fandom.com" target="_blank" rel="noreferrer">
          Leaguepedia
        </a>{" "}
        (CC BY-SA 3.0) · icônes{" "}
        <a
          className="underline"
          href="https://developer.riotgames.com/docs/lol#data-dragon"
          target="_blank"
          rel="noreferrer"
        >
          Riot Data Dragon
        </a>
        . Projet non affilié à Riot Games.
      </footer>
    </main>
  );
}
