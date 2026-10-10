import { describe, expect, test } from "vitest";
import { dedupeConsecutiveLabelParts } from "@/ui/lib/accessible-label";

describe("dedupeConsecutiveLabelParts", () => {
  test("removes consecutive duplicates case-insensitively and keeps nonconsecutive parts", () => {
    expect(dedupeConsecutiveLabelParts(["Deploy", "Failed", "failed", "SSH", "", "Deploy"]))
      .toEqual(["Deploy", "Failed", "SSH", "Deploy"]);
  });
});
