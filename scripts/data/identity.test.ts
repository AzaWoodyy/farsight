import { describe, expect, test } from "bun:test";
import { playerIdentity } from "./identity";

const canonical = playerIdentity(
  ["Xiaohu", "Caps", "Darshan", "Exakick", "Viper (Park Do-hyeon)", "Viper (Leo Liu)", "Ghost (Jang Yong-jun)"],
  [
    { name: "Xiaohu", page: "Xiaohu" },
    { name: "Darshan", page: "Darshan" },
    { name: "ZionSpartan", page: "Darshan" },
    { name: "3XA", page: "Exakick" },
    { name: "Viper", page: "Viper (Park Do-hyeon)" },
    { name: "Viper", page: "Viper (Leo Liu)" },
    { name: "Ghost", page: "Ghost (Jang Yong-jun)" },
    { name: "GHOST", page: "Ghost (Hwang Sung-min)" },
  ],
);

describe("playerIdentity", () => {
  test("a link that is a player page is kept", () => {
    expect(canonical("Caps")).toEqual({ page: "Caps", via: "page" });
  });

  test("a link at another case goes to the page", () => {
    expect(canonical("caPs")).toEqual({ page: "Caps", via: "case" });
    expect(canonical("xiaohu")).toEqual({ page: "Xiaohu", via: "case" });
  });

  test("an older handle goes to the page it redirects to", () => {
    expect(canonical("ZionSpartan")).toEqual({ page: "Darshan", via: "redirect" });
    expect(canonical("3XA")).toEqual({ page: "Exakick", via: "redirect" });
    expect(canonical("zionspartan")).toEqual({ page: "Darshan", via: "redirect" });
  });

  test("the exact page wins over a redirect of the same name", () => {
    const withPage = playerIdentity(["Darshan", "ZionSpartan"], [{ name: "ZionSpartan", page: "Darshan" }]);

    expect(withPage("ZionSpartan")).toEqual({ page: "ZionSpartan", via: "page" });
  });

  test("a redirect target counts as a page even without a Players row", () => {
    expect(canonical("ghost (hwang sung-min)")).toEqual({ page: "Ghost (Hwang Sung-min)", via: "case" });
  });

  test("a handle shared by several pages is not merged", () => {
    expect(canonical("Viper")).toEqual({ page: "Viper", via: "ambiguous" });
    expect(canonical("viper")).toEqual({ page: "viper", via: "ambiguous" });
  });

  test("two pages at another case are not passed over for a redirect", () => {
    const twoPages = playerIdentity(["Foo", "FOO", "Other"], [{ name: "foo", page: "Other" }]);

    expect(twoPages("foo")).toEqual({ page: "foo", via: "ambiguous" });
  });

  test("the exact redirect name wins over the same name at another case", () => {
    expect(canonical("Ghost")).toEqual({ page: "Ghost (Jang Yong-jun)", via: "redirect" });
    expect(canonical("GHOST")).toEqual({ page: "Ghost (Hwang Sung-min)", via: "redirect" });
    expect(canonical("ghost")).toEqual({ page: "ghost", via: "ambiguous" });
  });

  test("the disambiguation suffix is part of the page", () => {
    expect(canonical("Viper (Park Do-hyeon)")).toEqual({ page: "Viper (Park Do-hyeon)", via: "page" });
    expect(canonical("Viper (Someone Else)")).toEqual({ page: "Viper (Someone Else)", via: "unknown" });
  });

  test("an unknown link stays its own player", () => {
    expect(canonical("Gaethan")).toEqual({ page: "Gaethan", via: "unknown" });
  });
});
