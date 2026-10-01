import test from "node:test";
import assert from "node:assert/strict";
import { browserURL } from "../src/main/browser-url";

test("browser addresses accept websites, local servers and search terms", () => {
  assert.equal(browserURL(" example.com/docs?q=hello "), "https://example.com/docs?q=hello");
  assert.equal(browserURL("localhost:3000"), "http://localhost:3000/");
  assert.equal(browserURL("127.0.0.1:8080/page"), "http://127.0.0.1:8080/page");
  assert.equal(browserURL("[::1]:3000"), "http://[::1]:3000/");
  assert.equal(browserURL("LOCALHOST?hello"), "http://localhost/?hello");
  assert.equal(browserURL("https://example.com"), "https://example.com/");
  assert.equal(browserURL("electron browser controls"), "https://duckduckgo.com/?q=electron%20browser%20controls");
  assert.equal(browserURL("example.com alternatives"), "https://duckduckgo.com/?q=example.com%20alternatives");
});

test("browser rejects privileged protocols and embedded credentials", () => {
  for (const value of ["", null, "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "https://user:password@example.com", "x".repeat(8193)]) {
    assert.throws(() => browserURL(value));
  }
});
