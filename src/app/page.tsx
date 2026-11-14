import { AgentConsole } from "./agent-console";
import { Mark } from "./brand/logo";
import { SITE } from "./brand/site";

export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between gap-4 pt-5 sm:pt-8">
        <p className="inline-flex min-h-11 items-center gap-2.5">
          <Mark />
          <span className="text-base font-semibold lowercase">{SITE.name}</span>
        </p>
        <span className="hidden text-xs text-muted sm:block">~/ {SITE.tagline.toLowerCase()}</span>
      </header>
      <main className="flex-1 pb-16">
        <AgentConsole />
      </main>
      <footer className="border-t border-dashed border-line py-6 text-xs leading-relaxed text-muted">
        <p className="max-w-[80ch]">
          Données{" "}
          <a className="underline decoration-line underline-offset-2 hover:text-accent" href="https://lol.fandom.com" target="_blank" rel="noreferrer">
            Leaguepedia
          </a>{" "}
          (CC BY-SA 3.0) · icônes{" "}
          <a
            className="underline decoration-line underline-offset-2 hover:text-accent"
            href="https://developer.riotgames.com/docs/lol#data-dragon"
            target="_blank"
            rel="noreferrer"
          >
            Riot Data Dragon
          </a>
          . Projet non affilié à Riot Games, réalisé par{" "}
          <a className="underline decoration-line underline-offset-2 hover:text-accent" href="https://enzoneault.dev" target="_blank" rel="noreferrer">
            Enzo Neault
          </a>
          .
        </p>
        <p className="mt-2 max-w-[80ch]">
          Les questions posées sont conservées 30 jours, sans adresse IP ni identifiant personnel, pour améliorer
          l&apos;agent. Elles sont aussi envoyées à OpenRouter et au fournisseur du modèle de langage. Évite d’y
          inclure des informations personnelles.
        </p>
      </footer>
    </div>
  );
}
