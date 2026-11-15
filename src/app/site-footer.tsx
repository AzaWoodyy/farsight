import Link from "next/link";

/** A link inside running text, shared by the footer and the legal page. */
export const TEXT_LINK = "underline decoration-line underline-offset-2 hover:text-accent";

export const CC_BY_SA_URL = "https://creativecommons.org/licenses/by-sa/3.0/";

/**
 * Riot's boilerplate for third-party products, word for word (developer.riotgames.com/policies/general asks
 * for it "in a location that is readily visible to players"): it stays in English next to its French summary.
 */
export const RIOT_BOILERPLATE =
  "Farsight isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.";

/** The footer of every page: sources, the privacy summary and the Riot notice, with the full texts one click away. */
export function SiteFooter() {
  return (
    <footer className="border-t border-dashed border-line py-6 text-xs leading-relaxed text-muted">
      <p className="max-w-[80ch]">
        Données{" "}
        <a className={TEXT_LINK} href="https://lol.fandom.com" target="_blank" rel="noreferrer">
          Leaguepedia
        </a>{" "}
        (
        <a className={TEXT_LINK} href={CC_BY_SA_URL} target="_blank" rel="noreferrer license">
          CC BY-SA 3.0
        </a>
        ) · icônes{" "}
        <a
          className={TEXT_LINK}
          href="https://developer.riotgames.com/docs/lol#data-dragon"
          target="_blank"
          rel="noreferrer"
        >
          Riot Data Dragon
        </a>
        . Projet réalisé par{" "}
        <a
          className="font-medium text-accent underline decoration-accent underline-offset-2 hover:decoration-2"
          href="https://enzoneault.dev"
          target="_blank"
          rel="noreferrer"
        >
          Enzo Neault
        </a>
        .
      </p>
      <p className="mt-2 max-w-[80ch]">
        Les questions posées sont enregistrées sans adresse IP ni identifiant personnel, pour améliorer l&apos;agent.
        Elles sont aussi envoyées à OpenRouter et au fournisseur du modèle de langage. Évite d’y inclure des
        informations personnelles.
      </p>
      <p className="mt-2 max-w-[80ch]">
        Farsight n&apos;est ni approuvé ni sponsorisé par Riot Games. <span lang="en">{RIOT_BOILERPLATE}</span>
      </p>
      <p className="mt-2">
        <Link className={`tap ${TEXT_LINK}`} href="/mentions-legales">
          Mentions légales et confidentialité
        </Link>
      </p>
    </footer>
  );
}
