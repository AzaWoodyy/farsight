import Link from "next/link";
import type { ReactNode } from "react";
import { MAX_ROWS } from "@/lib/agent/guard";
import { SQL_TIMEOUT_MS } from "@/lib/db/generated-query";
import { YEAR_MIN } from "@/lib/domain/years";
import { type ContentSection, Ext } from "../content-page";
import { type Locale, PATHS } from "../i18n/locales";
import { CC_BY_SA_URL, TEXT_LINK } from "../site-footer";
import type { Facts } from "./facts";

const AUTHOR_URL = "https://www.enzoneault.dev";
const REPO_URL = "https://github.com/AzaWoodyy/farsight";
const RELEASES_URL = `${REPO_URL}/releases`;
const LEAGUEPEDIA_URL = "https://lol.fandom.com";
const DDRAGON_URL = "https://developer.riotgames.com/docs/lol#data-dragon";
const OPENROUTER_URL = "https://openrouter.ai";

const SQL_TIMEOUT_S = SQL_TIMEOUT_MS / 1000;

/** Title, description and header trail of the page: what its metadata needs, without the database. */
export const HOW: Record<Locale, { title: string; description: string; trail: string; toc: string }> = {
  fr: {
    title: "Comment Farsight répond à une question",
    description:
      "De la question au tableau : les quatre étapes de l'agent, le rôle du modèle de langage, d'où viennent les données et ce que Farsight ne sait pas.",
    trail: "comment ça marche",
    toc: "Sommaire",
  },
  en: {
    title: "How Farsight answers a question",
    description:
      "From a question to a table: the agent's four steps, where the language model comes in, where the data comes from and what Farsight cannot answer.",
    trail: "how it works",
    toc: "Contents",
  },
};

const TAG: Record<Locale, string> = { fr: "fr-FR", en: "en-GB" };

const count = (locale: Locale, n: number) => new Intl.NumberFormat(TAG[locale]).format(n);

const day = (locale: Locale, iso: string) => new Intl.DateTimeFormat(TAG[locale], { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));

function In({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link className={TEXT_LINK} href={href}>
      {children}
    </Link>
  );
}

function Step({ children }: { children: ReactNode }) {
  return <h3 className="pt-3 font-semibold">{children}</h3>;
}

function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5 marker:text-muted">{children}</ul>;
}

/** The dated line and the sections of the page in one language. */
type How = { dated: string; sections: ContentSection[] };

type CoverageText = { caption: string; competition: string; games: string; ingame: string; total: string };

/** Games of every competition of the scope and how many have a Riot game file, as the shipped database holds them. */
function Coverage({ locale, facts, text }: { locale: Locale; facts: Facts; text: CoverageText }) {
  const cell = "border-b border-line py-1.5 pr-4 align-top last:pr-0";
  const figure = `${cell} text-right tabular-nums`;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <caption className="pb-2 text-left text-muted">{text.caption}</caption>
        <thead>
          <tr className="text-muted">
            <th scope="col" className={`${cell} font-normal`}>
              {text.competition}
            </th>
            <th scope="col" className={`${figure} font-normal`}>
              {text.games}
            </th>
            <th scope="col" className={`${figure} font-normal`}>
              {text.ingame}
            </th>
          </tr>
        </thead>
        <tbody>
          {facts.leagues.map((l) => (
            <tr key={l.name}>
              <th scope="row" className={`${cell} font-normal`}>
                {l.short} <span className="text-muted">· {l.name}</span>
              </th>
              <td className={figure}>{count(locale, l.games)}</td>
              <td className={`${figure} ${l.ingame ? "" : "text-accent"}`}>{count(locale, l.ingame)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <th scope="row" className="py-1.5 pr-4">
              {text.total}
            </th>
            <td className="py-1.5 pr-4 text-right tabular-nums">{count(locale, facts.games)}</td>
            <td className="py-1.5 text-right tabular-nums">{count(locale, facts.ingame)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function fr(facts: Facts): How {
  const released = facts.releaseDay ? day("fr", facts.releaseDay) : null;

  return {
    dated: released ? `Données du ${released}.` : "Données mises à jour chaque semaine.",
    sections: [
      {
        id: "projet",
        label: "Le projet",
        body: (
          <>
            <p>
              Farsight répond à des questions sur l&apos;esport League of Legends. Tu écris « Résultats de Chovy à tous
              les Worlds » sur <In href={PATHS.home.fr}>la page d&apos;accueil</In>, il cherche dans une base de matchs
              professionnels et te rend un tableau, une phrase de résumé et les pages d&apos;où viennent les chiffres.
            </p>
            <p>
              C&apos;est un projet personnel d&apos;<Ext href={AUTHOR_URL}>Enzo Neault</Ext>, gratuit et sans publicité.
              Le code est public, sous licence MIT : <Ext href={REPO_URL}>dépôt GitHub de Farsight</Ext>.
            </p>
            <p>
              Le principe : les chiffres sortent d&apos;une requête sur la base, jamais de la mémoire d&apos;un modèle
              de langage, et la console montre le trajet de chaque question. Cette page décrit ce trajet, d&apos;où
              viennent les données et ce que Farsight ne sait pas faire.
            </p>
          </>
        ),
      },
      {
        id: "etapes",
        label: "D'une question à une réponse",
        body: (
          <>
            <p>
              Chaque question passe par quatre étapes. Ce sont celles que la console affiche sous chaque réponse, dans
              « Voir comment j&apos;ai trouvé ».
            </p>
            <Step>1. Comprendre</Step>
            <p>
              Farsight repère d&apos;abord de qui et de quoi tu parles : joueurs, équipes, champion, compétition,
              période. Il le fait avec des règles et des tables d&apos;alias tirées de Leaguepedia.
            </p>
            <p>
              Quand un nom peut désigner plusieurs joueurs, Farsight en choisit un, le dit dans une note et propose les
              autres : il ne tranche jamais en silence. Si les règles ne reconnaissent rien de sûr, un modèle de langage
              relève les noms dans la question. Ces noms sont ensuite cherchés dans les mêmes tables : le modèle ne peut
              pas faire entrer un joueur qui n&apos;est pas dans la base.
            </p>
            <Step>2. Construire la requête</Step>
            <p>
              Pour les questions courantes (parcours d&apos;un joueur, duel entre deux joueurs ou deux équipes,
              statistiques d&apos;un champion, classements, roster, série en BO, récap d&apos;une partie), Farsight
              utilise des outils typés : des requêtes SQL écrites à la main, dont seuls les paramètres changent. Aucun
              modèle n&apos;écrit de SQL dans ce cas.
            </p>
            <p>
              Des règles choisissent l&apos;outil. Quand elles laissent trop de mots de ta question non lus, leur choix
              est mis en doute et le modèle de langage tranche : garder l&apos;outil, en prendre un autre, ou n&apos;en
              prendre aucun.
            </p>
            <p>
              Quand aucun outil ne convient, le modèle écrit lui-même une requête SQL, à partir de ta question, des noms
              reconnus et du schéma de la base. C&apos;est le chemin le moins sûr, donc le plus encadré :
            </p>
            <List>
              <li>une seule instruction, en lecture seule, sur une base elle-même ouverte en lecture seule ;</li>
              <li>
                seulement les vues prévues pour ça et leurs colonnes connues : SQLite refuse lui-même toute lecture
                d&apos;une autre table ;
              </li>
              <li>une limite de {MAX_ROWS} lignes, ajoutée d&apos;office ;</li>
              <li>une compilation par SQLite avant toute exécution, qui rejette ce que les contrôles précédents auraient laissé passer ;</li>
              <li>
                une exécution dans un processus à part, sans accès aux secrets de l&apos;application, arrêté au bout de{" "}
                {SQL_TIMEOUT_S} secondes.
              </li>
            </List>
            <p>
              Les requêtes des outils typés passent par le même contrôle. Le modèle a aussi pour consigne de signaler
              une donnée absente plutôt que de l&apos;approcher avec une autre colonne : Farsight répond alors que la
              donnée n&apos;est pas dans la base, sans avancer de chiffre.
            </p>
            <Step>3. Exécuter et se corriger</Step>
            <p>
              La requête tourne sur un fichier SQLite livré avec le site. Si elle est refusée, échoue ou ne renvoie
              rien, Farsight réessaie autrement, un nombre limité de fois. Un outil typé élargit sa recherche par des
              assouplissements prévus d&apos;avance, par exemple baisser le nombre minimum de parties d&apos;un
              classement, et chacun est signalé par une note dans la réponse. Une requête générée est renvoyée au modèle
              avec le message d&apos;erreur ; sa correction repasse tous les contrôles.
            </p>
            <p>
              Quand le résultat vide s&apos;explique par les données (aucune partie de ce joueur dans cette
              compétition, pas de détail de partie pour cette ligue), Farsight s&apos;arrête et le dit, au lieu
              d&apos;insister.
            </p>
            <Step>4. Mettre en forme</Step>
            <p>
              Les lignes deviennent un tableau triable ou une vue dédiée : duel, fiche champion, série game par game,
              courbe d&apos;or d&apos;une partie. La phrase de résumé est d&apos;abord construite par l&apos;outil à
              partir des totaux. Un modèle de langage peut la reformuler, mais sa version n&apos;est gardée que si elle
              reprend les chiffres tels quels et ne cite aucun nom absent des faits ou de ta question ; sinon c&apos;est
              la phrase d&apos;origine qui s&apos;affiche. La réponse se termine par ses sources et des questions de suivi.
            </p>
          </>
        ),
      },
      {
        id: "modele",
        label: "Le rôle du modèle de langage",
        body: (
          <>
            <p>
              Le modèle de langage, appelé via <Ext href={OPENROUTER_URL}>OpenRouter</Ext>, n&apos;intervient
              qu&apos;à quatre endroits : relever les noms quand les règles n&apos;y arrivent pas, choisir un outil
              quand les règles doutent, écrire ou réparer une requête quand aucun outil ne convient, et reformuler la
              phrase de résumé.
            </p>
            <p>
              Il ne reçoit pas les lignes de résultat et n&apos;écrit aucune valeur du tableau : ce que tu lis dans un
              tableau vient de la base. Les questions courantes sont comprises et aiguillées par les règles seules.
            </p>
            <p>
              Sans le modèle (clé absente, ou crédit épuisé : le projet tourne sur une clé plafonnée), Farsight continue
              de répondre avec ses outils typés. Les questions les plus libres peuvent alors rester sans réponse, et
              une note le signale.
            </p>
            <p>
              Quand le modèle est sollicité, ta question est envoyée à OpenRouter et au fournisseur du modèle. Le
              détail est dans les <In href={PATHS.legal.fr}>mentions légales</In>.
            </p>
          </>
        ),
      },
      {
        id: "donnees",
        label: "Les données",
        body: (
          <>
            <p>
              Les résultats, les drafts (picks et bans), les tableaux de score et les classements viennent de{" "}
              <Ext href={LEAGUEPEDIA_URL}>Leaguepedia</Ext>, le wiki communautaire de l&apos;esport League of Legends,
              sous licence{" "}
              <Ext href={CC_BY_SA_URL} rel="noreferrer license">
                CC BY-SA 3.0
              </Ext>
              . La base de Farsight en est dérivée et partagée dans les mêmes conditions.
            </p>
            <p>
              Le détail d&apos;une partie (or, expérience et sbires à 10, 15 et 20 minutes, premiers objectifs, dragons
              par élément, courbe d&apos;or) vient des fichiers de partie de Riot que Leaguepedia héberge. Ils
              n&apos;existent pas pour toutes les parties : le tableau ci-dessous donne le compte par compétition.
            </p>
            <p>
              Les noms et les icônes des champions, des objets et des runes viennent de{" "}
              <Ext href={DDRAGON_URL}>Riot Data Dragon</Ext>.
            </p>
            <p>
              La réponse d&apos;un outil typé liste les pages Leaguepedia qu&apos;elle a lues : tournoi, joueur,
              équipe. Une requête générée cite les pages que ses lignes nomment ou, à défaut, Leaguepedia.
            </p>
            <p>
              Le périmètre est fixe : les Worlds, le MSI et le First Stand, les ligues majeures de Corée, de Chine, d&apos;Europe et
              d&apos;Amérique du Nord sous leurs noms successifs, les ligues du Japon, du Pacifique, du Vietnam, du
              Brésil et d&apos;Espagne, et quelques ligues de développement et nationales. La base commence en {YEAR_MIN}.
            </p>
            <Coverage
              locale="fr"
              facts={facts}
              text={{
                caption: released ? `Parties dans la base au ${released}.` : "Parties dans la base.",
                competition: "Compétition",
                games: "Parties",
                ingame: "Avec détail Riot",
                total: "Total",
              }}
            />
          </>
        ),
      },
      {
        id: "limites",
        label: "Ce que Farsight ne sait pas",
        body: (
          <List>
            <li>
              <strong>Le détail des parties de LPL.</strong> Leaguepedia n&apos;héberge aucun fichier de partie Riot
              pour la ligue chinoise. Résultats, drafts et scores de fin de partie y sont ; l&apos;or à 15 minutes, les
              premiers objectifs, les dragons par élément et la timeline n&apos;y sont pas. Farsight le dit au lieu de
              donner un chiffre.
            </li>
            <li>
              <strong>Le détail des parties anciennes.</strong>{" "}
              {facts.firstIngameYear
                ? `Aucune partie d'avant ${facts.firstIngameYear} n'a de fichier Riot, et il en manque encore sur les saisons qui suivent. `
                : ""}
              Certaines statistiques n&apos;existent qu&apos;à partir d&apos;une saison : l&apos;élément des dragons
              depuis 2016, la rune principale depuis 2018.
            </li>
            <li>
              <strong>Ce qui est hors périmètre.</strong> Les ligues absentes du tableau (LLA, TCL, LCO…), les
              autres jeux, et tout ce qui précède {YEAR_MIN}.
            </li>
            <li>
              <strong>Le direct.</strong> La base est refaite une fois par semaine : un match joué hier peut manquer.
            </li>
            <li>
              <strong>Ce que la base ne contient pas.</strong> Les MVP, par exemple, ou tout ce qui se passe hors des
              matchs : transferts, salaires, audiences, parties classées.
            </li>
            <li>
              <strong>Le fil de la conversation.</strong> Chaque question est lue seule : « et en 2023 ? » ne reprend
              pas la précédente. Les questions de suivi proposées sont complètes pour cette raison.
            </li>
            <li>
              <strong>Les noms qu&apos;il ne connaît pas.</strong> Farsight reconnaît les alias que Leaguepedia liste
              et une poignée de surnoms ajoutés à la main. Un autre surnom n&apos;est pas reconnu, et il le signale.
            </li>
          </List>
        ),
      },
      {
        id: "fraicheur",
        label: "Fraîcheur des données",
        body: (
          <>
            <p>
              Chaque lundi, un traitement automatique relit Leaguepedia, télécharge les fichiers Riot des nouvelles
              parties, reconstruit la base et la publie dans les <Ext href={RELEASES_URL}>releases du dépôt</Ext>. Le
              site est ensuite redéployé avec cette base.
            </p>
            {released && (
              <p>
                La version que tu consultes embarque les données du {released} : {count("fr", facts.games)} parties,
                dont {count("fr", facts.ingame)} avec leur détail Riot.
              </p>
            )}
          </>
        ),
      },
    ],
  };
}

function en(facts: Facts): How {
  const released = facts.releaseDay ? day("en", facts.releaseDay) : null;

  return {
    dated: released ? `Data as of ${released}.` : "Data updated every week.",
    sections: [
      {
        id: "project",
        label: "The project",
        body: (
          <>
            <p>
              Farsight answers questions about League of Legends esports. You type “Chovy&apos;s results at every
              Worlds” on <In href={PATHS.home.en}>the home page</In>; it searches a database of professional matches and
              gives you back a table, a one-sentence summary and the pages the figures come from.
            </p>
            <p>
              It is a personal project by <Ext href={AUTHOR_URL}>Enzo Neault</Ext>, free and without advertising. The
              code is public, under the MIT license: <Ext href={REPO_URL}>Farsight&apos;s GitHub repository</Ext>.
            </p>
            <p>
              The idea behind it: figures come out of a query on the database, never out of a language model&apos;s
              memory, and the console shows the path each question took. This page describes that path, where the data
              comes from and what Farsight cannot do.
            </p>
          </>
        ),
      },
      {
        id: "steps",
        label: "From a question to an answer",
        body: (
          <>
            <p>
              Every question goes through four steps. They are the ones the console shows under each answer, in “See how
              I found it”.
            </p>
            <Step>1. Understand</Step>
            <p>
              Farsight first works out who and what you are asking about: players, teams, a champion, a competition, a
              period. It does this with rules and alias tables taken from Leaguepedia.
            </p>
            <p>
              When a name could be several players, Farsight picks one, says so in a note and offers the others: it
              never chooses silently. If the rules recognize nothing for sure, a language model picks the names out of
              the question. Those names are then looked up in the same tables, so the model cannot bring in a player
              who is not in the database.
            </p>
            <Step>2. Build the query</Step>
            <p>
              For common questions (a player&apos;s track record, two players or two teams head to head, a
              champion&apos;s statistics, rankings, a roster, a best-of series, the recap of a game), Farsight uses
              typed tools: SQL queries written by hand, where only the parameters change. No model writes SQL here.
            </p>
            <p>
              Rules pick the tool. When they leave too many words of your question unread, their pick is put in doubt
              and the language model decides: keep the tool, take another one, or take none.
            </p>
            <p>
              When no tool fits, the model writes a SQL query itself, from your question, the names recognized and the
              schema of the database. This is the least reliable path, so it is the most guarded:
            </p>
            <List>
              <li>a single read-only statement, on a database that is itself opened read-only;</li>
              <li>
                only the views meant for it, and only their known columns: SQLite itself refuses any read of another
                table;
              </li>
              <li>a limit of {MAX_ROWS} rows, added whatever the query says;</li>
              <li>compiled by SQLite before anything runs, which rejects what the earlier checks might have missed;</li>
              <li>
                run in a separate process with no access to the application&apos;s secrets, killed after{" "}
                {SQL_TIMEOUT_S} seconds.
              </li>
            </List>
            <p>
              The typed tools&apos; queries go through the same guard. The model is also told to report missing data
              rather than approximate it with another column: Farsight then answers that the data is not in the
              database, and gives no figure.
            </p>
            <Step>3. Execute and self-correct</Step>
            <p>
              The query runs on a SQLite file shipped with the site. If it is rejected, fails or returns nothing,
              Farsight tries another way, a limited number of times. A typed tool widens its search through relaxations
              planned in advance, such as lowering the minimum number of games in a ranking, and each one is flagged by
              a note in the answer. A generated query goes back to the model with the error message; its fix goes
              through every check again.
            </p>
            <p>
              When the data itself explains the empty result (no game for that player in that competition, no in-game
              detail for that league), Farsight stops and says so instead of trying harder.
            </p>
            <Step>4. Format</Step>
            <p>
              The rows become a sortable table or a dedicated view: a head-to-head, a champion profile, a series game
              by game, the gold curve of a game. The summary sentence is first built by the tool from the totals. A
              language model may rephrase it, but its version is kept only if it repeats the figures as they are and
              names nothing that is absent from the facts or from your question; otherwise the original sentence is shown. The answer ends
              with its sources and follow-up questions.
            </p>
          </>
        ),
      },
      {
        id: "model",
        label: "Where the language model comes in",
        body: (
          <>
            <p>
              The language model, called through <Ext href={OPENROUTER_URL}>OpenRouter</Ext>, comes in at four places
              only: picking out names when the rules cannot, choosing a tool when the rules are in doubt, writing or
              repairing a query when no tool fits, and rephrasing the summary sentence.
            </p>
            <p>
              It is not given the result rows and writes no value of the table: what you read in a table comes from the
              database. Common questions are understood and routed by the rules alone.
            </p>
            <p>
              Without the model (no key, or no credit left: the project runs on a capped key), Farsight keeps answering
              with its typed tools. The most open-ended questions may then stay unanswered, and a note says so.
            </p>
            <p>
              When the model is called, your question is sent to OpenRouter and to the model provider. The details are
              in the <In href={PATHS.legal.en}>legal notice</In>.
            </p>
          </>
        ),
      },
      {
        id: "data",
        label: "The data",
        body: (
          <>
            <p>
              Results, drafts (picks and bans), scoreboards and standings come from{" "}
              <Ext href={LEAGUEPEDIA_URL}>Leaguepedia</Ext>, the community wiki of League of Legends esports, under the{" "}
              <Ext href={CC_BY_SA_URL} rel="noreferrer license">
                CC BY-SA 3.0
              </Ext>{" "}
              license. Farsight&apos;s database is derived from it and shared under the same terms.
            </p>
            <p>
              In-game detail (gold, experience and creep score at 10, 15 and 20 minutes, first objectives, dragons by
              element, the gold curve) comes from the Riot game files Leaguepedia hosts. Not every game has one: the
              table below gives the count per competition.
            </p>
            <p>
              Champion, item and rune names and icons come from <Ext href={DDRAGON_URL}>Riot Data Dragon</Ext>.
            </p>
            <p>
              A typed tool&apos;s answer lists the Leaguepedia pages it read: tournament, player, team. A generated
              query cites the pages its rows name or, failing that, Leaguepedia itself.
            </p>
            <p>
              The scope is fixed: Worlds, MSI and First Stand, the major leagues of Korea, China, Europe and North America under
              their successive names, the leagues of Japan, the Pacific, Vietnam, Brazil and Spain, and a few development
              and national leagues. The database starts in {YEAR_MIN}.
            </p>
            <Coverage
              locale="en"
              facts={facts}
              text={{
                caption: released ? `Games in the database as of ${released}.` : "Games in the database.",
                competition: "Competition",
                games: "Games",
                ingame: "With Riot detail",
                total: "Total",
              }}
            />
          </>
        ),
      },
      {
        id: "limits",
        label: "What Farsight cannot answer",
        body: (
          <List>
            <li>
              <strong>In-game detail for the LPL.</strong> Leaguepedia hosts no Riot game file for the Chinese league.
              Results, drafts and end-of-game scores are there; gold at 15 minutes, first objectives, dragons by element
              and the timeline are not. Farsight says so instead of giving a figure.
            </li>
            <li>
              <strong>In-game detail for old games.</strong>{" "}
              {facts.firstIngameYear
                ? `No game before ${facts.firstIngameYear} has a Riot file, and some are still missing in the seasons that follow. `
                : ""}
              Some statistics only exist from a given season: dragon elements from 2016, the keystone rune from 2018.
            </li>
            <li>
              <strong>Anything out of scope.</strong> Leagues that are not in the table (LLA, TCL, LCO…), other
              games, and everything before {YEAR_MIN}.
            </li>
            <li>
              <strong>Live results.</strong> The database is rebuilt once a week: a match played yesterday may be
              missing.
            </li>
            <li>
              <strong>What the database does not hold.</strong> MVP awards, for instance, or anything that happens
              outside the matches: transfers, salaries, viewership, ranked games.
            </li>
            <li>
              <strong>The thread of a conversation.</strong> Each question is read on its own: “and in 2023?” does not
              pick up the previous one. That is why the suggested follow-up questions are complete ones.
            </li>
            <li>
              <strong>Names it does not know.</strong> Farsight recognizes the aliases Leaguepedia lists and a handful
              of nicknames added by hand. Any other nickname is not recognized, and it says so.
            </li>
          </List>
        ),
      },
      {
        id: "freshness",
        label: "How fresh the data is",
        body: (
          <>
            <p>
              Every Monday, an automated job rereads Leaguepedia, downloads the Riot files of the new games, rebuilds
              the database and publishes it in the <Ext href={RELEASES_URL}>repository&apos;s releases</Ext>. The site
              is then redeployed with that database.
            </p>
            {released && (
              <p>
                The version you are reading ships the data of {released}: {count("en", facts.games)} games, of which{" "}
                {count("en", facts.ingame)} have their Riot detail.
              </p>
            )}
          </>
        ),
      },
    ],
  };
}

const CONTENT: Record<Locale, (facts: Facts) => How> = { fr, en };

export const howContent = (locale: Locale, facts: Facts) => CONTENT[locale](facts);
