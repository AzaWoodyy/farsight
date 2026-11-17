import type { ReactNode } from "react";
import type { Locale } from "../i18n/locales";
import { CC_BY_SA_URL, RIOT_BOILERPLATE, TEXT_LINK } from "../site-footer";

const CONTACT_URL = "https://enzoneault.dev";
const LICENSE_URL = "https://github.com/AzaWoodyy/farsight/blob/main/LICENSE";

type Legal = {
  title: string;
  description: string;
  /** Where the visitor is, in the header. */
  trail: string;
  updated: string;
  /** Name of the table of contents, for screen readers. */
  toc: string;
  sections: { id: string; label: string; body: ReactNode }[];
};

function Ext({ href, children, rel = "noreferrer" }: { href: string; children: ReactNode; rel?: string }) {
  return (
    <a className={TEXT_LINK} href={href} target="_blank" rel={rel}>
      {children}
    </a>
  );
}

/** The host's postal address, with its country written in the language of the page. */
function Host({ country }: { country: string }) {
  return (
    <address className="border-l border-line pl-4 not-italic">
      Vercel Inc.
      <br />
      440 N Barranca Avenue #4133
      <br />
      Covina, CA 91723
      <br />
      {country}
      <br />
      <Ext href="https://vercel.com">vercel.com</Ext> ·{" "}
      <a className={TEXT_LINK} href="mailto:privacy@vercel.com">
        privacy@vercel.com
      </a>
    </address>
  );
}

/** Riot's notices, word for word: they stay in English in every language. */
function RiotNotices() {
  return (
    <blockquote lang="en" className="space-y-2 border-l border-line pl-4 text-muted">
      <p>{RIOT_BOILERPLATE}</p>
      <p>
        Farsight was created under Riot Games&apos; &quot;Legal Jibber Jabber&quot; policy using assets owned by Riot
        Games. Riot Games does not endorse or sponsor this project.
      </p>
    </blockquote>
  );
}

const fr: Legal = {
  title: "Mentions légales et confidentialité",
  description:
    "Éditeur et hébergeur de Farsight, ce que deviennent les questions posées, notice Riot Games et licences des données et du code.",
  trail: "mentions légales",
  updated: "Dernière mise à jour : 15 novembre 2026.",
  toc: "Sommaire",
  sections: [
    {
      id: "editeur",
      label: "Éditeur",
      body: (
        <p>
          Farsight (askfarsight.com) est édité par Enzo Neault, un particulier, à titre personnel et non professionnel.
          Le site est gratuit, sans publicité et sans but commercial.
        </p>
      ),
    },
    {
      id: "hebergeur",
      label: "Hébergeur",
      body: (
        <>
          <p>Le site est hébergé par :</p>
          <Host country="États-Unis" />
        </>
      ),
    },
    {
      id: "contact",
      label: "Contact",
      body: (
        <p>
          Pour joindre l&apos;éditeur, signaler une erreur ou exercer un droit sur tes données : les moyens de contact
          sont sur <Ext href={CONTACT_URL}>enzoneault.dev</Ext>.
        </p>
      ),
    },
    {
      id: "confidentialite",
      label: "Confidentialité",
      body: (
        <>
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
        </>
      ),
    },
    {
      id: "riot",
      label: "Riot Games",
      body: (
        <>
          <p>Farsight n&apos;est ni approuvé ni sponsorisé par Riot Games.</p>
          <RiotNotices />
        </>
      ),
    },
    {
      id: "licences",
      label: "Licences",
      body: (
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
      ),
    },
  ],
};

const en: Legal = {
  title: "Legal notice and privacy",
  description:
    "Publisher and host of Farsight, what happens to the questions asked, the Riot Games notice and the licenses of the data and the code.",
  trail: "legal notice",
  updated: "Last updated: 15 November 2026.",
  toc: "Contents",
  sections: [
    {
      id: "publisher",
      label: "Publisher",
      body: (
        <p>
          Farsight (askfarsight.com) is published by Enzo Neault, a private individual, in a personal and
          non-professional capacity. The site is free, without advertising and without any commercial purpose.
        </p>
      ),
    },
    {
      id: "host",
      label: "Host",
      body: (
        <>
          <p>The site is hosted by:</p>
          <Host country="United States" />
        </>
      ),
    },
    {
      id: "contact",
      label: "Contact",
      body: (
        <p>
          To reach the publisher, report an error or exercise a right over your data: the ways to get in touch are on{" "}
          <Ext href={CONTACT_URL}>enzoneault.dev</Ext>.
        </p>
      ),
    },
    {
      id: "privacy",
      label: "Privacy",
      body: (
        <>
          <p>
            Data controller: Enzo Neault (see{" "}
            <a className={TEXT_LINK} href="#contact">
              Contact
            </a>
            ). The site works without an account and sets no cookie.
          </p>
          <p>
            The questions asked are logged at Langfuse, without an IP address or a visitor identifier, to improve the
            agent, and sent to OpenRouter and to the language model provider to answer them. The publisher can read
            them for 30 days. Vercel, the host, receives your IP address to serve the site and limit abuse, and counts
            page views (Vercel Web Analytics).
          </p>
          <p>
            This processing relies on the publisher&apos;s legitimate interest. Vercel and OpenRouter are American
            companies: data is processed outside the European Union.
          </p>
          <p>
            You can ask for access to your data, for its correction or its deletion, or object to its processing, by
            writing to the publisher. You can also lodge a complaint with the{" "}
            <Ext href="https://www.cnil.fr/en/plaintes">CNIL</Ext>, the French data protection authority.
          </p>
        </>
      ),
    },
    {
      id: "riot",
      label: "Riot Games",
      body: <RiotNotices />,
    },
    {
      id: "licenses",
      label: "Licenses",
      body: (
        <p>
          The data comes from <Ext href="https://lol.fandom.com">Leaguepedia</Ext>, under the{" "}
          <Ext href={CC_BY_SA_URL} rel="noreferrer license">
            CC BY-SA 3.0
          </Ext>{" "}
          license: Farsight&apos;s database, which is derived from it, is shared under the same terms. The code is under
          the{" "}
          <Ext href={LICENSE_URL} rel="noreferrer license">
            MIT license
          </Ext>
          .
        </p>
      ),
    },
  ],
};

export const LEGAL: Record<Locale, Legal> = { fr, en };
