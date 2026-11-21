import { relative, resolve } from "node:path";

import { defineRule } from "@oxlint/plugins";

import baseline from "./comment-baseline.json" with { type: "json" };
import { isToolingComment } from "./tooling-comments.ts";

const allowed = new Map<string, number>(Object.entries(baseline));
const ROOT = resolve(import.meta.dirname, "../../..");

export const noCommentsRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow comments; a decision goes to docs/adr, everything else is said by the code.",
    },
    messages: {
      comment:
        "No comments: name the code so it needs none, and record a non-obvious decision in docs/adr (see .claude/skills/delete-comment).",
      overBaseline:
        "This file holds {{count}} comments and its baseline allows {{allowed}}: the baseline only goes down. Remove the new comment (a decision goes to docs/adr).",
      underBaseline:
        "This file holds {{count}} comments and its baseline allows {{allowed}}: lower its entry in tools/oxlint/farsight/comment-baseline.json (remove it at 0).",
    },
  },
  createOnce(context) {
    return {
      Program(node) {
        const comments = context.sourceCode
          .getAllComments()
          .filter((comment) => comment.type !== "Shebang" && !isToolingComment(comment.value));

        const file = relative(ROOT, resolve(context.cwd, context.filename)).replaceAll("\\", "/");
        const limit = allowed.get(file) ?? 0;
        const data = { count: String(comments.length), allowed: String(limit) };

        if (comments.length < limit) {
          context.report({ node, messageId: "underBaseline", data });

          return;
        }

        if (comments.length === limit) return;

        for (const comment of comments) {
          context.report({
            loc: comment.loc,
            messageId: limit === 0 ? "comment" : "overBaseline",
            data,
          });
        }
      },
    };
  },
});
