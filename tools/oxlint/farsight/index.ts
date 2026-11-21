import { eslintCompatPlugin } from "@oxlint/plugins";

import { noCommentsRule } from "./no-comments.ts";

const farsightPlugin = eslintCompatPlugin({
  meta: { name: "farsight" },
  rules: {
    "no-comments": noCommentsRule,
  },
});

export default farsightPlugin;
