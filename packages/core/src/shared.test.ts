import { expect, test } from "bun:test";
import { tildeOf } from "./shared";

test("paths under home use a tilde with or without trailing slashes on HOME", () => {
	expect(tildeOf("/home/me/a", "/home/me")).toBe("~/a");
	expect(tildeOf("/home/me/a", "/home/me/")).toBe("~/a");
	expect(tildeOf("/home/me/a", "/home/me///")).toBe("~/a");
});

test("root HOME shortens absolute paths beneath it", () => {
	expect(tildeOf("/a", "/")).toBe("~/a");
	expect(tildeOf("/a/b", "///")).toBe("~/a/b");
});

test("the home directory itself is shown as a tilde", () => {
	expect(tildeOf("/home/me", "/home/me")).toBe("~");
	expect(tildeOf("/home/me", "/home/me/")).toBe("~");
	expect(tildeOf("/home/me", "/home/me///")).toBe("~");
	expect(tildeOf("/", "/")).toBe("~");
	expect(tildeOf("/", "///")).toBe("~");
});

test("paths outside home stay unchanged", () => {
	expect(tildeOf("/elsewhere/a", "/home/me/")).toBe("/elsewhere/a");
	expect(tildeOf("/home/meX/a", "/home/me/")).toBe("/home/meX/a");
	expect(tildeOf("relative/a", "/")).toBe("relative/a");
	expect(tildeOf("", "/")).toBe("");
	expect(tildeOf("", "/home/me/")).toBe("");
});

test("paths stay unchanged when HOME is unset or empty", () => {
	expect(tildeOf("/home/me/a", undefined)).toBe("/home/me/a");
	expect(tildeOf("/home/me/a", "")).toBe("/home/me/a");
});
