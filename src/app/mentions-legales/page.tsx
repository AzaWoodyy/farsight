import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE } from "../brand/site";
import { HomeLink } from "../home-link";
import { CC_BY_SA_URL, RIOT_BOILERPLATE, SiteFooter, TEXT_LINK } from "../site-footer";
import { ThemeToggle } from "../theme-toggle";

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

export default function MentionsLegales() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between gap-4 pt-5 sm:pt-8">
        <HomeLink />
        <div className="flex items-center gap-4">
          <span className="hidden text-xs text-muted sm:block">~/ mentions légales</span>
          <ThemeToggle />
        </div>
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
              Responsable du traitement : Enzo Neault (voir{" "}
              <a className={TEXT_LINK} href="#contact">
                Contact
              </a>
              ). Le site fonctionne sans compte et ne dépose aucun cookie.
            </p>
            <p>
              Les questions posées sont enregistrées chez Langfuse, sans adresse IP ni identifiant de visiteur, pour
              améliorer l&apos;agent, et envoyées à OpenRouter et au fournisseur du modèle de langage pour y répondre.
              L&apos;éditeur peut les consulter pendant 30 jours. Vercel, l&apos;hébergeur, reçoit ton adresse IP pour
              servir le site et limiter les abus, et compte les pages vues (Vercel Web Analytics).
            </p>
            <p>
              Ces traitements reposent sur l&apos;intérêt légitime de l&apos;éditeur. Vercel et OpenRouter sont des
              sociétés américaines : des données sont traitées hors de l&apos;Union européenne.
            </p>
            <p>
              Tu peux demander l&apos;accès à tes données, leur rectification ou leur suppression, ou t&apos;opposer à
              leur traitement, en écrivant à l&apos;éditeur. Tu peux aussi adresser une réclamation à la{" "}
              <Ext href="https://www.cnil.fr/fr/plaintes">CNIL</Ext>.
            </p>
          </Section>

          <Section id="riot">
            <p>Farsight n&apos;est ni approuvé ni sponsorisé par Riot Games.</p>
            <blockquote lang="en" className="space-y-2 border-l border-line pl-4 text-muted">
              <p>{RIOT_BOILERPLATE}</p>
              <p>
                Farsight was created under Riot Games&apos; &quot;Legal Jibber Jabber&quot; policy using assets owned
                by Riot Games. Riot Games does not endorse or sponsor this project.
              </p>
            </blockquote>
          </Section>

          <Section id="licences">
            <p>
              Les données viennent de <Ext href="https://lol.fandom.com">Leaguepedia</Ext>, sous licence{" "}
              <Ext href={CC_BY_SA_URL} rel="noreferrer license">
                CC BY-SA 3.0
              </Ext>{" "}
              : la base de Farsight, qui en est dérivée, est partagée dans les mêmes conditions. Le code est sous{" "}
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
