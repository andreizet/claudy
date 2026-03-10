import { describe, expect, it } from "vitest";
import { md5 } from "../../shared/md5";

describe("md5", () => {
  it("hashes known values correctly", () => {
    expect(md5("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5("hello")).toBe("5d41402abc4b2a76b9719d911017c592");
    expect(md5("awrcloud.app@caphyon.com")).toBe("b4f8d34835d504c328423c8e87031a13");
  });
});
