import type { ReactNode } from "react";
import type { Locale } from "../i18n/locales";
import { CC_BY_SA_URL, RIOT_BOILERPLATE, TEXT_LINK } from "../site-footer";

const CONTACT_URL = "https://www.enzoneault.dev";
const LICENSE_URL = "https://github.com/AzaWoodyy/farsight/blob/main/LICENSE";

export const LEGAL_UPDATED = "2026-11-23";

const updatedOn = (tag: string) => new Intl.DateTimeFormat(tag, { dateStyle: "long", timeZone: "UTC" }).format(new Date(LEGAL_UPDATED));

type Legal = {
  title: string;
  description: string;
  trail: string;
  updated: string;
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
  updated: `Dernière mise à jour : ${updatedOn("fr-FR")}.`,
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
            ). Les questions du site fonctionnent sans compte et sans cookie. Seule la conversation demande un compte : voir{" "}
            <a className={TEXT_LINK} href="#conversation">
              Conversation
            </a>
            .
          </p>
          <p>
            Les questions posées sont enregistrées chez Langfuse, sans adresse IP ni identifiant de visiteur, pour
            améliorer l&apos;agent, et envoyées à OpenRouter et au fournisseur du modèle de langage pour y répondre.
            L&apos;éditeur peut les consulter pendant 30 jours. Vercel, l&apos;hébergeur, reçoit ton adresse IP pour
            servir le site et limiter les abus, compte les pages vues (Vercel Web Analytics) et mesure leur temps
            de chargement (Vercel Speed Insights).
          </p>
          <p>
            La question affichée figure dans l&apos;adresse de la page (<code>?q=</code>), pour que tu puisses
            partager le lien vers une réponse. Elle reste donc dans l&apos;historique de ton navigateur, et quand
            une page est ouverte ou rechargée à cette adresse, Vercel la reçoit avec ton adresse IP dans ses
            journaux de requêtes. Les mesures d&apos;audience ne la reçoivent pas, et elle n&apos;est pas transmise
            aux autres sites.
          </p>
          <p>
            Les icônes viennent des serveurs de Riot Games (Data Dragon) ; les photos des joueurs, les logos des
            équipes et les icônes de dragons de ceux de Fandom, qui héberge Leaguepedia : ton navigateur les télécharge directement, et ces serveurs voient donc ton
            adresse IP et l&apos;adresse du site.
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
      id: "conversation",
      label: "Conversation",
      body: (
        <>
          <p>
            La conversation (<code>/chat</code>) est en bêta et réservée aux comptes que l&apos;éditeur invite. Elle
            demande de se connecter, et rien de ce qui suit ne concerne le reste du site.
          </p>
          <p>
            Les comptes sont gérés par <Ext href="https://clerk.com">Clerk</Ext> (Clerk, Inc., États-Unis), qui reçoit
            ton adresse e-mail, ou ton identité Google ou GitHub si tu choisis ce mode de connexion, ainsi que ton adresse IP et
            des informations sur ton navigateur pour protéger la connexion contre les robots. Clerk dépose les cookies
            nécessaires à la session, sur les pages de conversation uniquement.
          </p>
          <p>
            Tes conversations (tes messages et les résultats affichés) sont enregistrées dans la base de Farsight,
            hébergée par Neon à Francfort, et rattachées à l&apos;identifiant de ton compte. Les 30 plus récentes sont
            gardées jusqu&apos;à ce que tu les supprimes, une par une depuis la liste. Supprimer ton compte, depuis le
            menu du compte ou en écrivant à l&apos;éditeur, supprime aussi tes conversations. Le nombre de messages
            envoyés chaque jour par un compte est gardé 7 jours, pour appliquer la limite de 100 messages par jour.
          </p>
          <p>
            Chaque message est envoyé à OpenRouter et au fournisseur du modèle de langage avec les échanges précédents
            de la conversation, et enregistré chez Langfuse avec un identifiant de conversation, sans ton adresse
            e-mail. L&apos;éditeur peut consulter ces enregistrements pendant 30 jours, et tes conversations tant
            qu&apos;elles existent.
          </p>
          <p>
            Ces traitements servent à fournir le service que tu demandes en te connectant. Clerk est une société
            américaine : des données sont traitées hors de l&apos;Union européenne. Tes droits et la façon de les
            exercer sont les mêmes que dans la section Confidentialité.
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
        <>
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
          <p>
            Les photos des joueurs appartiennent à Riot Games et aux organisateurs des compétitions. Elles ne font pas
            partie de la base ni de sa licence : Farsight garde seulement le nom de chaque fichier et affiche la photo
            depuis <Ext href="https://lol.fandom.com">Leaguepedia</Ext>, qui la publie au titre de l&apos;usage
            équitable (fair use). Le survol d&apos;une photo indique son année.
          </p>
          <p>
            Il en va de même des logos des équipes, qui appartiennent à chaque équipe, et des icônes de dragons, qui
            appartiennent à Riot Games : Farsight n&apos;en garde que le nom de fichier et les affiche depuis
            Leaguepedia.
          </p>
        </>
      ),
    },
  ],
};

const en: Legal = {
  title: "Legal notice and privacy",
  description:
    "Publisher and host of Farsight, what happens to the questions asked, the Riot Games notice and the licenses of the data and the code.",
  trail: "legal notice",
  updated: `Last updated: ${updatedOn("en-GB")}.`,
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
            ). The site's questions work without an account and without a cookie. Only the conversation asks for an account: see{" "}
            <a className={TEXT_LINK} href="#conversation">
              Conversation
            </a>
            .
          </p>
          <p>
            The questions asked are logged at Langfuse, without an IP address or a visitor identifier, to improve the
            agent, and sent to OpenRouter and to the language model provider to answer them. The publisher can read
            them for 30 days. Vercel, the host, receives your IP address to serve the site and limit abuse, and counts
            page views (Vercel Web Analytics) and measures how fast they load (Vercel Speed Insights).
          </p>
          <p>
            The question on screen is part of the page address (<code>?q=</code>), so that you can share the link
            to an answer. It therefore stays in your browser history, and when a page is opened or reloaded at
            that address, Vercel receives it with your IP address in its request logs. The audience measurements
            do not receive it, and it is not passed on to other sites.
          </p>
          <p>
            Icons come from Riot Games&apos; servers (Data Dragon); player photos, team logos and dragon icons from
            those of Fandom, which hosts Leaguepedia: your browser downloads them directly, so these servers see your IP address and the site&apos;s
            address.
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
      id: "conversation",
      label: "Conversation",
      body: (
        <>
          <p>
            The conversation (<code>/en/chat</code>) is in beta and open to the accounts the publisher invites. It
            asks you to sign in, and nothing below applies to the rest of the site.
          </p>
          <p>
            Accounts are handled by <Ext href="https://clerk.com">Clerk</Ext> (Clerk, Inc., United States), which
            receives your email address, or your Google or GitHub identity if you sign in that way, as well as your IP address
            and information about your browser to protect sign-in against bots. Clerk sets the cookies the session
            needs, on the conversation pages only.
          </p>
          <p>
            Your conversations (your messages and the results shown) are stored in Farsight&apos;s database, hosted by
            Neon in Frankfurt, and tied to your account identifier. The 30 most recent are kept until you delete
            them, one by one from the list. Deleting your account, from the account menu or by writing to the
            publisher, deletes your conversations too. The number of messages an account sends each day is kept for
            7 days, to apply the limit of 100 messages a day.
          </p>
          <p>
            Each message is sent to OpenRouter and to the language model provider with the earlier turns of the
            conversation, and logged at Langfuse with a conversation identifier, without your email address. The
            publisher can read these logs for 30 days, and your conversations for as long as they exist.
          </p>
          <p>
            This processing serves to provide the service you ask for by signing in. Clerk is a US company: data is
            processed outside the European Union. Your rights, and how to exercise them, are those of the Privacy
            section.
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
        <>
          <p>
            The data comes from <Ext href="https://lol.fandom.com">Leaguepedia</Ext>, under the{" "}
            <Ext href={CC_BY_SA_URL} rel="noreferrer license">
              CC BY-SA 3.0
            </Ext>{" "}
            license: Farsight&apos;s database, which is derived from it, is shared under the same terms. The code is
            under the{" "}
            <Ext href={LICENSE_URL} rel="noreferrer license">
              MIT license
            </Ext>
            .
          </p>
          <p>
            Player photos belong to Riot Games and to the competition organizers. They are not part of the database or
            its license: Farsight keeps only each file&apos;s name and shows the photo from{" "}
            <Ext href="https://lol.fandom.com">Leaguepedia</Ext>, which publishes it as fair use. Hovering a photo
            shows its year.
          </p>
          <p>
            The same goes for team logos, which belong to each team, and dragon icons, which belong to Riot Games:
            Farsight keeps only their file names and shows them from Leaguepedia.
          </p>
        </>
      ),
    },
  ],
};

export const LEGAL: Record<Locale, Legal> = { fr, en };
