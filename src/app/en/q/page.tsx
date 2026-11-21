import { connection } from "next/server";
import { Suspense } from "react";
import { answerMetadata } from "../../answer-metadata";
import { HomePage } from "../../home-page";

export async function generateMetadata({ searchParams }: PageProps<"/en/q">) {
  return answerMetadata("en", await searchParams);
}

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
