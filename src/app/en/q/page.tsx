import { connection } from "next/server";
import { Suspense } from "react";
import { answerMetadata } from "../../answer-metadata";
import { HomePage } from "../../home-page";

/**
 * The home page opened on a question: `/en?q=…` is rewritten here (next.config.ts). Same page as the home, but
 * rendered per request, so the link carries the metadata of its answer for the preview a chat draws of it.
 */
export async function generateMetadata({ searchParams }: PageProps<"/en/q">) {
  return answerMetadata("en", await searchParams);
}

/** Says the page is rendered per request on purpose: its metadata reads the address, its body does not. */
async function PerRequest() {
  await connection();

  return null;
}

export default function AnswerLink() {
  return (
    <>
      <HomePage locale="en" />
      <Suspense>
        <PerRequest />
      </Suspense>
    </>
  );
}
