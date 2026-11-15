import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Mark } from "../brand/logo";
import { SITE } from "../brand/site";
import { CC_BY_SA_URL, RIOT_BOILERPLATE, SiteFooter, TEXT_LINK } from "../site-footer";

const TITLE = "Mentions légales et confidentialité";

const DESCRIPTION =
  "Éditeur et hébergeur de Farsight, ce que deviennent les questions posées, notice Riot Games et licences des données et du code.";

const PATH = "/mentions-legales";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: { type: "website", locale: "fr_FR", siteName: SITE.name, title: TITLE, description: DESCRIPTION, url: PATH },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const CONTACT_URL = "https://enzoneault.dev";
const LICENSE_URL = "https://github.com/AzaWoodyy/farsight/blob/main/LICENSE";

const SECTIONS = [
  { id: "editeur", label: "Éditeur" },
  { id: "hebergeur", label: "Hébergeur" },
  { id: "contact", label: "Contact" },
  { id: "confidentialite", label: "Confidentialité" },
  { id: "riot", label: "Riot Games" },
  { id: "licences", label: "Licences" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function Ext({ href, children, rel = "noreferrer" }: { href: string; children: ReactNode; rel?: string }) {
  return (
    <a className={TEXT_LINK} href={href} target="_blank" rel={rel}>
      {children}
    </a>
  );
}

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const label = SECTIONS.find((s) => s.id === id)?.label;

  return (
    <section aria-labelledby={id} className="mt-12 space-y-3">
      <h2 id={id} className="scroll-mt-6 text-xs tracking-widest text-muted uppercase">
        ── {label}
      </h2>
      {children}
    </section>
  );
}

/** One recipient of the privacy notice: who receives what, and for how long when it is known. */
function Recipient({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-semibold">{name}</dt>
      <dd className="mt-1 text-muted">{children}</dd>
    </div>
  );
}

export default function MentionsLegales() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between gap-4 pt-5 sm:pt-8">
        <Link href="/" className="inline-flex min-h-11 items-center gap-2.5 hover:text-accent" aria-label={`${SITE.name}, retour à l'accueil`}>
          <Mark size={32} />
          <span className="text-base font-semibold lowercase">{SITE.name}</span>
        </Link>
        <span className="hidden text-xs text-muted sm:block">~/ mentions légales</span>
      </header>
      <main className="flex-1 pt-10 pb-16 text-sm leading-relaxed sm:pt-16">
        <div className="max-w-[75ch]">
          <h1 className="text-xl leading-snug font-semibold text-balance sm:text-3xl">{TITLE}</h1>
          <p className="mt-3 text-xs text-muted">Dernière mise à jour : 15 novembre 2026.</p>
          <nav aria-label="Sommaire" className="mt-6">
            <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <a className={`tap ${TEXT_LINK}`} href={`#${s.id}`}>
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <Section id="editeur">
            <p>
              Farsight (askfarsight.com) est édité par Enzo Neault, un particulier, à titre personnel et non
              professionnel. Le site est gratuit, sans publicité et sans but commercial.
            </p>
          </Section>

          <Section id="hebergeur">
            <p>Le site est hébergé par :</p>
            <address className="border-l border-line pl-4 not-italic">
              Vercel Inc.
              <br />
              440 N Barranca Avenue #4133
              <br />
              Covina, CA 91723
              <br />
              États-Unis
              <br />
              <Ext href="https://vercel.com">vercel.com</Ext> ·{" "}
              <a className={TEXT_LINK} href="mailto:privacy@vercel.com">
                privacy@vercel.com
              </a>
            </address>
          </Section>

          <Section id="contact">
            <p>
              Pour joindre l&apos;éditeur, signaler une erreur ou exercer un droit sur tes données : les moyens de
              contact sont sur <Ext href={CONTACT_URL}>enzoneault.dev</Ext>.
            </p>
          </Section>

          <Section id="confidentialite">
            <p>
              Farsight fonctionne sans compte et ne demande aucune information personnelle. Le site ne dépose aucun
              cookie et n&apos;écrit rien dans le stockage de ton navigateur.
            </p>
            <dl className="space-y-4">
              <Recipient name="Les questions posées : Langfuse">
                Chaque question et sa réponse sont enregistrées dans Langfuse pour améliorer l&apos;agent, sans
                adresse IP, cookie ni identifiant de visiteur : seul un identifiant aléatoire regroupe les questions
                d&apos;une même conversation. Les adresses e-mail, adresses IP et numéros de téléphone reconnus sont
                masqués, pas les noms. L&apos;éditeur peut consulter ces enregistrements pendant 30 jours.
              </Recipient>
              <Recipient name="Les questions posées : OpenRouter et le fournisseur du modèle">
                La question est aussi envoyée, sans masquage, à OpenRouter et au fournisseur du modèle de langage (par
                défaut, un modèle Claude d&apos;Anthropic). Évite d&apos;y écrire des informations personnelles.
              </Recipient>
              <Recipient name="Les pages vues : Vercel Web Analytics">
                En production, les pages vues sont comptées sans cookie : chemin de la page, site d&apos;origine, pays,
                navigateur et type d&apos;appareil.
              </Recipient>
              <Recipient name="L'adresse IP">
                Vercel, l&apos;hébergeur, la reçoit comme tout serveur web. L&apos;application ne s&apos;en sert que
                pour limiter le nombre de questions et ne l&apos;enregistre pas. Les icônes sont chargées depuis le
                serveur Data Dragon de Riot Games, qui la reçoit aussi.
              </Recipient>
            </dl>
            <p>
              Ces traitements reposent sur l&apos;intérêt légitime de l&apos;éditeur : faire fonctionner le site, le
              protéger des abus et améliorer les réponses. Vercel et OpenRouter sont des sociétés américaines.
            </p>
            <p>
              Tu peux demander l&apos;accès à tes données, leur rectification ou leur suppression, ou t&apos;opposer à
              leur traitement, en écrivant à l&apos;éditeur (voir{" "}
              <a className={TEXT_LINK} href="#contact">
                Contact
              </a>
              ) avec le texte de la question et sa date approximative. Tu peux aussi adresser une réclamation à la{" "}
              <Ext href="https://www.cnil.fr/fr/plaintes">CNIL</Ext>.
            </p>
            <p className="text-muted">
              Pour en savoir plus :{" "}
              <Ext href="https://vercel.com/legal/privacy-policy">Vercel</Ext>,{" "}
              <Ext href="https://vercel.com/docs/analytics/privacy-policy">Vercel Web Analytics</Ext>,{" "}
              <Ext href="https://langfuse.com/privacy">Langfuse</Ext>,{" "}
              <Ext href="https://openrouter.ai/privacy">OpenRouter</Ext>.
            </p>
          </Section>

          <Section id="riot">
            <p>
              Farsight est un projet de fan, indépendant de Riot Games. Il n&apos;est ni approuvé ni sponsorisé par
              Riot Games et ne reflète pas les opinions de Riot Games ni de quiconque participe officiellement à la
              production ou à la gestion de ses propriétés. Riot Games, League of Legends et toutes les propriétés
              associées sont des marques ou des marques déposées de Riot Games, Inc.
            </p>
            <p className="text-muted">Le texte demandé par Riot Games, dans sa version officielle :</p>
            <blockquote lang="en" className="space-y-2 border-l border-line pl-4 text-muted">
              <p>{RIOT_BOILERPLATE}</p>
              <p>
                Farsight was created under Riot Games&apos; &quot;Legal Jibber Jabber&quot; policy using assets owned
                by Riot Games. Riot Games does not endorse or sponsor this project.
              </p>
            </blockquote>
            <p className="text-muted">
              Sources : <Ext href="https://developer.riotgames.com/policies/general">règles générales du portail développeur</Ext>{" "}
              et <Ext href="https://www.riotgames.com/en/legal">politique « Legal Jibber Jabber »</Ext> de Riot Games.
            </p>
          </Section>

          <Section id="licences">
            <p>
              <span className="font-semibold">Données.</span> Les résultats, compositions et statistiques viennent de{" "}
              <Ext href="https://lol.fandom.com">Leaguepedia</Ext>, sous licence{" "}
              <Ext href={CC_BY_SA_URL} rel="noreferrer license">
                Creative Commons Attribution-ShareAlike 3.0 (CC BY-SA 3.0)
              </Ext>
              . Chaque réponse cite et relie ses pages Leaguepedia. La base de données de Farsight, qui en est dérivée,
              est partagée dans les mêmes conditions : tu peux la réutiliser en citant Leaguepedia et en gardant la
              même licence.
            </p>
            <p>
              <span className="font-semibold">Noms et icônes.</span> Les noms et icônes des champions, objets et runes
              viennent de <Ext href="https://developer.riotgames.com/docs/lol#data-dragon">Riot Data Dragon</Ext> et
              restent la propriété de Riot Games.
            </p>
            <p>
              <span className="font-semibold">Code.</span> Le code de Farsight est publié sous{" "}
              <Ext href={LICENSE_URL} rel="noreferrer license">
                licence MIT
              </Ext>
              .
            </p>
          </Section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
